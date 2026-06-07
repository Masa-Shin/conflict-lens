import type { GitRunner } from './runner';

/**
 * Read the contents of `<ref>:<relativePath>` as a UTF-8 string.
 *
 * Returning a function (rather than calling `showBlob` directly) lets
 * the compute pipeline stay agnostic of whether the caller wants the
 * one-shot `git show` route (tests, fallback) or the long-lived
 * `git cat-file --batch` route (production).
 */
export type BlobReader = (
  ref: string,
  relativeFilePath: string,
  options?: { readonly signal?: AbortSignal },
) => Promise<string>;

/**
 * Fetch the contents of `<ref>:<path>` as a UTF-8 string by spawning a
 * one-shot `git show`. `git show <ref>:<path>` returns raw blob bytes;
 * smudge / textconv are *not* applied to this form, so `--no-textconv`
 * is unnecessary here (spec §4.1 注記 "git show は blob 取得用途で
 * textconv は無関係").
 *
 * For production hot paths prefer `createBlobReaderFromBatch` so the
 * spawn cost is amortized across reads.
 */
export async function showBlob(
  runner: GitRunner,
  repoRootPath: string,
  ref: string,
  relativeFilePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const result = await runner.run(['show', '--end-of-options', `${ref}:${relativeFilePath}`], {
    cwd: repoRootPath,
    signal: options.signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git show ${ref}:${relativeFilePath} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Build a `BlobReader` backed by one-shot `git show` spawns. Used by
 * tests and as a fallback when a batch reader is not available.
 */
export function createBlobReaderFromRunner(runner: GitRunner, repoRootPath: string): BlobReader {
  return (ref, relativeFilePath, options) =>
    showBlob(runner, repoRootPath, ref, relativeFilePath, options);
}
