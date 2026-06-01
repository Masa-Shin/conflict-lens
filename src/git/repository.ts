import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GitRunner } from './runner';
import type { VscodeGitApi, VscodeGitRepository } from './vscode-git-api';

export interface TargetRepository {
  /** Canonical absolute path to the repository root (after realpath). */
  readonly rootPath: string;
  /** Underlying vscode.git Repository handle. */
  readonly handle: VscodeGitRepository;
}

export type TargetRepositoryResult =
  | { readonly kind: 'ok'; readonly repository: TargetRepository }
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'not-a-repository' }
  | { readonly kind: 'submodule'; readonly superprojectPath: string }
  | { readonly kind: 'timed-out' };

/** Spec §4.1: wait up to 5s for vscode.git to populate the repository list. */
export const WAIT_FOR_REPOSITORY_TIMEOUT_MS = 5_000;

/**
 * Find and validate the repository that backs the first workspace folder.
 *
 * Spec §3.1.3 / §4.1:
 *  - Only the first workspace folder is considered (MVP).
 *  - The path is canonicalized via realpath before comparison.
 *  - If the matching repository is a submodule (its
 *    superproject-working-tree is non-empty), it is excluded.
 *  - If vscode.git has not yet populated `repositories`, wait for
 *    `onDidOpenRepository` up to 5 seconds and try again.
 */
export async function detectTargetRepository(params: {
  gitApi: VscodeGitApi;
  runner: GitRunner;
  primaryWorkspaceFolderPath: string | undefined;
  timeoutMs?: number;
}): Promise<TargetRepositoryResult> {
  const { gitApi, runner, primaryWorkspaceFolderPath } = params;
  if (!primaryWorkspaceFolderPath) {
    return { kind: 'no-workspace' };
  }

  let canonicalFolderPath: string;
  try {
    canonicalFolderPath = fs.realpathSync(primaryWorkspaceFolderPath);
  } catch {
    return { kind: 'not-a-repository' };
  }

  const immediate = findRepositoryContaining(gitApi.repositories, canonicalFolderPath);
  if (immediate) {
    return await classifyRepository(immediate, runner, canonicalFolderPath);
  }

  const waitResult = await waitForRepository(
    gitApi,
    canonicalFolderPath,
    params.timeoutMs ?? WAIT_FOR_REPOSITORY_TIMEOUT_MS,
  );
  if (!waitResult) {
    return { kind: 'timed-out' };
  }
  return await classifyRepository(waitResult, runner, canonicalFolderPath);
}

function waitForRepository(
  gitApi: VscodeGitApi,
  canonicalFolderPath: string,
  timeoutMs: number,
): Promise<VscodeGitRepository | undefined> {
  return new Promise<VscodeGitRepository | undefined>((resolve) => {
    let settled = false;
    const subscription = gitApi.onDidOpenRepository((repo) => {
      if (settled) return;
      if (repositoryContains(repo, canonicalFolderPath)) {
        settled = true;
        clearTimeout(timer);
        subscription.dispose();
        resolve(repo);
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
  });
}

function findRepositoryContaining(
  repositories: readonly VscodeGitRepository[],
  canonicalFolderPath: string,
): VscodeGitRepository | undefined {
  for (const repo of repositories) {
    if (repositoryContains(repo, canonicalFolderPath)) {
      return repo;
    }
  }
  return undefined;
}

function repositoryContains(
  repo: VscodeGitRepository,
  canonicalFolderPath: string,
): boolean {
  let repoPath: string;
  try {
    repoPath = fs.realpathSync(repo.rootUri.fsPath);
  } catch {
    return false;
  }
  return isSamePathOrUnder(canonicalFolderPath, repoPath);
}

async function classifyRepository(
  handle: VscodeGitRepository,
  runner: GitRunner,
  _fallbackCwd: string,
): Promise<TargetRepositoryResult> {
  // Canonical path is a hard contract of TargetRepository.rootPath. If
  // realpath fails (deleted directory, permission revoked between detection
  // and classification), the repository is effectively unusable: bail out.
  let rootPath: string;
  try {
    rootPath = fs.realpathSync(handle.rootUri.fsPath);
  } catch {
    return { kind: 'not-a-repository' };
  }

  // Exclude submodules.
  const result = await runner.run(
    ['rev-parse', '--show-superproject-working-tree'],
    { cwd: rootPath },
  );
  if (result.exitCode === 0) {
    const superproject = result.stdout.trim();
    if (superproject.length > 0) {
      return { kind: 'submodule', superprojectPath: superproject };
    }
  }
  // If rev-parse itself fails for an unknown reason we still treat the
  // repository as usable (best effort) rather than disabling the extension.

  return { kind: 'ok', repository: { rootPath, handle } };
}

/**
 * True iff `candidatePath` is at or below `containerPath`. Both inputs are
 * expected to be canonical absolute paths (realpath-resolved). Uses
 * `path.relative` so prefix attacks like `/repo-malicious` cannot fool the
 * containment check.
 */
export function isSamePathOrUnder(candidatePath: string, containerPath: string): boolean {
  if (candidatePath === containerPath) return true;
  const rel = path.relative(containerPath, candidatePath);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Returns true iff `filePath` is a regular file inside `repoRootPath`,
 * after canonicalization. Rejects:
 *  - paths that don't exist
 *  - symlinks (per spec §3.1.3 / §5.5 B5; symlinks can point outside the
 *    repository and leak file contents)
 *  - paths whose realpath escapes `repoRootPath`
 *
 * `repoRootPath` is expected to be already canonical (e.g. from
 * `TargetRepository.rootPath`).
 *
 * This is async because it becomes a per-file hot path once the
 * FileDecorationProvider lands (Phase 9). Sync I/O here would block the
 * extension host on every Explorer redraw (spec §5.4).
 */
export async function isFileWithinRepository(
  filePath: string,
  repoRootPath: string,
): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) {
    return false;
  }
  let canonical: string;
  try {
    canonical = await fs.promises.realpath(filePath);
  } catch {
    return false;
  }
  return isSamePathOrUnder(canonical, repoRootPath);
}
