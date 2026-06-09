import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Schema version of the on-disk state file. Bump it when the shape changes
 * in a way the reader (the Claude Code MCP server) must distinguish; the
 * reader is expected to reject a version it does not understand rather than
 * guess at an older or newer layout.
 */
export const STATE_SCHEMA_VERSION = 1;

/**
 * The snapshot the extension writes for the Claude Code integration. It
 * carries only cheap, edit-stable data — the conflict line ranges are never
 * stored here; the reader computes those on demand from the same git state.
 * See docs/claude-code-integration.md §4.
 *
 * The base fields are `null` when no base branch is resolved (or its SHAs
 * are not yet known). The reader treats that as "cannot determine" rather
 * than "nothing is conflict-prone", so a missing base never reads as safe.
 */
export interface ConflictLensState {
  readonly schemaVersion: number;
  /** Canonical repository root (matches `TargetRepository.rootPath`). */
  readonly repoRoot: string;
  /** Human-readable base ref, e.g. `origin/main`. `null` when unresolved. */
  readonly baseBranch: string | null;
  /** Commit the base ref points to — the right endpoint of the base diff. */
  readonly baseTipSha: string | null;
  /** `merge-base(HEAD, base)` — the left endpoint of the base diff. */
  readonly mergeBaseSha: string | null;
  /** Repo-relative paths the base branch changed vs the merge-base. */
  readonly changedFiles: readonly string[];
  /** Remote the base lives on (informational). */
  readonly remoteName: string | null;
  /** ISO-8601 timestamp of when this snapshot was written. */
  readonly generatedAt: string;
}

const STATE_DIR = 'conflict-lens';
const STATE_FILE = 'state.json';

/**
 * Location of the state file for a repository: inside its `.git` directory,
 * which git never tracks, so the snapshot cannot leak into the repository
 * or onto teammates.
 *
 * NOTE: assumes a standard `.git` directory. Linked worktrees and
 * submodules (where `.git` is a file pointing elsewhere) are out of scope
 * for now; see FUTURE.md.
 */
export function conflictLensStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.git', STATE_DIR, STATE_FILE);
}

/**
 * Atomically write the snapshot: serialize to a per-process temp file in
 * the same directory, then rename over the target. The rename is atomic, so
 * a concurrent reader never observes a half-written file. The pid suffix
 * keeps two VS Code windows on the same repo from racing on a shared temp
 * name.
 */
export async function writeConflictLensState(state: ConflictLensState): Promise<void> {
  const target = conflictLensStatePath(state.repoRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Read and parse the snapshot. Returns `null` when the file is absent or
 * unreadable/corrupt — callers treat all of those as "no usable snapshot"
 * (i.e. "cannot determine") rather than throwing.
 */
export async function readConflictLensState(repoRoot: string): Promise<ConflictLensState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(conflictLensStatePath(repoRoot), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ConflictLensState;
    if (typeof parsed?.schemaVersion !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remove the state file. Used when the integration is turned off. */
export async function deleteConflictLensState(repoRoot: string): Promise<void> {
  await fs.rm(conflictLensStatePath(repoRoot), { force: true });
}
