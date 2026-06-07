import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isPathBinaryAgainstRef,
  numstatReportsBinary,
  parseHunkHeaders,
  resolveMergeBase,
  resolveRefToCommit,
} from '../../../src/git/diff';
import { createGitRunner } from '../../../src/git/runner';

const runner = createGitRunner('git');

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

async function commitFile(
  repo: string,
  filePath: string,
  content: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(repo, filePath), content);
  await run('git', ['add', filePath], repo);
  await run('git', ['commit', '-q', '-m', message], repo);
}

describe('parseHunkHeaders', () => {
  it('returns [] for empty input', () => {
    expect(parseHunkHeaders('')).toEqual([]);
  });

  it('parses a change hunk with explicit counts', () => {
    expect(parseHunkHeaders('@@ -10,3 +12,5 @@')).toEqual([
      { oldStart: 10, oldCount: 3, newStart: 12, newCount: 5 },
    ]);
  });

  it('defaults omitted counts to 1', () => {
    expect(parseHunkHeaders('@@ -10 +12 @@')).toEqual([
      { oldStart: 10, oldCount: 1, newStart: 12, newCount: 1 },
    ]);
    expect(parseHunkHeaders('@@ -10 +12,3 @@')).toEqual([
      { oldStart: 10, oldCount: 1, newStart: 12, newCount: 3 },
    ]);
  });

  it('parses a pure addition (oldCount=0)', () => {
    expect(parseHunkHeaders('@@ -10,0 +11,3 @@')).toEqual([
      { oldStart: 10, oldCount: 0, newStart: 11, newCount: 3 },
    ]);
  });

  it('parses a pure deletion (newCount=0)', () => {
    expect(parseHunkHeaders('@@ -30,2 +29,0 @@')).toEqual([
      { oldStart: 30, oldCount: 2, newStart: 29, newCount: 0 },
    ]);
  });

  it('ignores diff preamble and +/- body lines', () => {
    const diff = [
      'diff --git a/foo b/foo',
      'index abc..def 100644',
      '--- a/foo',
      '+++ b/foo',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '@@ -5,0 +6,2 @@',
      '+added',
      '+lines',
    ].join('\n');
    const hunks = parseHunkHeaders(diff);
    expect(hunks).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 },
    ]);
  });

  it('ignores malformed @@ lines without aborting', () => {
    const diff = ['@@ totally bogus @@', '@@ -1,1 +1,1 @@'].join('\n');
    expect(parseHunkHeaders(diff)).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
  });

  it('tolerates the trailing function header that git sometimes emits', () => {
    expect(parseHunkHeaders('@@ -1,1 +1,1 @@ class Foo {')).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
  });
});

describe('numstatReportsBinary', () => {
  it('returns false for empty output', () => {
    expect(numstatReportsBinary('')).toBe(false);
  });

  it('returns false for a textual change', () => {
    expect(numstatReportsBinary('12\t3\tsrc/foo.ts\n')).toBe(false);
  });

  it('returns true when added / deleted are both "-"', () => {
    expect(numstatReportsBinary('-\t-\tassets/logo.png\n')).toBe(true);
  });

  it('detects a binary record mixed with textual ones', () => {
    const out = ['4\t0\ta.txt', '-\t-\tb.bin', '1\t1\tc.txt'].join('\n');
    expect(numstatReportsBinary(out)).toBe(true);
  });

  it('does not treat a path containing a tab as a binary marker', () => {
    // Path with a literal tab; only the first two tabs are field separators.
    expect(numstatReportsBinary('3\t1\tweird\tname.txt\n')).toBe(false);
  });
});

describe('resolveMergeBase (integration)', () => {
  const teardown: string[] = [];
  afterEach(() => {
    for (const r of teardown) {
      try {
        fs.rmSync(r, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    teardown.length = 0;
  });

  async function makeBranchedRepo(): Promise<{
    repo: string;
    mergeBase: string;
    headOnFeature: string;
  }> {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-mb-')));
    await run('git', ['init', '-q', '-b', 'main'], repo);
    await run('git', ['config', 'user.email', 't@e'], repo);
    await run('git', ['config', 'user.name', 'Test'], repo);
    await run('git', ['config', 'commit.gpgsign', 'false'], repo);
    await commitFile(repo, 'file.txt', 'a\n', 'merge-base');
    const mergeBase = (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await commitFile(repo, 'file.txt', 'a\nb\n', 'feature change');
    const headOnFeature = (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
    await run('git', ['checkout', '-q', 'main'], repo);
    await commitFile(repo, 'file.txt', 'a\nc\n', 'base change');
    await run('git', ['checkout', '-q', 'feature'], repo);
    return { repo, mergeBase, headOnFeature };
  }

  it('returns the actual merge-base SHA for two diverged branches', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await resolveMergeBase(runner, fx.repo, 'main');
    expect(result).toBe(fx.mergeBase);
  });

  it('resolveMergeBase returns undefined for a non-existent ref', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await resolveMergeBase(runner, fx.repo, 'origin/does-not-exist');
    expect(result).toBeUndefined();
  });

  it('resolveRefToCommit resolves a branch name to its tip commit', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await resolveRefToCommit(runner, fx.repo, 'feature');
    expect(result).toBe(fx.headOnFeature);
  });

  it('resolveRefToCommit returns undefined for a non-existent ref', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await resolveRefToCommit(runner, fx.repo, 'origin/nope');
    expect(result).toBeUndefined();
  });

  it('resolveRefToCommit peels an annotated tag down to its commit', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    await run('git', ['tag', '-a', 'v1', '-m', 'release'], fx.repo);
    const result = await resolveRefToCommit(runner, fx.repo, 'v1');
    expect(result).toBe(fx.headOnFeature);
  });

  it('isPathBinaryAgainstRef is false for a textual file changed on base', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    // file.txt is 'a\nc\n' on main vs 'a\nb\n' on the checked-out feature.
    const result = await isPathBinaryAgainstRef(runner, fx.repo, 'main', 'file.txt');
    expect(result).toBe(false);
  });

  it('isPathBinaryAgainstRef is true when the file is binary', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    // Track a binary blob (embedded NUL) with different content on each
    // branch, so base↔worktree differ and git emits the `-\t-` numstat row.
    await run('git', ['checkout', '-q', 'main'], fx.repo);
    fs.writeFileSync(path.join(fx.repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    await run('git', ['add', 'blob.bin'], fx.repo);
    await run('git', ['commit', '-q', '-m', 'add binary on main'], fx.repo);
    await run('git', ['checkout', '-q', 'feature'], fx.repo);
    fs.writeFileSync(path.join(fx.repo, 'blob.bin'), Buffer.from([9, 0, 9, 0, 9]));
    await run('git', ['add', 'blob.bin'], fx.repo);
    await run('git', ['commit', '-q', '-m', 'add binary on feature'], fx.repo);
    const result = await isPathBinaryAgainstRef(runner, fx.repo, 'main', 'blob.bin');
    expect(result).toBe(true);
  });

  it('isPathBinaryAgainstRef is false for an unknown ref (non-zero exit)', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await isPathBinaryAgainstRef(runner, fx.repo, 'origin/nope', 'file.txt');
    expect(result).toBe(false);
  });
});
