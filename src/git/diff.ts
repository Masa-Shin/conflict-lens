/**
 * Parsed unified-diff hunk header. Line numbers are 1-based, matching the
 * format produced by git. `oldCount` / `newCount` default to 1 when omitted
 * in the header (per the unified-diff spec).
 *
 * Examples:
 *   "@@ -10,3 +12,5 @@"   → oldStart=10, oldCount=3, newStart=12, newCount=5
 *   "@@ -10 +12 @@"       → oldStart=10, oldCount=1, newStart=12, newCount=1
 *   "@@ -10,0 +11,3 @@"   → pure addition (oldCount=0)
 *   "@@ -30,2 +29,0 @@"   → pure deletion (newCount=0)
 */
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** Hunk classification per spec §3.2.1. */
export type HunkKind = 'change' | 'deletion' | 'addition';

export function classifyHunk(hunk: DiffHunk): HunkKind {
  if (hunk.oldCount > 0 && hunk.newCount === 0) return 'deletion';
  if (hunk.oldCount === 0 && hunk.newCount > 0) return 'addition';
  return 'change';
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

import type { GitRunner } from './runner';

/**
 * Run the "base-side diff" — the changes the base branch has accumulated
 * relative to the merge-base with HEAD. Hunk header line numbers are in
 * merge-base coordinates; conversion to HEAD coordinates is the caller's
 * responsibility (see src/diff/mapping.ts).
 *
 * The caller passes the already-resolved `mergeBaseSha` instead of letting
 * git recompute it via `--merge-base HEAD <base>` on every call — for a
 * hot path like the per-keystroke decoration refresh, that internal
 * resolution is pure waste.
 *
 * Flags:
 *  - `<mergeBaseSha> <baseBranch>`: diff from merge-base to base.
 *  - `--unified=0`: drop context lines so the hunk headers contain pure
 *    change ranges.
 *  - `--no-ext-diff` / `--no-textconv`: refuse to execute user-defined
 *    diff drivers (spec §5.5 S2).
 *  - `--no-color`: deterministic output.
 *  - `-M`: detect renames so a moved file doesn't appear as a full delete +
 *    full add.
 *  - `--end-of-options`: harden against `<baseBranch>` strings that start
 *    with `--`.
 */
export async function runBaseDiff(
  runner: GitRunner,
  repoRootPath: string,
  mergeBaseSha: string,
  baseBranch: string,
  relativeFilePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<DiffHunk[]> {
  const result = await runner.run(
    [
      'diff',
      '--unified=0',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-M',
      '--end-of-options',
      mergeBaseSha,
      baseBranch,
      '--',
      relativeFilePath,
    ],
    { cwd: repoRootPath, signal: options.signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff (base side) for ${relativeFilePath} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return parseHunkHeaders(result.stdout);
}

/**
 * Resolve the merge-base SHA between HEAD and `baseBranch`. Returns
 * `undefined` if no common ancestor exists (e.g. unrelated histories) or
 * the operation fails for any other reason. The caller should treat
 * `undefined` as "no weak highlights available right now" rather than as
 * an error.
 *
 * `--end-of-options` hardens against branch names beginning with `--`.
 */
export async function resolveMergeBase(
  runner: GitRunner,
  repoRootPath: string,
  baseBranch: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const result = await runner.run(
    ['merge-base', '--end-of-options', 'HEAD', baseBranch],
    { cwd: repoRootPath, signal: options.signal },
  );
  if (result.exitCode !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha.length === 0 ? undefined : sha;
}

/**
 * Resolve the current HEAD commit SHA. Returns `undefined` if HEAD does
 * not point to a commit (e.g. unborn branch) or the call fails.
 * `--verify` plus `^{commit}` guards against tag-to-tree pointers; if
 * HEAD happens to be an annotated tag, we want the commit it ultimately
 * resolves to.
 */
export async function resolveHeadSha(
  runner: GitRunner,
  repoRootPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const result = await runner.run(
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    { cwd: repoRootPath, signal: options.signal },
  );
  if (result.exitCode !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha.length === 0 ? undefined : sha;
}

/**
 * Resolve an arbitrary ref (branch, tag, SHA) to the commit it points to.
 * Returns `undefined` when the ref does not resolve to a commit or the call
 * fails. `--verify` plus `^{commit}` peels annotated tags down to the commit
 * and rejects non-commit objects; `--end-of-options` hardens against ref
 * names beginning with `--`.
 *
 * Used by Show Base Changes to pin the diff to the base branch's *current*
 * tip SHA, so the virtual diff URI changes whenever the base moves and
 * VSCode cannot serve stale cached content.
 */
export async function resolveRefToCommit(
  runner: GitRunner,
  repoRootPath: string,
  ref: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const result = await runner.run(
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { cwd: repoRootPath, signal: options.signal },
  );
  if (result.exitCode !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha.length === 0 ? undefined : sha;
}

/**
 * Extract all hunk headers from a unified-diff payload. Non-`@@` lines are
 * ignored, so the function tolerates `diff --git`, `index`, `---`, `+++`
 * preamble lines as well as patch body lines (since we run with
 * `--unified=0` the body still contains context-less +/- lines that must
 * be skipped here).
 */
export function parseHunkHeaders(diffOutput: string): DiffHunk[] {
  if (diffOutput.length === 0) return [];
  const hunks: DiffHunk[] = [];
  for (const line of diffOutput.split('\n')) {
    if (!line.startsWith('@@ ')) continue;
    const match = HUNK_HEADER_PATTERN.exec(line);
    if (!match) continue;
    const [, oldStart, oldCount, newStart, newCount] = match;
    hunks.push({
      oldStart: Number(oldStart),
      oldCount: oldCount === undefined ? 1 : Number(oldCount),
      newStart: Number(newStart),
      newCount: newCount === undefined ? 1 : Number(newCount),
    });
  }
  return hunks;
}
