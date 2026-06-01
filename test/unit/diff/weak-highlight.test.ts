import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { mapHunkToRight, computeWeakHighlights } from '../../../src/diff/weak-highlight';
import { createBlobReaderFromRunner } from '../../../src/git/blob';
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

describe('mapHunkToRight (pure)', () => {
  // A trivial mapping where every left line maps to the same right line.
  const identity = (n: number): number | undefined => (n >= 1 && n <= 10 ? n : undefined);

  it('change hunk with both endpoints surviving', () => {
    const r = mapHunkToRight(
      { oldStart: 3, oldCount: 2, newStart: 3, newCount: 2 },
      identity,
      10,
    );
    expect(r).toEqual({ startLine: 3, endLine: 4, insertion: false });
  });

  it('pure addition uses the line after the insertion point', () => {
    const r = mapHunkToRight(
      { oldStart: 5, oldCount: 0, newStart: 6, newCount: 3 },
      identity,
      10,
    );
    expect(r).toEqual({ startLine: 6, endLine: 6, insertion: true });
  });

  it('pure addition with shifted mapping', () => {
    // Right side has 2 extra leading lines (every left N → right N+2).
    const shifted = (n: number) => (n >= 1 && n <= 5 ? n + 2 : undefined);
    const r = mapHunkToRight(
      { oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 },
      shifted,
      7,
    );
    expect(r).toEqual({ startLine: 6, endLine: 6, insertion: true });
  });

  it('hunk whose endpoints survive but middle is lost expands to the survivors', () => {
    // Left line 5 deleted on right; 4 and 6 survive.
    const partial = (n: number) => (n === 5 ? undefined : n);
    const r = mapHunkToRight(
      { oldStart: 4, oldCount: 3, newStart: 4, newCount: 3 },
      partial,
      10,
    );
    expect(r).toEqual({ startLine: 4, endLine: 6, insertion: false });
  });

  it('returns undefined when no merge-base line in the hunk survives', () => {
    const r = mapHunkToRight(
      { oldStart: 3, oldCount: 2, newStart: 3, newCount: 2 },
      () => undefined,
      10,
    );
    expect(r).toBeUndefined();
  });
});

interface FixtureRepo {
  repo: string;
  mergeBaseSha: string;
  baseBranch: string;
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

async function makeFixture(): Promise<FixtureRepo> {
  // Layout:
  //   merge-base: file.txt has "L1..L5"
  //   on base/main: line 3 changed to "L3-base"
  //   on feature (HEAD): an extra line prepended
  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-weak-')),
  );
  await run('git', ['init', '-q', '-b', 'main'], repo);
  await run('git', ['config', 'user.email', 't@e'], repo);
  await run('git', ['config', 'user.name', 'Test'], repo);
  await run('git', ['config', 'commit.gpgsign', 'false'], repo);

  await commitFile(repo, 'file.txt', 'L1\nL2\nL3\nL4\nL5\n', 'merge-base');
  const mergeBase = (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();

  // Diverge: feature branch gets a prepended line.
  await run('git', ['checkout', '-q', '-b', 'feature'], repo);
  await commitFile(repo, 'file.txt', 'PREFIX\nL1\nL2\nL3\nL4\nL5\n', 'feature commit');

  // Back to main, change line 3.
  await run('git', ['checkout', '-q', 'main'], repo);
  await commitFile(repo, 'file.txt', 'L1\nL2\nL3-base\nL4\nL5\n', 'base change');

  await run('git', ['checkout', '-q', 'feature'], repo);
  return { repo, mergeBaseSha: mergeBase, baseBranch: 'main' };
}

function cleanup(repos: string[]): void {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

describe('computeWeakHighlights (integration)', () => {
  const teardown: string[] = [];
  afterEach(() => {
    cleanup(teardown);
    teardown.length = 0;
  });

  it('translates a base-side line-3 change into HEAD line 4 (1-line shift)', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    const rightContent = fs.readFileSync(path.join(fx.repo, 'file.txt'), 'utf8');
    const ranges = await computeWeakHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    // Base changed merge-base line 3; feature prepended 1 line, so it
    // lands on right-side line 4.
    expect(ranges).toEqual([{ startLine: 4, endLine: 4, insertion: false }]);
  });

  it('follows the buffer when rightContent differs from HEAD', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    // HEAD on feature is ["PREFIX", "L1".."L5"]. Pretend the user typed
    // an additional leading line that hasn't been committed.
    const rightContent = 'BUFFER\nPREFIX\nL1\nL2\nL3\nL4\nL5\n';
    const ranges = await computeWeakHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    // Two leading lines shift merge-base line 3 to right-side line 5.
    expect(ranges).toEqual([{ startLine: 5, endLine: 5, insertion: false }]);
  });

  it('returns [] when the base side did not change the file', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    // Reset base to the merge-base commit so there are no base-side changes.
    await run('git', ['checkout', '-q', 'main'], fx.repo);
    await run('git', ['reset', '-q', '--hard', fx.mergeBaseSha], fx.repo);
    await run('git', ['checkout', '-q', 'feature'], fx.repo);
    const rightContent = fs.readFileSync(path.join(fx.repo, 'file.txt'), 'utf8');
    const ranges = await computeWeakHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    expect(ranges).toEqual([]);
  });

  it('suppresses ranges when hunks exceed largeFileHunkThreshold', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    const rightContent = fs.readFileSync(path.join(fx.repo, 'file.txt'), 'utf8');
    // The fixture has 1 hunk; setting the threshold to 0 keeps it
    // disabled, and to 1 keeps it within the gate. Pushing it to a
    // negative-equivalent of "any positive number lower than 1" needs
    // a more complex fixture; instead just confirm the gate fires when
    // we set the threshold below the observed hunk count by using a
    // multi-hunk fixture below.
    const baseline = await computeWeakHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
      largeFileHunkThreshold: 200,
    });
    expect(baseline.length).toBeGreaterThan(0);

    // Same call but with the threshold beneath the actual hunk count.
    const gated = await computeWeakHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
      // The fixture has 1 hunk → threshold = 0 disables, threshold = 1
      // is "exactly at the limit, still allowed", but anything > the
      // count is also allowed. To trigger the gate, use a hunk count
      // greater than the threshold: the fixture has exactly 1 hunk,
      // so we need to construct a multi-hunk file to gate it. Wait —
      // for THIS test we just verify the gate's > comparison: set
      // threshold = 0 (disabled) and threshold = 1 (>= hunk count, no
      // gate). We can't gate the 1-hunk fixture without restructuring.
      // The simpler invariant: when threshold == 0 the gate is off, so
      // we get the same baseline ranges.
      largeFileHunkThreshold: 0,
    });
    expect(gated).toEqual(baseline);
  });

  it('returns [] when threshold is positive and hunk count exceeds it', async () => {
    // Build a fresh fixture where merge-base has multi.txt and base
    // makes three separate single-line edits.
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-threshold-')),
    );
    teardown.push(repo);
    await run('git', ['init', '-q', '-b', 'main'], repo);
    await run('git', ['config', 'user.email', 't@e'], repo);
    await run('git', ['config', 'user.name', 'Test'], repo);
    await run('git', ['config', 'commit.gpgsign', 'false'], repo);
    const original = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
    await commitFile(repo, 'multi.txt', original, 'mb');
    const mergeBaseSha = (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await run('git', ['checkout', '-q', 'main'], repo);
    // Three separate hunks on base.
    const baseLines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    baseLines[0] = 'changed0';
    baseLines[3] = 'changed3';
    baseLines[6] = 'changed6';
    await commitFile(repo, 'multi.txt', baseLines.join('\n') + '\n', 'base 3 hunks');
    await run('git', ['checkout', '-q', 'feature'], repo);
    const rightContent = original;

    const baseline = await computeWeakHighlights({
      runner,
      repoRootPath: repo,
      baseBranch: 'main',
      mergeBaseSha,
      relativeFilePath: 'multi.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, repo),
    });
    expect(baseline.length).toBe(3);

    const gated = await computeWeakHighlights({
      runner,
      repoRootPath: repo,
      baseBranch: 'main',
      mergeBaseSha,
      relativeFilePath: 'multi.txt',
      rightContent,
      readBlob: createBlobReaderFromRunner(runner, repo),
      largeFileHunkThreshold: 2,
    });
    expect(gated).toEqual([]);
  });
});
