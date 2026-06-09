import * as vscode from 'vscode';

import { ByteLruCache } from '../cache/lru';
import {
  applyBaseDiffToBuffer,
  loadBaseDiff,
  type BaseDiff,
  type WeakHighlightRange,
} from '../diff/weak-highlight';
import type { BlobReader } from '../git/blob';
import type { GitRunner } from '../git/runner';
import { t } from '../l10n';
import { cacheKeyFor, escapeMarkdown, sizeOfRanges } from './weak-decoration-helpers';

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
  /**
   * Tip of the base branch. The base-side diff
   * `git diff <mergeBaseSha> <baseBranch>` produces different output as
   * soon as this moves (e.g. a `git fetch` fast-forwards the base), so
   * the value is part of the cache key. The base-branch *name* is
   * unchanged in that scenario; without the tip SHA the cache would
   * return stale hunks until the next merge-base shift.
   */
  readonly baseTipSha: string;
  readonly readBlob: BlobReader;
}

/** Toggleable visuals. Background color / hover always render. */
export interface WeakDecorationSettings {
  readonly showOverviewRuler: boolean;
}

/** Spec §5.4 cache strategy: 16 MiB total / 4 MiB per entry. */
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/**
 * Separate budget for the base-diff cache. Each entry holds the
 * merge-base blob plus a small hunk list, so it can be considerably
 * larger than the range cache's per-entry payload. Kept distinct from
 * the range cache so eviction policies do not fight each other.
 */
const BASE_DIFF_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const BASE_DIFF_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

/**
 * A file past either of these limits is treated as generated rather than
 * hand-written: weak highlights add no value there, so we bail before any
 * git work. Gating up front (on values the editor already holds) skips the
 * `git diff`/`git show` spawn entirely and, just as importantly, skips the
 * per-keystroke in-memory line diff (`buildLineMapping`, roughly O(N×D)).
 * It also keeps the base-diff cache from thrashing on a merge-base blob too
 * large to store. The char limit sits well under the base-diff cache's
 * per-entry cap (~2M chars at `length * 2`) so every file we *do* process
 * stays cacheable.
 */
const MAX_HIGHLIGHT_LINES = 15_000;
const MAX_HIGHLIGHT_CHARS = 1_500_000;

function sizeOfBaseDiff(entry: BaseDiff): number {
  return entry.leftContent.length * 2 + entry.hunks.length * 32;
}

function baseDiffKey(
  baseBranch: string,
  mergeBaseSha: string,
  baseTipSha: string,
  relativeFilePath: string,
): string {
  return `${baseBranch}|${mergeBaseSha}|${baseTipSha}|${relativeFilePath}`;
}

export interface UpdateRequest {
  readonly editor: vscode.TextEditor;
  readonly relativeFilePath: string;
  readonly inputs: WeakHighlightInputs;
}

/**
 * Outcome of an `update` for the active editor:
 *  - `highlighted` — at least one weak highlight was applied.
 *  - `clean` — the file is unchanged on the base side (nothing to show).
 *  - `suppressed` — the file *is* changed on the base side, but highlights
 *    were withheld because it is too large to be hand-written. Callers
 *    surface this so the user can tell "no highlights" apart from
 *    "highlights deliberately off".
 */
export type HighlightOutcome = 'highlighted' | 'clean' | 'suppressed';

/**
 * Cached unit of work. `ranges` drives the decorations; `suppressed`
 * records that the empty `ranges` is a deliberate withholding rather than
 * a genuinely clean file, so it survives cache hits.
 */
interface ComputedRanges {
  readonly ranges: WeakHighlightRange[];
  readonly suppressed: boolean;
}

function sizeOfComputed(result: ComputedRanges): number {
  return sizeOfRanges(result.ranges) + 8;
}

function outcomeOf(result: ComputedRanges): HighlightOutcome {
  if (result.ranges.length > 0) return 'highlighted';
  return result.suppressed ? 'suppressed' : 'clean';
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
  readonly promise: Promise<ComputedRanges>;
}

export class WeakDecorationCoordinator implements vscode.Disposable {
  private readonly cache: ByteLruCache<string, ComputedRanges>;
  /**
   * Cache of base-side work keyed on `(base, mergeBaseSha, threshold,
   * file)` — none of which move when the user types. A cache hit means
   * the per-keystroke refresh skips `git diff` and `git show` entirely
   * and only does the in-memory mapping step.
   */
  private readonly baseDiffCache: ByteLruCache<string, BaseDiff>;
  /**
   * In-flight `loadBaseDiff` calls keyed the same way as
   * `baseDiffCache`. Multiple concurrent refreshes for the same file at
   * the same base/merge-base attach to the existing promise rather than
   * each spawning their own git process.
   */
  private readonly baseDiffInflight = new Map<string, Promise<BaseDiff>>();
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

  constructor(initialSettings: WeakDecorationSettings, baseBranchLabel: string) {
    this.cache = new ByteLruCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRY_BYTES, sizeOfComputed);
    this.baseDiffCache = new ByteLruCache(
      BASE_DIFF_CACHE_MAX_BYTES,
      BASE_DIFF_CACHE_MAX_ENTRY_BYTES,
      sizeOfBaseDiff,
    );
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
  async update(request: UpdateRequest): Promise<HighlightOutcome> {
    const { editor, relativeFilePath, inputs } = request;
    const document = editor.document;
    const startVersion = document.version;
    const result = await this.computeRanges(relativeFilePath, inputs, document);
    if (this.disposed) return 'clean';
    // If the buffer moved on we skip the apply, but the computed result is
    // still the best available signal for the active-editor outcome (the
    // visible decorations are from a near-identical version) — a fresh
    // refresh for the new version is already on its way.
    if (document.isClosed || document.version !== startVersion) {
      return outcomeOf(result);
    }
    this.applyRanges(editor, result.ranges);
    return outcomeOf(result);
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
  ): Promise<ComputedRanges> {
    const startVersion = document.version;
    const cacheKey = cacheKeyFor(relativeFilePath, inputs, startVersion);

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let entry = this.inflight.get(cacheKey);
    if (!entry) {
      const rightContent = document.getText();
      if (document.lineCount > MAX_HIGHLIGHT_LINES || rightContent.length > MAX_HIGHLIGHT_CHARS) {
        // Too large to be hand-written; skip the git-side work. Mark it
        // suppressed (not clean) so the UI can flag that highlights were
        // withheld, and cache it so a same-version re-entry stays free.
        const result: ComputedRanges = { ranges: [], suppressed: true };
        this.cache.set(cacheKey, result);
        return result;
      }
      entry = this.startCompute(
        cacheKey,
        inputs,
        relativeFilePath,
        document,
        startVersion,
        rightContent,
      );
    }
    try {
      return await entry.promise;
    } catch (err) {
      if (entry.controller.signal.aborted || this.disposed) {
        return { ranges: [], suppressed: false };
      }
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
    rightContent: string,
  ): InflightEntry {
    const controller = new AbortController();
    const promise = this.getBaseDiff(inputs, relativeFilePath, controller.signal).then(
      (baseDiff): ComputedRanges => ({
        ranges: applyBaseDiffToBuffer(baseDiff, rightContent),
        // The compute path never withholds; only the up-front size gate in
        // `computeRanges` produces a suppressed result.
        suppressed: false,
      }),
    );
    const entry: InflightEntry = { controller, promise };
    this.inflight.set(cacheKey, entry);

    void promise
      .then((result) => {
        // Only populate the cache if the result is still valid. Caching
        // a result computed against a now-stale buffer would be served
        // to other editors on a future cache hit even after the user
        // has typed past it.
        if (controller.signal.aborted || this.disposed) return;
        if (document.isClosed || document.version !== startVersion) return;
        this.cache.set(cacheKey, result);
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

  /**
   * Return the base-side work for this file, hitting the cache when
   * available. The cache is keyed on values that do not move during
   * typing, so the per-keystroke path stays free of git spawns once a
   * file has been seen at the current `(base, mergeBaseSha)`.
   */
  private async getBaseDiff(
    inputs: WeakHighlightInputs,
    relativeFilePath: string,
    signal: AbortSignal,
  ): Promise<BaseDiff> {
    const key = baseDiffKey(
      inputs.baseBranch,
      inputs.mergeBaseSha,
      inputs.baseTipSha,
      relativeFilePath,
    );
    const cached = this.baseDiffCache.get(key);
    if (cached) return cached;
    const inflight = this.baseDiffInflight.get(key);
    if (inflight) return inflight;
    let promise!: Promise<BaseDiff>;
    promise = (async () => {
      try {
        const baseDiff = await loadBaseDiff({
          runner: inputs.runner,
          repoRootPath: inputs.repoRootPath,
          baseBranch: inputs.baseBranch,
          mergeBaseSha: inputs.mergeBaseSha,
          relativeFilePath,
          readBlob: inputs.readBlob,
          signal,
        });
        // The up-front gate only sees the buffer (right side). If the
        // merge-base blob (left side) is huge, the entry exceeds the cache's
        // per-entry cap and would be rejected — so it would re-spawn git and
        // re-read the blob on every keystroke. Cache a small empty sentinel
        // instead: no highlights for that file, but no per-keystroke thrash.
        const cacheable =
          sizeOfBaseDiff(baseDiff) <= BASE_DIFF_CACHE_MAX_ENTRY_BYTES
            ? baseDiff
            : { hunks: [], leftContent: '' };
        if (!this.disposed && !signal.aborted) {
          this.baseDiffCache.set(key, cacheable);
        }
        return cacheable;
      } finally {
        if (this.baseDiffInflight.get(key) === promise) {
          this.baseDiffInflight.delete(key);
        }
      }
    })();
    this.baseDiffInflight.set(key, promise);
    return promise;
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
    const visualChanged = next.showOverviewRuler !== this.settings.showOverviewRuler;
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
    this.baseDiffCache.clear();
    this.baseDiffInflight.clear();
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.decorationType.dispose();
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
    this.cache.clear();
    this.baseDiffCache.clear();
    this.baseDiffInflight.clear();
  }

  /** Exposed for unit tests asserting the cache/inflight state after clear. */
  stats(): { cache: { entries: number; bytes: number }; inflight: number } {
    return { cache: this.cache.stats(), inflight: this.inflight.size };
  }

  private apply(editor: vscode.TextEditor, ranges: WeakHighlightRange[]): void {
    if (ranges.length === 0) {
      editor.setDecorations(this.decorationType, []);
      return;
    }
    const lineCount = editor.document.lineCount;
    const decorations: vscode.DecorationOptions[] = [];
    for (const range of ranges) {
      const startLine = Math.max(0, Math.min(range.startLine - 1, lineCount - 1));
      const endLine = Math.max(startLine, Math.min(range.endLine - 1, lineCount - 1));
      decorations.push({
        range: new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER),
        hoverMessage: this.buildHoverMessage(startLine, editor.document.uri),
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
      options.overviewRulerColor = new vscode.ThemeColor('conflictLens.changedLineBackground');
      options.overviewRulerLane = vscode.OverviewRulerLane.Center;
    }
    return vscode.window.createTextEditorDecorationType(options);
  }

  private buildHoverMessage(startLine: number, documentUri: vscode.Uri): vscode.MarkdownString {
    const baseEscaped = escapeMarkdown(this.baseBranchLabel);
    const md = new vscode.MarkdownString(t('Changed relative to {0}', baseEscaped));
    // Carry the hovered document's URI in the command args. Hovering does
    // not move focus, so in a split layout `vscode.window.activeTextEditor`
    // can point at a different file than the one under the cursor; without
    // this the commands would act on the wrong file (and the diff would
    // scroll a stale buffer to the hovered line). The first arg of
    // showBaseChanges is the hovered hunk's first line (0-based) so the diff
    // editor opens scrolled to that spot rather than always at file top.
    const uri = documentUri.toString();
    const showBaseArgs = encodeURIComponent(JSON.stringify([startLine, uri]));
    const previewArgs = encodeURIComponent(JSON.stringify([uri]));
    md.appendMarkdown(
      `\n\n[${t('Show base changes')}](command:conflictLens.showBaseChanges?${showBaseArgs})` +
        ` · [${t('Preview conflict')}](command:conflictLens.previewConflict?${previewArgs})`,
    );
    // Whitelist only our own commands so generic `command:?` URIs cannot
    // execute when the user hovers a decoration in a hostile workspace.
    md.isTrusted = {
      enabledCommands: ['conflictLens.showBaseChanges', 'conflictLens.previewConflict'],
    };
    return md;
  }
}
