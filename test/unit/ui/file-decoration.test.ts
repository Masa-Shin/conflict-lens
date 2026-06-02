import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(
      coord.provideFileDecoration(Uri.file('/elsewhere/a.txt')),
    ).toBeUndefined();
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
});
