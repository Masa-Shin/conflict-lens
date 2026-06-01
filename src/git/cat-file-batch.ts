import { spawn, type ChildProcess } from 'node:child_process';
import { Buffer } from 'node:buffer';

import type { BlobReader } from './blob';
import { SECURE_ARGS, SECURE_ENV } from './runner';

export interface GitCatFileBatchOptions {
  /** Path to the git binary (typically resolved via `resolveGitEnvironment`). */
  readonly gitPath: string;
  /** Repository working tree, used as the child's cwd. */
  readonly cwd: string;
}

export type CatFileBatchResult =
  | { readonly kind: 'ok'; readonly sha: string; readonly type: string; readonly content: Buffer }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' };

interface PendingRequest {
  readonly spec: string;
  readonly resolve: (result: CatFileBatchResult) => void;
  readonly reject: (err: Error) => void;
}

type ReaderState =
  | { readonly kind: 'header' }
  | { readonly kind: 'body'; readonly sha: string; readonly type: string; readonly size: number };

/**
 * Persistent `git cat-file --batch` child process.
 *
 * Spawning git costs ~10-100ms on macOS; the buffer-following weak
 * highlight would otherwise spawn a fresh git for every blob fetch on
 * every recompute. One long-lived process amortizes the spawn cost
 * across the whole session.
 *
 * The on-the-wire protocol is line-oriented for the request and
 * byte-counted for the response:
 *   request:  `<spec>\n`
 *   response (found):   `<sha> <type> <size>\n<content (size bytes)>\n`
 *   response (missing): `<spec> missing\n`
 *   response (ambig.):  `<spec> ambiguous\n`
 *
 * Requests are pipelined one-at-a-time. True pipelining (writing the
 * next spec before the previous response is read) is possible and could
 * cut latency further, but keeping the state machine to a single
 * in-flight request makes the failure modes much easier to reason about.
 *
 * The child is spawned lazily on the first `read` and respawned on
 * unexpected exit. `dispose()` rejects all pending requests and kills
 * the child; further reads on a disposed instance reject immediately.
 */
export class GitCatFileBatch {
  private child: ChildProcess | undefined;
  private readonly queue: PendingRequest[] = [];
  private current: PendingRequest | undefined;
  private state: ReaderState = { kind: 'header' };
  private buffer: Buffer = Buffer.alloc(0);
  private disposed = false;

  constructor(private readonly options: GitCatFileBatchOptions) {}

  /**
   * Look up an object by spec (`<sha>`, `<ref>:<path>`, etc.). Specs
   * with a literal LF or CR are rejected because the protocol uses LF
   * as the request terminator and silently writing one would corrupt
   * the state machine.
   */
  read(spec: string): Promise<CatFileBatchResult> {
    if (this.disposed) {
      return Promise.reject(new Error('GitCatFileBatch is disposed'));
    }
    if (spec.length === 0) {
      return Promise.reject(new Error('cat-file spec must not be empty'));
    }
    if (spec.includes('\n') || spec.includes('\r')) {
      return Promise.reject(
        new Error('cat-file spec must not contain a newline or carriage return'),
      );
    }
    return new Promise<CatFileBatchResult>((resolve, reject) => {
      this.queue.push({ spec, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const err = new Error('GitCatFileBatch was disposed');
    if (this.current) {
      this.current.reject(err);
      this.current = undefined;
    }
    for (const req of this.queue) req.reject(err);
    this.queue.length = 0;
    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        // best effort
      }
      child.kill('SIGTERM');
    }
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.current) return; // waiting for response
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.state = { kind: 'header' };
    try {
      this.ensureChild();
    } catch (err) {
      this.failCurrent(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) {
      this.failCurrent(new Error('cat-file: child stdin is not writable'));
      return;
    }
    const ok = stdin.write(`${next.spec}\n`);
    if (!ok) {
      // Backpressure on a pipe to git is exceedingly rare for tiny
      // request lines, but `write()` returning false means the buffer
      // is full; allow it to drain before the next pump.
      stdin.once('drain', () => this.pump());
    }
  }

  private ensureChild(): void {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    const env: NodeJS.ProcessEnv = { ...process.env, ...SECURE_ENV };
    const child = spawn(
      this.options.gitPath,
      [...SECURE_ARGS, 'cat-file', '--batch'],
      {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    child.once('error', (err) => this.failAll(err));
    child.once('close', (code, signal) => {
      if (this.disposed) return;
      this.failAll(
        new Error(
          `git cat-file --batch exited unexpectedly (code=${code ?? -1}, signal=${signal ?? 'null'})`,
        ),
      );
    });
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    // Drain stderr to prevent the kernel pipe buffer from filling and
    // blocking the child. The contents are otherwise ignored.
    child.stderr?.on('data', () => {
      /* drain */
    });
    this.child = child;
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.parseOne()) {
      /* consume as much as possible */
    }
  }

  private parseOne(): boolean {
    if (!this.current) return false;
    if (this.state.kind === 'header') {
      const nlIdx = this.buffer.indexOf(0x0a);
      if (nlIdx === -1) return false;
      const line = this.buffer.subarray(0, nlIdx).toString('utf8');
      this.buffer = this.buffer.subarray(nlIdx + 1);
      const parsed = parseHeaderLine(line);
      if (parsed.kind === 'missing' || parsed.kind === 'ambiguous') {
        this.completeCurrent({ kind: parsed.kind });
        return true;
      }
      if (parsed.kind === 'malformed') {
        this.failCurrent(new Error(`cat-file: malformed header "${line}"`));
        return true;
      }
      this.state = {
        kind: 'body',
        sha: parsed.sha,
        type: parsed.type,
        size: parsed.size,
      };
      return true;
    }
    // body
    const needed = this.state.size + 1; // content + trailing LF
    if (this.buffer.length < needed) return false;
    const content = Buffer.from(this.buffer.subarray(0, this.state.size));
    this.buffer = this.buffer.subarray(needed);
    const result: CatFileBatchResult = {
      kind: 'ok',
      sha: this.state.sha,
      type: this.state.type,
      content,
    };
    this.state = { kind: 'header' };
    this.completeCurrent(result);
    return true;
  }

  private completeCurrent(result: CatFileBatchResult): void {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    cur.resolve(result);
    this.pump();
  }

  private failCurrent(err: Error): void {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    cur.reject(err);
    this.pump();
  }

  private failAll(err: Error): void {
    if (this.disposed) return;
    if (this.current) {
      const cur = this.current;
      this.current = undefined;
      cur.reject(err);
    }
    for (const req of this.queue) req.reject(err);
    this.queue.length = 0;
    // Mark the child as dead so the next `read()` triggers a respawn.
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.state = { kind: 'header' };
  }
}

/**
 * Adapt a `GitCatFileBatch` to the `BlobReader` interface used by the
 * weak-highlight compute pipeline. The per-request `signal` is currently
 * ignored: the batch protocol does not surface per-request cancellation,
 * and reads complete fast enough that this has not been a practical
 * problem. If it becomes one, add a queue-removal path on the batch.
 */
export function createBlobReaderFromBatch(batch: GitCatFileBatch): BlobReader {
  return async (ref, relativeFilePath, _options) => {
    const spec = `${ref}:${relativeFilePath}`;
    const result = await batch.read(spec);
    if (result.kind === 'ok') return result.content.toString('utf8');
    if (result.kind === 'missing') {
      throw new Error(`git cat-file --batch: ${spec} not found`);
    }
    throw new Error(`git cat-file --batch: ${spec} is ambiguous`);
  };
}

type HeaderParseResult =
  | { readonly kind: 'ok'; readonly sha: string; readonly type: string; readonly size: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'malformed' };

/**
 * Exported for unit tests. Detect missing / ambiguous before falling
 * back to the success format. The "missing" / "ambiguous" indicator is
 * always the last space-separated token of the response, even if the
 * echoed spec itself contains spaces (e.g. `HEAD:dir name/file.txt`).
 */
export function parseHeaderLine(line: string): HeaderParseResult {
  const lastSpace = line.lastIndexOf(' ');
  if (lastSpace !== -1) {
    const tail = line.slice(lastSpace + 1);
    if (tail === 'missing') return { kind: 'missing' };
    if (tail === 'ambiguous') return { kind: 'ambiguous' };
  }
  const parts = line.split(' ');
  if (parts.length !== 3) return { kind: 'malformed' };
  const size = Number(parts[2]);
  if (!Number.isInteger(size) || size < 0) return { kind: 'malformed' };
  return { kind: 'ok', sha: parts[0], type: parts[1], size };
}
