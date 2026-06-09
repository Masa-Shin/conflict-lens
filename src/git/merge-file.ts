import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizeLineEndings } from '../util/text';
import type { GitRunner } from './runner';

export interface MergeFileResult {
  /** Merged content with standard `<<<<<<<` / `=======` / `>>>>>>>` conflict markers. */
  readonly content: string;
  /**
   * Number of conflicts. `git merge-file` returns this as the exit code
   * (capped by git at 127). `0` means a fully clean merge.
   */
  readonly conflictCount: number;
}

/**
 * Run a three-way merge with `git merge-file -p` against the three
 * string contents and return the merged output with standard
 * `<<<<<<<` / `=======` / `>>>>>>>` conflict markers. Used by the
 * Preview Conflict command to show what `git merge` itself would write.
 *
 * `git merge-file` only accepts file paths, so the three contents are
 * written into a single per-call tmpdir and removed in `finally`. On
 * 2.44+ git there is an `--object-id` mode that avoids temp files, but
 * supporting it would push the minimum supported version up and force
 * a dual-path implementation; the disk write is cheap (tmpfs on macOS
 * and Linux) and bounded by the file size, so we go single-path.
 *
 * Flags:
 *  - `-p`: write to stdout, leaving the input files alone.
 *  - `-L`: fixed labels (`ours` / `theirs`) so callers do not have to
 *    predict what tmpfile name git would otherwise stamp into the
 *    marker line. The base label is still required by `git merge-file`
 *    even though `--diff3` is not passed (it would otherwise pick up
 *    the tmpfile name on systems that surface the base label in error
 *    messages).
 *  - `--end-of-options`: hardening against unusual file names.
 *
 * Exit code semantics (`git merge-file(1)`):
 *  - 0 → clean
 *  - 1..127 → number of conflicts (git caps the count at 127)
 *  - anything else → fatal error. git returns -1 from C on a fatal
 *    error, which the OS surfaces as exit status 255 (never a negative
 *    number); a signal kill surfaces as the runner's `-1`. So the only
 *    safe "this is a conflict count" range is 0..127, and everything
 *    outside it must be treated as a failure — otherwise a 255 would be
 *    mistaken for "255 conflicts" and open an empty preview.
 */
export async function runMergeFile(
  runner: GitRunner,
  repoRootPath: string,
  oursContent: string,
  baseContent: string,
  theirsContent: string,
  options: { signal?: AbortSignal } = {},
): Promise<MergeFileResult> {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'conflict-lens-mf-'));
  const oursPath = path.join(tmpdir, 'ours');
  const basePath = path.join(tmpdir, 'base');
  const theirsPath = path.join(tmpdir, 'theirs');
  try {
    // Normalize all three to LF first. `git merge-file` compares line by
    // line, so a CRLF buffer against LF blobs would manufacture conflicts (or
    // leave stray `\r`) purely from line-ending differences.
    await Promise.all([
      fs.writeFile(oursPath, normalizeLineEndings(oursContent)),
      fs.writeFile(basePath, normalizeLineEndings(baseContent)),
      fs.writeFile(theirsPath, normalizeLineEndings(theirsContent)),
    ]);

    const result = await runner.run(
      [
        'merge-file',
        '-p',
        '-L',
        'ours',
        '-L',
        'base',
        '-L',
        'theirs',
        '--end-of-options',
        oursPath,
        basePath,
        theirsPath,
      ],
      { cwd: repoRootPath, signal: options.signal },
    );

    if (result.timedOut || result.truncated || result.exitCode < 0 || result.exitCode > 127) {
      throw new Error(`git merge-file failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return {
      content: result.stdout,
      conflictCount: result.exitCode,
    };
  } finally {
    // Best-effort cleanup; a failed rm is not worth surfacing because the
    // OS will clear tmpdir on the next boot anyway.
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  }
}
