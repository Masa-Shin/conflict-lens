import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeStrongHighlights } from '../../../src/diff/strong-highlight';
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

interface Fixture {
  repo: string;
  mergeBaseSha: string;
  baseBranch: string;
}

async function makeFixture(): Promise<Fixture> {
  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-strong-')),
  );
  await run('git', ['init', '-q', '-b', 'main'], repo);
  await run('git', ['config', 'user.email', 't@e'], repo);
  await run('git', ['config', 'user.name', 'Test'], repo);
  await run('git', ['config', 'commit.gpgsign', 'false'], repo);
  await commitFile(repo, 'file.txt', 'A\nB\nC\n', 'mb');
  const mergeBase = (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
  await run('git', ['checkout', '-q', '-b', 'feature'], repo);
  await commitFile(repo, 'file.txt', 'A\nB-ours\nC\n', 'feature change');
  await run('git', ['checkout', '-q', 'main'], repo);
  await commitFile(repo, 'file.txt', 'A\nB-theirs\nC\n', 'base change');
  await run('git', ['checkout', '-q', 'feature'], repo);
  return { repo, mergeBaseSha: mergeBase, baseBranch: 'main' };
}

describe('computeStrongHighlights (integration)', () => {
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

  it('locates the conflict line when ours mirrors HEAD', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    const oursContent = fs.readFileSync(path.join(fx.repo, 'file.txt'), 'utf8');
    const ranges = await computeStrongHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      oursContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    expect(ranges).toEqual([{ startLine: 2, endLine: 2, insertion: false }]);
  });

  it('reflects buffer edits because ours = buffer text', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    // The user typed an additional leading line that hasn't been
    // committed. The conflict on the "B" line should now land at
    // buffer line 3 instead of line 2.
    const oursContent = 'PREFIX\nA\nB-ours\nC\n';
    const ranges = await computeStrongHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      oursContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    expect(ranges).toEqual([{ startLine: 3, endLine: 3, insertion: false }]);
  });

  it('returns [] when there is no conflict', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    // Reset main to merge-base so theirs == base; only ours has changes.
    await run('git', ['checkout', '-q', 'main'], fx.repo);
    await run('git', ['reset', '-q', '--hard', fx.mergeBaseSha], fx.repo);
    await run('git', ['checkout', '-q', 'feature'], fx.repo);
    const oursContent = fs.readFileSync(path.join(fx.repo, 'file.txt'), 'utf8');
    const ranges = await computeStrongHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      oursContent,
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    expect(ranges).toEqual([]);
  });

  it('returns [] for files that do not exist at the merge-base', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    const ranges = await computeStrongHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'nonexistent.txt',
      oursContent: 'x\n',
      readBlob: createBlobReaderFromRunner(runner, fx.repo),
    });
    expect(ranges).toEqual([]);
  });

  it('short-circuits when the file is not in baseChangedFiles', async () => {
    const fx = await makeFixture();
    teardown.push(fx.repo);
    const oursContent = fs.readFileSync(path.join(fx.repo, 'file.txt'), 'utf8');
    const reader = vi.fn(createBlobReaderFromRunner(runner, fx.repo));
    // file.txt actually does conflict in the fixture, but we tell the
    // gate that the base did not touch it — the compute should bail
    // out before reading any blobs.
    const ranges = await computeStrongHighlights({
      runner,
      repoRootPath: fx.repo,
      baseBranch: fx.baseBranch,
      mergeBaseSha: fx.mergeBaseSha,
      relativeFilePath: 'file.txt',
      oursContent,
      readBlob: reader,
      baseChangedFiles: new Set([]),
    });
    expect(ranges).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });
});
