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
  | 'origin-main'
  | 'origin-master';

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
}

/**
 * Decide the effective base branch for a repository, following the priority
 * order in spec §3.1.2:
 *
 *   1. The user-configured value, if it validates strictly.
 *   2. `git symbolic-ref refs/remotes/origin/HEAD` if it points to a
 *      remote-tracking ref we have locally.
 *   3. `origin/main` if present in the local listing.
 *   4. `origin/master` if present in the local listing.
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
  const { runner, repoRootPath, configured } = params;
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

  // Priority 2: symbolic-ref refs/remotes/origin/HEAD
  const symRef = await runner.run(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: repoRootPath },
  );
  if (symRef.exitCode === 0) {
    const candidate = symRef.stdout.trim();
    if (listing.branches.includes(candidate)) {
      return { kind: 'ok', baseBranch: candidate, source: 'symbolic-ref', listing };
    }
  }

  // Priority 3 / 4
  if (listing.branches.includes('origin/main')) {
    return { kind: 'ok', baseBranch: 'origin/main', source: 'origin-main', listing };
  }
  if (listing.branches.includes('origin/master')) {
    return { kind: 'ok', baseBranch: 'origin/master', source: 'origin-master', listing };
  }

  return { kind: 'none-found', listing };
}
