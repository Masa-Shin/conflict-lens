import type { GitRunner } from '../git/runner';

export type BaseChangeKind = 'added' | 'deleted' | 'modified' | 'none';

export interface BaseChange {
  /** What the base branch did to the file, relative to the merge-base. */
  readonly change: BaseChangeKind;
  /** The unified diff (merge-base → base tip). Captures whole-file deletion. */
  readonly diff: string;
  readonly truncated: boolean;
}

const DIFF_MAX_LINES = 400;

/**
 * The base branch's own change to one file: the diff from the merge-base to
 * the base tip. This is the authoritative "what the base did" — it is not
 * projected onto the working file, so a whole-file deletion shows up as the
 * entire file removed.
 */
export async function getBaseChange(
  runner: GitRunner,
  repoRoot: string,
  mergeBaseSha: string,
  baseTipSha: string,
  relPosix: string,
  options: { signal?: AbortSignal } = {},
): Promise<BaseChange> {
  const result = await runner.run(
    [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--end-of-options',
      mergeBaseSha,
      baseTipSha,
      '--',
      relPosix,
    ],
    { cwd: repoRoot, signal: options.signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff (base change) for ${relPosix} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  const patch = result.stdout;
  let change: BaseChangeKind = 'none';
  if (patch.length === 0) change = 'none';
  else if (/^deleted file mode/m.test(patch)) change = 'deleted';
  else if (/^new file mode/m.test(patch)) change = 'added';
  else change = 'modified';

  const lines = patch.split('\n');
  const truncated = lines.length > DIFF_MAX_LINES;
  const diff = truncated
    ? `${lines.slice(0, DIFF_MAX_LINES).join('\n')}\n... (diff truncated; ${lines.length - DIFF_MAX_LINES} more lines) ...`
    : patch;
  return { change, diff, truncated };
}
