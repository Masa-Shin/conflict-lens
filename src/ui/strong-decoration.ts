import * as vscode from 'vscode';

import { ByteLruCache } from '../cache/lru';
import {
  computeStrongHighlights,
  type StrongHighlightRange,
} from '../diff/strong-highlight';
import { t } from '../l10n';
import {
  cacheKeyFor,
  escapeMarkdown,
  sizeOfRanges,
} from './weak-decoration-helpers';
import type {
  WeakDecorationSettings,
  WeakHighlightInputs,
} from './weak-decoration';

/**
 * Strong-highlight inputs are structurally identical to weak: both
 * pipelines need a runner, repo root, base branch, merge-base SHA, and
 * a blob reader. Aliasing keeps the call sites uniform.
 */
export type StrongHighlightInputs = WeakHighlightInputs;

const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

export interface UpdateRequest {
  readonly editor: vscode.TextEditor;
  readonly relativeFilePath: string;
  readonly inputs: StrongHighlightInputs;
}

interface InflightEntry {
  readonly controller: AbortController;
  readonly promise: Promise<StrongHighlightRange[]>;
}

/**
 * Owns the strong-highlight `TextEditorDecorationType` and the per-file
 * LRU cache of predicted-conflict ranges.
 *
 * Mirrors `WeakDecorationCoordinator` in structure (cache key, version
 * check, in-flight coalescing, settings refresh) but applies a red
 * conflict-color decoration and computes via the merge-file pipeline
 * instead of the merge-base diff. The two coordinators run side by
 * side: a line with both decorations renders both backgrounds blended.
 * Suppressing the weak band underneath a strong band is left for a
 * future hardening pass.
 */
export class StrongDecorationCoordinator implements vscode.Disposable {
  private readonly cache: ByteLruCache<string, StrongHighlightRange[]>;
  private readonly inflight = new Map<string, InflightEntry>();
  private decorationType: vscode.TextEditorDecorationType;
  private settings: WeakDecorationSettings;
  private baseBranchLabel: string;
  private disposed = false;

  constructor(
    private readonly gutterIconUri: vscode.Uri,
    initialSettings: WeakDecorationSettings,
    baseBranchLabel: string,
  ) {
    this.cache = new ByteLruCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRY_BYTES, sizeOfRanges);
    this.settings = initialSettings;
    this.baseBranchLabel = baseBranchLabel;
    this.decorationType = this.buildDecorationType();
  }

  async update(request: UpdateRequest): Promise<void> {
    const { editor, relativeFilePath, inputs } = request;
    const document = editor.document;
    const startVersion = document.version;
    const cacheKey = cacheKeyFor(relativeFilePath, inputs, startVersion);

    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.apply(editor, cached);
      return;
    }

    let entry = this.inflight.get(cacheKey);
    if (!entry) {
      entry = this.startCompute(cacheKey, inputs, relativeFilePath, document, startVersion);
    }

    let ranges: StrongHighlightRange[];
    try {
      ranges = await entry.promise;
    } catch (err) {
      if (entry.controller.signal.aborted || this.disposed) return;
      throw err;
    }
    if (entry.controller.signal.aborted || this.disposed) return;
    if (document.isClosed || document.version !== startVersion) return;
    this.apply(editor, ranges);
  }

  private startCompute(
    cacheKey: string,
    inputs: StrongHighlightInputs,
    relativeFilePath: string,
    document: vscode.TextDocument,
    startVersion: number,
  ): InflightEntry {
    const controller = new AbortController();
    const promise = computeStrongHighlights({
      runner: inputs.runner,
      repoRootPath: inputs.repoRootPath,
      baseBranch: inputs.baseBranch,
      mergeBaseSha: inputs.mergeBaseSha,
      relativeFilePath,
      oursContent: document.getText(),
      readBlob: inputs.readBlob,
      largeFileHunkThreshold: inputs.largeFileHunkThreshold,
      signal: controller.signal,
    });
    const entry: InflightEntry = { controller, promise };
    this.inflight.set(cacheKey, entry);

    void promise
      .then((ranges) => {
        if (controller.signal.aborted || this.disposed) return;
        if (document.isClosed || document.version !== startVersion) return;
        this.cache.set(cacheKey, ranges);
      })
      .catch(() => {
        /* surfaced to each awaiter below */
      })
      .finally(() => {
        if (this.inflight.get(cacheKey) === entry) {
          this.inflight.delete(cacheKey);
        }
      });
    return entry;
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
  }

  refreshVisuals(next: WeakDecorationSettings, baseBranchLabel: string): boolean {
    const visualChanged =
      next.showGutterIcon !== this.settings.showGutterIcon ||
      next.showOverviewRuler !== this.settings.showOverviewRuler;
    const labelChanged = baseBranchLabel !== this.baseBranchLabel;
    if (!visualChanged && !labelChanged) return false;
    this.settings = next;
    this.baseBranchLabel = baseBranchLabel;
    if (visualChanged) {
      this.decorationType.dispose();
      this.decorationType = this.buildDecorationType();
    }
    return visualChanged;
  }

  invalidateAll(): void {
    this.cache.clear();
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.decorationType.dispose();
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
    this.cache.clear();
  }

  stats(): { cache: { entries: number; bytes: number }; inflight: number } {
    return { cache: this.cache.stats(), inflight: this.inflight.size };
  }

  private apply(editor: vscode.TextEditor, ranges: StrongHighlightRange[]): void {
    if (ranges.length === 0) {
      editor.setDecorations(this.decorationType, []);
      return;
    }
    const hover = this.buildHoverMessage();
    const lineCount = editor.document.lineCount;
    const decorations: vscode.DecorationOptions[] = [];
    for (const range of ranges) {
      const startLine = Math.max(0, Math.min(range.startLine - 1, lineCount - 1));
      const endLine = Math.max(startLine, Math.min(range.endLine - 1, lineCount - 1));
      decorations.push({
        range: new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER),
        hoverMessage: hover,
      });
    }
    editor.setDecorations(this.decorationType, decorations);
  }

  private buildDecorationType(): vscode.TextEditorDecorationType {
    const options: vscode.DecorationRenderOptions = {
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('conflictLens.conflictLineBackground'),
    };
    if (this.settings.showGutterIcon) {
      options.gutterIconPath = this.gutterIconUri;
      options.gutterIconSize = 'contain';
    }
    if (this.settings.showOverviewRuler) {
      options.overviewRulerColor = new vscode.ThemeColor(
        'conflictLens.conflictLineBackground',
      );
      options.overviewRulerLane = vscode.OverviewRulerLane.Center;
    }
    return vscode.window.createTextEditorDecorationType(options);
  }

  private buildHoverMessage(): vscode.MarkdownString {
    const baseEscaped = escapeMarkdown(this.baseBranchLabel);
    const md = new vscode.MarkdownString(
      t('Will conflict when merging {0}', baseEscaped),
    );
    md.isTrusted = false;
    return md;
  }
}
