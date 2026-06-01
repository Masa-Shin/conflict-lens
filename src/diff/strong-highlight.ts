import type { BlobReader } from '../git/blob';
import { runMergeFile } from '../git/merge-file';
import type { GitRunner } from '../git/runner';
import {
  parseConflictMarkers,
  type ConflictRange,
} from './conflict-markers';

export type StrongHighlightRange = ConflictRange;

export interface ComputeStrongHighlightsParams {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  /**
   * Tip of the base branch (e.g. `origin/main`). Used as `theirs` in the
   * trial merge: this is the side the user will eventually merge / rebase
   * onto.
   */
  readonly baseBranch: string;
  /**
   * Merge-base SHA between HEAD and `baseBranch`. The blob at this
   * commit is used as the merge `base`.
   */
  readonly mergeBaseSha: string;
  readonly relativeFilePath: string;
  /**
   * The editor buffer text. Passed as `ours` to merge-file so that the
   * resulting conflict ranges are already in buffer-local line numbers —
   * no extra mapping step is required.
   *
   * Trade-off: this predicts conflicts including any edits the user has
   * made in the buffer (good UX), but it does *not* match `git merge`'s
   * exact behavior, which always merges committed states. The
   * difference disappears the moment the user commits.
   */
  readonly oursContent: string;
  readonly readBlob: BlobReader;
  readonly signal?: AbortSignal;
}

/**
 * Compute the strong-highlight (predicted conflict) line ranges for a
 * single file, aligned to the buffer.
 *
 * Pipeline:
 *   1. Fetch the merge-base and base-branch blobs in parallel.
 *   2. Run `git merge-file -p --diff3` with the buffer text as `ours`.
 *   3. Parse the marker output into ours-coordinate ranges.
 *
 * Returns `[]` for any condition that makes a strong highlight
 * ill-defined — missing blob on one side (new / deleted file), the
 * merge-file run reporting `conflictCount === 0`, etc. The weak
 * highlight still runs in those cases and provides the user-visible
 * "something changed here" signal.
 */
export async function computeStrongHighlights(
  params: ComputeStrongHighlightsParams,
): Promise<StrongHighlightRange[]> {
  const {
    runner,
    repoRootPath,
    baseBranch,
    mergeBaseSha,
    relativeFilePath,
    oursContent,
    readBlob,
    signal,
  } = params;

  // Use allSettled so a missing blob on one side doesn't reject the
  // other read; either way, missing blobs mean we cannot perform a
  // three-way merge for this file.
  const [baseRes, theirsRes] = await Promise.allSettled([
    readBlob(mergeBaseSha, relativeFilePath, { signal }),
    readBlob(baseBranch, relativeFilePath, { signal }),
  ]);
  if (baseRes.status !== 'fulfilled' || theirsRes.status !== 'fulfilled') {
    return [];
  }

  const merged = await runMergeFile(
    runner,
    repoRootPath,
    oursContent,
    baseRes.value,
    theirsRes.value,
    { signal },
  );
  if (merged.conflictCount === 0) return [];
  return parseConflictMarkers(merged.content);
}
