import { diffLines } from 'diff';

import { normalizeForDiff } from '../util/text';

/**
 * Mapping from "merge-base side" line numbers to "current side"
 * (HEAD or buffer) line numbers. Both sides use 1-based line numbers, the
 * convention git uses in hunk headers.
 *
 * Only lines that survive **unchanged** through the diff have entries.
 * Lines deleted on the right have no entry; lines added on the right have
 * no inverse-mapping in this direction.
 */
export interface LineMapping {
  /** Returns the 1-based line number on the right, or `undefined` if the left line was removed. */
  toRight(leftLine: number): number | undefined;
  readonly leftLineCount: number;
  readonly rightLineCount: number;
}

/**
 * Build a line-mapping between two text contents. Inputs are normalized
 * (CRLF/CR → LF, leading BOM stripped) so newline conventions or BOM
 * differences between `git show` and the editor buffer cannot create
 * spurious diffs.
 *
 * Implementation uses jsdiff's `diffLines`, walking both sides while
 * counting lines. For each "unchanged" segment we register
 * `leftLine → rightLine` for every line in the segment.
 */
export function buildLineMapping(leftContent: string, rightContent: string): LineMapping {
  const left = normalizeForDiff(leftContent);
  const right = normalizeForDiff(rightContent);
  const changes = diffLines(left, right);

  const map = new Map<number, number>();
  let leftLine = 1;
  let rightLine = 1;

  for (const change of changes) {
    const count = lineCount(change.value, change.count);
    if (change.added) {
      rightLine += count;
    } else if (change.removed) {
      leftLine += count;
    } else {
      for (let i = 0; i < count; i++) {
        map.set(leftLine + i, rightLine + i);
      }
      leftLine += count;
      rightLine += count;
    }
  }

  return {
    toRight: (n) => map.get(n),
    leftLineCount: leftLine - 1,
    rightLineCount: rightLine - 1,
  };
}

/**
 * jsdiff sets `count` on every part for diffLines, but the type marks it as
 * optional. Fall back to counting newlines in `value` to keep this robust
 * against future API changes.
 */
function lineCount(value: string, count: number | undefined): number {
  if (typeof count === 'number') return count;
  // diffLines guarantees each part ends with a newline (or is the trailing
  // partial last line). Count the newlines; add 1 if the value does not
  // end with one.
  if (value.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) newlines++;
  }
  return value.endsWith('\n') ? newlines : newlines + 1;
}
