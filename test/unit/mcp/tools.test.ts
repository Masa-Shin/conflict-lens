import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createGitRunner } from '../../../src/git/runner';
import {
  STATE_SCHEMA_VERSION,
  writeConflictLensState,
  type ConflictLensState,
} from '../../../src/mcp/state-file';
import {
  getBaseChanges,
  getBaseContext,
  listBaseChanges,
  type ToolContext,
} from '../../../src/mcp/tools';
import { setupScenario, type Scenario } from './repo-fixture';

const runner = createGitRunner('git');
const FIVE = 'l1\nl2\nl3\nl4\nl5\n';

const open: Scenario[] = [];

async function start(
  scenario: Scenario,
  changedFiles: string[],
  overrides: Partial<ConflictLensState> = {},
): Promise<ToolContext> {
  open.push(scenario);
  await writeConflictLensState({
    schemaVersion: STATE_SCHEMA_VERSION,
    repoRoot: scenario.repo,
    baseBranch: scenario.baseBranch,
    baseTipSha: scenario.baseTipSha,
    mergeBaseSha: scenario.mergeBaseSha,
    changedFiles,
    remoteName: 'origin',
    generatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  });
  return { cwd: scenario.repo, runner };
}

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

describe('getBaseContext', () => {
  it('returns the resolved base and endpoints', async () => {
    const scenario = setupScenario({
      root: { 'foo.txt': FIVE },
      baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
    });
    const ctx = await start(scenario, ['foo.txt']);
    expect(await getBaseContext(ctx)).toMatchObject({
      status: 'ok',
      baseBranch: 'main',
      baseTipSha: scenario.baseTipSha,
      mergeBaseSha: scenario.mergeBaseSha,
      remoteName: 'origin',
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
  });

  it('returns unresolved without a state file', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-nostate-')));
    try {
      const ctx: ToolContext = { cwd: empty, runner };
      expect((await getBaseContext(ctx)) as { status: string }).toMatchObject({
        status: 'unresolved',
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not cross into a parent repository for a nested repo without its own state', async () => {
    // Outer repo has a snapshot; a distinct git repo nested inside it does not.
    // Querying from the inner repo must report unresolved, not serve the
    // outer repo's base context against the inner repo's files.
    const outer = setupScenario({
      root: { 'foo.txt': FIVE },
      baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
    });
    await start(outer, ['foo.txt']);
    const inner = path.join(outer.repo, 'inner');
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    const ctx: ToolContext = { cwd: inner, runner };
    expect((await getBaseContext(ctx)) as { status: string }).toMatchObject({
      status: 'unresolved',
    });
  });
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
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
  });

  it('checks membership for specific paths', async () => {
    const ctx = await start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
      ['foo.txt'],
    );
    const result = (await listBaseChanges(ctx, ['foo.txt', 'other.ts'])) as {
      results: { changedOnBase: boolean }[];
    };
    expect(result.results.map((r) => r.changedOnBase)).toEqual([true, false]);
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

  it('reports stale when the recorded endpoints no longer resolve', async () => {
    // Override the base tip with a SHA that does not exist, so the git diff
    // fails — as it would after a gc or rebase dropped the commit.
    const ctx = await start(
      setupScenario({ root: { 'foo.txt': FIVE }, baseChange: (t) => t.remove('foo.txt') }),
      ['foo.txt'],
      { baseTipSha: '0000000000000000000000000000000000000000' },
    );
    expect((await getBaseChanges(ctx, 'foo.txt')) as { status: string }).toMatchObject({
      status: 'stale',
    });
  });
});
