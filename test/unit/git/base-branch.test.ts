import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBaseBranch } from '../../../src/git/base-branch';
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

interface Workspace {
  repo: string;
  bareRemote: string;
}

async function makeWorkspace(opts: {
  defaultBranch: 'main' | 'master' | 'trunk';
  pushHeadRef: boolean;
}): Promise<Workspace> {
  const bareRemote = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-bare-')),
  );
  await run('git', ['init', '-q', '--bare', '-b', opts.defaultBranch, bareRemote], os.tmpdir());

  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-work-')),
  );
  await run('git', ['init', '-q', '-b', opts.defaultBranch], repo);
  await run('git', ['config', 'user.email', 't@e'], repo);
  await run('git', ['config', 'user.name', 'Test'], repo);
  await run('git', ['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  await run('git', ['add', '.'], repo);
  await run('git', ['commit', '-q', '-m', 'init'], repo);
  await run('git', ['remote', 'add', 'origin', bareRemote], repo);
  await run('git', ['push', '-q', '-u', 'origin', opts.defaultBranch], repo);
  // Optionally also push a trunk branch so origin/HEAD detection has work to do.
  if (opts.pushHeadRef) {
    // Set origin/HEAD to point at the default branch (some test cases want it).
    await run(
      'git',
      ['remote', 'set-head', 'origin', opts.defaultBranch],
      repo,
    );
  }
  return { repo, bareRemote };
}

function cleanup(ws: Workspace): void {
  for (const d of [ws.repo, ws.bareRemote]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

describe('resolveBaseBranch', () => {
  const teardown: Workspace[] = [];
  afterEach(() => {
    while (teardown.length) cleanup(teardown.pop()!);
  });

  it('accepts a valid configured value (priority 1)', async () => {
    const ws = await makeWorkspace({ defaultBranch: 'main', pushHeadRef: false });
    teardown.push(ws);
    const result = await resolveBaseBranch({
      runner,
      repoRootPath: ws.repo,
      configured: 'origin/main',
      remoteName: 'origin',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.baseBranch).toBe('origin/main');
      expect(result.source).toBe('configured');
    }
  });

  it('surfaces configured-invalid (does NOT silently fall back) when the value fails validation', async () => {
    const ws = await makeWorkspace({ defaultBranch: 'main', pushHeadRef: false });
    teardown.push(ws);
    const result = await resolveBaseBranch({
      runner,
      repoRootPath: ws.repo,
      configured: 'origin/never-existed',
      remoteName: 'origin',
    });
    expect(result.kind).toBe('configured-invalid');
  });

  it('uses origin/HEAD when configured is unset (priority 2)', async () => {
    const ws = await makeWorkspace({ defaultBranch: 'main', pushHeadRef: true });
    teardown.push(ws);
    const result = await resolveBaseBranch({
      runner,
      repoRootPath: ws.repo,
      configured: undefined,
      remoteName: 'origin',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.baseBranch).toBe('origin/main');
      expect(result.source).toBe('symbolic-ref');
    }
  });

  it('falls back to origin/main (priority 3) when origin/HEAD is not set', async () => {
    const ws = await makeWorkspace({ defaultBranch: 'main', pushHeadRef: false });
    teardown.push(ws);
    // Remove the local origin/HEAD symbolic ref so priority 2 is skipped.
    await run('git', ['remote', 'set-head', 'origin', '-d'], ws.repo);
    const result = await resolveBaseBranch({
      runner,
      repoRootPath: ws.repo,
      configured: undefined,
      remoteName: 'origin',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.baseBranch).toBe('origin/main');
      expect(result.source).toBe('default-main');
    }
  });

  it('falls back to origin/master (priority 4) when origin/main is missing', async () => {
    const ws = await makeWorkspace({ defaultBranch: 'master', pushHeadRef: false });
    teardown.push(ws);
    await run('git', ['remote', 'set-head', 'origin', '-d'], ws.repo);
    const result = await resolveBaseBranch({
      runner,
      repoRootPath: ws.repo,
      configured: undefined,
      remoteName: 'origin',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.baseBranch).toBe('origin/master');
      expect(result.source).toBe('default-master');
    }
  });

  it('returns none-found when no remote-tracking branch matches any priority', async () => {
    const ws = await makeWorkspace({ defaultBranch: 'trunk', pushHeadRef: false });
    teardown.push(ws);
    await run('git', ['remote', 'set-head', 'origin', '-d'], ws.repo);
    const result = await resolveBaseBranch({
      runner,
      repoRootPath: ws.repo,
      configured: undefined,
      remoteName: 'origin',
    });
    expect(result.kind).toBe('none-found');
  });
});
