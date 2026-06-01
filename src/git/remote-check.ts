import type { GitRunner } from './runner';

export type RemoteCheckResult =
  | { readonly kind: 'up-to-date'; readonly sha: string }
  | {
      readonly kind: 'behind';
      readonly localSha: string;
      readonly remoteSha: string;
    }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Split a `<remote>/<branch>` style ref into its parts. Walks the
 * actual configured remotes (longest-prefix match) so a remote with a
 * slash in its name (e.g. `origin/staging`) does not confuse a base
 * branch like `origin/staging/main`.
 */
export async function splitRemoteBranch(
  runner: GitRunner,
  repoRootPath: string,
  baseBranch: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ remote: string; branch: string } | undefined> {
  const result = await runner.run(['remote'], {
    cwd: repoRootPath,
    signal: options.signal,
  });
  if (result.exitCode !== 0) return undefined;
  const remotes = result.stdout
    .split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter((s) => s.length > 0);
  let best: { remote: string; branch: string } | undefined;
  for (const remote of remotes) {
    const prefix = `${remote}/`;
    if (!baseBranch.startsWith(prefix)) continue;
    if (!best || remote.length > best.remote.length) {
      best = { remote, branch: baseBranch.slice(prefix.length) };
    }
  }
  return best;
}

/**
 * Compare the remote ref `<remote>/refs/heads/<branch>` to the local
 * tracking ref `refs/remotes/<baseBranch>`. Returns:
 *  - `up-to-date`: both sides resolve to the same commit.
 *  - `behind`: the local tracking ref is older than the remote — i.e.
 *    the user would benefit from `git fetch`.
 *  - `error`: the remote was unreachable, ls-remote failed, the local
 *    tracking ref does not exist, etc. Treated as a transient failure
 *    by the caller (retry on next interval).
 *
 * Hardening:
 *  - `--exit-code` on ls-remote so a missing ref returns 2 instead of
 *    silently succeeding with no output.
 *  - `refs/heads/<branch>` instead of bare `<branch>` so a tag with the
 *    same name cannot be picked up.
 *  - `--end-of-options` on both calls so refs starting with `--` cannot
 *    be confused with flags.
 */
export async function checkRemoteForUpdates(
  runner: GitRunner,
  repoRootPath: string,
  baseBranch: string,
  options: { signal?: AbortSignal } = {},
): Promise<RemoteCheckResult> {
  const split = await splitRemoteBranch(runner, repoRootPath, baseBranch, options);
  if (!split) {
    return {
      kind: 'error',
      reason: `Cannot determine remote for "${baseBranch}".`,
    };
  }

  const [remoteResult, localResult] = await Promise.all([
    runner.run(
      [
        'ls-remote',
        '--exit-code',
        '--end-of-options',
        split.remote,
        `refs/heads/${split.branch}`,
      ],
      { cwd: repoRootPath, signal: options.signal },
    ),
    runner.run(
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `refs/remotes/${baseBranch}^{commit}`,
      ],
      { cwd: repoRootPath, signal: options.signal },
    ),
  ]);

  if (remoteResult.exitCode !== 0) {
    return {
      kind: 'error',
      reason:
        remoteResult.stderr.trim() ||
        `git ls-remote exited with ${remoteResult.exitCode}`,
    };
  }
  if (localResult.exitCode !== 0) {
    return {
      kind: 'error',
      reason: `Local ref refs/remotes/${baseBranch} not found.`,
    };
  }

  const remoteSha = remoteResult.stdout.split(/\s/)[0]?.trim();
  const localSha = localResult.stdout.trim();
  if (!remoteSha) {
    return { kind: 'error', reason: 'ls-remote returned empty output' };
  }
  if (remoteSha === localSha) {
    return { kind: 'up-to-date', sha: localSha };
  }
  return { kind: 'behind', localSha, remoteSha };
}
