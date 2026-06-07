import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/git/changed-files', () => ({
  listChangedFilesOnBase: vi.fn(),
}));

import { listChangedFilesOnBase } from '../../../src/git/changed-files';
import { Uri } from '../../__mocks__/vscode';
import {
  FileDecorationCoordinator,
  type FileDecorationInputs,
} from '../../../src/ui/file-decoration';

const listChanged = vi.mocked(listChangedFilesOnBase);

function makeInputs(): FileDecorationInputs {
  return {
    runner: { gitPath: 'git', run: vi.fn() } as unknown as FileDecorationInputs['runner'],
    repoRootPath: '/tmp/repo',
    baseBranch: 'origin/main',
    mergeBaseSha: 'mb123',
    baseTipSha: 'tip123',
  };
}

describe('FileDecorationCoordinator', () => {
  let coord: FileDecorationCoordinator;

  beforeEach(() => {
    coord = new FileDecorationCoordinator({ showBadges: true });
    listChanged.mockReset();
  });

  it('returns undefined before any refresh has populated the set', () => {
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/foo.txt'))).toBeUndefined();
  });

  it('returns the changed decoration for files in the changed set', async () => {
    listChanged.mockResolvedValueOnce(['a.txt', 'b.txt']);
    await coord.refresh(makeInputs());

    const decoA = coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'));
    expect(decoA?.badge).toBe('≠');

    const decoB = coord.provideFileDecoration(Uri.file('/tmp/repo/b.txt'));
    expect(decoB?.badge).toBe('≠');

    const decoC = coord.provideFileDecoration(Uri.file('/tmp/repo/c.txt'));
    expect(decoC).toBeUndefined();
  });

  it('omits the badge when showBadges is false', async () => {
    coord.updateSettings({ showBadges: false }, 'origin/main');
    listChanged.mockResolvedValueOnce(['a.txt']);
    await coord.refresh(makeInputs());
    const deco = coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'));
    expect(deco?.badge).toBeUndefined();
  });

  it('returns undefined for URIs outside the repo root', async () => {
    listChanged.mockResolvedValueOnce(['a.txt']);
    await coord.refresh(makeInputs());
    expect(coord.provideFileDecoration(Uri.file('/elsewhere/a.txt'))).toBeUndefined();
  });

  it('skips redundant refresh when the cache key is unchanged', async () => {
    listChanged.mockResolvedValue(['a.txt']);
    const inputs = makeInputs();
    await coord.refresh(inputs);
    expect(listChanged).toHaveBeenCalledTimes(1);

    await coord.refresh(inputs);
    expect(listChanged).toHaveBeenCalledTimes(1);

    await coord.refresh({ ...inputs, mergeBaseSha: 'mb-different' });
    expect(listChanged).toHaveBeenCalledTimes(2);
  });

  // Regression: when a slow git lets a newer refresh start before the
  // older one finishes, the older one must not commit its now-stale set.
  // Otherwise it would leave the old changed-list resident and
  // provideFileDecoration (no key guard) would paint wrong badges.
  it('does not commit the result when isSuperseded reports the refresh was overtaken', async () => {
    listChanged.mockResolvedValueOnce(['stale.txt']);
    await coord.refresh(makeInputs(), () => true);

    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/stale.txt'))).toBeUndefined();
    // The trio was never finalized, so a later refresh is free to run.
    expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'stale.txt')).toBeUndefined();

    listChanged.mockResolvedValueOnce(['fresh.txt']);
    await coord.refresh(makeInputs(), () => false);
    expect(listChanged).toHaveBeenCalledTimes(2);
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/fresh.txt'))).toBeDefined();
  });

  it('clear() empties the set and forces the next refresh to run', async () => {
    listChanged.mockResolvedValueOnce(['a.txt']);
    await coord.refresh(makeInputs());
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'))).toBeDefined();

    coord.clear();
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'))).toBeUndefined();

    listChanged.mockResolvedValueOnce(['a.txt']);
    await coord.refresh(makeInputs());
    expect(listChanged).toHaveBeenCalledTimes(2);
  });

  describe('hasBaseChange', () => {
    it('returns undefined before the changed set has been populated', () => {
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'a.txt')).toBeUndefined();
    });

    it('returns true / false for a populated set at the matching key', async () => {
      listChanged.mockResolvedValueOnce(['a.txt']);
      await coord.refresh(makeInputs());
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'a.txt')).toBe(true);
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'b.txt')).toBe(false);
    });

    it('returns undefined when any of (base, mergeBase, baseTip) does not match the cached key', async () => {
      listChanged.mockResolvedValueOnce(['a.txt']);
      await coord.refresh(makeInputs());
      // Caller asking about a different merge-base — set is stale for them.
      expect(coord.hasBaseChange('origin/main', 'mb-different', 'tip123', 'a.txt')).toBeUndefined();
      expect(coord.hasBaseChange('origin/master', 'mb123', 'tip123', 'a.txt')).toBeUndefined();
      // Same merge-base but the base tip moved (e.g. a fetch fast-forwarded it).
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip-different', 'a.txt')).toBeUndefined();
    });

    it('returns undefined after clear() drops the cached set', async () => {
      listChanged.mockResolvedValueOnce(['a.txt']);
      await coord.refresh(makeInputs());
      coord.clear();
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'a.txt')).toBeUndefined();
    });

    // Regression: a failed fetch must not finalize the cache key as an
    // empty set. If it did, hasBaseChange would report "not changed" for
    // every file (dropping the weak highlight) and the soft cache would
    // refuse to retry until the base moved.
    it('stays "unknown" and retries after a failed fetch', async () => {
      listChanged.mockRejectedValueOnce(new Error('git diff failed'));
      await expect(coord.refresh(makeInputs())).rejects.toThrow();

      // Not finalized: the trio is still unknown, so callers fall back to
      // their own pipeline instead of assuming the file is unchanged.
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'a.txt')).toBeUndefined();

      // Not stuck: the same trio is fetched again rather than short-circuited.
      listChanged.mockResolvedValueOnce(['a.txt']);
      await coord.refresh(makeInputs());
      expect(listChanged).toHaveBeenCalledTimes(2);
      expect(coord.hasBaseChange('origin/main', 'mb123', 'tip123', 'a.txt')).toBe(true);
    });
  });

  it('fires onDidChangeFileDecorations whenever the state changes', async () => {
    const fired: Array<unknown[] | undefined> = [];
    coord.onDidChangeFileDecorations((uris) => fired.push(uris as never));

    listChanged.mockResolvedValueOnce(['a.txt']);
    await coord.refresh(makeInputs());
    expect(fired).toHaveLength(1);

    coord.updateSettings({ showBadges: false }, 'origin/main');
    expect(fired).toHaveLength(2);

    coord.clear();
    expect(fired).toHaveLength(3);
  });

  // The fast path only fires when uri.fsPath sits directly under the
  // realpath'd root (the /tmp/repo cases above). These exercise the parts
  // layered on top of it: NFC key matching and the symlink realpath fallback.
  describe('symlink + Unicode handling', () => {
    let workdir: string;

    beforeEach(() => {
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-lens-deco-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

    it('matches a changed file regardless of Unicode normalization form', async () => {
      const nfc = 'café.ts'; // precomposed é
      const nfd = 'café.ts'; // decomposed e + combining acute
      // Guard: if a formatter ever normalizes these literals to the same
      // form, this test would pass trivially — fail loudly instead.
      expect(nfc).not.toBe(nfd);
      // The changed set arrives in one form; the lookup URI in the other.
      listChanged.mockResolvedValueOnce([nfd]);
      await coord.refresh(makeInputs());

      const deco = coord.provideFileDecoration(Uri.file(`/tmp/repo/${nfc}`));
      expect(deco?.badge).toBe('≠');
    });

    it('resolves the badge through realpath when the workspace path is a symlink', async () => {
      const realRepoRoot = fs.realpathSync(fs.mkdtempSync(path.join(workdir, 'repo-')));
      fs.writeFileSync(path.join(realRepoRoot, 'a.txt'), 'a');
      const linkedRoot = path.join(workdir, 'linked-root');
      fs.symlinkSync(realRepoRoot, linkedRoot);

      listChanged.mockResolvedValueOnce(['a.txt']);
      await coord.refresh({ ...makeInputs(), repoRootPath: realRepoRoot });

      const uriViaLink = Uri.file(path.join(linkedRoot, 'a.txt'));
      // First paint: the raw symlink path is "outside" the realpath'd root,
      // so the fast path misses and the fallback resolves off the paint path.
      expect(coord.provideFileDecoration(uriViaLink)).toBeUndefined();

      // The fallback fires a repaint once the realpath mapping is cached.
      await new Promise<void>((resolve) => {
        const sub = coord.onDidChangeFileDecorations(() => {
          sub.dispose();
          resolve();
        });
      });

      // Second paint: served from the realpath cache → badge appears.
      expect(coord.provideFileDecoration(uriViaLink)?.badge).toBe('≠');
    });
  });
});
