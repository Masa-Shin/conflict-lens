import { showBlob } from '../git/blob';
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

export interface ComputeWeakHighlightsParams {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly baseBranch: string;
  readonly mergeBaseSha: string;
  /** Path relative to repo root. Must already be validated (spec §3.1.3). */
  readonly relativeFilePath: string;
  readonly signal?: AbortSignal;
}

/**
 * Compute weak-highlight line ranges for the given file, based on the
 * **committed HEAD**. Untracked / buffer-following variants are added in
 * Phase 7.
 *
 * Pipeline (spec §3.1.1):
 *   1. base-side diff (hunk headers, merge-base coordinates)
 *   2. fetch merge-base blob and HEAD blob via `git show`
 *   3. build a merge-base → HEAD line mapping via in-memory diff
 *   4. translate each hunk's merge-base line range to HEAD coordinates
 *
 * Hunks whose merge-base lines do not survive into HEAD (deleted by the
 * user's own changes) are dropped silently; the strong highlight in
 * Phase 8 will catch the real conflicts.
 */
export async function computeWeakHighlights(
  params: ComputeWeakHighlightsParams,
): Promise<WeakHighlightRange[]> {
  const {
    runner,
    repoRootPath,
    baseBranch,
    mergeBaseSha,
    relativeFilePath,
    signal,
  } = params;

  const hunks = await runBaseDiff(runner, repoRootPath, baseBranch, relativeFilePath, { signal });
  if (hunks.length === 0) return [];

  // Both blob fetches can race in parallel; they're independent.
  const [leftContent, rightContent] = await Promise.all([
    showBlob(runner, repoRootPath, mergeBaseSha, relativeFilePath, { signal }),
    showBlob(runner, repoRootPath, 'HEAD', relativeFilePath, { signal }),
  ]);
  const mapping = buildLineMapping(leftContent, rightContent);

  const ranges: WeakHighlightRange[] = [];
  for (const hunk of hunks) {
    const range = mapHunkToRight(hunk, mapping.toRight, mapping.rightLineCount);
    if (range) ranges.push(range);
  }
  return ranges;
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
