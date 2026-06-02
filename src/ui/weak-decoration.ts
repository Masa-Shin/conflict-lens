import * as vscode from 'vscode';

import { ByteLruCache } from '../cache/lru';
import {
  computeWeakHighlights,
  type WeakHighlightRange,
} from '../diff/weak-highlight';
import type { BlobReader } from '../git/blob';
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
 *
 * HEAD SHA is intentionally omitted: with buffer-following the right
 * side is the editor buffer, not the HEAD blob, so a HEAD movement
 * without a buffer change must still hit the cache.
 */
export interface WeakHighlightInputs {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly baseBranch: string;
  readonly mergeBaseSha: string;
  readonly readBlob: BlobReader;
  /**
   * Spec §3.4: suppress line decorations when the base-side diff has
   * more than this many hunks. `0` disables the gate.
   */
  readonly largeFileHunkThreshold: number;
}

/** Toggleable visuals. Background color / hover always render. */
export interface WeakDecorationSettings {
  readonly showOverviewRuler: boolean;
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
 *  3. Setting changes that affect visuals (`showOverviewRuler`) rebuild
 *     the decoration type once; existing editors must be re-applied
 *     externally to pick it up.
 */
interface InflightEntry {
  readonly controller: AbortController;
  readonly promise: Promise<WeakHighlightRange[]>;
}

export class WeakDecorationCoordinator implements vscode.Disposable {
  private readonly cache: ByteLruCache<string, WeakHighlightRange[]>;
  /**
   * Active computes keyed by cache key. A second request for the same
   * key (e.g. two split editors showing the same document at the same
   * version) attaches to the existing promise instead of spawning a
   * second git process. Aborted only by `invalidateAll` / `dispose`;
   * stale-result protection is provided by the post-await version check
   * rather than per-event cancellation.
   */
  private readonly inflight = new Map<string, InflightEntry>();
  private decorationType: vscode.TextEditorDecorationType;
  private settings: WeakDecorationSettings;
  private baseBranchLabel: string;
  private disposed = false;

  constructor(
    initialSettings: WeakDecorationSettings,
    baseBranchLabel: string,
  ) {
    this.cache = new ByteLruCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRY_BYTES, sizeOfRanges);
    this.settings = initialSettings;
    this.baseBranchLabel = baseBranchLabel;
    this.decorationType = this.buildDecorationType();
  }

  /**
   * Apply weak highlights to `editor`. Cache-hits render synchronously.
   * Cache-misses spawn `computeWeakHighlights` (or attach to an in-flight
   * one with the same key). After awaiting we verify that the editor's
   * document is still at the version we started with; otherwise the
   * buffer has moved on and the result is discarded.
   */
  async update(request: UpdateRequest): Promise<boolean> {
    const { editor, relativeFilePath, inputs } = request;
    const document = editor.document;
    const startVersion = document.version;
    const ranges = await this.computeRanges(relativeFilePath, inputs, document);
    if (this.disposed) return false;
    // If the buffer moved on we skip the apply, but the computed ranges are
    // still the best available signal for "does this file have highlights"
    // (the visible decorations are from a near-identical version) — a fresh
    // refresh for the new version is already on its way.
    if (document.isClosed || document.version !== startVersion) {
      return ranges.length > 0;
    }
    this.applyRanges(editor, ranges);
    return ranges.length > 0;
  }

  /**
   * Cache-aware compute. Does not touch the editor. Returns `[]` when
   * the underlying compute is cancelled or fails in a way the
   * coordinator wants to swallow.
   */
  async computeRanges(
    relativeFilePath: string,
    inputs: WeakHighlightInputs,
    document: vscode.TextDocument,
  ): Promise<WeakHighlightRange[]> {
    const startVersion = document.version;
    const cacheKey = cacheKeyFor(relativeFilePath, inputs, startVersion);

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let entry = this.inflight.get(cacheKey);
    if (!entry) {
      entry = this.startCompute(cacheKey, inputs, relativeFilePath, document, startVersion);
    }
    try {
      return await entry.promise;
    } catch (err) {
      if (entry.controller.signal.aborted || this.disposed) return [];
      throw err;
    }
  }

  /**
   * Apply pre-computed ranges. Idempotent — calling with `[]` clears
   * the editor's weak decorations.
   */
  applyRanges(editor: vscode.TextEditor, ranges: WeakHighlightRange[]): void {
    this.apply(editor, ranges);
  }

  private startCompute(
    cacheKey: string,
    inputs: WeakHighlightInputs,
    relativeFilePath: string,
    document: vscode.TextDocument,
    startVersion: number,
  ): InflightEntry {
    const controller = new AbortController();
    const promise = computeWeakHighlights({
      runner: inputs.runner,
      repoRootPath: inputs.repoRootPath,
      baseBranch: inputs.baseBranch,
      mergeBaseSha: inputs.mergeBaseSha,
      relativeFilePath,
      rightContent: document.getText(),
      readBlob: inputs.readBlob,
      largeFileHunkThreshold: inputs.largeFileHunkThreshold,
      signal: controller.signal,
    });
    const entry: InflightEntry = { controller, promise };
    this.inflight.set(cacheKey, entry);

    void promise
      .then((ranges) => {
        // Only populate the cache if the result is still valid. Caching
        // a result computed against a now-stale buffer would be served
        // to other editors on a future cache hit even after the user
        // has typed past it.
        if (controller.signal.aborted || this.disposed) return;
        if (document.isClosed || document.version !== startVersion) return;
        this.cache.set(cacheKey, ranges);
      })
      .catch(() => {
        // Errors are surfaced to each awaiter individually; here we only
        // need to make sure the unhandled-rejection slot is silenced.
      })
      .finally(() => {
        if (this.inflight.get(cacheKey) === entry) {
          this.inflight.delete(cacheKey);
        }
      });
    return entry;
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

  /** Drop all cached results — call when baseBranch / merge-base changes. */
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
    md.appendMarkdown(
      `\n\n[${t('Show base changes')}](command:conflictLens.showBaseChanges)` +
        ` · [${t('Preview conflict')}](command:conflictLens.previewConflict)`,
    );
    // Whitelist only our own commands so generic `command:?` URIs cannot
    // execute when the user hovers a decoration in a hostile workspace.
    md.isTrusted = {
      enabledCommands: [
        'conflictLens.showBaseChanges',
        'conflictLens.previewConflict',
      ],
    };
    return md;
  }
}
