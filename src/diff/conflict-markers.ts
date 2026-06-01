/**
 * A run of `ours`-side lines that will be inside a `<<<<<<<` /
 * `>>>>>>>` block when the trial merge runs.
 *
 * Lines are 1-based, inclusive. When the trial merge would insert
 * content where ours has nothing (`insertion=true`), `startLine === endLine`
 * and they point to the line *after* the insertion site, matching the
 * weak-highlight insertion convention.
 */
export interface ConflictRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly insertion: boolean;
}

/**
 * Conflict markers must be 7 of their respective character, optionally
 * followed by a label (`<<<<<<< ours`) or end-of-line. We require space
 * or tab as the separator so that a literal `<<<<<<<X` in source code
 * is not misread as a marker. `=======` is the one marker that has no
 * label (it is the divider, not a side identifier), so the regex
 * insists on exactly seven equals and nothing else.
 */
const MARKER_OURS = /^<{7}([ \t]|$)/;
const MARKER_BASE = /^\|{7}([ \t]|$)/;
const MARKER_MID = /^={7}$/;
const MARKER_THEIRS = /^>{7}([ \t]|$)/;

type ParserState = 'plain' | 'ours' | 'base' | 'theirs';

/**
 * Parse the output of `git merge-file -p --diff3` and return the line
 * ranges of every conflict in ours-side coordinates.
 *
 * The parser is a four-state machine over the line stream:
 *   plain → (`<<<<<<<`) → ours
 *   ours  → (`|||||||`) → base   (or `=======` directly if no --diff3)
 *   base  → (`=======`) → theirs
 *   theirs→ (`>>>>>>>`) → plain
 *
 * The ours-line counter only advances for "plain" and "ours" lines —
 * the `base` and `theirs` sections were synthesized by merge-file and
 * do not correspond to ours' line numbers.
 *
 * Lines outside an open conflict that happen to match a marker regex
 * are ignored (they cannot legally appear there in merge-file output);
 * an open conflict that is never terminated (truncated input) is also
 * silently dropped.
 */
export function parseConflictMarkers(content: string): ConflictRange[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  // Drop a single trailing empty token that comes from a content-ending
  // newline. The terminator is part of the previous line, not a new one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const ranges: ConflictRange[] = [];
  let state: ParserState = 'plain';
  let oursLine = 1;
  let conflictStart: number | undefined;
  let lastOursLine = 0;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (MARKER_OURS.test(line)) {
      // Starting a new conflict, even if we appear to already be inside
      // one (defensive against malformed input).
      state = 'ours';
      conflictStart = oursLine;
      lastOursLine = oursLine - 1; // sentinel: no ours lines yet
      continue;
    }
    if (MARKER_BASE.test(line)) {
      if (state === 'ours') state = 'base';
      continue;
    }
    if (MARKER_MID.test(line)) {
      // `=======` is the ours→theirs (no diff3) or base→theirs (diff3)
      // transition. Anything in `plain` is ignored.
      if (state === 'ours' || state === 'base') state = 'theirs';
      continue;
    }
    if (MARKER_THEIRS.test(line)) {
      if (state === 'theirs' && conflictStart !== undefined) {
        const insertion = lastOursLine < conflictStart;
        ranges.push(
          insertion
            ? { startLine: conflictStart, endLine: conflictStart, insertion: true }
            : { startLine: conflictStart, endLine: lastOursLine, insertion: false },
        );
      }
      conflictStart = undefined;
      state = 'plain';
      continue;
    }
    // Content line — advance the ours counter only in sections that
    // actually originate from ours.
    if (state === 'plain') {
      oursLine++;
    } else if (state === 'ours') {
      lastOursLine = oursLine;
      oursLine++;
    }
    // `base` and `theirs` sections do not advance ours' coordinates.
  }

  // `oursLine - 1` is the total ours-side line count we observed while
  // walking. An insertion-style conflict at end-of-file has
  // `conflictStart = oursLine`, i.e. one past the last real ours line,
  // which would otherwise point the highlight at a buffer line that
  // does not exist. Clamp such anchors onto the actual last ours line
  // so the strong color paints somewhere meaningful; if the buffer is
  // empty we drop the range entirely since there is nothing to anchor on.
  const totalOursLines = oursLine - 1;
  if (ranges.length === 0) return ranges;
  const clamped: ConflictRange[] = [];
  for (const r of ranges) {
    if (r.insertion && r.startLine > totalOursLines) {
      if (totalOursLines <= 0) continue;
      clamped.push({
        startLine: totalOursLines,
        endLine: totalOursLines,
        insertion: true,
      });
    } else {
      clamped.push(r);
    }
  }
  return clamped;
}
