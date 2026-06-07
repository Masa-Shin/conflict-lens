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
    return await classifyRepository(immediate, runner);
  }

  const waitResult = await waitForRepository(
    gitApi,
    canonicalFolderPath,
    params.timeoutMs ?? WAIT_FOR_REPOSITORY_TIMEOUT_MS,
  );
  if (!waitResult) {
    return { kind: 'timed-out' };
  }
  return await classifyRepository(waitResult, runner);
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

/**
 * Pick the repository whose root contains `canonicalFolderPath`. When two
 * repos qualify (the typical case: a workspace folder opened inside a
 * submodule will match both the parent repo and the submodule itself), we
 * choose the **deepest** matching root. That way a user who opens
 * `/proj/sub` directly gets the submodule classified (and subsequently
 * rejected as `submodule`), instead of silently being assigned the parent
 * repo `/proj`, which would defeat the spec §3.1.3 submodule exclusion.
 */
function findRepositoryContaining(
  repositories: readonly VscodeGitRepository[],
  canonicalFolderPath: string,
): VscodeGitRepository | undefined {
  let best: { repo: VscodeGitRepository; depth: number } | undefined;
  for (const repo of repositories) {
    const repoPath = canonicalRepoRoot(repo);
    if (!repoPath) continue;
    if (!isSamePathOrUnder(canonicalFolderPath, repoPath)) continue;
    if (!best || repoPath.length > best.depth) {
      best = { repo, depth: repoPath.length };
    }
  }
  return best?.repo;
}

function repositoryContains(repo: VscodeGitRepository, canonicalFolderPath: string): boolean {
  const repoPath = canonicalRepoRoot(repo);
  if (!repoPath) return false;
  return isSamePathOrUnder(canonicalFolderPath, repoPath);
}

function canonicalRepoRoot(repo: VscodeGitRepository): string | undefined {
  try {
    return fs.realpathSync(repo.rootUri.fsPath);
  } catch {
    return undefined;
  }
}

async function classifyRepository(
  handle: VscodeGitRepository,
  runner: GitRunner,
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
  const result = await runner.run(['rev-parse', '--show-superproject-working-tree'], {
    cwd: rootPath,
  });
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
 * Strip the Windows extended-length namespace prefix (`\\?\C:\…` or
 * `\\?\UNC\server\share`). `fs.realpathSync` (a JS implementation) and
 * `fs.promises.realpath` (libuv) disagree on whether they emit this prefix,
 * so two paths pointing at the same location can differ by it alone. Left
 * unstripped, `path.relative` treats them as different roots and reports the
 * descendant as "outside". No-op on POSIX.
 */
function stripWindowsNamespacePrefix(p: string): string {
  if (path.sep !== '\\') return p;
  return p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}

/**
 * True iff `candidatePath` is at or below `containerPath`. Both inputs are
 * expected to be canonical absolute paths (realpath-resolved). Uses
 * `path.relative` so prefix attacks like `/repo-malicious` cannot fool the
 * containment check.
 */
export function isSamePathOrUnder(candidatePath: string, containerPath: string): boolean {
  const candidate = stripWindowsNamespacePrefix(candidatePath);
  const container = stripWindowsNamespacePrefix(containerPath);
  if (candidate === container) return true;
  const rel = path.relative(container, candidate);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Repo-relative, forward-slashed path for `filePath` after realpath
 * canonicalization, or `undefined` when the path is a symlink, does not
 * exist, is the repo root itself, or resolves outside the repo.
 *
 * Canonicalization rejects (per spec §3.1.3 / §5.5 B5): symlinks, which can
 * point outside the repository and leak file contents; and paths whose
 * realpath escapes `repoRootPath` (e.g. via a parent-dir symlink).
 * `repoRootPath` is expected to be already canonical (e.g. from
 * `TargetRepository.rootPath`).
 *
 * The Explorer hands `provideFileDecoration` URIs in the workspace's
 * namespace, which differs from the realpath'd repo root when the workspace
 * is opened through a symlink. Resolving the file this way keeps the
 * file-tree badge and the in-editor highlight in agreement.
 *
 * This is async because it becomes a per-file hot path in the
 * FileDecorationProvider. Sync I/O here would block the extension host on
 * every Explorer redraw (spec §5.4).
 */
export async function repoRelativePathViaRealpath(
  filePath: string,
  repoRootPath: string,
): Promise<string | undefined> {
  const canon = await canonicalizeWithin(filePath, repoRootPath);
  if (!canon) return undefined;
  const rel = path.relative(canon.root, canon.file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/**
 * Canonicalization behind `repoRelativePathViaRealpath`. Returns the
 * realpath'd file and root (with
 * the Windows namespace prefix stripped so they share a comparison basis)
 * when `filePath` is a non-symlink regular path at or under `repoRootPath`;
 * `undefined` otherwise.
 */
async function canonicalizeWithin(
  filePath: string,
  repoRootPath: string,
): Promise<{ file: string; root: string } | undefined> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) {
    return undefined;
  }
  let file: string;
  let root: string;
  try {
    // Canonicalize both operands through the SAME realpath, or they can
    // diverge on Windows: the sync fs.realpathSync that produced repoRootPath
    // is a JS implementation that leaves 8.3 short names (RUNNER~1) intact,
    // while the async fs.promises.realpath (libuv) expands them to their long
    // form. The mismatch makes path.relative report every descendant as
    // "outside". Re-resolving the root here keeps the comparison honest.
    file = stripWindowsNamespacePrefix(await fs.promises.realpath(filePath));
    root = stripWindowsNamespacePrefix(await fs.promises.realpath(repoRootPath));
  } catch {
    return undefined;
  }
  if (!isSamePathOrUnder(file, root)) {
    return undefined;
  }
  return { file, root };
}
