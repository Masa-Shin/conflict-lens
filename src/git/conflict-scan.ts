import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { normalizeForDiff } from '../util/text';
import type { BlobReader } from './blob';
import { runMergeFile } from './merge-file';
import type { GitRunner } from './runner';

export interface ConflictScanFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Number of conflicting places in this file (≥ 1). */
  readonly conflicts: number;
}

export interface ConflictScanResult {
  /** Sum of conflicting places across all files. */
  readonly totalConflicts: number;
  /** Files with at least one conflict, most conflicts first. */
  readonly files: readonly ConflictScanFile[];
  /** Files that could not be merged as text (e.g. binary); not counted. */
  readonly skipped: readonly string[];
}

export interface ConflictScanParams {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly mergeBaseSha: string;
  readonly baseTipSha: string;
  /**
   * Repo-relative POSIX paths the base branch changed. Only these can
   * conflict, so they bound the scan.
   */
  readonly changedFiles: readonly string[];
  readonly readBlob: BlobReader;
}

/**
 * Count the places where merging the base branch into the working tree
 * would conflict. A conflict needs both sides to have touched the file, so
 * the scan first intersects the base-changed set with the locally-touched
 * set (two git calls, independent of file count); only the intersection —
 * usually a handful of files — gets a three-way merge (`git merge-file`)
 * with the merge-base blob as the ancestor, the base tip blob as theirs,
 * and the on-disk file as ours, the same primitive Preview Conflict uses.
 * Whole-file cases (modify/delete and add/add with different content)
 * count as one place each.
 *
 * The merged files run sequentially: the scan follows an explicit user
 * action (the Fetch click) and is latency-tolerant, so we avoid a burst of
 * concurrent `git merge-file` spawns and temp dirs.
 */
export async function scanBaseConflicts(params: ConflictScanParams): Promise<ConflictScanResult> {
  // If the prefilter itself fails (unexpected git error), fall back to
  // scanning every base-changed file — slower but equally correct.
  let locallyTouched: ReadonlySet<string> | undefined;
  try {
    locallyTouched = await listLocallyTouched(params);
  } catch {
    locallyTouched = undefined;
  }

  const files: ConflictScanFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const relPosix of params.changedFiles) {
    // Identical to the merge-base on our side → the base's change applies
    // cleanly. No blob reads, no merge.
    if (locallyTouched && !locallyTouched.has(relPosix)) continue;
    let conflicts: number;
    try {
      conflicts = await scanFile(params, relPosix);
    } catch {
      // `git merge-file` refuses binary content with a fatal exit, and other
      // per-file failures are equally unmergeable-as-text. Skip rather than
      // abort the whole scan; the caller reports skipped files in the log.
      skipped.push(relPosix);
      continue;
    }
    if (conflicts > 0) {
      files.push({ path: relPosix, conflicts });
      total += conflicts;
    }
  }
  files.sort((a, b) => b.conflicts - a.conflicts || a.path.localeCompare(b.path));
  return { totalConflicts: total, files, skipped };
}

/**
 * The repo-relative paths whose content differs from the merge-base on our
 * side: commits on HEAD since the merge-base, staged and unstaged edits,
 * deletions (`git diff`), plus untracked files (`git ls-files --others`,
 * which an add/add conflict needs). Ignored files are not listed — a base
 * merge would flag those as "untracked file would be overwritten" rather
 * than produce a content conflict.
 */
async function listLocallyTouched(params: ConflictScanParams): Promise<ReadonlySet<string>> {
  const { runner, repoRootPath, mergeBaseSha } = params;
  const common = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;
  const [diff, untracked] = await Promise.all([
    runner.run(
      ['diff', '--name-only', '-z', '--no-renames', ...common, '--end-of-options', mergeBaseSha],
      { cwd: repoRootPath },
    ),
    runner.run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRootPath }),
  ]);
  if (diff.exitCode !== 0) {
    throw new Error(`git diff --name-only (local side) exited with ${diff.exitCode}`);
  }
  if (untracked.exitCode !== 0) {
    throw new Error(`git ls-files --others exited with ${untracked.exitCode}`);
  }
  const set = new Set<string>();
  for (const out of [diff.stdout, untracked.stdout]) {
    for (const p of out.split('\0')) if (p.length > 0) set.add(p);
  }
  return set;
}

async function scanFile(params: ConflictScanParams, relPosix: string): Promise<number> {
  const { runner, repoRootPath, mergeBaseSha, baseTipSha, readBlob } = params;
  const [ancestor, theirs, ours] = await Promise.all([
    blobOrNull(readBlob, mergeBaseSha, relPosix),
    blobOrNull(readBlob, baseTipSha, relPosix),
    workingFileOrNull(repoRootPath, relPosix),
  ]);

  if (ours === null) {
    // No local file. The base's change lands cleanly unless we deleted a
    // file the base modified (delete/modify).
    return ancestor !== null && theirs !== null && !sameText(ancestor, theirs) ? 1 : 0;
  }
  if (theirs === null) {
    // The base deleted the file; local edits clash with that (modify/delete).
    return ancestor !== null && !sameText(ours, ancestor) ? 1 : 0;
  }
  // Already identical to the base side — nothing to merge.
  if (sameText(ours, theirs)) return 0;
  // Our side never diverged from the ancestor — the base's change applies
  // cleanly. Mostly redundant with the locally-touched prefilter, but it
  // keeps the fallback path (prefilter failed) from spawning merge-file for
  // every untouched file.
  if (ancestor !== null && sameText(ours, ancestor)) return 0;
  // Both sides have content. A missing ancestor (both sides added the file)
  // degrades to an empty ancestor, which merge-file reports as one big
  // add/add conflict.
  const { conflictCount } = await runMergeFile(runner, repoRootPath, ours, ancestor ?? '', theirs);
  return conflictCount;
}

function sameText(a: string, b: string): boolean {
  return normalizeForDiff(a) === normalizeForDiff(b);
}

/**
 * Read a blob, mapping "path does not exist at that commit" to `null`.
 * Matches both the batch reader's "not found" and `git show`'s "does not
 * exist" phrasing; other failures (too large, dispose) propagate so the
 * file is skipped, not misread as deleted.
 */
async function blobOrNull(
  readBlob: BlobReader,
  ref: string,
  relPosix: string,
): Promise<string | null> {
  try {
    return await readBlob(ref, relPosix);
  } catch (err) {
    if (
      err instanceof Error &&
      /not found|does not exist|exists on disk, but not in/.test(err.message)
    ) {
      return null;
    }
    throw err;
  }
}

async function workingFileOrNull(repoRoot: string, relPosix: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoRoot, ...relPosix.split('/')), 'utf8');
  } catch {
    return null;
  }
}
