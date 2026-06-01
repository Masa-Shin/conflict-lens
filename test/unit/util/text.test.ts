import { describe, expect, it } from 'vitest';

import {
  normalizeForDiff,
  normalizeLineEndings,
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
