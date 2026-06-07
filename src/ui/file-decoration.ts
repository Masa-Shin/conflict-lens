import * as vscode from 'vscode';

import { listChangedFilesOnBase } from '../git/changed-files';
import { repoRelativePathViaRealpath } from '../git/repository';
import type { GitRunner } from '../git/runner';
import { t } from '../l10n';
import { relativeIfWithin } from './file-decoration-helpers';

export { relativeIfWithin };

/**
 * Normalize a repo-relative path to NFC before comparing against the
 * changed set. macOS can hand back decomposed (NFD) names from the
 * filesystem while git stores precomposed (NFC) bytes; without this an
 * accented name like `café.ts` would miss the lookup. No-op for ASCII.
 */
function normalizeKey(relativePath: string): string {
  return relativePath.normalize('NFC');
}

export interface FileDecorationSettings {
  readonly showBadges: boolean;
}

export interface FileDecorationInputs {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly baseBranch: string;
  readonly mergeBaseSha: string;
  /**
   * Tip of the base branch. Included in the refresh key so that a
   * base-side fast-forward (which leaves the merge-base alone) still
   * triggers a re-fetch of the changed-files set.
   */
  readonly baseTipSha: string;
}

/**
 * Owns the file-tree decoration state and implements VSCode's
 * `FileDecorationProvider`. Tracks `changed`: files the base branch
 * has modified relative to the merge-base — the file-level twin of
 * the weak highlight.
 *
 * `provideFileDecoration` is on the explorer-paint hot path so it does
 * O(1) lookups against a pre-computed set; the git work happens once
 * per state change inside `refresh`. A soft cache keyed by
 * `(baseBranch, mergeBaseSha)` collapses redundant refresh calls into
 * no-ops so an editor-driven refresh does not re-spawn the diff.
 */
export class FileDecorationCoordinator implements vscode.FileDecorationProvider, vscode.Disposable {
  private changed = new Set<string>();
  private settings: FileDecorationSettings;
  private baseBranchLabel = '(no base)';
  /**
   * Memoized decoration. Its content depends only on `settings` and
   * `baseBranchLabel`, so it is built once and reused across every
   * changed node until `updateSettings` invalidates it.
   */
  private cachedDecoration: vscode.FileDecoration | undefined;
  /** Repo root for URI→path conversion. Undefined when no inputs yet. */
  private repoRootPath: string | undefined;
  /**
   * Cache of realpath'd repo-relative paths per Explorer URI (`null` =
   * outside / a symlink / nonexistent). Populated lazily by the
   * symlink-aware fallback so the paint path does its realpath I/O at most
   * once per URI. Cleared when the repo root changes.
   */
  private readonly realpathRelCache = new Map<string, string | null>();
  /** URIs with an in-flight realpath resolve, to dedupe concurrent paints. */
  private readonly realpathInflight = new Set<string>();
  private lastRefreshKey: string | undefined;
  private disposed = false;

  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[] | undefined> =
    this.didChangeEmitter.event;

  constructor(initialSettings: FileDecorationSettings) {
    this.settings = initialSettings;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.disposed) return undefined;
    if (this.changed.size === 0) return undefined;
    if (uri.scheme !== 'file' || !this.repoRootPath) return undefined;
    const root = this.repoRootPath;
    // Fast path: when the workspace is opened at its real location, the raw
    // fsPath is already in the repo's namespace and this answer is final.
    const rel = relativeIfWithin(uri.fsPath, root);
    if (rel !== undefined) {
      return this.changed.has(normalizeKey(rel)) ? this.buildChangedDecoration() : undefined;
    }
    // The raw fsPath looks outside the realpath'd root — either genuinely
    // outside, or the workspace was opened through a symlink so the two
    // namespaces differ. The in-editor highlight path realpaths the file
    // (repoRelativePathViaRealpath), so mirror it here to stay in agreement.
    return this.decorationViaRealpath(uri, root);
  }

  /**
   * Symlink-aware fallback for `provideFileDecoration`. Stays synchronous so
   * the explorer paint never blocks on I/O: a resolved mapping answers from
   * cache, an unresolved one schedules a one-off realpath and repaints just
   * this node once the canonical repo-relative path is known.
   */
  private decorationViaRealpath(uri: vscode.Uri, root: string): vscode.FileDecoration | undefined {
    const cached = this.realpathRelCache.get(uri.fsPath);
    if (cached !== undefined) {
      return cached !== null && this.changed.has(cached)
        ? this.buildChangedDecoration()
        : undefined;
    }
    if (!this.realpathInflight.has(uri.fsPath)) {
      this.realpathInflight.add(uri.fsPath);
      void repoRelativePathViaRealpath(uri.fsPath, root).then((resolved) => {
        this.realpathInflight.delete(uri.fsPath);
        if (this.disposed) return;
        const relKey = resolved === undefined ? null : normalizeKey(resolved);
        this.realpathRelCache.set(uri.fsPath, relKey);
        // Repaint only when the result would actually add a badge; the
        // already-painted "no badge" stays correct otherwise.
        if (relKey !== null && this.changed.has(relKey)) {
          this.didChangeEmitter.fire([uri]);
        }
      });
    }
    return undefined;
  }

  /**
   * Whether the base branch has touched `relativeFilePath` between the
   * merge-base and the base tip, given the caller's view of
   * `(baseBranch, mergeBaseSha)`. Returns `undefined` when the
   * changed-files set has not yet been populated for that pair —
   * callers must treat that as "unknown" and fall back to their normal
   * pipeline rather than assume "not changed."
   *
   * Used by the weak-highlight pipeline as a pre-filter so files the
   * base has not modified can skip the `git diff` spawn entirely.
   */
  hasBaseChange(
    baseBranch: string,
    mergeBaseSha: string,
    baseTipSha: string,
    relativeFilePath: string,
  ): boolean | undefined {
    if (this.lastRefreshKey !== `${baseBranch}|${mergeBaseSha}|${baseTipSha}`) {
      return undefined;
    }
    return this.changed.has(normalizeKey(relativeFilePath));
  }

  /**
   * Recompute `changed` against the given inputs. If the
   * (baseBranch, mergeBaseSha) pair has not moved since the last
   * call the work is skipped — explorer paint hot path stays free
   * of redundant git spawns.
   *
   * `isSuperseded` lets the caller abandon the result after the await:
   * when two refreshes race (a slow git lets a newer one start before
   * the older finishes), the later-finishing one must not commit its
   * set, or it would leave a stale changed-list resident — and
   * `provideFileDecoration` reads `changed` with no key guard, so a
   * stale set repaints wrong badges until the next refresh.
   */
  async refresh(inputs: FileDecorationInputs, isSuperseded?: () => boolean): Promise<void> {
    if (this.disposed) return;
    const key = `${inputs.baseBranch}|${inputs.mergeBaseSha}|${inputs.baseTipSha}`;
    if (key === this.lastRefreshKey) return;

    const changedArr = await listChangedFilesOnBase(
      inputs.runner,
      inputs.repoRootPath,
      inputs.baseBranch,
    );

    if (this.disposed || isSuperseded?.()) return;

    if (this.repoRootPath !== inputs.repoRootPath) {
      // Root moved: previously resolved symlink mappings no longer apply.
      this.realpathRelCache.clear();
    }
    this.repoRootPath = inputs.repoRootPath;
    this.changed = new Set(changedArr.map(normalizeKey));
    this.lastRefreshKey = key;
    this.didChangeEmitter.fire(undefined);
  }

  /**
   * Drop all decorations (e.g. when the extension transitions to an
   * inactive state, when the base branch is unset, or while a rebase
   * is in progress).
   */
  clear(): void {
    if (this.disposed) return;
    if (this.changed.size === 0) return;
    this.changed = new Set();
    this.lastRefreshKey = undefined;
    this.didChangeEmitter.fire(undefined);
  }

  /**
   * Push new visual / label settings. Always refires `onDidChange` so
   * the explorer rebuilds — callers should only invoke this on actual
   * configuration deltas.
   */
  updateSettings(next: FileDecorationSettings, baseBranchLabel: string): void {
    if (this.disposed) return;
    this.settings = next;
    this.baseBranchLabel = baseBranchLabel;
    this.cachedDecoration = undefined;
    this.didChangeEmitter.fire(undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.didChangeEmitter.dispose();
  }

  private buildChangedDecoration(): vscode.FileDecoration {
    return (this.cachedDecoration ??= {
      badge: this.settings.showBadges ? '≠' : undefined,
      tooltip: t('Conflict Lens: changed by {0}', this.baseBranchLabel),
      propagate: true,
    });
  }
}
