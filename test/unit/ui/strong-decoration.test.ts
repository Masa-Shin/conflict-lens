import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/diff/strong-highlight', () => ({
  computeStrongHighlights: vi.fn(),
}));

import { computeStrongHighlights } from '../../../src/diff/strong-highlight';
import { Uri, TextEditorDecorationType } from '../../__mocks__/vscode';
import {
  StrongDecorationCoordinator,
  type StrongHighlightInputs,
} from '../../../src/ui/strong-decoration';

const mockedCompute = vi.mocked(computeStrongHighlights);

function fakeEditor(): {
  document: { version: number; isClosed: boolean; lineCount: number; uri: Uri; getText(): string };
  setDecorations(type: unknown, options: unknown[]): void;
  _calls: Array<{ type: unknown; options: unknown[] }>;
} {
  return {
    document: {
      version: 1,
      isClosed: false,
      lineCount: 3,
      uri: Uri.file('/tmp/repo/file.txt'),
      getText: () => 'a\nb\nc\n',
    },
    _calls: [],
    setDecorations(type, options) {
      this._calls.push({ type, options: [...options] });
    },
  };
}

function makeInputs(): StrongHighlightInputs {
  return {
    runner: { gitPath: 'git', run: vi.fn() } as unknown as StrongHighlightInputs['runner'],
    repoRootPath: '/tmp/repo',
    baseBranch: 'origin/main',
    mergeBaseSha: 'mb123',
    readBlob: vi.fn(),
    baseChangedFiles: new Set(['file.txt']),
    largeFileHunkThreshold: 200,
  };
}

describe('StrongDecorationCoordinator', () => {
  let coord: StrongDecorationCoordinator;

  beforeEach(() => {
    coord = new StrongDecorationCoordinator(
      Uri.file('/icon.svg'),
      { showOverviewRuler: true, showGutterIcon: true },
      'origin/main',
    );
    mockedCompute.mockReset();
  });

  afterEach(() => {
    coord.dispose();
  });

  it('routes compute through computeStrongHighlights, not weak', async () => {
    mockedCompute.mockResolvedValueOnce([
      { startLine: 1, endLine: 2, insertion: false },
    ]);
    const editor = fakeEditor();
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    expect(mockedCompute).toHaveBeenCalledTimes(1);
    expect(editor._calls).toHaveLength(1);
  });

  it('uses the conflict-color theme and triangle icon for the decoration type', () => {
    const decoration = (coord as unknown as { decorationType: TextEditorDecorationType })
      .decorationType;
    expect(decoration.options.isWholeLine).toBe(true);
    const bg = decoration.options.backgroundColor as { id: string };
    expect(bg.id).toBe('conflictLens.conflictLineBackground');
    expect(decoration.options.gutterIconPath).toBeDefined();
    const ruler = decoration.options.overviewRulerColor as { id: string };
    expect(ruler.id).toBe('conflictLens.conflictLineBackground');
  });

  it('honors the version-check guard for stale results', async () => {
    let resolveCompute!: (r: Array<{ startLine: number; endLine: number; insertion: boolean }>) => void;
    mockedCompute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve as never;
        }),
    );
    const editor = fakeEditor();
    const updatePromise = coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    editor.document.version = 99;
    resolveCompute([{ startLine: 1, endLine: 1, insertion: false }]);
    await updatePromise;
    expect(editor._calls).toHaveLength(0);
  });
});
