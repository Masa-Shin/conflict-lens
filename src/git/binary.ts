import { stringifyError } from '../util/error';
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
  /**
   * The vscode.git API handle obtained as part of resolution. Cached here so
   * callers do not have to invoke `getAPI(1)` a second time (which could
   * have side effects if the host extension is not idempotent).
   */
  readonly gitApi: VscodeGitApi;
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
 * On success the returned environment includes the resolved `gitApi` handle
 * so callers (e.g. `detectTargetRepository`) do not have to dig into the
 * extension exports a second time.
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

  if (compareMajorMinor(version, MIN_GIT_VERSION) < 0) {
    return { kind: 'git-too-old', version };
  }

  return {
    kind: 'ok',
    environment: {
      runner,
      version,
      supportsConflictPrediction:
        compareMajorMinor(version, STRONG_HIGHLIGHT_MIN_VERSION) >= 0,
      gitApi,
    },
  };
}

/**
 * Parse "git version X.Y.Z[...]" from the start of `git --version` output.
 * The leading anchor `^` rejects strings like `"foogit version 1.2.3"` and
 * the trailing `(?:\s|$)` requires a real word boundary so version-like
 * substrings buried in other output are not picked up. See spec §5.5 C1.
 */
export function parseGitVersion(output: string): ParsedGitVersion | undefined {
  const match = output.match(/^git version (\d+)\.(\d+)(?:\.(\d+))?(?:\s|$)/);
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

/**
 * Compare two versions by **major.minor only**. Patch is intentionally
 * ignored because the only gates that matter here (2.30 minimum, 2.38
 * conflict-prediction) are at the minor level. Use a different helper when
 * patch-level precision is required.
 */
export function compareMajorMinor(
  v: ParsedGitVersion,
  ref: { major: number; minor: number },
): number {
  if (v.major !== ref.major) return v.major - ref.major;
  return v.minor - ref.minor;
}
