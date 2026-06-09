import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isChangedOnBase, toRepoRelativePosix } from '../../../src/mcp/paths';

describe('toRepoRelativePosix', () => {
  const root = path.resolve('/repo');

  it('keeps a relative path repo-relative', () => {
    expect(toRepoRelativePosix('src/foo.ts', root, root)).toBe('src/foo.ts');
  });

  it('resolves an absolute path inside the repo', () => {
    expect(toRepoRelativePosix(path.join(root, 'src/foo.ts'), root, root)).toBe('src/foo.ts');
  });

  it('resolves a relative path against the cwd', () => {
    expect(toRepoRelativePosix('foo.ts', root, path.join(root, 'src'))).toBe('src/foo.ts');
  });

  it('strips a leading ./ and collapses interior ..', () => {
    expect(toRepoRelativePosix('./a/b/../c.ts', root, root)).toBe('a/c.ts');
  });

  it('rejects the repo root itself and paths outside the repo', () => {
    expect(toRepoRelativePosix('.', root, root)).toBeNull();
    expect(toRepoRelativePosix('../outside.ts', root, root)).toBeNull();
    expect(toRepoRelativePosix(path.resolve('/elsewhere/x.ts'), root, root)).toBeNull();
  });
});

describe('isChangedOnBase', () => {
  it('matches a path in the changed set', () => {
    expect(isChangedOnBase('src/foo.ts', ['src/foo.ts', 'a/b.ts'])).toBe(true);
    expect(isChangedOnBase('src/bar.ts', ['src/foo.ts'])).toBe(false);
  });

  it('matches across NFC/NFD normalization', () => {
    const nfc = 'café.ts'.normalize('NFC');
    const nfd = 'café.ts'.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(isChangedOnBase(nfd, [nfc])).toBe(true);
  });

  it('is case-sensitive and needs the full path', () => {
    expect(isChangedOnBase('src/Foo.ts', ['src/foo.ts'])).toBe(false);
    expect(isChangedOnBase('foo.ts', ['src/foo.ts'])).toBe(false);
    expect(isChangedOnBase('src/foo.ts', [])).toBe(false);
  });
});
