import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseMergeTreeOutput,
  runMergeTree,
} from '../../../src/git/merge-tree';
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
  fs.mkdirSync(path.dirname(path.join(repo, filePath)), { recursive: true });
  fs.writeFileSync(path.join(repo, filePath), content);
  await run('git', ['add', filePath], repo);
  await run('git', ['commit', '-q', '-m', message], repo);
}

describe('parseMergeTreeOutput (pure)', () => {
  it('returns clean for a bare tree SHA', () => {
    expect(parseMergeTreeOutput('abc123\0')).toEqual({
      kind: 'clean',
      treeSha: 'abc123',
    });
  });

  it('returns conflicted with one path before the info section', () => {
    // <sha>\0<path>\0\0<info...>\0
    const stdout = 'treeSha\0src/a.ts\0\0info-stuff\0';
    expect(parseMergeTreeOutput(stdout)).toEqual({
      kind: 'conflicted',
      treeSha: 'treeSha',
      conflictedPaths: ['src/a.ts'],
    });
  });

  it('returns conflicted with multiple paths', () => {
    const stdout = 'tree\0a\0b\0c\0\0info\0';
    expect(parseMergeTreeOutput(stdout)).toEqual({
      kind: 'conflicted',
      treeSha: 'tree',
      conflictedPaths: ['a', 'b', 'c'],
    });
  });

  it('reports unsupported on empty output', () => {
    const r = parseMergeTreeOutput('');
    expect(r.kind).toBe('unsupported');
  });
});

describe('runMergeTree (integration)', () => {
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
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-mt-')),
    );
    await run('git', ['init', '-q', '-b', 'main'], repo);
    await run('git', ['config', 'user.email', 't@e'], repo);
    await run('git', ['config', 'user.name', 'Test'], repo);
    await run('git', ['config', 'commit.gpgsign', 'false'], repo);
    return repo;
  }

  it('reports a clean merge when only one side changed', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commitFile(repo, 'file.txt', 'a\nb\nc\n', 'mb');
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await commitFile(repo, 'file.txt', 'a\nb-feature\nc\n', 'feature only');
    // main was not advanced, so the merge is trivially clean.
    const result = await runMergeTree(runner, repo, 'main');
    expect(result.kind).toBe('clean');
  });

  it('reports the conflicted path when both sides touch the same line', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commitFile(repo, 'file.txt', 'a\nb\nc\n', 'mb');
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await commitFile(repo, 'file.txt', 'a\nb-feature\nc\n', 'feature change');
    await run('git', ['checkout', '-q', 'main'], repo);
    await commitFile(repo, 'file.txt', 'a\nb-main\nc\n', 'main change');
    await run('git', ['checkout', '-q', 'feature'], repo);
    const result = await runMergeTree(runner, repo, 'main');
    expect(result.kind).toBe('conflicted');
    if (result.kind === 'conflicted') {
      expect(result.conflictedPaths).toContain('file.txt');
    }
  });

  it('lists each conflicted path exactly once even when both sides touch many files', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commitFile(repo, 'a.txt', 'a\n', 'mb a');
    await commitFile(repo, 'b.txt', 'b\n', 'mb b');
    await run('git', ['checkout', '-q', '-b', 'feature'], repo);
    await commitFile(repo, 'a.txt', 'a-feature\n', 'feature a');
    await commitFile(repo, 'b.txt', 'b-feature\n', 'feature b');
    await run('git', ['checkout', '-q', 'main'], repo);
    await commitFile(repo, 'a.txt', 'a-main\n', 'main a');
    await commitFile(repo, 'b.txt', 'b-main\n', 'main b');
    await run('git', ['checkout', '-q', 'feature'], repo);
    const result = await runMergeTree(runner, repo, 'main');
    expect(result.kind).toBe('conflicted');
    if (result.kind === 'conflicted') {
      const sorted = [...result.conflictedPaths].sort();
      expect(sorted).toEqual(['a.txt', 'b.txt']);
    }
  });

  it('returns unsupported when given an unknown ref', async () => {
    const repo = await newRepo();
    teardown.push(repo);
    await commitFile(repo, 'file.txt', 'a\n', 'mb');
    const result = await runMergeTree(runner, repo, 'origin/never-fetched');
    expect(result.kind).toBe('unsupported');
  });
});
