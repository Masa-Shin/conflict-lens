import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/git/changed-files', () => ({
  listChangedFilesOnBase: vi.fn(),
}));
vi.mock('../../../src/git/merge-tree', () => ({
  runMergeTree: vi.fn(),
}));

import { listChangedFilesOnBase } from '../../../src/git/changed-files';
import { runMergeTree } from '../../../src/git/merge-tree';
import { Uri } from '../../__mocks__/vscode';
import {
  FileDecorationCoordinator,
  type FileDecorationInputs,
} from '../../../src/ui/file-decoration';

const listChanged = vi.mocked(listChangedFilesOnBase);
const mergeTree = vi.mocked(runMergeTree);

function makeInputs(): FileDecorationInputs {
  return {
    runner: { gitPath: 'git', run: vi.fn() } as unknown as FileDecorationInputs['runner'],
    repoRootPath: '/tmp/repo',
    baseBranch: 'origin/main',
    mergeBaseSha: 'mb123',
  };
}

describe('FileDecorationCoordinator', () => {
  let coord: FileDecorationCoordinator;

  beforeEach(() => {
    coord = new FileDecorationCoordinator({ showColors: true, showBadges: true });
    listChanged.mockReset();
    mergeTree.mockReset();
  });

  it('returns undefined before any refresh has populated the sets', () => {
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/foo.txt'))).toBeUndefined();
  });

  it('returns the conflicted decoration for files in the merge-tree conflict set', async () => {
    listChanged.mockResolvedValueOnce(['a.txt', 'b.txt']);
    mergeTree.mockResolvedValueOnce({
      kind: 'conflicted',
      treeSha: 't',
      conflictedPaths: ['a.txt'],
    });
    await coord.refresh(makeInputs(), true);

    const decoA = coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'));
    expect(decoA?.badge).toBe('!');
    expect(decoA?.color?.id).toBe('conflictLens.potentialConflictFileForeground');

    const decoB = coord.provideFileDecoration(Uri.file('/tmp/repo/b.txt'));
    expect(decoB?.badge).toBe('Δ');
    expect(decoB?.color?.id).toBe('conflictLens.changedFileForeground');

    const decoC = coord.provideFileDecoration(Uri.file('/tmp/repo/c.txt'));
    expect(decoC).toBeUndefined();
  });

  it('omits the color when showColors is false', async () => {
    coord.updateSettings({ showColors: false, showBadges: true }, 'origin/main');
    listChanged.mockResolvedValueOnce(['a.txt']);
    mergeTree.mockResolvedValueOnce({ kind: 'clean', treeSha: 't' });
    await coord.refresh(makeInputs(), true);
    const deco = coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'));
    expect(deco?.badge).toBe('Δ');
    expect(deco?.color).toBeUndefined();
  });

  it('omits the badge when showBadges is false', async () => {
    coord.updateSettings({ showColors: true, showBadges: false }, 'origin/main');
    listChanged.mockResolvedValueOnce(['a.txt']);
    mergeTree.mockResolvedValueOnce({ kind: 'clean', treeSha: 't' });
    await coord.refresh(makeInputs(), true);
    const deco = coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'));
    expect(deco?.badge).toBeUndefined();
    expect(deco?.color?.id).toBe('conflictLens.changedFileForeground');
  });

  it('returns undefined for URIs outside the repo root', async () => {
    listChanged.mockResolvedValueOnce(['a.txt']);
    mergeTree.mockResolvedValueOnce({ kind: 'clean', treeSha: 't' });
    await coord.refresh(makeInputs(), true);
    expect(
      coord.provideFileDecoration(Uri.file('/elsewhere/a.txt')),
    ).toBeUndefined();
  });

  it('skips redundant refresh when the cache key is unchanged', async () => {
    listChanged.mockResolvedValue(['a.txt']);
    mergeTree.mockResolvedValue({ kind: 'clean', treeSha: 't' });
    const inputs = makeInputs();
    await coord.refresh(inputs, true);
    expect(listChanged).toHaveBeenCalledTimes(1);
    expect(mergeTree).toHaveBeenCalledTimes(1);

    await coord.refresh(inputs, true);
    expect(listChanged).toHaveBeenCalledTimes(1);
    expect(mergeTree).toHaveBeenCalledTimes(1);

    // Strong toggle is part of the key — flipping it triggers a fresh run.
    await coord.refresh(inputs, false);
    expect(listChanged).toHaveBeenCalledTimes(2);
  });

  it('does not invoke merge-tree when strong is disabled', async () => {
    listChanged.mockResolvedValueOnce(['a.txt']);
    await coord.refresh(makeInputs(), false);
    expect(listChanged).toHaveBeenCalledTimes(1);
    expect(mergeTree).not.toHaveBeenCalled();
    const deco = coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'));
    expect(deco?.badge).toBe('Δ');
  });

  it('clear() empties the sets and forces the next refresh to run', async () => {
    listChanged.mockResolvedValueOnce(['a.txt']);
    mergeTree.mockResolvedValueOnce({ kind: 'clean', treeSha: 't' });
    await coord.refresh(makeInputs(), true);
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'))).toBeDefined();

    coord.clear();
    expect(coord.provideFileDecoration(Uri.file('/tmp/repo/a.txt'))).toBeUndefined();

    listChanged.mockResolvedValueOnce(['a.txt']);
    mergeTree.mockResolvedValueOnce({ kind: 'clean', treeSha: 't' });
    await coord.refresh(makeInputs(), true);
    expect(listChanged).toHaveBeenCalledTimes(2);
  });

  it('fires onDidChangeFileDecorations whenever the state changes', async () => {
    const fired: Array<unknown[] | undefined> = [];
    coord.onDidChangeFileDecorations((uris) => fired.push(uris as never));

    listChanged.mockResolvedValueOnce(['a.txt']);
    mergeTree.mockResolvedValueOnce({ kind: 'clean', treeSha: 't' });
    await coord.refresh(makeInputs(), true);
    expect(fired).toHaveLength(1);

    coord.updateSettings({ showColors: false, showBadges: true }, 'origin/main');
    expect(fired).toHaveLength(2);

    coord.clear();
    expect(fired).toHaveLength(3);
  });
});
