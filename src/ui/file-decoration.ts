import * as vscode from 'vscode';

import { listChangedFilesOnBase } from '../git/changed-files';
import { runMergeTree } from '../git/merge-tree';
import type { GitRunner } from '../git/runner';
import { t } from '../l10n';
import { relativeIfWithin } from './file-decoration-helpers';

export { relativeIfWithin };

export interface FileDecorationSettings {
  readonly showColors: boolean;
  readonly showBadges: boolean;
}

export interface FileDecorationInputs {
  readonly runner: GitRunner;
  readonly repoRootPath: string;
  readonly baseBranch: string;
  readonly mergeBaseSha: string;
}

/**
 * Owns the file-tree decoration state and implements VSCode's
 * `FileDecorationProvider`. Two sets are tracked:
 *  - `changed`: files the base branch has modified relative to the
 *    merge-base — the file-level twin of the weak highlight.
 *  - `conflicted`: files that `git merge-tree` predicts will conflict
 *    when the merge runs — the file-level twin of the strong highlight.
 *
 * `provideFileDecoration` is on the explorer-paint hot path so it does
 * O(1) lookups against pre-computed sets; the git work happens once
 * per state change inside `refresh`. A soft cache keyed by
 * `(baseBranch, mergeBaseSha, strongEnabled)` collapses redundant
 * refresh calls into no-ops so an editor-driven refresh does not
 * re-spawn merge-tree.
 */
export class FileDecorationCoordinator
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private changed = new Set<string>();
  private conflicted = new Set<string>();
  private settings: FileDecorationSettings;
  private baseBranchLabel = '(no base)';
  /** Repo root for URI→path conversion. Undefined when no inputs yet. */
  private repoRootPath: string | undefined;
  private lastRefreshKey: string | undefined;
  private disposed = false;

  private readonly didChangeEmitter = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[] | undefined> =
    this.didChangeEmitter.event;

  constructor(initialSettings: FileDecorationSettings) {
    this.settings = initialSettings;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (this.disposed) return undefined;
    if (uri.scheme !== 'file' || !this.repoRootPath) return undefined;
    const rel = relativeIfWithin(uri.fsPath, this.repoRootPath);
    if (rel === undefined) return undefined;
    if (this.conflicted.has(rel)) return this.buildConflictedDecoration();
    if (this.changed.has(rel)) return this.buildChangedDecoration();
    return undefined;
  }

  /**
   * Recompute `changed` and `conflicted` against the given inputs. If
   * the (baseBranch, mergeBaseSha, strongEnabled) triple has not moved
   * since the last call the work is skipped — explorer paint hot path
   * stays free of redundant git spawns.
   */
  async refresh(inputs: FileDecorationInputs, strongEnabled: boolean): Promise<void> {
    if (this.disposed) return;
    const key = `${inputs.baseBranch}|${inputs.mergeBaseSha}|${strongEnabled ? '1' : '0'}`;
    if (key === this.lastRefreshKey) return;

    const [changedArr, mergeTreeResult] = await Promise.all([
      listChangedFilesOnBase(inputs.runner, inputs.repoRootPath, inputs.baseBranch),
      strongEnabled
        ? runMergeTree(inputs.runner, inputs.repoRootPath, inputs.baseBranch)
        : Promise.resolve({ kind: 'clean' as const, treeSha: '' }),
    ]);

    this.repoRootPath = inputs.repoRootPath;
    this.changed = new Set(changedArr);
    this.conflicted =
      mergeTreeResult.kind === 'conflicted'
        ? new Set(mergeTreeResult.conflictedPaths)
        : new Set();
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
    if (this.changed.size === 0 && this.conflicted.size === 0) return;
    this.changed = new Set();
    this.conflicted = new Set();
    this.lastRefreshKey = undefined;
    this.didChangeEmitter.fire(undefined);
  }

  /**
   * Push new visual / label settings. Always refires `onDidChange` so
   * the explorer rebuilds — callers should only invoke this on actual
   * configuration deltas.
   */
  updateSettings(
    next: FileDecorationSettings,
    baseBranchLabel: string,
  ): void {
    if (this.disposed) return;
    this.settings = next;
    this.baseBranchLabel = baseBranchLabel;
    this.didChangeEmitter.fire(undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.didChangeEmitter.dispose();
  }

  private buildChangedDecoration(): vscode.FileDecoration {
    return {
      badge: this.settings.showBadges ? 'Δ' : undefined,
      color: this.settings.showColors
        ? new vscode.ThemeColor('conflictLens.changedFileForeground')
        : undefined,
      tooltip: t('Conflict Lens: changed by {0}', this.baseBranchLabel),
      propagate: true,
    };
  }

  private buildConflictedDecoration(): vscode.FileDecoration {
    return {
      badge: this.settings.showBadges ? '!' : undefined,
      color: this.settings.showColors
        ? new vscode.ThemeColor('conflictLens.potentialConflictFileForeground')
        : undefined,
      tooltip: t('Conflict Lens: will conflict on merge with {0}', this.baseBranchLabel),
      propagate: true,
    };
  }
}

