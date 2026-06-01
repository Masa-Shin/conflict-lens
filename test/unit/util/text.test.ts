import { describe, expect, it } from 'vitest';

import {
  normalizeForDiff,
  normalizeLineEndings,
  splitLines,
  stripUtf8Bom,
} from '../../../src/util/text';

describe('normalizeLineEndings', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('converts lone CR to LF', () => {
    expect(normalizeLineEndings('a\rb\rc')).toBe('a\nb\nc');
  });

  it('leaves LF-only text unchanged', () => {
    const input = 'a\nb\nc\n';
    expect(normalizeLineEndings(input)).toBe(input);
  });

  it('handles mixed endings', () => {
    expect(normalizeLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('stripUtf8Bom', () => {
  it('removes a leading BOM', () => {
    expect(stripUtf8Bom('﻿hello')).toBe('hello');
  });

  it('leaves the string unchanged when there is no BOM', () => {
    expect(stripUtf8Bom('hello')).toBe('hello');
  });

  it('only strips a single leading BOM, not one in the middle', () => {
    expect(stripUtf8Bom('hi﻿there')).toBe('hi﻿there');
  });
});

describe('normalizeForDiff', () => {
  it('combines BOM strip and line-ending normalization', () => {
    expect(normalizeForDiff('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('splitLines', () => {
  it('returns [] for empty input', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('splits LF', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('splits CRLF without leaving stray \\r (Windows git default)', () => {
    expect(splitLines('a\r\nb\r\nc\r\n')).toEqual(['a', 'b', 'c']);
  });

  it('splits lone CR', () => {
    expect(splitLines('a\rb\rc')).toEqual(['a', 'b', 'c']);
  });

  it('drops the trailing empty element after final newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});
