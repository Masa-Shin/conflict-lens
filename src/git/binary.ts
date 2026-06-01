import { createGitRunner, type GitRunner } from './runner';
import type { VscodeGitApi } from './vscode-git-api';

export interface ParsedGitVersion {
  /** e.g. "2.45.2" */
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface GitEnvironment {
  readonly runner: GitRunner;
  readonly version: ParsedGitVersion;
  /** True iff version >= 2.38 (supports `merge-tree --write-tree`). */
  readonly supportsConflictPrediction: boolean;
}

export type GitEnvironmentResult =
  | { readonly kind: 'ok'; readonly environment: GitEnvironment }
  | { readonly kind: 'vscode-git-unavailable'; readonly reason: string }
  | { readonly kind: 'git-not-found'; readonly reason: string }
  | { readonly kind: 'git-too-old'; readonly version: ParsedGitVersion };

/** Minimum git version required for any feature (because of `--merge-base`). */
export const MIN_GIT_VERSION: { major: number; minor: number } = { major: 2, minor: 30 };
/** Minimum git version required for strong (conflict prediction) highlighting. */
export const STRONG_HIGHLIGHT_MIN_VERSION: { major: number; minor: number } = {
  major: 2,
  minor: 38,
};

/**
 * Holder for a vscode.Extension-shaped object. We accept the bare minimum so
 * the function can be unit-tested without depending on the real `vscode`
 * module (the extension passes `vscode.extensions.getExtension('vscode.git')`).
 */
export interface VscodeExtensionLike {
  readonly isActive: boolean;
  /**
   * Returns a thenable. Typed as PromiseLike (not Promise) so this interface
   * is structurally assignable from `vscode.Extension<T>` whose activate()
   * returns the vscode-specific `Thenable<T>` type.
   */
  activate(): PromiseLike<unknown>;
  readonly exports: { getAPI(version: number): VscodeGitApi } | undefined;
}

/**
 * Resolve the git binary path via `vscode.git` and verify its version.
 *
 * Steps:
 *  1. Activate vscode.git if needed; surface "vscode-git-unavailable" otherwise.
 *  2. Read `gitApi.git.path`; if missing, surface "git-not-found".
 *  3. Run `git --version`; if it fails to spawn, surface "git-not-found".
 *  4. Parse the version string; reject versions below MIN_GIT_VERSION.
 *  5. Otherwise return an `ok` environment with a flag indicating whether
 *     strong highlighting (>=2.38) is available.
 *
 * The caller is responsible for turning each non-`ok` variant into the
 * appropriate user feedback (status bar text, notification, etc.).
 */
export async function resolveGitEnvironment(
  vscodeGitExt: VscodeExtensionLike | undefined,
): Promise<GitEnvironmentResult> {
  if (!vscodeGitExt) {
    return {
      kind: 'vscode-git-unavailable',
      reason: 'Built-in vscode.git extension was not found.',
    };
  }

  if (!vscodeGitExt.isActive) {
    try {
      await vscodeGitExt.activate();
    } catch (err) {
      return {
        kind: 'vscode-git-unavailable',
        reason: `Failed to activate vscode.git: ${stringifyError(err)}`,
      };
    }
  }

  const exportsObj = vscodeGitExt.exports;
  if (!exportsObj || typeof exportsObj.getAPI !== 'function') {
    return {
      kind: 'vscode-git-unavailable',
      reason: 'vscode.git did not expose getAPI(version).',
    };
  }

  let gitApi: VscodeGitApi;
  try {
    gitApi = exportsObj.getAPI(1);
  } catch (err) {
    return {
      kind: 'vscode-git-unavailable',
      reason: `vscode.git getAPI(1) threw: ${stringifyError(err)}`,
    };
  }

  const gitPath: string | undefined = gitApi.git?.path;
  if (typeof gitPath !== 'string' || gitPath.length === 0) {
    return {
      kind: 'git-not-found',
      reason: 'vscode.git did not provide a git executable path.',
    };
  }

  const runner = createGitRunner(gitPath);

  let result;
  try {
    result = await runner.run(['--version'], { cwd: process.cwd() });
  } catch (err) {
    return {
      kind: 'git-not-found',
      reason: `Failed to spawn ${gitPath}: ${stringifyError(err)}`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      kind: 'git-not-found',
      reason: `git --version exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }

  const version = parseGitVersion(result.stdout);
  if (!version) {
    return {
      kind: 'git-not-found',
      reason: `Could not parse git version from: ${result.stdout.trim()}`,
    };
  }

  if (compareVersion(version, MIN_GIT_VERSION) < 0) {
    return { kind: 'git-too-old', version };
  }

  return {
    kind: 'ok',
    environment: {
      runner,
      version,
      supportsConflictPrediction:
        compareVersion(version, STRONG_HIGHLIGHT_MIN_VERSION) >= 0,
    },
  };
}

/**
 * Parse the first "git version X.Y.Z[...]" line of `git --version` output.
 * Accepts both upstream ("git version 2.45.2") and Apple Git
 * ("git version 2.39.3 (Apple Git-146)") formats.
 */
export function parseGitVersion(output: string): ParsedGitVersion | undefined {
  const match = output.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  const [, majorStr, minorStr, patchStr] = match;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = patchStr === undefined ? 0 : Number(patchStr);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return undefined;
  }
  return {
    raw: patchStr === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
  };
}

export function compareVersion(
  v: ParsedGitVersion,
  ref: { major: number; minor: number },
): number {
  if (v.major !== ref.major) return v.major - ref.major;
  return v.minor - ref.minor;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
