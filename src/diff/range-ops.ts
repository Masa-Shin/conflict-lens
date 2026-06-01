/**
 * Shared line-range shape used by both the weak and strong highlight
 * pipelines. The two range types are nominally distinct in the source
 * (`WeakHighlightRange` vs `ConflictRange`) but structurally identical;
 * declaring the operations in terms of this shape lets the orchestrator
 * mix them without unsafe casts.
 */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly insertion: boolean;
}

/**
 * Return the line ranges in `base` minus the lines covered by `mask`.
 * A base range that straddles a mask boundary is split into one or
 * more sub-ranges; ranges fully inside the mask are dropped.
 *
 * Insertion anchors are treated as occupying a single line. An
 * insertion whose anchor lies on a masked line is dropped entirely —
 * the strong (mask) indicator on that line is already the user-facing
 * signal, and leaving the weak anchor would just stack decorations.
 */
export function subtractRanges<T extends LineRange>(
  base: readonly T[],
  mask: readonly LineRange[],
): T[] {
  if (mask.length === 0) return base.slice();
  if (base.length === 0) return [];

  const covered = new Set<number>();
  for (const m of mask) {
    for (let l = m.startLine; l <= m.endLine; l++) covered.add(l);
  }

  const result: T[] = [];
  for (const r of base) {
    if (r.insertion) {
      if (!covered.has(r.startLine)) result.push(r);
      continue;
    }
    let runStart: number | undefined;
    for (let l = r.startLine; l <= r.endLine; l++) {
      if (covered.has(l)) {
        if (runStart !== undefined) {
          result.push({ ...r, startLine: runStart, endLine: l - 1 });
          runStart = undefined;
        }
      } else if (runStart === undefined) {
        runStart = l;
      }
    }
    if (runStart !== undefined) {
      result.push({ ...r, startLine: runStart, endLine: r.endLine });
    }
  }
  return result;
}
