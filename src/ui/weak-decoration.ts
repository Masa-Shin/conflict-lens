import * as vscode from 'vscode';

import { ByteLruCache } from '../cache/lru';
import {
  computeWeakHighlights,
  type WeakHighlightRange,
} from '../diff/weak-highlight';
import type { GitRunner } from '../git/runner';
import { t } from '../l10n';
import {
  cacheKeyFor,
  escapeMarkdown,
  sizeOfRanges,
} from './weak-decoration-helpers';

export { cacheKeyFor, escapeMarkdown, sizeOfRanges };

/**
 * Snapshot of all the inputs that determine the weak-highlight ranges of
 * a single file. Both the cache key (sans `runner`) and the compute call
 * are derived from this.
 */
export interface WeakHighlightInputs {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly baseBranch: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
}

/** Toggleable visuals. Background color / hover always render. */
export interface WeakDecorationSettings {
  readonly showOverviewRuler: boolean;
  readonly showGutterIcon: boolean;
}

/** Spec §5.4 cache strategy: 16 MiB total / 4 MiB per entry. */
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

export interface UpdateRequest {
  readonly editor: vscode.TextEditor;
  readonly relativeFilePath: string;
  readonly inputs: WeakHighlightInputs;
}

/**
 * Owns the single `TextEditorDecorationType` for weak highlights, plus the
 * LRU cache of computed ranges and the in-flight cancellation map.
 *
 * Designed around three guarantees:
 *  1. A stale compute for an editor never overwrites a newer one. When a
 *     second `update()` arrives for the same cache key, the first is
 *     aborted and any result it produces is discarded.
 *  2. Re-entering an editor that was already computed reads from the LRU
 *     cache and renders synchronously (no spawn).
 *  3. Setting changes that affect visuals (`showGutterIcon`,
 *     `showOverviewRuler`) rebuild the decoration type once; existing
 *     editors must be re-applied externally to pick it up.
 */
export class WeakDecorationCoordinator implements vscode.Disposable {
  private readonly cache: ByteLruCache<string, WeakHighlightRange[]>;
  private readonly inflight = new Map<string, AbortController>();
  private decorationType: vscode.TextEditorDecorationType;
  private settings: WeakDecorationSettings;
  private baseBranchLabel: string;

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

  /**
   * Apply weak highlights to `editor`. Cache-hits render synchronously
   * (one micro-task hop). Cache-misses spawn `computeWeakHighlights` and
   * cancel any in-flight compute for the same cache key.
   */
  async update(request: UpdateRequest): Promise<void> {
    const { editor, relativeFilePath, inputs } = request;
    const key = cacheKeyFor(relativeFilePath, inputs);

    const cached = this.cache.get(key);
    if (cached) {
      this.apply(editor, cached);
      return;
    }

    const previous = this.inflight.get(key);
    if (previous) previous.abort();
    const controller = new AbortController();
    this.inflight.set(key, controller);

    let ranges: WeakHighlightRange[];
    try {
      ranges = await computeWeakHighlights({
        runner: inputs.runner,
        repoRootPath: inputs.repoRootPath,
        baseBranch: inputs.baseBranch,
        mergeBaseSha: inputs.mergeBaseSha,
        relativeFilePath,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      throw err;
    } finally {
      if (this.inflight.get(key) === controller) {
        this.inflight.delete(key);
      }
    }
    if (controller.signal.aborted) return;
    this.cache.set(key, ranges);
    this.apply(editor, ranges);
  }

  /** Remove weak highlights from `editor` without touching the cache. */
  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
  }

  /**
   * Update the visual toggles and/or the base-branch label shown in
   * hovers. Returns `true` if the underlying decoration type was rebuilt
   * (callers should then re-apply to every visible editor).
   */
  refreshVisuals(next: WeakDecorationSettings, baseBranchLabel: string): boolean {
    const visualChanged =
      next.showGutterIcon !== this.settings.showGutterIcon ||
      next.showOverviewRuler !== this.settings.showOverviewRuler;
    const labelChanged = baseBranchLabel !== this.baseBranchLabel;
    if (!visualChanged && !labelChanged) return false;
    this.settings = next;
    this.baseBranchLabel = baseBranchLabel;
    // Decoration type carries gutter / overview-ruler config baked-in, so
    // we have to dispose and recreate it. Hover text is rebuilt per-apply,
    // so the label change alone doesn't require a rebuild.
    if (visualChanged) {
      this.decorationType.dispose();
      this.decorationType = this.buildDecorationType();
    }
    return visualChanged;
  }

  /** Drop all cached results — call when baseBranch / HEAD invariants change. */
  invalidateAll(): void {
    this.cache.clear();
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
  }

  dispose(): void {
    this.decorationType.dispose();
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.cache.clear();
  }

  /** Diagnostic stats (used by debug logging per spec §5.4 observability). */
  stats(): { cache: { entries: number; bytes: number }; inflight: number } {
    return { cache: this.cache.stats(), inflight: this.inflight.size };
  }

  private apply(editor: vscode.TextEditor, ranges: WeakHighlightRange[]): void {
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
      backgroundColor: new vscode.ThemeColor('conflictLens.changedLineBackground'),
    };
    if (this.settings.showGutterIcon) {
      options.gutterIconPath = this.gutterIconUri;
      options.gutterIconSize = 'contain';
    }
    if (this.settings.showOverviewRuler) {
      options.overviewRulerColor = new vscode.ThemeColor(
        'conflictLens.changedLineBackground',
      );
      options.overviewRulerLane = vscode.OverviewRulerLane.Center;
    }
    return vscode.window.createTextEditorDecorationType(options);
  }

  private buildHoverMessage(): vscode.MarkdownString {
    const baseEscaped = escapeMarkdown(this.baseBranchLabel);
    const md = new vscode.MarkdownString(
      t('Changed relative to {0}', baseEscaped),
    );
    // Hover text must never be a trusted MarkdownString: command:?
    // links inside one would otherwise execute when the user hovers.
    md.isTrusted = false;
    return md;
  }
}
