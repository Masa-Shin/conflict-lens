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

  it('handles changes in the middle (line 2 replaced)', () => {
    const left = 'a\nold\nb\n';
    const right = 'a\nnew\nb\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBe(1);
    expect(map.toRight(2)).toBeUndefined(); // old removed
    expect(map.toRight(3)).toBe(3); // b is at line 3 on both sides
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

  it('handles a fully replaced file (no unchanged lines)', () => {
    const left = 'one\ntwo\n';
    const right = 'apple\nbanana\ncherry\n';
    const map = buildLineMapping(left, right);
    expect(map.toRight(1)).toBeUndefined();
    expect(map.toRight(2)).toBeUndefined();
    expect(map.leftLineCount).toBe(2);
    expect(map.rightLineCount).toBe(3);
  });

  it('handles empty inputs', () => {
    const map = buildLineMapping('', '');
    expect(map.leftLineCount).toBe(0);
    expect(map.rightLineCount).toBe(0);
    expect(map.toRight(1)).toBeUndefined();
  });
});
