import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitRunner } from '../../../src/git/runner';
import {
  detectGitState,
  isStateBlockingHighlights,
  statusLabelFor,
} from '../../../src/git/state';

const runner = createGitRunner('git');

/** Run a process and resolve when it exits. */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

async function initRepoWithCommit(): Promise<string> {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-state-')),
  );
  await run('git', ['init', '-q', '-b', 'main'], dir);
  await run('git', ['config', 'user.email', 't@e'], dir);
  await run('git', ['config', 'user.name', 'Test'], dir);
  await run('git', ['config', 'commit.gpgsign', 'false'], dir);
  await run('git', ['config', 'tag.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n');
  await run('git', ['add', '.'], dir);
  await run('git', ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

async function initRepoNoCommit(): Promise<string> {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-state-')),
  );
  await run('git', ['init', '-q', '-b', 'main'], dir);
  return dir;
}

async function gitDir(repoDir: string): Promise<string> {
  const r = await run('git', ['rev-parse', '--git-dir'], repoDir);
  const out = r.stdout.trim();
  return path.isAbsolute(out) ? out : path.resolve(repoDir, out);
}

describe('detectGitState', () => {
  const workdirs: string[] = [];

  beforeEach(() => {
    workdirs.length = 0;
  });

  afterEach(() => {
    for (const d of workdirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  function track<T extends string>(d: T): T {
    workdirs.push(d);
    return d;
  }

  it('returns no-commits for a freshly init-ed repo without commits', async () => {
    const dir = track(await initRepoNoCommit());
    const state = await detectGitState(runner, dir);
    expect(state).toEqual({ kind: 'no-commits' });
  });

  it('returns ready with no modifiers for a clean repo with one commit', async () => {
    const dir = track(await initRepoWithCommit());
    const state = await detectGitState(runner, dir);
    expect(state).toEqual({ kind: 'ready', detached: false, bisecting: false });
  });

  it('flags detached HEAD when checking out a raw SHA', async () => {
    const dir = track(await initRepoWithCommit());
    const head = (await run('git', ['rev-parse', 'HEAD'], dir)).stdout.trim();
    await run('git', ['checkout', '-q', '--detach', head], dir);
    const state = await detectGitState(runner, dir);
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.detached).toBe(true);
      expect(state.bisecting).toBe(false);
    }
  });

  it('reports merging when .git/MERGE_HEAD is present', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.writeFileSync(path.join(gd, 'MERGE_HEAD'), 'abc\n');
    const state = await detectGitState(runner, dir);
    expect(state).toEqual({ kind: 'merging' });
  });

  it('reports cherry-picking when CHERRY_PICK_HEAD is present', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.writeFileSync(path.join(gd, 'CHERRY_PICK_HEAD'), 'abc\n');
    expect(await detectGitState(runner, dir)).toEqual({ kind: 'cherry-picking' });
  });

  it('reports reverting when REVERT_HEAD is present', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.writeFileSync(path.join(gd, 'REVERT_HEAD'), 'abc\n');
    expect(await detectGitState(runner, dir)).toEqual({ kind: 'reverting' });
  });

  it('reports rebasing when rebase-merge directory exists', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.mkdirSync(path.join(gd, 'rebase-merge'));
    expect(await detectGitState(runner, dir)).toEqual({ kind: 'rebasing' });
  });

  it('reports rebasing when rebase-apply directory exists', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.mkdirSync(path.join(gd, 'rebase-apply'));
    expect(await detectGitState(runner, dir)).toEqual({ kind: 'rebasing' });
  });

  it('reports rebasing over merging when both markers present (priority)', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.mkdirSync(path.join(gd, 'rebase-merge'));
    fs.writeFileSync(path.join(gd, 'MERGE_HEAD'), 'abc\n');
    expect((await detectGitState(runner, dir)).kind).toBe('rebasing');
  });

  it('flags bisecting modifier on top of ready when BISECT_LOG exists', async () => {
    const dir = track(await initRepoWithCommit());
    const gd = await gitDir(dir);
    fs.writeFileSync(path.join(gd, 'BISECT_LOG'), 'log\n');
    const state = await detectGitState(runner, dir);
    expect(state).toEqual({ kind: 'ready', detached: false, bisecting: true });
  });
});

describe('statusLabelFor', () => {
  it('returns "" for a vanilla ready state', () => {
    expect(statusLabelFor({ kind: 'ready', detached: false, bisecting: false })).toBe('');
  });

  it('returns "(detached)" / "(bisecting)" / "(detached, bisecting)"', () => {
    expect(statusLabelFor({ kind: 'ready', detached: true, bisecting: false })).toBe(
      '(detached)',
    );
    expect(statusLabelFor({ kind: 'ready', detached: false, bisecting: true })).toBe(
      '(bisecting)',
    );
    expect(statusLabelFor({ kind: 'ready', detached: true, bisecting: true })).toBe(
      '(detached, bisecting)',
    );
  });

  it.each([
    [{ kind: 'no-commits' as const }, '(no commits)'],
    [{ kind: 'rebasing' as const }, '(rebasing)'],
    [{ kind: 'merging' as const }, '(merging)'],
    [{ kind: 'cherry-picking' as const }, '(cherry-picking)'],
    [{ kind: 'reverting' as const }, '(reverting)'],
  ])('labels %o as %s', (state, label) => {
    expect(statusLabelFor(state)).toBe(label);
  });
});

describe('isStateBlockingHighlights', () => {
  it('is false only for an attached ready state', () => {
    expect(
      isStateBlockingHighlights({ kind: 'ready', detached: false, bisecting: false }),
    ).toBe(false);
    // Bisecting on a branch is fine; the branch still frames "your work".
    expect(
      isStateBlockingHighlights({ kind: 'ready', detached: false, bisecting: true }),
    ).toBe(false);
    // Detached HEAD has no base branch to diff against → suppressed.
    expect(
      isStateBlockingHighlights({ kind: 'ready', detached: true, bisecting: false }),
    ).toBe(true);
    expect(
      isStateBlockingHighlights({ kind: 'ready', detached: true, bisecting: true }),
    ).toBe(true);
    expect(isStateBlockingHighlights({ kind: 'no-commits' })).toBe(true);
    expect(isStateBlockingHighlights({ kind: 'rebasing' })).toBe(true);
    expect(isStateBlockingHighlights({ kind: 'merging' })).toBe(true);
    expect(isStateBlockingHighlights({ kind: 'cherry-picking' })).toBe(true);
    expect(isStateBlockingHighlights({ kind: 'reverting' })).toBe(true);
  });
});
