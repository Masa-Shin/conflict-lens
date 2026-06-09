import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  STATE_SCHEMA_VERSION,
  conflictLensStatePath,
  deleteConflictLensState,
  readConflictLensState,
  writeConflictLensState,
  type ConflictLensState,
} from '../../../src/mcp/state-file';

const tmpDirs: string[] = [];

async function makeRepoRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cl-state-'));
  tmpDirs.push(dir);
  // The state file lives under `.git/...`; create that dir so the layout
  // mirrors a real repository.
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function sampleState(repoRoot: string): ConflictLensState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    repoRoot,
    baseBranch: 'origin/main',
    baseTipSha: 'a'.repeat(40),
    mergeBaseSha: 'b'.repeat(40),
    changedFiles: ['src/foo.ts', 'docs/bar.md'],
    remoteName: 'origin',
    generatedAt: '2026-06-08T00:00:00.000Z',
  };
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('conflict-lens state file', () => {
  it('places the file under .git/conflict-lens', async () => {
    const root = await makeRepoRoot();
    expect(conflictLensStatePath(root)).toBe(
      path.join(root, '.git', 'conflict-lens', 'state.json'),
    );
  });

  it('round-trips a written snapshot', async () => {
    const root = await makeRepoRoot();
    const state = sampleState(root);
    await writeConflictLensState(state);
    expect(await readConflictLensState(root)).toEqual(state);
  });

  it('writes atomically, leaving no temp file behind', async () => {
    const root = await makeRepoRoot();
    await writeConflictLensState(sampleState(root));
    const entries = fs.readdirSync(path.join(root, '.git', 'conflict-lens'));
    expect(entries).toEqual(['state.json']);
  });

  it('overwrites a previous snapshot', async () => {
    const root = await makeRepoRoot();
    await writeConflictLensState(sampleState(root));
    const updated: ConflictLensState = {
      ...sampleState(root),
      baseBranch: null,
      baseTipSha: null,
      mergeBaseSha: null,
      changedFiles: [],
    };
    await writeConflictLensState(updated);
    expect(await readConflictLensState(root)).toEqual(updated);
  });

  it('returns null when no snapshot exists', async () => {
    const root = await makeRepoRoot();
    expect(await readConflictLensState(root)).toBeNull();
  });

  it('returns null for a corrupt snapshot', async () => {
    const root = await makeRepoRoot();
    const target = conflictLensStatePath(root);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '{ not json', 'utf8');
    expect(await readConflictLensState(root)).toBeNull();
  });

  it('deletes the snapshot and is a no-op when already gone', async () => {
    const root = await makeRepoRoot();
    await writeConflictLensState(sampleState(root));
    await deleteConflictLensState(root);
    expect(await readConflictLensState(root)).toBeNull();
    // A second delete must not throw.
    await deleteConflictLensState(root);
  });
});
