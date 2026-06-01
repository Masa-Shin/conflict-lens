import { describe, expect, it } from 'vitest';

import { classifyHunk, parseHunkHeaders } from '../../../src/git/diff';

describe('parseHunkHeaders', () => {
  it('returns [] for empty input', () => {
    expect(parseHunkHeaders('')).toEqual([]);
  });

  it('parses a change hunk with explicit counts', () => {
    expect(parseHunkHeaders('@@ -10,3 +12,5 @@')).toEqual([
      { oldStart: 10, oldCount: 3, newStart: 12, newCount: 5 },
    ]);
  });

  it('defaults omitted counts to 1', () => {
    expect(parseHunkHeaders('@@ -10 +12 @@')).toEqual([
      { oldStart: 10, oldCount: 1, newStart: 12, newCount: 1 },
    ]);
    expect(parseHunkHeaders('@@ -10 +12,3 @@')).toEqual([
      { oldStart: 10, oldCount: 1, newStart: 12, newCount: 3 },
    ]);
  });

  it('parses a pure addition (oldCount=0)', () => {
    expect(parseHunkHeaders('@@ -10,0 +11,3 @@')).toEqual([
      { oldStart: 10, oldCount: 0, newStart: 11, newCount: 3 },
    ]);
  });

  it('parses a pure deletion (newCount=0)', () => {
    expect(parseHunkHeaders('@@ -30,2 +29,0 @@')).toEqual([
      { oldStart: 30, oldCount: 2, newStart: 29, newCount: 0 },
    ]);
  });

  it('ignores diff preamble and +/- body lines', () => {
    const diff = [
      'diff --git a/foo b/foo',
      'index abc..def 100644',
      '--- a/foo',
      '+++ b/foo',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '@@ -5,0 +6,2 @@',
      '+added',
      '+lines',
    ].join('\n');
    const hunks = parseHunkHeaders(diff);
    expect(hunks).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 },
    ]);
  });

  it('ignores malformed @@ lines without aborting', () => {
    const diff = [
      '@@ totally bogus @@',
      '@@ -1,1 +1,1 @@',
    ].join('\n');
    expect(parseHunkHeaders(diff)).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
  });

  it('tolerates the trailing function header that git sometimes emits', () => {
    expect(parseHunkHeaders('@@ -1,1 +1,1 @@ class Foo {')).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
  });
});

describe('classifyHunk', () => {
  it.each([
    [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }, 'change'],
    [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 3 }, 'addition'],
    [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 0 }, 'deletion'],
    [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }, 'change'],
  ] as const)('classifies %o as %s', (hunk, kind) => {
    expect(classifyHunk(hunk)).toBe(kind);
  });
});
