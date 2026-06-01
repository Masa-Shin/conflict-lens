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
