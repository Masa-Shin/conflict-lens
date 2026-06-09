import * as fs from 'node:fs';
import * as path from 'node:path';

/** realpath if it resolves, otherwise the input unchanged (for missing paths). */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Normalize an incoming path (absolute or relative, any separator) to a
 * repo-relative POSIX path, NFC-normalized to match git's output. Returns
 * `null` when the path is the repo root itself or resolves outside the
 * repository.
 *
 * `repoRoot` is already canonical (the extension records it via realpath), so
 * the cwd and the input's directory are canonicalized too — otherwise a
 * workspace opened through a symlink would make a repo-internal file look
 * external. The basename is left as-is because the file may not exist yet.
 */
export function toRepoRelativePosix(
  inputPath: string,
  repoRoot: string,
  cwd: string,
): string | null {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(canonical(cwd), inputPath);
  const canonAbs = path.join(canonical(path.dirname(abs)), path.basename(abs));
  const rel = path.relative(repoRoot, canonAbs);
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
