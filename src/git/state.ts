import * as fs from 'node:fs';
import * as path from 'node:path';

import { splitLines } from '../util/text';
import type { GitRunner } from './runner';

/**
 * Discriminated union of repository-level git states that affect whether
 * Conflict Lens should produce highlights, and how the status bar reads.
 *
 * Priority order (spec §3.2.4 §5.2):
 *   no-commits  >  rebasing / merging / cherry-picking / reverting  >  ready
 *
 * `detached` and `bisecting` are *modifiers* of the `ready` state. They are
 * benign on their own (highlighting keeps working) but should be shown in
 * the status bar as a hint.
 */
export type GitState =
  | { readonly kind: 'no-commits' }
  | { readonly kind: 'rebasing' }
  | { readonly kind: 'merging' }
  | { readonly kind: 'cherry-picking' }
  | { readonly kind: 'reverting' }
  | { readonly kind: 'ready'; readonly detached: boolean; readonly bisecting: boolean };

/** Targets passed to `git rev-parse --git-path` and `fs.access` in one batch. */
const MID_OP_PATHS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
] as const;
type MidOpKey = (typeof MID_OP_PATHS)[number];

export interface DetectGitStateOptions {
  readonly signal?: AbortSignal;
  /**
   * Optional warning sink. When the function falls back to a safe state due
   * to unexpected git output, callers (e.g. extension.ts) can record what
   * happened to the output channel via this callback. Detection itself
   * stays vscode-agnostic.
   */
  readonly onWarn?: (message: string) => void;
}

/**
 * Inspect a repository and return the current top-level git state.
 *
 * Implementation notes:
 *  - All six `.git/<marker>` paths are resolved in a SINGLE `git rev-parse`
 *    invocation (P18 mitigation; without this we'd spawn 6 processes per
 *    state evaluation, which fires every onDidChange).
 *  - Existence is then checked via `fs.promises.access` in parallel, so no
 *    sync I/O blocks the extension host.
 *  - `git rev-parse --git-path` returns paths relative to the current
 *    working directory; we re-anchor them on `repoRootPath` before stat.
 */
export async function detectGitState(
  runner: GitRunner,
  repoRootPath: string,
  options: DetectGitStateOptions = {},
): Promise<GitState> {
  const { signal, onWarn } = options;

  // Step 1: HEAD existence (no-commits has highest priority).
  const head = await runner.run(['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRootPath,
    signal,
  });
  if (head.exitCode !== 0) {
    return { kind: 'no-commits' };
  }

  // Step 2: resolve all marker paths in one git call.
  const pathArgs = MID_OP_PATHS.flatMap((target) => ['--git-path', target]);
  const pathLookup = await runner.run(['rev-parse', ...pathArgs], {
    cwd: repoRootPath,
    signal,
  });

  let markers: Record<MidOpKey, boolean>;
  if (pathLookup.exitCode === 0) {
    // splitLines, not split('\n'): git on Windows emits CRLF text-mode and a
    // raw \n split would leave \r on every line, making path.resolve produce
    // paths that never exist → all markers silently false → state stuck
    // on `ready` even mid-rebase.
    const lines = splitLines(pathLookup.stdout).filter((line) => line.length > 0);
    if (lines.length === MID_OP_PATHS.length) {
      const resolvedPaths = lines.map((line) => resolveRepoRelative(repoRootPath, line));
      const existenceFlags = await Promise.all(resolvedPaths.map(pathExists));
      markers = Object.fromEntries(
        MID_OP_PATHS.map((key, i) => [key, existenceFlags[i]]),
      ) as Record<MidOpKey, boolean>;
    } else {
      onWarn?.(
        `detectGitState: expected ${MID_OP_PATHS.length} --git-path lines, got ${lines.length}. Treating as no in-progress op.`,
      );
      markers = emptyMarkers();
    }
  } else {
    onWarn?.(
      `detectGitState: rev-parse --git-path failed (exit ${pathLookup.exitCode}). Treating as no in-progress op.`,
    );
    markers = emptyMarkers();
  }

  // Step 3: classify (spec §5.2 priority).
  if (markers['rebase-merge'] || markers['rebase-apply']) {
    return { kind: 'rebasing' };
  }
  if (markers['MERGE_HEAD']) {
    return { kind: 'merging' };
  }
  if (markers['CHERRY_PICK_HEAD']) {
    return { kind: 'cherry-picking' };
  }
  if (markers['REVERT_HEAD']) {
    return { kind: 'reverting' };
  }

  // Step 4: detached / bisecting modifiers for the ready state.
  const symRef = await runner.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repoRootPath,
    signal,
  });
  const detached = symRef.exitCode !== 0;

  return {
    kind: 'ready',
    detached,
    bisecting: markers['BISECT_LOG'],
  };
}

/**
 * Human-readable label used in the status bar suffix and in tooltips for
 * states that disable highlighting (no-commits / rebasing / etc.).
 */
export function statusLabelFor(state: GitState): string {
  switch (state.kind) {
    case 'no-commits':
      return '(no commits)';
    case 'rebasing':
      return '(rebasing)';
    case 'merging':
      return '(merging)';
    case 'cherry-picking':
      return '(cherry-picking)';
    case 'reverting':
      return '(reverting)';
    case 'ready': {
      if (!state.detached && !state.bisecting) return '';
      const mods: string[] = [];
      if (state.detached) mods.push('detached');
      if (state.bisecting) mods.push('bisecting');
      return `(${mods.join(', ')})`;
    }
  }
}

/** True when highlighting / decoration should be suppressed for this state. */
export function isStateBlockingHighlights(state: GitState): boolean {
  if (state.kind !== 'ready') return true;
  // Detached HEAD has no branch to frame "your work" against, and nobody
  // develops in this state (it is what bisect / `git checkout <sha>` land
  // you in). Suppress highlights and badges entirely rather than diff
  // against a base the user is not actually working from.
  return state.detached;
}

function emptyMarkers(): Record<MidOpKey, boolean> {
  return Object.fromEntries(MID_OP_PATHS.map((k) => [k, false])) as Record<
    MidOpKey,
    boolean
  >;
}

function resolveRepoRelative(repoRootPath: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(repoRootPath, candidate);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
