import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMergeFile } from '../../../src/git/merge-file';
import { createGitRunner } from '../../../src/git/runner';

const runner = createGitRunner('git');

describe('runMergeFile (integration)', () => {
  let repo: string;

  beforeAll(() => {
    // merge-file does not need a repository, but we still pass a cwd to
    // keep the runner's contract honest.
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-mf-cwd-')));
  });

  afterAll(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('returns clean output when only one side changes', async () => {
    const result = await runMergeFile(runner, repo, 'A\nB\nC\n', 'A\nB\nC\n', 'A\nB-theirs\nC\n');
    expect(result.conflictCount).toBe(0);
    expect(result.content).toBe('A\nB-theirs\nC\n');
  });

  it('returns standard conflict markers when both sides modify the same line', async () => {
    const result = await runMergeFile(
      runner,
      repo,
      'A\nB-ours\nC\n',
      'A\nB\nC\n',
      'A\nB-theirs\nC\n',
    );
    expect(result.conflictCount).toBeGreaterThan(0);
    expect(result.content).toContain('<<<<<<< ours');
    expect(result.content).toContain('=======');
    expect(result.content).toContain('>>>>>>> theirs');
    expect(result.content).toContain('B-ours');
    expect(result.content).toContain('B-theirs');
    // We deliberately stopped passing --diff3, so the base section
    // and its `||||||| base` divider should NOT appear.
    expect(result.content).not.toContain('||||||| base');
  });

  it('emits an empty ours section when ours deletes a line that theirs modifies', async () => {
    const result = await runMergeFile(runner, repo, 'A\nC\n', 'A\nB\nC\n', 'A\nB-theirs\nC\n');
    expect(result.conflictCount).toBeGreaterThan(0);
    // The "ours" section between <<<<<<< and ======= should have no
    // lines because ours deleted that line.
    const lines = result.content.split('\n');
    const startIdx = lines.findIndex((l) => l === '<<<<<<< ours');
    const midIdx = lines.findIndex((l) => l === '=======');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(midIdx).toBeGreaterThan(startIdx);
    const oursSection = lines.slice(startIdx + 1, midIdx);
    expect(oursSection).toEqual([]);
  });

  it('treats identical inputs as a no-op', async () => {
    const text = 'identical\ncontent\nblock\n';
    const result = await runMergeFile(runner, repo, text, text, text);
    expect(result.conflictCount).toBe(0);
    expect(result.content).toBe(text);
  });

  it('parallel calls do not collide on tmpdir names', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runMergeFile(runner, repo, `ours-${i}\n`, `base-${i}\n`, `theirs-${i}\n`),
      ),
    );
    // Each call had three differing inputs so each conflicts.
    for (const r of results) {
      expect(r.conflictCount).toBeGreaterThan(0);
    }
  });
});
