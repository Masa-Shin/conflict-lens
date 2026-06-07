import { spawn, type ChildProcess } from 'node:child_process';
import { Buffer } from 'node:buffer';

import type { BlobReader } from './blob';
import { SECURE_ARGS, SECURE_ENV } from './runner';

export interface GitCatFileBatchOptions {
  /** Path to the git binary (typically resolved via `resolveGitEnvironment`). */
  readonly gitPath: string;
  /** Repository working tree, used as the child's cwd. */
  readonly cwd: string;
  /**
   * Reject any object whose body exceeds this many bytes. The header line
   * carries the size up front, so an over-cap object is drained off the
   * pipe (to keep the protocol in sync) without ever being buffered, and
   * reported as `too-large`. Defaults to {@link DEFAULT_MAX_BLOB_BYTES}.
   * Without this a single huge tracked blob (a checked-in bundle, a large
   * generated file) would be loaded whole into the extension-host heap.
   */
  readonly maxBlobBytes?: number;
}

/**
 * Default per-object body cap. Mirrors the one-shot runner's
 * `DEFAULT_MAX_BUFFER_BYTES` so the batch path is bounded the same way the
 * spawn-per-call path already is.
 */
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024; // 64 MiB

export type CatFileBatchResult =
  | { readonly kind: 'ok'; readonly sha: string; readonly type: string; readonly content: Buffer }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'too-large'; readonly size: number };

interface PendingRequest {
  readonly spec: string;
  readonly resolve: (result: CatFileBatchResult) => void;
  readonly reject: (err: Error) => void;
}

type ReaderState =
  | { readonly kind: 'header' }
  | { readonly kind: 'body'; readonly sha: string; readonly type: string; readonly size: number }
  /**
   * Draining an over-cap object: discard `remaining` bytes (body + trailing
   * LF) without buffering them, then resolve the current request as
   * `too-large`.
   */
  | { readonly kind: 'skip'; readonly remaining: number; readonly size: number };

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
  /**
   * Unparsed stdout bytes, held as the raw pipe chunks rather than one
   * growing buffer. Appending is O(1) and the body is concatenated exactly
   * once (in `take`), so a large blob arriving in many chunks costs O(size)
   * total — not the O(size²) a concat-on-every-`data` accumulator would.
   */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private disposed = false;
  private readonly maxBlobBytes: number;

  constructor(private readonly options: GitCatFileBatchOptions) {
    const cap = options.maxBlobBytes;
    this.maxBlobBytes =
      typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_BLOB_BYTES;
  }

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
    const child = spawn(this.options.gitPath, [...SECURE_ARGS, 'cat-file', '--batch'], {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.once('error', (err) => this.failAll(err));
    child.once('close', (code, signal) => {
      if (this.disposed) return;
      this.failAll(
        new Error(
          `git cat-file --batch exited unexpectedly (code=${code ?? -1}, signal=${signal ?? 'null'})`,
        ),
      );
    });
    // If the child dies while we are writing a request line, the EPIPE/
    // ECONNRESET lands on the stdin stream rather than the child's 'error'
    // event. Without this listener Node would rethrow it and crash the
    // extension host; the death itself is handled via 'close' → failAll.
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    // Drain stderr to prevent the kernel pipe buffer from filling and
    // blocking the child. The contents are otherwise ignored.
    child.stderr?.on('data', () => {
      /* drain */
    });
    this.child = child;
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.parseOne()) {
      /* consume as much as possible */
    }
  }

  /** Offset of the first byte `b` across the buffered chunks, or -1. */
  private indexOfByte(b: number): number {
    let base = 0;
    for (const chunk of this.chunks) {
      const i = chunk.indexOf(b);
      if (i !== -1) return base + i;
      base += chunk.length;
    }
    return -1;
  }

  /**
   * Remove and return the first `n` buffered bytes as one Buffer. Caller
   * must ensure `n <= this.buffered`. Copies at most `n` bytes once; when a
   * single chunk already holds the request the chunk (or a view of it) is
   * handed back without copying.
   */
  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length === n) {
      this.chunks.shift();
      this.buffered -= n;
      return first;
    }
    if (first.length > n) {
      const out = first.subarray(0, n);
      this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, n - off);
      chunk.copy(out, off, 0, take);
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
      off += take;
    }
    this.buffered -= n;
    return out;
  }

  /**
   * Discard up to `n` buffered bytes without materializing them. Returns
   * the number actually dropped (less than `n` only when the buffer ran dry).
   */
  private drop(n: number): number {
    let dropped = 0;
    while (dropped < n && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, n - dropped);
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
      this.buffered -= take;
      dropped += take;
    }
    return dropped;
  }

  private parseOne(): boolean {
    if (!this.current) return false;
    if (this.state.kind === 'header') {
      const nlIdx = this.indexOfByte(0x0a);
      if (nlIdx === -1) return false;
      const line = this.take(nlIdx).toString('utf8');
      this.drop(1); // trailing LF
      const parsed = parseHeaderLine(line);
      if (parsed.kind === 'missing' || parsed.kind === 'ambiguous') {
        this.completeCurrent({ kind: parsed.kind });
        return true;
      }
      if (parsed.kind === 'malformed') {
        this.failCurrent(new Error(`cat-file: malformed header "${line}"`));
        return true;
      }
      if (parsed.size > this.maxBlobBytes) {
        // Too big to hold. Switch to draining the body (content + trailing
        // LF) so the next response stays aligned, without ever buffering it.
        this.state = { kind: 'skip', remaining: parsed.size + 1, size: parsed.size };
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

    if (this.state.kind === 'skip') {
      if (this.buffered === 0) return false;
      const remaining = this.state.remaining - this.drop(this.state.remaining);
      if (remaining > 0) {
        this.state = { kind: 'skip', remaining, size: this.state.size };
        return false; // wait for the rest of the oversized body
      }
      const size = this.state.size;
      this.state = { kind: 'header' };
      this.completeCurrent({ kind: 'too-large', size });
      return true;
    }

    // body
    const needed = this.state.size + 1; // content + trailing LF
    if (this.buffered < needed) return false;
    const content = this.take(this.state.size);
    this.drop(1); // trailing LF
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
    this.chunks = [];
    this.buffered = 0;
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
    if (result.kind === 'too-large') {
      throw new Error(`git cat-file --batch: ${spec} is too large (${result.size} bytes)`);
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
