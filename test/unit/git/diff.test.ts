import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyHunk,
  parseHunkHeaders,
  resolveHeadSha,
  resolveMergeBase,
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
    const diff = [
      '@@ totally bogus @@',
      '@@ -1,1 +1,1 @@',
    ].join('\n');
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

describe('classifyHunk', () => {
  it.each([
    [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }, 'change'],
    [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 3 }, 'addition'],
    [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 0 }, 'deletion'],
    [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }, 'change'],
  ] as const)('classifies %o as %s', (hunk, kind) => {
    expect(classifyHunk(hunk)).toBe(kind);
  });
});

describe('resolveMergeBase / resolveHeadSha (integration)', () => {
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
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-mb-')),
    );
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

  it('resolveHeadSha returns the current HEAD commit', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await resolveHeadSha(runner, fx.repo);
    expect(result).toBe(fx.headOnFeature);
  });

  it('resolveMergeBase returns undefined for a non-existent ref', async () => {
    const fx = await makeBranchedRepo();
    teardown.push(fx.repo);
    const result = await resolveMergeBase(runner, fx.repo, 'origin/does-not-exist');
    expect(result).toBeUndefined();
  });
});
