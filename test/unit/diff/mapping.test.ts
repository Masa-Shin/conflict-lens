import { describe, expect, it } from 'vitest';

import { buildLineMapping } from '../../../src/diff/mapping';

describe('buildLineMapping', () => {
  it('identity mapping when contents are identical', () => {
    const text = 'a\nb\nc\nd\n';
    const map = buildLineMapping(text, text);
    expect(map.leftLineCount).toBe(4);
    expect(map.rightLineCount).toBe(4);
    for (let i = 1; i <= 4; i++) expect(map.toRight(i)).toBe(i);
  });

  it('shifts the mapping when lines are prepended on the right', () => {
    const left = 'foo\nbar\nbaz\n';
    const right = 'NEW1\nNEW2\nfoo\nbar\nbaz\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(3); // foo
    expect(map.toRight(2)).toBe(4); // bar
    expect(map.toRight(3)).toBe(5); // baz
  });

  it('returns undefined for lines removed on the right', () => {
    const left = 'foo\nbar\nbaz\n';
    const right = 'foo\nbaz\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1); // foo
    expect(map.toRight(2)).toBeUndefined(); // bar gone
    expect(map.toRight(3)).toBe(2); // baz
  });

  it('pairs an in-place edit so the replaced line still maps positionally', () => {
    const left = 'a\nold\nb\n';
    const right = 'a\nnew\nb\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    // `old` removed immediately followed by `new` added — treated as an
    // in-place edit so the highlight survives.
    expect(map.toRight(2)).toBe(2);
    expect(map.toRight(3)).toBe(3);
  });

  it('normalizes CRLF on input', () => {
    const left = 'a\r\nb\r\nc\r\n';
    const right = 'a\nb\nNEW\nc\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBe(2);
    expect(map.toRight(3)).toBe(4); // c shifted by the inserted NEW line
  });

  it('normalizes a leading UTF-8 BOM', () => {
    const leftWithBom = '﻿a\nb\nc\n';
    const right = 'a\nb\nc\n';
    const map = buildLineMapping(leftWithBom, right);
    // Line 1 ("a") must map to right line 1 even though left has the BOM.
    expect(map.toRight(1)).toBe(1);
  });

  it('pairs a fully replaced file element-wise, clamping the tail to the last added line', () => {
    const left = 'one\ntwo\n';
    const right = 'apple\nbanana\ncherry\n';
    const map = buildLineMapping(left, right);
    // No unchanged context, so the whole file is removed→added. Pair
    // positionally: left 1 → right 1, left 2 → right 2; `cherry` has no
    // left counterpart and stays unmapped on the right side.
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBe(2);
    expect(map.leftLineCount).toBe(2);
    expect(map.rightLineCount).toBe(3);
  });

  it('clamps a removed block longer than the added block to the last added line', () => {
    const left = 'a\nold1\nold2\nold3\nb\n';
    const right = 'a\nnew\nb\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBe(2); // old1 → new
    expect(map.toRight(3)).toBe(2); // old2 → new (clamped)
    expect(map.toRight(4)).toBe(2); // old3 → new (clamped)
    expect(map.toRight(5)).toBe(3); // b is at line 3 on the right
  });

  it('pairs a removed block shorter than the added block at the first added line', () => {
    const left = 'a\nold\nb\n';
    const right = 'a\nnew1\nnew2\nnew3\nb\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBe(2); // old → new1 (first of the added block)
    expect(map.toRight(3)).toBe(5); // b shifted by 2 extra lines on the right
  });

  it('does not pair a removed block when no added block immediately follows', () => {
    // `bar` removed with no replacement: unchanged on either side of the
    // removal, no in-place edit semantics.
    const left = 'foo\nbar\nbaz\n';
    const right = 'foo\nbaz\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBeUndefined();
    expect(map.toRight(3)).toBe(2);
  });

  it('does not pair across an unchanged separator between removed and added', () => {
    // `old` is removed, then later (after an unchanged line) `new` is added.
    // jsdiff emits these as non-adjacent blocks, so the removed line gets
    // no mapping — pairing across unchanged segments would be wrong.
    const left = 'a\nold\nb\n';
    const right = 'a\nb\nnew\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBeUndefined();
    expect(map.toRight(3)).toBe(2);
  });

  it('handles empty inputs', () => {
    const map = buildLineMapping('', '');
    expect(map.leftLineCount).toBe(0);
    expect(map.rightLineCount).toBe(0);
    expect(map.toRight(1)).toBeUndefined();
  });
});
