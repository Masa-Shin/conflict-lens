import * as path from 'node:path';

import type { BlobReader } from '../git/blob';
import type { GitRunner } from '../git/runner';
import { isChangedOnBase, toRepoRelativePosix } from './paths';
import { getBaseChange, getMergeConflict, type ConflictKind } from './queries';
import { readConflictLensState, type ConflictLensState } from './state-file';

/**
 * Everything the tool handlers need from the host, injected so the logic
 * stays free of process globals and the MCP transport (and thus testable).
 */
export interface ToolContext {
  /** Directory queries are resolved from (the server process cwd). */
  readonly cwd: string;
  readonly runner: GitRunner;
  /** Blob reader, keyed by repo root so the host can cache the batch. */
  readonly getReadBlob: (repoRoot: string) => BlobReader;
}

type ResolvedState = ConflictLensState & {
  baseBranch: string;
  baseTipSha: string;
  mergeBaseSha: string;
};

function isResolved(state: ConflictLensState): state is ResolvedState {
  return Boolean(state.baseBranch && state.baseTipSha && state.mergeBaseSha);
}

export const UNRESOLVED = {
  status: 'unresolved',
  message:
    'Conflict Lens has no resolved base branch: the extension may not be running, the MCP ' +
    'integration may be off (conflictLens.mcp.enabled), or no base branch was detected.',
} as const;

/**
 * Locate the state file by walking up from `cwd`. Re-read on every call so
 * the answer always reflects the latest base endpoints — nothing is cached.
 */
export async function findState(
  cwd: string,
): Promise<{ root: string; state: ConflictLensState } | null> {
  let dir = cwd;
  for (;;) {
    const state = await readConflictLensState(dir);
    if (state) return { root: dir, state };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const CONFLICT_NOTES: Record<ConflictKind, string | undefined> = {
  none: undefined,
  content: undefined,
  add_add: 'Both sides add this file with different content.',
  base_deleted_local_modified: 'The base branch deleted this file; your version modifies it.',
  local_deleted_base_modified: 'You deleted this file; the base branch modifies it.',
};

// === Base-branch changes (what the base did) ===

/**
 * List the files the base branch changed (vs the merge-base), or check
 * specific paths. Reads only the cached state — no git runs.
 */
export async function listBaseChanges(ctx: ToolContext, paths?: string[]): Promise<unknown> {
  const found = await findState(ctx.cwd);
  if (!found || !isResolved(found.state)) return UNRESOLVED;
  const { state } = found;
  if (!paths || paths.length === 0) {
    return { status: 'ok', baseBranch: state.baseBranch, files: state.changedFiles };
  }
  const results = paths.map((p) => {
    const rel = toRepoRelativePosix(p, state.repoRoot, ctx.cwd);
    return { path: p, changedOnBase: rel !== null && isChangedOnBase(rel, state.changedFiles) };
  });
  return { status: 'ok', baseBranch: state.baseBranch, results };
}

/** Return the base branch's own diff for one file (merge-base → base tip). */
export async function getBaseChanges(ctx: ToolContext, inputPath: string): Promise<unknown> {
  const found = await findState(ctx.cwd);
  if (!found || !isResolved(found.state)) return UNRESOLVED;
  const { state } = found;

  const rel = toRepoRelativePosix(inputPath, state.repoRoot, ctx.cwd);
  if (rel === null) {
    return { status: 'invalid_path', message: `Path is outside the repository: ${inputPath}` };
  }
  if (!isChangedOnBase(rel, state.changedFiles)) {
    return { status: 'unchanged', path: rel, baseBranch: state.baseBranch };
  }
  const result = await getBaseChange(
    ctx.runner,
    state.repoRoot,
    state.mergeBaseSha,
    state.baseTipSha,
    rel,
  );
  return {
    status: 'ok',
    path: rel,
    baseBranch: state.baseBranch,
    change: result.change,
    diff: result.diff,
    truncated: result.truncated,
  };
}

// === Real merge conflicts (what will actually clash) ===

/**
 * List the files that actually conflict when the base branch is merged into
 * the working tree. Only files the base changed can conflict, so the search
 * is bounded by the cached changed-file set.
 */
export async function listConflicts(ctx: ToolContext): Promise<unknown> {
  const found = await findState(ctx.cwd);
  if (!found || !isResolved(found.state)) return UNRESOLVED;
  const { state } = found;
  const readBlob = ctx.getReadBlob(state.repoRoot);
  const files: { path: string; kind: ConflictKind }[] = [];
  for (const f of state.changedFiles) {
    const result = await getMergeConflict(
      ctx.runner,
      readBlob,
      state.repoRoot,
      state.mergeBaseSha,
      state.baseTipSha,
      f,
    );
    if (result.conflicting) files.push({ path: f, kind: result.kind });
  }
  return { status: 'ok', baseBranch: state.baseBranch, files };
}

/** Return the actual merge conflicts in one file. */
export async function getConflicts(ctx: ToolContext, inputPath: string): Promise<unknown> {
  const found = await findState(ctx.cwd);
  if (!found || !isResolved(found.state)) return UNRESOLVED;
  const { state } = found;

  const rel = toRepoRelativePosix(inputPath, state.repoRoot, ctx.cwd);
  if (rel === null) {
    return { status: 'invalid_path', message: `Path is outside the repository: ${inputPath}` };
  }
  if (!isChangedOnBase(rel, state.changedFiles)) {
    // The base did not touch this file, so merging it cannot conflict.
    return {
      status: 'ok',
      path: rel,
      baseBranch: state.baseBranch,
      conflicting: false,
      conflicts: [],
    };
  }
  const result = await getMergeConflict(
    ctx.runner,
    ctx.getReadBlob(state.repoRoot),
    state.repoRoot,
    state.mergeBaseSha,
    state.baseTipSha,
    rel,
  );
  return {
    status: 'ok',
    path: rel,
    baseBranch: state.baseBranch,
    conflicting: result.conflicting,
    kind: result.kind,
    conflicts: result.regions,
    note: CONFLICT_NOTES[result.kind],
  };
}
