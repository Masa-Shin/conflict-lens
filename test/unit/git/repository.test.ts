import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFileWithinRepository, isSamePathOrUnder } from '../../../src/git/repository';

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

describe('isFileWithinRepository', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-repo-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function makeRepoTree(): { repoRoot: string; insideFile: string; outsideFile: string } {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'outside-')));
    const insideFile = path.join(repoRoot, 'src', 'inside.ts');
    fs.mkdirSync(path.dirname(insideFile), { recursive: true });
    fs.writeFileSync(insideFile, 'inside');
    const outsideFile = path.join(outsideDir, 'leak.ts');
    fs.writeFileSync(outsideFile, 'leak');
    return { repoRoot, insideFile, outsideFile };
  }

  it('accepts a regular file under the repo root', async () => {
    const { repoRoot, insideFile } = makeRepoTree();
    expect(await isFileWithinRepository(insideFile, repoRoot)).toBe(true);
  });

  it('rejects a file outside the repo root', async () => {
    const { repoRoot, outsideFile } = makeRepoTree();
    expect(await isFileWithinRepository(outsideFile, repoRoot)).toBe(false);
  });

  it('rejects a symlink, even if its target is inside the repo', async () => {
    const { repoRoot, insideFile } = makeRepoTree();
    const linkPath = path.join(repoRoot, 'link-to-inside');
    fs.symlinkSync(insideFile, linkPath);
    // Symlinks are excluded outright (spec §3.1.3 / §5.5 B5).
    expect(await isFileWithinRepository(linkPath, repoRoot)).toBe(false);
  });

  it('rejects a non-existent path', async () => {
    const { repoRoot } = makeRepoTree();
    const missing = path.join(repoRoot, 'does', 'not', 'exist');
    expect(await isFileWithinRepository(missing, repoRoot)).toBe(false);
  });

  it('rejects a path whose realpath escapes via a parent-dir symlink', async () => {
    const { repoRoot, outsideFile } = makeRepoTree();
    // Set up: /repo/aliased-outside -> /outside, then test /repo/aliased-outside/leak.ts
    const aliasedOutside = path.join(repoRoot, 'aliased-outside');
    fs.symlinkSync(path.dirname(outsideFile), aliasedOutside);
    const escapingPath = path.join(aliasedOutside, path.basename(outsideFile));
    // lstat on the leaf is a regular file (not a symlink), but realpath of
    // any ancestor segment expands to /outside, so the final canonical
    // location is outside the repo.
    expect(await isFileWithinRepository(escapingPath, repoRoot)).toBe(false);
  });

  it('does not treat /repo-malicious-prefix as inside /repo (prefix attack)', () => {
    const realRepoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
    // Pretend the canonical repo root is the shorter "/repo" prefix. We
    // simulate the attack by giving isSamePathOrUnder the literal paths.
    expect(isSamePathOrUnder(`${realRepoRoot}-evil/file.ts`, realRepoRoot)).toBe(false);
  });
});
