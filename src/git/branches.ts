import { splitLines } from '../util/text';
import type { GitRunner } from './runner';

/** Remote-tracking branch inventory for a repository. */
export interface RemoteBranchListing {
  /** Registered remotes after allow-list filtering. */
  readonly remotes: readonly string[];
  /** `refname:short` of every refs/remotes/* ref except symbolic refs (e.g. origin/HEAD). */
  readonly branches: readonly string[];
}

/** Successful breakdown of a `<remote>/<branch>` string. */
export interface ParsedRemoteBranch {
  readonly remote: string;
  readonly branch: string;
}

/**
 * Allow-listed character set for remote names. Anything outside this set is
 * ignored when reading `git remote` output, defending against hostile
 * `.git/config` entries such as `[remote "evil --upload-pack=x"]` whose
 * section header would otherwise appear in `git remote` output (see spec
 * §5.5 SR-2).
 */
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Allow-listed character set for the user-supplied `conflictLens.baseBranch`
 * setting (spec §3.1.2 §5.5 S5). Stricter than git's own ref name rules:
 * forbids any character that could trip option parsing (`-`, `@{`, etc.) or
 * traversal sequences (`..`).
 */
const BASE_BRANCH_CHARSET = /^[A-Za-z0-9._/-]+$/;
const DISALLOWED_SEQUENCES: readonly string[] = ['..', '@{', '~', '^', ':'];
const MAX_BASE_BRANCH_LENGTH = 255;

/** Discriminated result of `validateBaseBranch`. Caller decides what to surface. */
export type BaseBranchValidation =
  | {
      readonly kind: 'ok';
      readonly remote: string;
      readonly branch: string;
      readonly fullRef: string;
    }
  | { readonly kind: 'invalid-format'; readonly reason: string }
  | { readonly kind: 'invalid-charset'; readonly reason: string }
  | { readonly kind: 'unknown-remote'; readonly attemptedRemote: string }
  | { readonly kind: 'invalid-ref-name'; readonly reason: string }
  | { readonly kind: 'not-in-listing' };

/**
 * Enumerate the remotes and the remote-tracking branches of `repoRootPath`.
 *
 *  - `git remote` output is filtered through {@link REMOTE_NAME_PATTERN}.
 *    Any name with shell metacharacters or whitespace is dropped.
 *  - `git for-each-ref refs/remotes` includes symbolic refs such as
 *    `origin/HEAD`. We detect them via the `%(symref)` field and drop them
 *    (spec §3.1.2; otherwise they pollute the Select Base Branch quick pick
 *    and the listing-equality check).
 */
export async function listRemoteBranches(
  runner: GitRunner,
  repoRootPath: string,
): Promise<RemoteBranchListing> {
  const [remotes, branches] = await Promise.all([
    readRemotes(runner, repoRootPath),
    readRemoteRefs(runner, repoRootPath),
  ]);
  return { remotes, branches };
}

async function readRemotes(runner: GitRunner, cwd: string): Promise<string[]> {
  const result = await runner.run(['remote'], { cwd });
  if (result.exitCode !== 0) return [];
  // Use splitLines (not split('\n')) so a CRLF-mode git on Windows does not
  // leave a trailing \r that breaks the allow-list match.
  return splitLines(result.stdout)
    .map((line) => line.trim())
    .filter((line) => REMOTE_NAME_PATTERN.test(line));
}

async function readRemoteRefs(runner: GitRunner, cwd: string): Promise<string[]> {
  const result = await runner.run(
    ['for-each-ref', '--format=%(refname:short)%09%(symref)', 'refs/remotes'],
    { cwd },
  );
  if (result.exitCode !== 0) return [];
  const out: string[] = [];
  for (const line of splitLines(result.stdout)) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    // The format string always emits a tab. tab === -1 should be impossible
    // for git ≥ 2.30; we keep the defensive branch as a guard.
    const name = tab === -1 ? line : line.slice(0, tab);
    const symref = tab === -1 ? '' : line.slice(tab + 1);
    if (symref.length > 0) continue; // skip symbolic refs (e.g. origin/HEAD)
    if (name.length === 0) continue;
    out.push(name);
  }
  return out;
}

/**
 * Split `"<remote>/<branch>"` against a known remote list using a
 * **longest-prefix match**. When remotes are `['up', 'upstream']` and the
 * input is `'upstream/foo'`, the result is `{ remote: 'upstream',
 * branch: 'foo' }` rather than `{ remote: 'up', branch: 'stream/foo' }`.
 *
 * Returns `undefined` if no remote prefix matches, or if the matched prefix
 * leaves an empty branch component.
 */
export function parseRemoteBranch(
  baseBranch: string,
  remotes: readonly string[],
): ParsedRemoteBranch | undefined {
  const sortedByLengthDesc = [...remotes].sort((a, b) => b.length - a.length);
  for (const remote of sortedByLengthDesc) {
    const prefix = `${remote}/`;
    if (baseBranch.startsWith(prefix) && baseBranch.length > prefix.length) {
      return { remote, branch: baseBranch.slice(prefix.length) };
    }
  }
  return undefined;
}

/**
 * Validate a user-supplied `baseBranch` against the spec §3.1.2 pipeline:
 *
 *   1. format (length, control characters)
 *   2. allow-list character set + forbidden traversal sequences
 *   3. longest-prefix split against `listing.remotes`
 *   4. `git check-ref-format` on the fully-qualified `refs/remotes/<r>/<b>`
 *      (NB: never `--branch`, which would expand shortcuts like `@{-1}`)
 *   5. exact-match presence in `listing.branches`
 *
 * Step 6 (`git ls-remote` fallback for "exists on remote but not fetched
 * yet") is handled by Phase 11; this function stops at step 5.
 */
export async function validateBaseBranch(
  candidate: string,
  context: { runner: GitRunner; repoRootPath: string; listing: RemoteBranchListing },
): Promise<BaseBranchValidation> {
  // Step 1: format
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { kind: 'invalid-format', reason: 'empty' };
  }
  if (candidate.length > MAX_BASE_BRANCH_LENGTH) {
    return { kind: 'invalid-format', reason: 'too long' };
  }
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { kind: 'invalid-format', reason: 'control character' };
    }
  }

  // Step 2: allow-list + forbidden sequences
  if (!BASE_BRANCH_CHARSET.test(candidate)) {
    return { kind: 'invalid-charset', reason: 'disallowed characters' };
  }
  for (const seq of DISALLOWED_SEQUENCES) {
    if (candidate.includes(seq)) {
      return { kind: 'invalid-charset', reason: `disallowed sequence "${seq}"` };
    }
  }
  if (candidate.startsWith('/') || candidate.endsWith('/')) {
    return { kind: 'invalid-charset', reason: 'leading/trailing slash' };
  }

  // Step 3: remote prefix
  const parsed = parseRemoteBranch(candidate, context.listing.remotes);
  if (!parsed) {
    const slash = candidate.indexOf('/');
    const attempted = slash === -1 ? candidate : candidate.slice(0, slash);
    return { kind: 'unknown-remote', attemptedRemote: attempted };
  }

  // Step 4: fully-qualified check-ref-format (no --branch)
  const fullRef = `refs/remotes/${parsed.remote}/${parsed.branch}`;
  const refCheck = await context.runner.run(['check-ref-format', fullRef], {
    cwd: context.repoRootPath,
  });
  if (refCheck.exitCode !== 0) {
    return {
      kind: 'invalid-ref-name',
      reason: refCheck.stderr.trim() || 'check-ref-format rejected',
    };
  }

  // Step 5: must already be in the local for-each-ref listing
  if (!context.listing.branches.includes(candidate)) {
    return { kind: 'not-in-listing' };
  }

  return { kind: 'ok', remote: parsed.remote, branch: parsed.branch, fullRef };
}
