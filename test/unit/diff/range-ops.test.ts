import { describe, expect, it } from 'vitest';

import { subtractRanges, type LineRange } from '../../../src/diff/range-ops';

const r = (
  startLine: number,
  endLine: number,
  insertion = false,
): LineRange => ({ startLine, endLine, insertion });

describe('subtractRanges', () => {
  it('returns a copy of base when the mask is empty', () => {
    const base = [r(1, 5), r(10, 12)];
    const result = subtractRanges(base, []);
    expect(result).toEqual(base);
    // independent array, so mutating the result does not touch base
    expect(result).not.toBe(base);
  });

  it('returns [] when base is empty', () => {
    expect(subtractRanges([], [r(1, 1)])).toEqual([]);
  });

  it('drops a base range entirely inside the mask', () => {
    expect(subtractRanges([r(3, 5)], [r(1, 10)])).toEqual([]);
  });

  it('trims the left side when only the start is masked', () => {
    expect(subtractRanges([r(3, 10)], [r(1, 5)])).toEqual([r(6, 10)]);
  });

  it('trims the right side when only the end is masked', () => {
    expect(subtractRanges([r(3, 10)], [r(8, 12)])).toEqual([r(3, 7)]);
  });

  it('splits a base range that straddles a mask in the middle', () => {
    expect(subtractRanges([r(1, 10)], [r(4, 6)])).toEqual([r(1, 3), r(7, 10)]);
  });

  it('handles multiple disjoint masks against one base range', () => {
    expect(subtractRanges([r(1, 20)], [r(3, 5), r(10, 12)])).toEqual([
      r(1, 2),
      r(6, 9),
      r(13, 20),
    ]);
  });

  it('drops an insertion anchor that lies on a masked line', () => {
    const ins = r(5, 5, true);
    expect(subtractRanges([ins], [r(4, 6)])).toEqual([]);
  });

  it('keeps an insertion anchor outside the mask', () => {
    const ins = r(5, 5, true);
    expect(subtractRanges([ins], [r(10, 12)])).toEqual([ins]);
  });

  it('preserves non-mask fields on split sub-ranges', () => {
    type Extra = LineRange & { reason: string };
    const base: Extra[] = [{ startLine: 1, endLine: 10, insertion: false, reason: 'x' }];
    const result = subtractRanges(base, [r(4, 6)]);
    expect(result).toEqual([
      { startLine: 1, endLine: 3, insertion: false, reason: 'x' },
      { startLine: 7, endLine: 10, insertion: false, reason: 'x' },
    ]);
  });
});
