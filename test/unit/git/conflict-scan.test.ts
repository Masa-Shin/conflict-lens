import { afterEach, describe, expect, it } from 'vitest';

import type { BlobReader } from '../../../src/git/blob';
import { GitCatFileBatch, createBlobReaderFromBatch } from '../../../src/git/cat-file-batch';
import { scanBaseConflicts, type ConflictScanResult } from '../../../src/git/conflict-scan';
import { createGitRunner } from '../../../src/git/runner';
import { setupScenario, type Scenario } from '../mcp/repo-fixture';

const runner = createGitRunner('git');
const FIVE = 'l1\nl2\nl3\nl4\nl5\n';
// Binary-looking content (contains a NUL), built at runtime so no literal
// NUL byte sits in this source file.
const bin = (s: string): string => `a${String.fromCharCode(0)}${s}\n`;

const open: { scenario: Scenario; batch: GitCatFileBatch }[] = [];

function start(scenario: Scenario): { scenario: Scenario; readBlob: BlobReader } {
  const batch = new GitCatFileBatch({ gitPath: 'git', cwd: scenario.repo });
  open.push({ scenario, batch });
  return { scenario, readBlob: createBlobReaderFromBatch(batch) };
}

function scan(
  scenario: Scenario,
  readBlob: BlobReader,
  changedFiles: string[],
): Promise<ConflictScanResult> {
  return scanBaseConflicts({
    runner,
    repoRootPath: scenario.repo,
    mergeBaseSha: scenario.mergeBaseSha,
    baseTipSha: scenario.baseTipSha,
    changedFiles,
    readBlob,
  });
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    if (entry) {
      entry.batch.dispose();
      entry.scenario.cleanup();
    }
  }
});

describe('scanBaseConflicts', () => {
  it('counts a content conflict where both sides changed the same line', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
        localChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-local\nl4\nl5\n'),
      }),
    );
    expect(await scan(scenario, readBlob, ['foo.txt'])).toEqual({
      totalConflicts: 1,
      files: [{ path: 'foo.txt', conflicts: 1 }],
      skipped: [],
    });
  });

  it('reports nothing when only the base changed the file', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
    );
    const result = await scan(scenario, readBlob, ['foo.txt']);
    expect(result.totalConflicts).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('counts two separated conflicting regions as two places', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`);
    const make = (a: string, b: string): string => {
      const copy = [...lines];
      copy[1] = a;
      copy[10] = b;
      return `${copy.join('\n')}\n`;
    };
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': `${lines.join('\n')}\n` },
        baseChange: (t) => t.write('foo.txt', make('base-top', 'base-bottom')),
        localChange: (t) => t.write('foo.txt', make('local-top', 'local-bottom')),
      }),
    );
    const result = await scan(scenario, readBlob, ['foo.txt']);
    expect(result.totalConflicts).toBe(2);
    expect(result.files).toEqual([{ path: 'foo.txt', conflicts: 2 }]);
  });

  it('counts base-deleted + locally-modified as one place', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.remove('foo.txt'),
        localChange: (t) => t.write('foo.txt', 'l1\nl2\nEDITED\nl4\nl5\n'),
      }),
    );
    expect((await scan(scenario, readBlob, ['foo.txt'])).totalConflicts).toBe(1);
  });

  it('reports nothing when the base deleted a file we did not touch', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.remove('foo.txt'),
      }),
    );
    expect((await scan(scenario, readBlob, ['foo.txt'])).totalConflicts).toBe(0);
  });

  it('counts locally-deleted + base-modified as one place', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
        localChange: (t) => t.remove('foo.txt'),
      }),
    );
    expect((await scan(scenario, readBlob, ['foo.txt'])).totalConflicts).toBe(1);
  });

  it('reports nothing for a base-added file absent locally', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('new.txt', 'hello\n'),
      }),
    );
    expect((await scan(scenario, readBlob, ['new.txt'])).totalConflicts).toBe(0);
  });

  it('counts an add/add with different content as one place', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('new.txt', 'base version\n'),
        localChange: (t) => t.write('new.txt', 'local version\n'),
      }),
    );
    expect((await scan(scenario, readBlob, ['new.txt'])).totalConflicts).toBe(1);
  });

  it('orders files by conflict count and sums the total', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`);
    const make = (a: string, b: string): string => {
      const copy = [...lines];
      copy[1] = a;
      copy[10] = b;
      return `${copy.join('\n')}\n`;
    };
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'one.txt': FIVE, 'two.txt': `${lines.join('\n')}\n` },
        baseChange: (t) => {
          t.write('one.txt', 'l1\nl2\nl3-base\nl4\nl5\n');
          t.write('two.txt', make('base-top', 'base-bottom'));
        },
        localChange: (t) => {
          t.write('one.txt', 'l1\nl2\nl3-local\nl4\nl5\n');
          t.write('two.txt', make('local-top', 'local-bottom'));
        },
      }),
    );
    const result = await scan(scenario, readBlob, ['one.txt', 'two.txt']);
    expect(result.totalConflicts).toBe(3);
    expect(result.files).toEqual([
      { path: 'two.txt', conflicts: 2 },
      { path: 'one.txt', conflicts: 1 },
    ]);
  });

  it('skips a binary file instead of failing the scan', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'bin.dat': bin('b'), 'foo.txt': FIVE },
        baseChange: (t) => {
          t.write('bin.dat', bin('base'));
          t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n');
        },
        localChange: (t) => {
          t.write('bin.dat', bin('local'));
          t.write('foo.txt', 'l1\nl2\nl3-local\nl4\nl5\n');
        },
      }),
    );
    const result = await scan(scenario, readBlob, ['bin.dat', 'foo.txt']);
    expect(result.skipped).toEqual(['bin.dat']);
    // The text file is still counted despite the binary neighbor.
    expect(result.totalConflicts).toBe(1);
    expect(result.files).toEqual([{ path: 'foo.txt', conflicts: 1 }]);
  });
});
