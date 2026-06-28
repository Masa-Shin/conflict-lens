import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBlobReaderFromRunner, showBlob } from '../../../src/git/blob';
import { createGitRunner } from '../../../src/git/runner';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@e',
};

function git(args: readonly string[], cwd: string): void {
  execFileSync('git', [...args], { cwd, env: GIT_ENV, stdio: 'ignore' });
}

describe('showBlob (one-shot `git show` fallback)', () => {
  let repo: string;
  const runner = createGitRunner('git');

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-blob-')));
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 't@e'], repo);
    git(['config', 'user.name', 'Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);

    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\nworld\n');
    fs.mkdirSync(path.join(repo, 'dir with space'));
    fs.writeFileSync(path.join(repo, 'dir with space/foo.txt'), 'spaced\n');
    // A path that starts with a dash must not be parsed as an option.
    fs.writeFileSync(path.join(repo, '-dashed.txt'), 'dash\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'v1'], repo);
    git(['branch', 'v1'], repo);

    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\nedited\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'v2'], repo);
  });

  afterAll(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('reads a blob at HEAD', async () => {
    await expect(showBlob(runner, repo, 'HEAD', 'file.txt')).resolves.toBe('hello\nedited\n');
  });

  it('reads the blob of an older ref, not the working tree', async () => {
    await expect(showBlob(runner, repo, 'v1', 'file.txt')).resolves.toBe('hello\nworld\n');
  });

  it('reads a path containing spaces', async () => {
    await expect(showBlob(runner, repo, 'HEAD', 'dir with space/foo.txt')).resolves.toBe(
      'spaced\n',
    );
  });

  it('reads a path that begins with a dash', async () => {
    await expect(showBlob(runner, repo, 'HEAD', '-dashed.txt')).resolves.toBe('dash\n');
  });

  it('rejects with the git error for a missing path', async () => {
    await expect(showBlob(runner, repo, 'HEAD', 'no-such.txt')).rejects.toThrow(
      /git show HEAD:no-such\.txt exited with \d+/,
    );
  });

  it('rejects with the git error for an unknown ref', async () => {
    await expect(showBlob(runner, repo, 'no-such-ref', 'file.txt')).rejects.toThrow(/exited with/);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      showBlob(runner, repo, 'HEAD', 'file.txt', { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('createBlobReaderFromRunner binds runner and repo root', async () => {
    const read = createBlobReaderFromRunner(runner, repo);
    await expect(read('v1', 'file.txt')).resolves.toBe('hello\nworld\n');
    await expect(read('HEAD', 'no-such.txt')).rejects.toThrow(/exited with/);
  });
});
