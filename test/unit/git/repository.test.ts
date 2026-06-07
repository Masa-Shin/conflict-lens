import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSamePathOrUnder, repoRelativePathViaRealpath } from '../../../src/git/repository';

describe('isSamePathOrUnder', () => {
  it('returns true for the same canonical path', () => {
    expect(isSamePathOrUnder('/repo', '/repo')).toBe(true);
  });

  it('returns true for a descendant path', () => {
    expect(isSamePathOrUnder('/repo/src/file.ts', '/repo')).toBe(true);
  });

  it('returns false for a sibling that shares the same prefix string', () => {
    // Critical: naive startsWith would return true here.
    expect(isSamePathOrUnder('/repo-malicious-prefix/file.ts', '/repo')).toBe(false);
  });

  it('returns false for a path above the container', () => {
    expect(isSamePathOrUnder('/other', '/repo')).toBe(false);
  });

  it('returns false for the container parent', () => {
    expect(isSamePathOrUnder('/', '/repo')).toBe(false);
  });

  it.skipIf(path.sep !== '\\')(
    'treats a candidate carrying the Windows extended-length prefix as inside',
    () => {
      // realpathSync (JS) and promises.realpath (libuv) disagree on emitting
      // `\\?\`; without normalization path.relative would report "outside".
      expect(isSamePathOrUnder('\\\\?\\C:\\repo\\src\\file.ts', 'C:\\repo')).toBe(true);
    },
  );
});

describe('repoRelativePathViaRealpath', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-rel-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns the forward-slashed repo-relative path for a file under the root', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    const insideFile = path.join(repoRoot, 'src', 'inside.ts');
    fs.mkdirSync(path.dirname(insideFile), { recursive: true });
    fs.writeFileSync(insideFile, 'inside');
    expect(await repoRelativePathViaRealpath(insideFile, repoRoot)).toBe('src/inside.ts');
  });

  // The reported bug: opening the workspace through a symlinked root made
  // the Explorer hand URIs in the symlink namespace, which path.relative
  // against the realpath'd root reports as "outside" — so no badge. The
  // realpath'd comparison must recover the true repo-relative path.
  it('resolves a file reached through a symlinked workspace root', async () => {
    const realRepoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    const insideFile = path.join(realRepoRoot, 'src', 'inside.ts');
    fs.mkdirSync(path.dirname(insideFile), { recursive: true });
    fs.writeFileSync(insideFile, 'inside');

    const linkedRoot = path.join(workdir, 'linked-root');
    fs.symlinkSync(realRepoRoot, linkedRoot);
    const fileViaLink = path.join(linkedRoot, 'src', 'inside.ts');

    expect(await repoRelativePathViaRealpath(fileViaLink, realRepoRoot)).toBe('src/inside.ts');
  });

  it('returns undefined for a file outside the repo root', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'outside-')));
    const outsideFile = path.join(outsideDir, 'leak.ts');
    fs.writeFileSync(outsideFile, 'leak');
    expect(await repoRelativePathViaRealpath(outsideFile, repoRoot)).toBeUndefined();
  });

  it('returns undefined for the repo root itself and for a symlink', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    expect(await repoRelativePathViaRealpath(repoRoot, repoRoot)).toBeUndefined();

    const insideFile = path.join(repoRoot, 'inside.ts');
    fs.writeFileSync(insideFile, 'inside');
    const linkPath = path.join(repoRoot, 'link-to-inside');
    fs.symlinkSync(insideFile, linkPath);
    expect(await repoRelativePathViaRealpath(linkPath, repoRoot)).toBeUndefined();
  });

  it('returns undefined for a non-existent path', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    const missing = path.join(repoRoot, 'does', 'not', 'exist');
    expect(await repoRelativePathViaRealpath(missing, repoRoot)).toBeUndefined();
  });

  it('returns undefined when a parent-dir symlink makes the path escape the repo', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'outside-')));
    const outsideFile = path.join(outsideDir, 'leak.ts');
    fs.writeFileSync(outsideFile, 'leak');
    // /repo/aliased-outside -> /outside, then resolve /repo/aliased-outside/leak.ts.
    const aliasedOutside = path.join(repoRoot, 'aliased-outside');
    fs.symlinkSync(outsideDir, aliasedOutside);
    const escapingPath = path.join(aliasedOutside, 'leak.ts');
    // lstat on the leaf is a regular file, but realpath of an ancestor
    // segment expands to /outside, so the canonical location is outside.
    expect(await repoRelativePathViaRealpath(escapingPath, repoRoot)).toBeUndefined();
  });
});
