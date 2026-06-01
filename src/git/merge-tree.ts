import type { GitRunner } from './runner';

/**
 * Outcome of a `git merge-tree --write-tree` trial merge.
 *
 * - `clean`: the merge would succeed without conflicts.
 * - `conflicted`: the merge would produce conflicts in `conflictedPaths`.
 * - `unsupported`: git version is too old, or merge-tree refused (e.g. no
 *   common history). The strong-highlight pipeline degrades silently to
 *   weak-only in this case.
 */
export type MergeTreeResult =
  | { readonly kind: 'clean'; readonly treeSha: string }
  | {
      readonly kind: 'conflicted';
      readonly treeSha: string;
      readonly conflictedPaths: readonly string[];
    }
  | { readonly kind: 'unsupported'; readonly reason: string };

/**
 * Run a trial three-way merge to discover which files would conflict if
 * the user merged `baseBranch` into HEAD right now. Output is the
 * predicted-conflict input to the strong-highlight pipeline (spec §3.2.2).
 *
 * Flags:
 *  - `-z`: NUL-separated output, so paths containing spaces / newlines
 *    survive intact.
 *  - `--write-tree`: opt into the modern (Git 2.38+) merge-tree mode that
 *    actually performs a merge instead of the legacy trivial-merge output.
 *  - `--name-only`: restrict the post-tree output to conflicting paths
 *    only; we don't care about mode/oid/stage triples for highlighting.
 *  - `--end-of-options`: guard against `baseBranch` strings that begin
 *    with `--`.
 *
 * `--merge-base` is intentionally *not* passed: that flag is Git 2.40+,
 * but merge-tree itself only needs 2.38 and will auto-discover the
 * merge-base for the two-commit-ish form. Keeping our minimum version
 * gate at 2.38 is worth a tiny amount of duplicated work.
 *
 * Exit code semantics differ across git versions:
 *  - Git 2.39: 0 for any successful merge attempt (clean *or* conflicted),
 *    non-zero only for actual errors (unknown ref, unrelated histories).
 *  - Newer git: 0 for clean, 1 for conflicted, non-zero for errors.
 *
 * To work on both, we parse the output structure instead of relying on
 * the exit code alone: the presence of a conflicted-paths section
 * between the tree SHA and the info section is the source of truth.
 */
export async function runMergeTree(
  runner: GitRunner,
  repoRootPath: string,
  baseBranch: string,
  options: { signal?: AbortSignal } = {},
): Promise<MergeTreeResult> {
  const result = await runner.run(
    [
      'merge-tree',
      '-z',
      '--write-tree',
      '--name-only',
      '--end-of-options',
      'HEAD',
      baseBranch,
    ],
    { cwd: repoRootPath, signal: options.signal },
  );

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return {
      kind: 'unsupported',
      reason:
        result.stderr.trim() || `git merge-tree exited with code ${result.exitCode}`,
    };
  }

  return parseMergeTreeOutput(result.stdout);
}

/**
 * Parse the NUL-delimited output of `git merge-tree -z --write-tree
 * --name-only`. Layout:
 *
 *   <treeSha> NUL
 *   [ <conflictedPath> NUL ]*
 *   NUL                          ← only present when there are conflicts
 *   <info-section>               ← only present when there are conflicts
 *
 * The conflict section starts at the first empty token after the tree
 * SHA, so we slice everything between index 1 and that separator.
 *
 * Exported for unit tests.
 */
export function parseMergeTreeOutput(stdout: string): MergeTreeResult {
  const tokens = stdout.split('\0');
  // Strip a single trailing empty token from the final \0 separator.
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  if (tokens.length === 0 || tokens[0].length === 0) {
    return {
      kind: 'unsupported',
      reason: 'git merge-tree produced no tree SHA',
    };
  }
  const treeSha = tokens[0];
  // Find the section separator (empty token) after the path list.
  let separatorIdx = tokens.length;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === '') {
      separatorIdx = i;
      break;
    }
  }
  const paths = tokens.slice(1, separatorIdx);
  if (paths.length === 0) {
    return { kind: 'clean', treeSha };
  }
  return { kind: 'conflicted', treeSha, conflictedPaths: paths };
}
