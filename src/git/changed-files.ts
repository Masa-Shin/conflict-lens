import type { GitRunner } from './runner';

/**
 * List the repo-relative paths that the base branch has changed
 * compared to the merge-base with HEAD. This is the file-level
 * counterpart of the weak-highlight line ranges: each path in the
 * result is a file the user will want to know about because the base
 * side touched it.
 *
 * Flags:
 *  - `--merge-base HEAD <base>`: diff from merge-base(HEAD, base) to
 *    base, so the output is purely base-side activity. Files HEAD-only
 *    changed are not included — the user already knows about those.
 *  - `--name-only`: paths only; we don't need the patch body.
 *  - `-z`: NUL-separated, so paths containing spaces / newlines survive.
 *  - `--no-renames`: emit a base-side rename as a delete + add (two
 *    entries) so that whichever name still exists in HEAD ends up
 *    decorated. The default rename-detection would collapse the rename
 *    to a single entry under the new name, which may not exist on the
 *    HEAD side yet.
 *  - `--no-ext-diff` / `--no-textconv`: refuse user-defined drivers.
 *  - `--no-color`: deterministic output.
 *  - `--end-of-options`: hardening against ref names beginning with `--`.
 *
 * Throws if the command exits non-zero. The callers depend on the
 * distinction between "the base genuinely changed no files" (empty
 * result) and "we could not determine the changed set" (failure): on
 * failure the file-decoration pipeline must keep its previous state and
 * fall back to the per-file diff rather than treat every file as
 * unchanged and drop the weak highlight. An empty array is therefore
 * reserved for a successful run that found nothing.
 */
export async function listChangedFilesOnBase(
  runner: GitRunner,
  repoRootPath: string,
  baseBranch: string,
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const result = await runner.run(
    [
      'diff',
      '--merge-base',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--end-of-options',
      'HEAD',
      baseBranch,
    ],
    { cwd: repoRootPath, signal: options.signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff --name-only (base side) for ${baseBranch} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split('\0').filter((s) => s.length > 0);
}
