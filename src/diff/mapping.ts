import { diffLines } from 'diff';

import { normalizeForDiff } from '../util/text';

/**
 * Mapping from "merge-base side" line numbers to "current side"
 * (HEAD or buffer) line numbers. Both sides use 1-based line numbers, the
 * convention git uses in hunk headers.
 *
 * Entries cover two cases:
 *  - Lines unchanged through the diff map identity-style to their right-side
 *    position.
 *  - Lines that look like in-place edits (a `removed` block immediately
 *    followed by `added`) are paired positionally so that the weak
 *    highlight survives small edits like "user typed a space on the
 *    line the base was about to remove". See `buildLineMapping`.
 *
 * Lines deleted on the right with no paired addition have no entry; lines
 * added on the right have no inverse-mapping in this direction.
 */
export interface LineMapping {
  /** Returns the 1-based line number on the right, or `undefined` if the left line did not survive. */
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
 * counting lines. Three cases:
 *  - Unchanged segment: register `leftLine + i → rightLine + i`.
 *  - `removed` block immediately followed by `added` (an in-place edit
 *    on a region of lines): pair removed line `i` with added line
 *    `min(i, addedLen - 1)`. This keeps the weak highlight visible
 *    when the user types on a base-deleted line — without the pairing
 *    the line would silently drop out of the mapping the moment its
 *    content stopped matching the merge-base.
 *  - Bare `removed` (no following `added`): no mapping; the line was
 *    actually deleted on the right and there is nothing to highlight.
 *
 * We deliberately do not pair the reverse order (`added` then `removed`),
 * because that arrangement typically indicates an unrelated addition
 * followed by an unrelated removal rather than a single edit, and
 * pairing it would produce misleading mappings.
 */
export function buildLineMapping(leftContent: string, rightContent: string): LineMapping {
  const left = normalizeForDiff(leftContent);
  const right = normalizeForDiff(rightContent);
  const changes = diffLines(left, right);

  const map = new Map<number, number>();
  let leftLine = 1;
  let rightLine = 1;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const count = lineCount(change.value, change.count);

    if (change.removed) {
      const next = changes[i + 1];
      if (next?.added) {
        const addedCount = lineCount(next.value, next.count);
        if (addedCount > 0) {
          for (let j = 0; j < count; j++) {
            map.set(leftLine + j, rightLine + Math.min(j, addedCount - 1));
          }
        }
        leftLine += count;
        rightLine += addedCount;
        i++;
        continue;
      }
      leftLine += count;
    } else if (change.added) {
      rightLine += count;
    } else {
      for (let k = 0; k < count; k++) {
        map.set(leftLine + k, rightLine + k);
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
