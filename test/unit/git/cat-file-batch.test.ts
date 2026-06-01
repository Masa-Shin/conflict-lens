import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GitCatFileBatch,
  parseHeaderLine,
} from '../../../src/git/cat-file-batch';

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out).toString('utf8') }),
    );
  });
}

describe('parseHeaderLine (pure)', () => {
  it('parses a found header', () => {
    expect(parseHeaderLine('abc123 blob 42')).toEqual({
      kind: 'ok',
      sha: 'abc123',
      type: 'blob',
      size: 42,
    });
  });

  it('parses a found header with size 0', () => {
    expect(parseHeaderLine('def blob 0')).toEqual({
      kind: 'ok',
      sha: 'def',
      type: 'blob',
      size: 0,
    });
  });

  it('detects missing', () => {
    expect(parseHeaderLine('HEAD:does-not-exist missing')).toEqual({
      kind: 'missing',
    });
  });

  it('detects missing even when the echoed spec contains spaces', () => {
    expect(parseHeaderLine('HEAD:dir name/file.txt missing')).toEqual({
      kind: 'missing',
    });
  });

  it('detects ambiguous', () => {
    expect(parseHeaderLine('abcd ambiguous')).toEqual({ kind: 'ambiguous' });
  });

  it('rejects malformed headers', () => {
    expect(parseHeaderLine('one')).toEqual({ kind: 'malformed' });
    expect(parseHeaderLine('a b notanumber')).toEqual({ kind: 'malformed' });
    expect(parseHeaderLine('a b -1')).toEqual({ kind: 'malformed' });
    // Four tokens with a non-missing tail: not a valid success line.
    expect(parseHeaderLine('a b 1 extra')).toEqual({ kind: 'malformed' });
  });
});

interface Fixture {
  repo: string;
  fileBlob: string;
  bigFileBlob: string;
  spacePathBlob: string;
}

describe('GitCatFileBatch (integration)', () => {
  let fx: Fixture;
  let batch: GitCatFileBatch;

  beforeAll(async () => {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-batch-')),
    );
    await run('git', ['init', '-q', '-b', 'main'], repo);
    await run('git', ['config', 'user.email', 't@e'], repo);
    await run('git', ['config', 'user.name', 'Test'], repo);
    await run('git', ['config', 'commit.gpgsign', 'false'], repo);

    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\nworld\n');
    // A bigger blob to exercise size > 1 stdout chunk.
    fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(200_000));
    fs.mkdirSync(path.join(repo, 'dir with space'));
    fs.writeFileSync(path.join(repo, 'dir with space/foo.txt'), 'spaced\n');
    await run('git', ['add', '.'], repo);
    await run('git', ['commit', '-q', '-m', 'init'], repo);

    const fileBlob = (
      await run('git', ['rev-parse', 'HEAD:file.txt'], repo)
    ).stdout.trim();
    const bigFileBlob = (
      await run('git', ['rev-parse', 'HEAD:big.txt'], repo)
    ).stdout.trim();
    const spacePathBlob = (
      await run('git', ['rev-parse', 'HEAD:dir with space/foo.txt'], repo)
    ).stdout.trim();

    fx = { repo, fileBlob, bigFileBlob, spacePathBlob };
    batch = new GitCatFileBatch({ gitPath: 'git', cwd: repo });
  });

  afterAll(() => {
    batch?.dispose();
    try {
      fs.rmSync(fx.repo, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('reads a blob by ref:path and returns its bytes', async () => {
    const result = await batch.read('HEAD:file.txt');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.type).toBe('blob');
    expect(result.sha).toBe(fx.fileBlob);
    expect(result.content.toString('utf8')).toBe('hello\nworld\n');
  });

  it('reads a blob by sha', async () => {
    const result = await batch.read(fx.fileBlob);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.content.toString('utf8')).toBe('hello\nworld\n');
  });

  it('returns missing for a nonexistent path', async () => {
    const result = await batch.read('HEAD:does-not-exist.txt');
    expect(result.kind).toBe('missing');
  });

  it('serializes concurrent reads in FIFO order', async () => {
    const results = await Promise.all([
      batch.read('HEAD:file.txt'),
      batch.read('HEAD:does-not-exist.txt'),
      batch.read('HEAD:file.txt'),
    ]);
    expect(results[0].kind).toBe('ok');
    expect(results[1].kind).toBe('missing');
    expect(results[2].kind).toBe('ok');
  });

  it('handles a blob larger than a typical pipe chunk', async () => {
    const result = await batch.read('HEAD:big.txt');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.content.length).toBe(200_000);
  });

  it('handles a path that contains spaces', async () => {
    const result = await batch.read('HEAD:dir with space/foo.txt');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sha).toBe(fx.spacePathBlob);
    expect(result.content.toString('utf8')).toBe('spaced\n');
  });

  it('rejects specs containing a newline', async () => {
    await expect(batch.read('HEAD:foo\nbar')).rejects.toThrow(/newline/);
  });

  it('rejects further reads after dispose', async () => {
    const ephemeral = new GitCatFileBatch({ gitPath: 'git', cwd: fx.repo });
    const first = ephemeral.read('HEAD:file.txt');
    await first;
    ephemeral.dispose();
    await expect(ephemeral.read('HEAD:file.txt')).rejects.toThrow(/disposed/);
  });
});
