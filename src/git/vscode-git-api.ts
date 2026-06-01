import type { Event, Uri } from 'vscode';

/**
 * Thin type definitions for the bits of the built-in vscode.git API that this
 * extension uses. Mirrors the (internal, but stable since v1.x) shape of
 * `extension.exports.getAPI(1)`. Only the surface area Conflict Lens needs
 * is declared so that the rest of the codebase can rely on a typed
 * interface instead of `any`.
 *
 * Source of truth: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
export interface VscodeGitApi {
  readonly git: {
    /** Resolved path to the git executable, honoring user's `git.path` setting. */
    readonly path: string;
  };
  readonly repositories: readonly VscodeGitRepository[];
  readonly onDidOpenRepository: Event<VscodeGitRepository>;
  readonly onDidCloseRepository: Event<VscodeGitRepository>;
}

export interface VscodeGitFetchOptions {
  readonly remote?: string;
  readonly ref?: string;
  readonly depth?: number;
  readonly prune?: boolean;
}

export interface VscodeGitRepository {
  readonly rootUri: Uri;
  readonly state: VscodeGitRepositoryState;
  /**
   * Modern vscode.git surfaces a single `fetch(options)` overload.
   * Declared optional so we can detect at runtime whether the running
   * VSCode version supports it; the auto-fetch path falls back to the
   * runner when not present.
   */
  fetch?(options?: VscodeGitFetchOptions): Promise<void>;
}

export interface VscodeGitRepositoryState {
  readonly HEAD: VscodeGitBranch | undefined;
  readonly onDidChange: Event<void>;
}

export interface VscodeGitBranch {
  readonly name?: string;
  readonly commit?: string;
}
