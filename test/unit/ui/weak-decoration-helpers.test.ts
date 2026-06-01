import { describe, expect, it } from 'vitest';

import {
  cacheKeyFor,
  escapeMarkdown,
  sizeOfRanges,
} from '../../../src/ui/weak-decoration-helpers';

describe('cacheKeyFor', () => {
  const inputs = {
    repoRootPath: '/repo',
    baseBranch: 'origin/main',
    mergeBaseSha: 'abc123',
    headSha: 'def456',
  };

  it('produces a stable key for identical inputs', () => {
    expect(cacheKeyFor('src/a.ts', inputs)).toBe(
      cacheKeyFor('src/a.ts', inputs),
    );
  });

  it('differs when any field differs', () => {
    const k = cacheKeyFor('src/a.ts', inputs);
    expect(k).not.toBe(cacheKeyFor('src/b.ts', inputs));
    expect(k).not.toBe(cacheKeyFor('src/a.ts', { ...inputs, baseBranch: 'origin/dev' }));
    expect(k).not.toBe(cacheKeyFor('src/a.ts', { ...inputs, mergeBaseSha: 'xxx' }));
    expect(k).not.toBe(cacheKeyFor('src/a.ts', { ...inputs, headSha: 'yyy' }));
    expect(k).not.toBe(cacheKeyFor('src/a.ts', { ...inputs, repoRootPath: '/other' }));
  });
});

describe('sizeOfRanges', () => {
  it('is monotonic in the number of ranges', () => {
    const empty = sizeOfRanges([]);
    const one = sizeOfRanges([{ startLine: 1, endLine: 1, insertion: false }]);
    const two = sizeOfRanges([
      { startLine: 1, endLine: 1, insertion: false },
      { startLine: 5, endLine: 9, insertion: true },
    ]);
    expect(one).toBeGreaterThan(empty);
    expect(two).toBeGreaterThan(one);
  });

  it('returns a non-negative finite number', () => {
    const v = sizeOfRanges([{ startLine: 1, endLine: 1, insertion: false }]);
    expect(v).toBeGreaterThan(0);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('escapeMarkdown', () => {
  it('escapes characters that would otherwise change formatting', () => {
    expect(escapeMarkdown('origin/main')).toBe('origin/main');
    expect(escapeMarkdown('feature/*')).toBe('feature/\\*');
    expect(escapeMarkdown('_under_')).toBe('\\_under\\_');
    expect(escapeMarkdown('a[b]c')).toBe('a\\[b\\]c');
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
    expect(escapeMarkdown('<tag>')).toBe('\\<tag\\>');
    expect(escapeMarkdown('a|b')).toBe('a\\|b');
    expect(escapeMarkdown('-x')).toBe('\\-x');
    expect(escapeMarkdown('a+b')).toBe('a\\+b');
    expect(escapeMarkdown('!{x}')).toBe('\\!\\{x\\}');
    expect(escapeMarkdown('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves plain text untouched', () => {
    expect(escapeMarkdown('main')).toBe('main');
    expect(escapeMarkdown('release/2026.06')).toBe('release/2026.06');
  });
});
