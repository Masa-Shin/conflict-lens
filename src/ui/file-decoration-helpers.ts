import * as path from 'node:path';

/**
 * Repo-relative, forward-slashed path if `absolutePath` is inside
 * `repoRootPath`; `undefined` otherwise (or for the repo root itself,
 * which has no meaningful relative form).
 *
 * Lives in its own helper module so unit tests can exercise it without
 * pulling in the `vscode` module that the coordinator depends on.
 */
export function relativeIfWithin(absolutePath: string, repoRootPath: string): string | undefined {
  const rel = path.relative(repoRootPath, absolutePath);
  if (rel === '') return undefined;
  if (rel.startsWith('..')) return undefined;
  if (path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
