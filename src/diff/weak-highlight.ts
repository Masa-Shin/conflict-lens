import type { BlobReader } from '../git/blob';
import { runBaseDiff, type DiffHunk } from '../git/diff';
import type { GitRunner } from '../git/runner';
import { buildLineMapping } from './mapping';

/**
 * A single weak-highlight target on the right side (HEAD or buffer).
 * Lines are 1-based, inclusive.
 *
 * `insertion` is `true` for pure additions on the base side (oldCount=0).
 * The corresponding lines do not exist on the right; UI code should render
 * them as a gutter marker on the nearest surviving line.
 */
export interface WeakHighlightRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly insertion: boolean;
}

/**
 * Result of the base-side work: the hunk list (in merge-base coordinates)
 * plus the merge-base blob text. Both are functions of
 * `(baseBranch, mergeBaseSha, relativeFilePath)` only — completely
 * independent of the editor buffer — so callers can cache this across
 * keystrokes and only re-run the buffer-dependent mapping step.
 */
export interface BaseDiff {
  readonly hunks: readonly DiffHunk[];
  readonly leftContent: string;
}

export interface LoadBaseDiffParams {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly baseBranch: string;
  readonly mergeBaseSha: string;
  readonly relativeFilePath: string;
  readonly readBlob: BlobReader;
  readonly signal?: AbortSignal;
}

export interface ComputeWeakHighlightsParams extends LoadBaseDiffParams {
  /**
   * Authoritative right-side content. Callers pass the current editor
   * buffer (`document.getText()`) so that highlights follow user edits in
   * unsaved files; passing the HEAD blob would be wrong as soon as the
   * user inserts or deletes a line. For untracked-on-disk files the
   * caller can read the disk bytes; both routes use this same path.
   */
  readonly rightContent: string;
}

/**
 * Run the git-side half of the pipeline: fetch the base-side hunk list
 * and the merge-base blob. Both depend only on
 * `(baseBranch, mergeBaseSha, relativeFilePath)` and are safe to cache
 * for the lifetime of those three values — typing in the editor never
 * invalidates the result.
 */
export async function loadBaseDiff(params: LoadBaseDiffParams): Promise<BaseDiff> {
  const { runner, repoRootPath, baseBranch, mergeBaseSha, relativeFilePath, readBlob, signal } =
    params;

  const hunks = await runBaseDiff(
    runner,
    repoRootPath,
    mergeBaseSha,
    baseBranch,
    relativeFilePath,
    { signal },
  );
  if (hunks.length === 0) {
    return { hunks, leftContent: '' };
  }
  const leftContent = await readBlob(mergeBaseSha, relativeFilePath, { signal });
  return { hunks, leftContent };
}

/**
 * Run the buffer-dependent half of the pipeline against a pre-fetched
 * `BaseDiff`. Pure in-memory work — `buildLineMapping` plus a per-hunk
 * coordinate translation. Cheap enough to run on every keystroke.
 */
export function applyBaseDiffToBuffer(
  baseDiff: BaseDiff,
  rightContent: string,
): WeakHighlightRange[] {
  if (baseDiff.hunks.length === 0) return [];
  const mapping = buildLineMapping(baseDiff.leftContent, rightContent);
  const ranges: WeakHighlightRange[] = [];
  for (const hunk of baseDiff.hunks) {
    const range = mapHunkToRight(hunk, mapping.toRight, mapping.rightLineCount);
    if (range) ranges.push(range);
  }
  return ranges;
}

/**
 * Convenience composition of `loadBaseDiff` + `applyBaseDiffToBuffer`
 * for callers that do not maintain their own base-diff cache. The
 * decoration coordinator splits the two halves so that typing only
 * triggers the in-memory part; tests and one-shot callers can keep
 * using this one-stop function.
 *
 * Pipeline (spec §3.1.1):
 *   1. base-side diff (hunk headers, merge-base coordinates)
 *   2. fetch merge-base blob via `git show`
 *   3. build a merge-base → right-side line mapping via in-memory diff
 *   4. translate each hunk's merge-base line range to right-side coordinates
 *
 * Hunks whose merge-base lines do not survive into the right side
 * (deleted by the user's own changes or unsaved edits) are dropped
 * silently.
 */
export async function computeWeakHighlights(
  params: ComputeWeakHighlightsParams,
): Promise<WeakHighlightRange[]> {
  const baseDiff = await loadBaseDiff(params);
  return applyBaseDiffToBuffer(baseDiff, params.rightContent);
}

/**
 * Convert a single hunk (merge-base coordinates) into a HEAD-coordinate
 * highlight range. Exported for unit testing.
 *
 * Three cases (spec §3.2.1):
 *  - `oldCount === 0` (pure addition): the base inserted lines that do
 *    not exist on the right. Anchor on the surviving line that immediately
 *    follows the insertion point (`oldStart` itself for `@@ -X,0 ...` per
 *    git's convention of pointing one line *before* the insertion).
 *  - `oldCount > 0`: map first and last affected merge-base lines through
 *    the line map. If either endpoint was deleted on the right, fall back
 *    to whichever endpoint survived; if neither did, drop the hunk.
 */
export function mapHunkToRight(
  hunk: DiffHunk,
  toRight: (leftLine: number) => number | undefined,
  rightLineCount: number,
): WeakHighlightRange | undefined {
  if (hunk.oldCount === 0) {
    // Pure addition: try the next surviving merge-base line first, then
    // fall back to the preceding one.
    const after = toRight(hunk.oldStart + 1);
    if (after !== undefined) {
      return { startLine: after, endLine: after, insertion: true };
    }
    const before = toRight(hunk.oldStart);
    if (before !== undefined) {
      // Insertion conceptually belongs *after* this line; clamp to rightLineCount.
      const anchor = Math.min(before + 1, Math.max(rightLineCount, before));
      return { startLine: anchor, endLine: anchor, insertion: true };
    }
    return undefined;
  }

  const lastOld = hunk.oldStart + hunk.oldCount - 1;
  const startRight = toRight(hunk.oldStart);
  const endRight = toRight(lastOld);
  if (startRight !== undefined && endRight !== undefined) {
    return {
      startLine: Math.min(startRight, endRight),
      endLine: Math.max(startRight, endRight),
      insertion: false,
    };
  }
  // Partial survival: scan inward from each end for the closest surviving line.
  const expandedStart = findSurvivingForward(hunk.oldStart, lastOld, toRight);
  const expandedEnd = findSurvivingBackward(hunk.oldStart, lastOld, toRight);
  if (expandedStart !== undefined && expandedEnd !== undefined) {
    return {
      startLine: Math.min(expandedStart, expandedEnd),
      endLine: Math.max(expandedStart, expandedEnd),
      insertion: false,
    };
  }
  return undefined;
}

function findSurvivingForward(
  from: number,
  to: number,
  toRight: (n: number) => number | undefined,
): number | undefined {
  for (let n = from; n <= to; n++) {
    const r = toRight(n);
    if (r !== undefined) return r;
  }
  return undefined;
}

function findSurvivingBackward(
  from: number,
  to: number,
  toRight: (n: number) => number | undefined,
): number | undefined {
  for (let n = to; n >= from; n--) {
    const r = toRight(n);
    if (r !== undefined) return r;
  }
  return undefined;
}
