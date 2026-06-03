import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/diff/weak-highlight', () => {
  return {
    loadBaseDiff: vi.fn(),
    applyBaseDiffToBuffer: vi.fn(),
  };
});

import {
  applyBaseDiffToBuffer,
  loadBaseDiff,
  type BaseDiff,
} from '../../../src/diff/weak-highlight';
import { Uri, TextEditorDecorationType } from '../../__mocks__/vscode';
import {
  WeakDecorationCoordinator,
  type WeakHighlightInputs,
} from '../../../src/ui/weak-decoration';

const mockedLoad = vi.mocked(loadBaseDiff);
const mockedApply = vi.mocked(applyBaseDiffToBuffer);

const STUB_BASE_DIFF: BaseDiff = {
  hunks: [],
  leftContent: '',
};

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
  };
}

describe('WeakDecorationCoordinator', () => {
  let coord: WeakDecorationCoordinator;

  beforeEach(() => {
    coord = new WeakDecorationCoordinator(
      { showOverviewRuler: true },
      'origin/main',
    );
    mockedLoad.mockReset();
    mockedApply.mockReset();
    // Default: load returns the stub immediately; tests can override.
    mockedLoad.mockResolvedValue(STUB_BASE_DIFF);
    mockedApply.mockReturnValue([]);
  });

  afterEach(() => {
    coord.dispose();
  });

  it('applies the computed ranges as whole-line decorations', async () => {
    mockedApply.mockReturnValueOnce([
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

  it('embeds the hovered document URI in both hover command links', async () => {
    mockedApply.mockReturnValueOnce([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
    const editor = fakeEditor();
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    const opt = editor._calls[0]!.options[0] as { hoverMessage: { value: string } };
    const value = opt.hoverMessage.value;
    const uri = editor.document.uri.toString();
    // 1-based startLine 2 → 0-based line 1, paired with the URI.
    const showBaseArgs = encodeURIComponent(JSON.stringify([1, uri]));
    const previewArgs = encodeURIComponent(JSON.stringify([uri]));
    expect(value).toContain(
      `command:conflictLens.showBaseChanges?${showBaseArgs}`,
    );
    expect(value).toContain(
      `command:conflictLens.previewConflict?${previewArgs}`,
    );
  });

  it('skips the git-side load on a same-input re-update; only the buffer-side mapping re-runs', async () => {
    mockedApply.mockReturnValueOnce([
      { startLine: 1, endLine: 1, insertion: false },
    ]);
    const editor = fakeEditor();
    const inputs = makeInputs();
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedLoad).toHaveBeenCalledTimes(1);

    // Same editor (same version), same inputs → range cache hit.
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(editor._calls).toHaveLength(2);
  });

  it('reuses the cached base-diff on a new buffer version (no git spawn, mapping re-runs)', async () => {
    mockedApply.mockReturnValue([{ startLine: 1, endLine: 1, insertion: false }]);
    const editor = fakeEditor('a\nb\nc\n', 1);
    const inputs = makeInputs();
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedLoad).toHaveBeenCalledTimes(1);

    // Buffer moved on (simulating a keystroke). Range cache misses but
    // base-diff cache hits → loadBaseDiff is NOT called again.
    editor.document.version = 2;
    await coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs,
    });
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(mockedApply).toHaveBeenCalledTimes(2);
  });

  it('discards stale results when document.version moves during compute', async () => {
    let resolveLoad!: (b: BaseDiff) => void;
    mockedLoad.mockImplementationOnce(
      () =>
        new Promise<BaseDiff>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    mockedApply.mockReturnValueOnce([
      { startLine: 1, endLine: 2, insertion: false },
    ]);
    const editor = fakeEditor('a\nb\nc\n', 5);
    const updatePromise = coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    // Buffer moves on while compute is in flight.
    editor.document.version = 6;
    resolveLoad(STUB_BASE_DIFF);
    await updatePromise;
    // No decoration applied because the version-check at apply-time
    // detected the stale result.
    expect(editor._calls).toHaveLength(0);
  });

  it('coalesces two parallel requests for the same cache key into one compute', async () => {
    let resolveLoad!: (b: BaseDiff) => void;
    mockedLoad.mockImplementationOnce(
      () =>
        new Promise<BaseDiff>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    mockedApply.mockReturnValue([
      { startLine: 1, endLine: 1, insertion: false },
    ]);
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
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    resolveLoad(STUB_BASE_DIFF);
    await Promise.all([p1, p2]);
    expect(mockedLoad).toHaveBeenCalledTimes(1);
  });

  it('skips the git-side load for files past the line-count gate', async () => {
    const editor = fakeEditor();
    editor.document.lineCount = 15_001;
    const result = await coord.update({
      editor: editor as never,
      relativeFilePath: 'generated.txt',
      inputs: makeInputs(),
    });
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(result).toBe('suppressed');
    expect(editor._calls[0]!.options).toEqual([]);
  });

  it('still highlights a file just under the line-count gate', async () => {
    mockedApply.mockReturnValueOnce([{ startLine: 1, endLine: 1, insertion: false }]);
    const editor = fakeEditor();
    editor.document.lineCount = 15_000;
    const result = await coord.update({
      editor: editor as never,
      relativeFilePath: 'big-but-handwritten.ts',
      inputs: makeInputs(),
    });
    expect(mockedLoad).toHaveBeenCalledTimes(1);
    expect(result).toBe('highlighted');
  });

  it('skips the git-side load for files past the char-count gate', async () => {
    const huge = 'x'.repeat(1_500_001);
    const editor = fakeEditor(huge);
    editor.document.lineCount = 1;
    const result = await coord.update({
      editor: editor as never,
      relativeFilePath: 'minified.js',
      inputs: makeInputs(),
    });
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(result).toBe('suppressed');
  });

  it('reports clean when the file is changed-free (empty hunks, not suppressed)', async () => {
    mockedApply.mockReturnValueOnce([]);
    const editor = fakeEditor();
    const result = await coord.update({
      editor: editor as never,
      relativeFilePath: 'unchanged.ts',
      inputs: makeInputs(),
    });
    expect(result).toBe('clean');
  });

  it('refreshVisuals rebuilds the decoration type only when toggles flip', () => {
    const initial = (coord as unknown as { decorationType: TextEditorDecorationType })
      .decorationType;
    const sameVisuals = coord.refreshVisuals(
      { showOverviewRuler: true },
      'origin/main',
    );
    expect(sameVisuals).toBe(false);
    expect(
      (coord as unknown as { decorationType: TextEditorDecorationType }).decorationType,
    ).toBe(initial);

    const changed = coord.refreshVisuals(
      { showOverviewRuler: false },
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
    let resolveLoad!: (b: BaseDiff) => void;
    mockedLoad.mockImplementationOnce(
      () =>
        new Promise<BaseDiff>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    mockedApply.mockReturnValue([
      { startLine: 1, endLine: 1, insertion: false },
    ]);
    const editor = fakeEditor();
    const updatePromise = coord.update({
      editor: editor as never,
      relativeFilePath: 'file.txt',
      inputs: makeInputs(),
    });
    coord.dispose();
    resolveLoad(STUB_BASE_DIFF);
    await updatePromise;
    // No decoration applied — coordinator was disposed mid-flight.
    expect(editor._calls).toHaveLength(0);
    expect(coord.stats().cache.entries).toBe(0);
    expect(coord.stats().inflight).toBe(0);
  });
});
