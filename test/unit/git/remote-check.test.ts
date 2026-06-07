import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkRemoteForUpdates, splitRemoteBranch } from '../../../src/git/remote-check';
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

async function commit(repo: string, file: string, content: string, msg: string): Promise<void> {
  fs.writeFileSync(path.join(repo, file), content);
  await run('git', ['add', file], repo);
  await run('git', ['commit', '-q', '-m', msg], repo);
}

interface Fixture {
  remoteRepo: string;
  localRepo: string;
}

/**
 * Build a bare "remote" repo and a local clone that tracks it. Allows
 * the tests to mutate the remote and observe the difference.
 */
async function makeFixture(): Promise<Fixture> {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-rc-')));
  const seedRepo = path.join(tmpRoot, 'seed');
  fs.mkdirSync(seedRepo);
  await run('git', ['init', '-q', '-b', 'main'], seedRepo);
  await run('git', ['config', 'user.email', 't@e'], seedRepo);
  await run('git', ['config', 'user.name', 'Test'], seedRepo);
  await run('git', ['config', 'commit.gpgsign', 'false'], seedRepo);
  await commit(seedRepo, 'file.txt', 'init\n', 'init');

  const remoteRepo = path.join(tmpRoot, 'remote.git');
  await run('git', ['clone', '-q', '--bare', seedRepo, remoteRepo], tmpRoot);

  const localRepo = path.join(tmpRoot, 'local');
  await run('git', ['clone', '-q', remoteRepo, localRepo], tmpRoot);
  await run('git', ['config', 'user.email', 't@e'], localRepo);
  await run('git', ['config', 'user.name', 'Test'], localRepo);
  await run('git', ['config', 'commit.gpgsign', 'false'], localRepo);

  return { remoteRepo, localRepo };
}

describe('splitRemoteBranch', () => {
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

  it('splits a standard origin/main into origin + main', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    expect(await splitRemoteBranch(runner, fx.localRepo, 'origin/main')).toEqual({
      remote: 'origin',
      branch: 'main',
    });
  });

  it('returns undefined when the prefix is not a known remote', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    expect(await splitRemoteBranch(runner, fx.localRepo, 'unknown/main')).toBeUndefined();
  });

  it('handles a branch name with a slash', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    expect(await splitRemoteBranch(runner, fx.localRepo, 'origin/release/2026.06')).toEqual({
      remote: 'origin',
      branch: 'release/2026.06',
    });
  });
});

describe('checkRemoteForUpdates', () => {
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

  it('reports up-to-date immediately after cloning', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    const result = await checkRemoteForUpdates(runner, fx.localRepo, 'origin/main');
    expect(result.kind).toBe('up-to-date');
  });

  it('reports behind when the remote has moved without a fetch', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    // Push a new commit to the remote without fetching it back.
    const pusher = path.join(path.dirname(fx.localRepo), 'pusher');
    await run('git', ['clone', '-q', fx.remoteRepo, pusher], path.dirname(fx.localRepo));
    await run('git', ['config', 'user.email', 't@e'], pusher);
    await run('git', ['config', 'user.name', 'Test'], pusher);
    await run('git', ['config', 'commit.gpgsign', 'false'], pusher);
    await commit(pusher, 'file.txt', 'updated\n', 'remote update');
    await run('git', ['push', '-q', 'origin', 'main'], pusher);

    const result = await checkRemoteForUpdates(runner, fx.localRepo, 'origin/main');
    expect(result.kind).toBe('behind');
    if (result.kind === 'behind') {
      expect(result.remoteSha).not.toBe(result.localSha);
    }
  });

  it('reports error from the ls-remote path when the remote ref does not exist', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    const result = await checkRemoteForUpdates(runner, fx.localRepo, 'origin/not-a-branch');
    expect(result.kind).toBe('error');
    // Must be the remote-side failure, not the local-tracking-ref path —
    // those two share the same `kind` and are only told apart by `reason`.
    if (result.kind === 'error') {
      expect(result.reason).not.toMatch(/Local ref/);
    }
  });

  it('reports error from the local-tracking-ref path when the remote ref exists but was never fetched', async () => {
    const fx = await makeFixture();
    teardown.push(path.dirname(fx.localRepo));
    // Push a branch to origin from a second clone and never fetch it back
    // into the local repo. ls-remote then succeeds (the ref exists
    // remotely) while `rev-parse refs/remotes/origin/untracked` fails,
    // which is the exact branch this test is meant to exercise.
    const pusher = path.join(path.dirname(fx.localRepo), 'pusher-extra');
    await run('git', ['clone', '-q', fx.remoteRepo, pusher], path.dirname(fx.localRepo));
    await run('git', ['config', 'user.email', 't@e'], pusher);
    await run('git', ['config', 'user.name', 'Test'], pusher);
    await run('git', ['config', 'commit.gpgsign', 'false'], pusher);
    await run('git', ['checkout', '-q', '-b', 'untracked'], pusher);
    await commit(pusher, 'extra.txt', 'extra\n', 'untracked branch');
    await run('git', ['push', '-q', 'origin', 'untracked'], pusher);

    const result = await checkRemoteForUpdates(runner, fx.localRepo, 'origin/untracked');
    expect(result.kind).toBe('error');
    // Pin the specific branch: the local tracking ref is the one missing.
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/Local ref refs\/remotes\/origin\/untracked not found/);
    }
  });
});
