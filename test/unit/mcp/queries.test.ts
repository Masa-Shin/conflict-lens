import { afterEach, describe, expect, it } from 'vitest';

import { GitCatFileBatch, createBlobReaderFromBatch } from '../../../src/git/cat-file-batch';
import type { BlobReader } from '../../../src/git/blob';
import { createGitRunner } from '../../../src/git/runner';
import { getBaseChange, getMergeConflict } from '../../../src/mcp/queries';
import { setupScenario, type Scenario } from './repo-fixture';

const runner = createGitRunner('git');
const MODIFY = 'l1\nl2\nl3\nl4\nl5\n';

const open: { scenario: Scenario; batch: GitCatFileBatch }[] = [];

function start(scenario: Scenario): { scenario: Scenario; readBlob: BlobReader } {
  const batch = new GitCatFileBatch({ gitPath: 'git', cwd: scenario.repo });
  open.push({ scenario, batch });
  return { scenario, readBlob: createBlobReaderFromBatch(batch) };
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

describe('getBaseChange', () => {
  it('reports a modification with the diff', async () => {
    const { scenario } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
    );
    const change = await getBaseChange(
      runner,
      scenario.repo,
      scenario.mergeBaseSha,
      scenario.baseTipSha,
      'foo.txt',
    );
    expect(change.change).toBe('modified');
    expect(change.diff).toContain('l3-base');
  });

  it('reports a whole-file deletion in full, not empty', async () => {
    const { scenario } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.remove('foo.txt'),
      }),
    );
    const change = await getBaseChange(
      runner,
      scenario.repo,
      scenario.mergeBaseSha,
      scenario.baseTipSha,
      'foo.txt',
    );
    expect(change.change).toBe('deleted');
    expect(change.diff).toContain('deleted file mode');
    expect(change.diff).toContain('-l3');
  });

  it('reports an addition', async () => {
    const { scenario } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.write('new.txt', 'hello\n'),
      }),
    );
    const change = await getBaseChange(
      runner,
      scenario.repo,
      scenario.mergeBaseSha,
      scenario.baseTipSha,
      'new.txt',
    );
    expect(change.change).toBe('added');
  });
});

describe('getMergeConflict', () => {
  const conflict = (scenario: Scenario, readBlob: BlobReader, file = 'foo.txt') =>
    getMergeConflict(
      runner,
      readBlob,
      scenario.repo,
      scenario.mergeBaseSha,
      scenario.baseTipSha,
      file,
    );

  it('finds a content conflict when both sides change the same lines', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
        localChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-local\nl4\nl5\n'),
      }),
    );
    const result = await conflict(scenario, readBlob);
    expect(result.conflicting).toBe(true);
    expect(result.kind).toBe('content');
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].text).toContain('l3-local');
    expect(result.regions[0].text).toContain('l3-base');
  });

  it('is clean when only the base changed the file', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
    );
    const result = await conflict(scenario, readBlob);
    expect(result.conflicting).toBe(false);
  });

  it('flags base-deleted + locally-modified as a conflict', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.remove('foo.txt'),
        localChange: (t) => t.write('foo.txt', 'l1\nl2\nCHANGED\nl4\nl5\n'),
      }),
    );
    const result = await conflict(scenario, readBlob);
    expect(result.conflicting).toBe(true);
    expect(result.kind).toBe('base_deleted_local_modified');
  });

  it('is clean when the base deleted a file you did not touch', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.remove('foo.txt'),
      }),
    );
    const result = await conflict(scenario, readBlob);
    expect(result.conflicting).toBe(false);
  });

  it('flags locally-deleted + base-modified as a conflict', async () => {
    const { scenario, readBlob } = start(
      setupScenario({
        root: { 'foo.txt': MODIFY },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
        localChange: (t) => t.remove('foo.txt'),
      }),
    );
    const result = await conflict(scenario, readBlob);
    expect(result.conflicting).toBe(true);
    expect(result.kind).toBe('local_deleted_base_modified');
  });
});
