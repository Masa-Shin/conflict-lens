import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { BlobReader } from '../git/blob';
import { runMergeFile } from '../git/merge-file';
import type { GitRunner } from '../git/runner';

/** Read the working-tree file from disk, or `null` if it is not there. */
export async function readWorkingFile(repoRoot: string, relPosix: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoRoot, relPosix.split('/').join(path.sep)), 'utf8');
  } catch {
    return null;
  }
}

/** Read a blob, or `null` when the path does not exist at that commit. */
export async function tryReadBlob(
  readBlob: BlobReader,
  sha: string,
  relPosix: string,
): Promise<string | null> {
  try {
    return await readBlob(sha, relPosix);
  } catch (err) {
    // The batch blob reader throws "... not found" for a missing path; that
    // is an expected answer here (the file was added or deleted on one side).
    if (err instanceof Error && err.message.includes('not found')) return null;
    throw err;
  }
}

export type BaseChangeKind = 'added' | 'deleted' | 'modified' | 'none';

export interface BaseChange {
  /** What the base branch did to the file, relative to the merge-base. */
  readonly change: BaseChangeKind;
  /** The unified diff (merge-base → base tip). Captures whole-file deletion. */
  readonly diff: string;
  readonly truncated: boolean;
}

const DIFF_MAX_LINES = 400;

/**
 * The base branch's own change to one file: the diff from the merge-base to
 * the base tip. This is the authoritative "what the base did" — it is not
 * projected onto the working file, so a whole-file deletion shows up as the
 * entire file removed.
 */
export async function getBaseChange(
  runner: GitRunner,
  repoRoot: string,
  mergeBaseSha: string,
  baseTipSha: string,
  relPosix: string,
  options: { signal?: AbortSignal } = {},
): Promise<BaseChange> {
  const result = await runner.run(
    [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--end-of-options',
      mergeBaseSha,
      baseTipSha,
      '--',
      relPosix,
    ],
    { cwd: repoRoot, signal: options.signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff (base change) for ${relPosix} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  const patch = result.stdout;
  let change: BaseChangeKind = 'none';
  if (patch.length === 0) change = 'none';
  else if (/^deleted file mode/m.test(patch)) change = 'deleted';
  else if (/^new file mode/m.test(patch)) change = 'added';
  else change = 'modified';

  const lines = patch.split('\n');
  const truncated = lines.length > DIFF_MAX_LINES;
  const diff = truncated
    ? `${lines.slice(0, DIFF_MAX_LINES).join('\n')}\n... (diff truncated; ${lines.length - DIFF_MAX_LINES} more lines) ...`
    : patch;
  return { change, diff, truncated };
}

export type ConflictKind =
  | 'none'
  | 'content'
  | 'add_add'
  | 'base_deleted_local_modified'
  | 'local_deleted_base_modified';

export interface ConflictRegion {
  /** 1-based line range in the merged output. */
  readonly startLine: number;
  readonly endLine: number;
  /** The conflict block, including the `<<<<<<<` / `=======` / `>>>>>>>` markers. */
  readonly text: string;
}

export interface MergeConflict {
  readonly conflicting: boolean;
  readonly kind: ConflictKind;
  readonly regions: ConflictRegion[];
}

const CLEAN: MergeConflict = { conflicting: false, kind: 'none', regions: [] };

/**
 * Whether merging the base branch into the working version of one file would
 * conflict, decided by an actual three-way merge (merge-base as ancestor,
 * base tip as theirs, the on-disk file as ours). Handles modify/delete by
 * comparing presence on each side; runs `git merge-file` for the content case.
 */
export async function getMergeConflict(
  runner: GitRunner,
  readBlob: BlobReader,
  repoRoot: string,
  mergeBaseSha: string,
  baseTipSha: string,
  relPosix: string,
  options: { signal?: AbortSignal } = {},
): Promise<MergeConflict> {
  const [ancestor, theirs, ours] = await Promise.all([
    tryReadBlob(readBlob, mergeBaseSha, relPosix),
    tryReadBlob(readBlob, baseTipSha, relPosix),
    readWorkingFile(repoRoot, relPosix),
  ]);

  // Base deleted the file.
  if (ancestor !== null && theirs === null) {
    if (ours === null || ours === ancestor) return CLEAN; // you removed it too / left it unchanged
    return { conflicting: true, kind: 'base_deleted_local_modified', regions: [] };
  }
  // You deleted the file, base still has it.
  if (ancestor !== null && ours === null && theirs !== null) {
    return theirs === ancestor
      ? CLEAN
      : { conflicting: true, kind: 'local_deleted_base_modified', regions: [] };
  }
  // Both sides have content → real three-way merge (ancestor null = add/add).
  if (ours !== null && theirs !== null) {
    const { content, conflictCount } = await runMergeFile(
      runner,
      repoRoot,
      ours,
      ancestor ?? '',
      theirs,
      { signal: options.signal },
    );
    if (conflictCount === 0) return CLEAN;
    return {
      conflicting: true,
      kind: ancestor === null ? 'add_add' : 'content',
      regions: parseConflictRegions(content),
    };
  }
  // The base did not change this file in a way that can conflict.
  return CLEAN;
}

/** Extract the `<<<<<<<` … `>>>>>>>` blocks from merged output. */
export function parseConflictRegions(merged: string): ConflictRegion[] {
  const lines = merged.split('\n');
  const regions: ConflictRegion[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) {
      start = i;
    } else if (lines[i].startsWith('>>>>>>>') && start !== -1) {
      regions.push({
        startLine: start + 1,
        endLine: i + 1,
        text: lines.slice(start, i + 1).join('\n'),
      });
      start = -1;
    }
  }
  return regions;
}
