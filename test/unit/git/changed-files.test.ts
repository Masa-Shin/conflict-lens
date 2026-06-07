import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { listChangedFilesOnBase } from '../../../src/git/changed-files';
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
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  await run('git', ['add', file], repo);
  await run('git', ['commit', '-q', '-m', msg], repo);
}

describe('listChangedFilesOnBase', () => {
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

  async function newRepo(): Promise<string> {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-cf-')));
    await run('git', ['init', '-q', '-b', 'main'], repo);
    await run('git', ['config', 'user.email', 't@e'], repo);
    await run('git', ['config', 'user.name', 'Test'], repo);
    await run('git', ['config', 'commit.gpgsign', 'false'], repo);
    return repo;
  }

  it('returns only base-side changes, not HEAD-side changes', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commit(repo, 'a.txt', 'a\n', 'mb a');
    await commit(repo, 'b.txt', 'b\n', 'mb b');
    await commit(repo, 'c.txt', 'c\n', 'mb c');
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await commit(repo, 'a.txt', 'a-feature\n', 'feature change a');
    await run('git', ['checkout', '-q', 'main'], repo);
    await commit(repo, 'b.txt', 'b-base\n', 'base change b');
    await commit(repo, 'c.txt', 'c-base\n', 'base change c');
    await run('git', ['checkout', '-q', 'feature'], repo);

    const files = await listChangedFilesOnBase(runner, repo, 'main');
    expect([...files].sort()).toEqual(['b.txt', 'c.txt']);
  });

  it('returns [] when the base side did not change anything', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commit(repo, 'a.txt', 'a\n', 'mb');
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await commit(repo, 'a.txt', 'a-feature\n', 'feature only');
    expect(await listChangedFilesOnBase(runner, repo, 'main')).toEqual([]);
  });

  it('preserves paths containing spaces', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commit(repo, 'dir name/file.txt', 'a\n', 'mb');
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await run('git', ['checkout', '-q', 'main'], repo);
    await commit(repo, 'dir name/file.txt', 'a-base\n', 'base');
    await run('git', ['checkout', '-q', 'feature'], repo);
    expect(await listChangedFilesOnBase(runner, repo, 'main')).toEqual(['dir name/file.txt']);
  });

  it('throws on an unknown ref so callers can tell failure from an empty diff', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commit(repo, 'a.txt', 'a\n', 'mb');
    await expect(listChangedFilesOnBase(runner, repo, 'origin/never')).rejects.toThrow();
  });
});
