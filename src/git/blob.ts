import type { GitRunner } from './runner';

/**
 * Fetch the contents of `<ref>:<path>` as a UTF-8 string.
 *
 * `git show <ref>:<path>` returns raw blob bytes; smudge / textconv are
 * *not* applied to this form, so `--no-textconv` is unnecessary here
 * (spec §4.1 注記 "git show は blob 取得用途で textconv は無関係").
 *
 * Phase 7 will replace direct spawns with the long-lived
 * `git cat-file --batch` helper for hot-path performance. Until then, each
 * call shells out a fresh process.
 */
export async function showBlob(
  runner: GitRunner,
  repoRootPath: string,
  ref: string,
  relativeFilePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const result = await runner.run(
    ['show', '--end-of-options', `${ref}:${relativeFilePath}`],
    { cwd: repoRootPath, signal: options.signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git show ${ref}:${relativeFilePath} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}
