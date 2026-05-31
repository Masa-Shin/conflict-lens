import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

/**
 * Options for a single git invocation.
 */
export interface GitCommandOptions {
  /** Working directory. Must be set explicitly to avoid process.cwd() leaking through. */
  readonly cwd: string;
  /** Extra environment variables, merged on top of process.env and SECURE_ENV. */
  readonly env?: NodeJS.ProcessEnv;
  /** AbortSignal for cancellation. The child will be killed with SIGTERM. */
  readonly signal?: AbortSignal;
  /** Override the default per-invocation timeout (milliseconds). */
  readonly timeoutMs?: number;
  /** Data to pipe to stdin. */
  readonly stdin?: string | Buffer;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** True if the command was killed because the timeout fired. */
  readonly timedOut: boolean;
}

export interface GitRunner {
  /** Path to the resolved git binary. */
  readonly gitPath: string;
  /** Spawn `git <subcommand> <args>` with all security/safety defaults applied. */
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

/** Default upper bound for a single git command (spec §5.4). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Environment variables that suppress interactive prompts and disable
 * environment-dependent behavior. See spec §4.1 and §5.5.
 */
export const SECURE_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  LC_ALL: 'C.UTF-8',
});

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Arguments inserted before every git subcommand. These neutralize dangerous
 * keys in .git/config so that opening a hostile repository cannot trigger
 * arbitrary code execution. See spec §4.1 共通プレフィクス and §5.5.
 *
 * NOTE: `credential.helper=` is intentionally *not* included here. Suppressing
 * the helper for every command would break OS-keychain based authentication
 * for HTTPS remotes (PAT-protected GitHub, etc.) and make `git fetch` /
 * `git ls-remote` fail silently. Local-only commands used by this extension
 * (diff / show / merge-tree / merge-file / rev-parse / cat-file /
 * for-each-ref / merge-base / check-attr) do not invoke the credential
 * helper, so omitting the override is safe. Network-bound commands
 * (`fetch` / `ls-remote`) will be handled in Phase 11 by delegating to
 * `vscode.git`'s `Repository.fetch()` whenever possible, and falling back
 * to an allow-list of well-known helpers (osxkeychain / manager / wincred /
 * cache / store) for the cases that must be spawned directly.
 */
export const SECURE_ARGS: readonly string[] = Object.freeze([
  '--no-pager',
  '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=',
  '-c', 'core.askpass=',
  '-c', 'core.editor=false',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${NULL_DEVICE}`,
  '-c', 'gpg.program=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.file.allow=never',
  '-c', 'uploadpack.packObjectsHook=',
  '-c', 'merge.conflictStyle=merge',
  '-c', 'diff.renames=true',
]);

export function createGitRunner(gitPath: string): GitRunner {
  return {
    gitPath,
    run(args, options) {
      return runGit(gitPath, args, options);
    },
  };
}

function runGit(
  gitPath: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...SECURE_ENV, ...options.env };
    const child = spawn(gitPath, [...SECURE_ARGS, ...args], {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timeoutId.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.once('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timeoutId);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: exitCode ?? -1,
        timedOut,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}
