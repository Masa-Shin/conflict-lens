import {
  listRemoteBranches,
  validateBaseBranch,
  type BaseBranchValidation,
  type RemoteBranchListing,
} from './branches';
import type { GitRunner } from './runner';

export type BaseBranchSource =
  | 'configured'
  | 'symbolic-ref'
  | 'default-main'
  | 'default-master';

export type BaseBranchResolution =
  | {
      readonly kind: 'ok';
      readonly baseBranch: string;
      readonly source: BaseBranchSource;
      readonly listing: RemoteBranchListing;
    }
  | {
      readonly kind: 'configured-invalid';
      readonly configured: string;
      readonly validation: BaseBranchValidation;
      readonly listing: RemoteBranchListing;
    }
  | {
      readonly kind: 'none-found';
      readonly listing: RemoteBranchListing;
    };

export interface ResolveBaseBranchParams {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  /** Current value from `conflictLens.baseBranch`. `undefined` means unset. */
  readonly configured: string | undefined;
  /**
   * Remote name used as the prefix for auto-detection candidates
   * (`<remoteName>/HEAD` symbolic-ref, `<remoteName>/main`,
   * `<remoteName>/master`). Read from `conflictLens.remoteName`; the
   * caller is expected to fall back to `'origin'` when the setting is
   * empty.
   */
  readonly remoteName: string;
}

/**
 * Decide the effective base branch for a repository:
 *
 *   1. The user-configured `conflictLens.baseBranch` value, if it validates strictly.
 *   2. `git symbolic-ref refs/remotes/<remoteName>/HEAD` if it points to a
 *      remote-tracking ref we have locally.
 *   3. `<remoteName>/main` if present in the local listing.
 *   4. `<remoteName>/master` if present in the local listing.
 *
 * `<remoteName>` defaults to `origin` but can be overridden through
 * `conflictLens.remoteName` so that users whose clone was made with
 * `--origin upstream` (or who renamed origin) still get detection.
 *
 * If the configured value is set but fails validation, we surface
 * `configured-invalid` so the caller can choose between a warning + Select
 * Base Branch prompt and falling through to detection (this function does
 * NOT auto-fall-through, to avoid silently using a different branch than
 * the one the user committed to the repo).
 */
export async function resolveBaseBranch(
  params: ResolveBaseBranchParams,
): Promise<BaseBranchResolution> {
  const { runner, repoRootPath, configured, remoteName } = params;
  const listing = await listRemoteBranches(runner, repoRootPath);

  if (configured !== undefined && configured.length > 0) {
    const validation = await validateBaseBranch(configured, {
      runner,
      repoRootPath,
      listing,
    });
    if (validation.kind === 'ok') {
      return { kind: 'ok', baseBranch: configured, source: 'configured', listing };
    }
    return { kind: 'configured-invalid', configured, validation, listing };
  }

  // Priority 2: symbolic-ref refs/remotes/<remoteName>/HEAD
  const symRef = await runner.run(
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`],
    { cwd: repoRootPath },
  );
  if (symRef.exitCode === 0) {
    const candidate = symRef.stdout.trim();
    if (listing.branches.includes(candidate)) {
      return { kind: 'ok', baseBranch: candidate, source: 'symbolic-ref', listing };
    }
  }

  // Priority 3 / 4
  const mainCandidate = `${remoteName}/main`;
  if (listing.branches.includes(mainCandidate)) {
    return { kind: 'ok', baseBranch: mainCandidate, source: 'default-main', listing };
  }
  const masterCandidate = `${remoteName}/master`;
  if (listing.branches.includes(masterCandidate)) {
    return { kind: 'ok', baseBranch: masterCandidate, source: 'default-master', listing };
  }

  return { kind: 'none-found', listing };
}
