import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/diff/weak-highlight', () => {
  return {
    computeWeakHighlights: vi.fn(),
  };
});

import { computeWeakHighlights } from '../../../src/diff/weak-highlight';
import { Uri, TextEditorDecorationType } from '../../__mocks__/vscode';
import {
  WeakDecorationCoordinator,
  type WeakHighlightInputs,
} from '../../../src/ui/weak-decoration';

const mockedCompute = vi.mocked(computeWeakHighlights);

interface FakeDocument {
  version: number;
  isClosed: boolean;
  lineCount: number;
  uri: Uri;
  getText(): string;
}

interface FakeEditor {
  document: FakeDocument;
  setDecorations(
    type: unknown,
    options: ReadonlyArray<{ range: { start: { line: number }; end: { line: number } } }>,
  ): void;
  _calls: Array<{ type: unknown; options: unknown[] }>;
}

function fakeEditor(text = 'a\nb\nc\n', initialVersion = 1): FakeEditor {
  const editor: FakeEditor = {
    document: {
      version: initialVersion,
      isClosed: false,
      lineCount: text.split('\n').length,
      uri: Uri.file('/tmp/repo/file.txt'),
      getText: () => text,
    },
    _calls: [],
    setDecorations(type, options) {
      this._calls.push({ type, options: [...options] });
    },
  };
  return editor;
}

function makeInputs(): WeakHighlightInputs {
  return {
    runner: { gitPath: 'git', run: vi.fn() } as unknown as WeakHighlightInputs['runner'],
    repoRootPath: '/tmp/repo',
    baseBranch: 'origin/main',
    mergeBaseSha: 'mb123',
    readBlob: vi.fn(),
    largeFileHunkThreshold: 200,
  };
}

describe('WeakDecorationCoordinator', () => {
  let coord: WeakDecorationCoordinator;

  beforeEach(() => {
    coord = new WeakDecorationCoordinator(
      Uri.file('/icon.svg'),
      { showOverviewRuler: true, showGutterIcon: true },
      'origin/main',
    );
    mockedCompute.mockReset();
  });

  afterEach(() => {
    coord.dispose();
  });

  it('applies the computed ranges as whole-line decorations', async () => {
    mockedCompute.mockResolvedValueOnce([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
    const editor = fakeEditor();
    await coord.update({
      editor: editor as unknown as Parameters<typeof coord.update>[0]['editor'],
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    expect(editor._calls).toHaveLength(1);
    const call = editor._calls[0]!;
    expect(call.options).toHaveLength(1);
    const opt = (call.options[0] as { range: { start: { line: number }; end: { line: number } } });
    // 1-based startLine 2 → 0-based start.line 1.
    expect(opt.range.start.line).toBe(1);
    expect(opt.range.end.line).toBe(1);
  });

  it('skips compute on the second update when inputs and version match', async () => {
    mockedCompute.mockResolvedValueOnce([
      { startLine: 1, endLine: 1, insertion: false },
    ]);
    const editor = fakeEditor();
    const inputs = makeInputs();
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedCompute).toHaveBeenCalledTimes(1);

    // Same editor (same version), same inputs → cache hit, no recompute.
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedCompute).toHaveBeenCalledTimes(1);
    // Decoration was applied twice — once per call.
    expect(editor._calls).toHaveLength(2);
  });

  it('discards stale results when document.version moves during compute', async () => {
    let resolveCompute!: (r: Array<{ startLine: number; endLine: number; insertion: boolean }>) => void;
    mockedCompute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve as never;
        }),
    );
    const editor = fakeEditor('a\nb\nc\n', 5);
    const updatePromise = coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    // Buffer moves on while compute is in flight.
    editor.document.version = 6;
    resolveCompute([{ startLine: 1, endLine: 2, insertion: false }]);
    await updatePromise;
    // No decoration applied because the version-check at apply-time
    // detected the stale result.
    expect(editor._calls).toHaveLength(0);
  });

  it('coalesces two parallel requests for the same cache key into one compute', async () => {
    let resolveCompute!: (r: Array<{ startLine: number; endLine: number; insertion: boolean }>) => void;
    mockedCompute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompute = resolve as never;
        }),
    );
    const editor = fakeEditor();
    const inputs = makeInputs();
    const p1 = coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    const p2 = coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedCompute).toHaveBeenCalledTimes(1);
    resolveCompute([{ startLine: 1, endLine: 1, insertion: false }]);
    await Promise.all([p1, p2]);
    // Both calls apply (each to the same editor) but compute ran once.
    expect(mockedCompute).toHaveBeenCalledTimes(1);
  });

  it('refreshVisuals rebuilds the decoration type only when toggles flip', () => {
    const initial = (coord as unknown as { decorationType: TextEditorDecorationType })
      .decorationType;
    const sameVisuals = coord.refreshVisuals(
      { showOverviewRuler: true, showGutterIcon: true },
      'origin/main',
    );
    expect(sameVisuals).toBe(false);
    expect(
      (coord as unknown as { decorationType: TextEditorDecorationType }).decorationType,
    ).toBe(initial);

    const changed = coord.refreshVisuals(
      { showOverviewRuler: false, showGutterIcon: true },
      'origin/main',
    );
    expect(changed).toBe(true);
    expect(initial.disposed).toBe(true);
    expect(
      (coord as unknown as { decorationType: TextEditorDecorationType }).decorationType,
    ).not.toBe(initial);
  });

  it('clear() applies an empty decoration set', () => {
    const editor = fakeEditor();
    coord.clear(editor as never);
    expect(editor._calls).toHaveLength(1);
    expect(editor._calls[0]!.options).toEqual([]);
  });

  it('dispose() drops in-flight computes and clears the cache', async () => {
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
    coord.dispose();
    resolveCompute([{ startLine: 1, endLine: 1, insertion: false }]);
    await updatePromise;
    // No decoration applied — coordinator was disposed mid-flight.
    expect(editor._calls).toHaveLength(0);
    expect(coord.stats().cache.entries).toBe(0);
    expect(coord.stats().inflight).toBe(0);
  });
});
