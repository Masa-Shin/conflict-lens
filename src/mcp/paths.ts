import * as path from 'node:path';

/**
 * Normalize an incoming path (absolute or relative, any separator) to a
 * repo-relative POSIX path, NFC-normalized to match git's output. Returns
 * `null` when the path is the repo root itself or resolves outside the
 * repository.
 */
export function toRepoRelativePosix(
  inputPath: string,
  repoRoot: string,
  cwd: string,
): string | null {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  const rel = path.relative(repoRoot, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/').normalize('NFC');
}

/**
 * Whether a repo-relative POSIX path is in the base-changed set. Both sides
 * are NFC-normalized so a macOS NFD path still matches git's NFC output.
 */
export function isChangedOnBase(relPosix: string, changedFiles: readonly string[]): boolean {
  const target = relPosix.normalize('NFC');
  return changedFiles.some((f) => f.normalize('NFC') === target);
}
