import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCatFileBatch, createBlobReaderFromBatch } from '../../../src/git/cat-file-batch';
import { createGitRunner } from '../../../src/git/runner';
import {
  STATE_SCHEMA_VERSION,
  writeConflictLensState,
  type ConflictLensState,
} from '../../../src/mcp/state-file';
import {
  getBaseChanges,
  getConflicts,
  listBaseChanges,
  listConflicts,
  type ToolContext,
} from '../../../src/mcp/tools';
import { setupScenario, type Scenario } from './repo-fixture';

const runner = createGitRunner('git');
const FIVE = 'l1\nl2\nl3\nl4\nl5\n';

const open: { scenario: Scenario; batch: GitCatFileBatch }[] = [];

async function start(
  scenario: Scenario,
  changedFiles: string[],
  baseOverrides: Partial<ConflictLensState> = {},
): Promise<ToolContext> {
  const batch = new GitCatFileBatch({ gitPath: 'git', cwd: scenario.repo });
  open.push({ scenario, batch });
  await writeConflictLensState({
    schemaVersion: STATE_SCHEMA_VERSION,
    repoRoot: scenario.repo,
    baseBranch: scenario.baseBranch,
    baseTipSha: scenario.baseTipSha,
    mergeBaseSha: scenario.mergeBaseSha,
    changedFiles,
    remoteName: 'origin',
    generatedAt: '2026-06-08T00:00:00.000Z',
    ...baseOverrides,
  });
  return { cwd: scenario.repo, runner, getReadBlob: () => createBlobReaderFromBatch(batch) };
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

describe('listBaseChanges', () => {
  it('lists the changed files', async () => {
    const ctx = await start(
      setupScenario({ root: { 'foo.txt': FIVE }, baseChange: (t) => t.remove('foo.txt') }),
      ['foo.txt'],
    );
    expect(await listBaseChanges(ctx)).toEqual({
      status: 'ok',
      baseBranch: 'main',
      files: ['foo.txt'],
    });
  });

  it('returns unresolved without a state file', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-nostate-')));
    try {
      const ctx: ToolContext = {
        cwd: empty,
        runner,
        getReadBlob: () => {
          throw new Error('unused');
        },
      };
      expect((await listBaseChanges(ctx)) as { status: string }).toMatchObject({
        status: 'unresolved',
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('getBaseChanges', () => {
  it('reports a base-side deletion in full (the layout.tsx case)', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'layout.tsx': FIVE },
        baseChange: (t) => t.remove('layout.tsx'),
        localChange: (t) => t.write('layout.tsx', 'l1\nl2\nEDITED\nl4\nl5\n'),
      }),
      ['layout.tsx'],
    );
    const result = (await getBaseChanges(ctx, 'layout.tsx')) as {
      status: string;
      change: string;
      diff: string;
    };
    expect(result.status).toBe('ok');
    expect(result.change).toBe('deleted');
    expect(result.diff).toContain('deleted file mode');
    expect(result.diff.length).toBeGreaterThan(0);
  });

  it('returns unchanged for a file the base did not touch', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'foo.txt': FIVE, 'other.txt': 'x\n' },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
      ['foo.txt'],
    );
    expect((await getBaseChanges(ctx, 'other.txt')) as { status: string }).toMatchObject({
      status: 'unchanged',
    });
  });

  it('rejects a path outside the repository', async () => {
    const ctx = await start(
      setupScenario({ root: { 'foo.txt': FIVE }, baseChange: (t) => t.remove('foo.txt') }),
      ['foo.txt'],
    );
    expect((await getBaseChanges(ctx, '../escape.ts')) as { status: string }).toMatchObject({
      status: 'invalid_path',
    });
  });
});

describe('listConflicts / getConflicts', () => {
  it('flags base-deleted + locally-edited as a conflict', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'layout.tsx': FIVE },
        baseChange: (t) => t.remove('layout.tsx'),
        localChange: (t) => t.write('layout.tsx', 'l1\nl2\nEDITED\nl4\nl5\n'),
      }),
      ['layout.tsx'],
    );
    expect(await listConflicts(ctx)).toEqual({
      status: 'ok',
      baseBranch: 'main',
      files: [{ path: 'layout.tsx', kind: 'base_deleted_local_modified' }],
    });
    expect((await getConflicts(ctx, 'layout.tsx')) as Record<string, unknown>).toMatchObject({
      status: 'ok',
      conflicting: true,
      kind: 'base_deleted_local_modified',
      conflicts: [],
      note: expect.stringContaining('deleted'),
    });
  });

  it('returns the conflict regions for a content clash', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
        localChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-local\nl4\nl5\n'),
      }),
      ['foo.txt'],
    );
    const result = (await getConflicts(ctx, 'foo.txt')) as {
      conflicting: boolean;
      conflicts: unknown[];
    };
    expect(result.conflicting).toBe(true);
    expect(result.conflicts).toHaveLength(1);
  });

  it('is clean when only the base changed the file', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
      ['foo.txt'],
    );
    expect((await getConflicts(ctx, 'foo.txt')) as { conflicting: boolean }).toMatchObject({
      conflicting: false,
    });
    expect(await listConflicts(ctx)).toEqual({ status: 'ok', baseBranch: 'main', files: [] });
  });

  it('treats a file the base did not change as no conflict, without git', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'foo.txt': FIVE, 'other.txt': 'x\n' },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
      ['foo.txt'],
    );
    expect((await getConflicts(ctx, 'other.txt')) as { conflicting: boolean }).toMatchObject({
      conflicting: false,
    });
  });
});
