import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RepoTools {
  readonly repo: string;
  write(relPath: string, content: string): void;
  remove(relPath: string): void;
  run(args: string[]): string;
}

export interface Scenario extends RepoTools {
  readonly baseBranch: 'main';
  readonly mergeBaseSha: string;
  readonly baseTipSha: string;
  readonly cleanup: () => void;
}

export interface ScenarioOptions {
  /** Files present at the root commit (the merge-base). */
  readonly root: Record<string, string>;
  /** Edits committed on the base branch (main). */
  readonly baseChange: (t: RepoTools) => void;
  /** Edits left uncommitted in the working tree on the feature branch. */
  readonly localChange?: (t: RepoTools) => void;
}

/**
 * Build a repo where `main` (the base) diverged from `feature` (HEAD) after a
 * shared root commit. `baseChange` is committed on `main`; `localChange` is
 * left dirty in the working tree on `feature` — i.e. the agent's current
 * on-disk edits. Returns the endpoints the extension would record.
 */
export function setupScenario(options: ScenarioOptions): Scenario {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-')));
  const run = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    })
      .toString()
      .trim();
  const write = (rel: string, content: string): void => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const remove = (rel: string): void => fs.rmSync(path.join(repo, rel), { force: true });
  const tools: RepoTools = { repo, write, remove, run };

  run(['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(options.root)) write(rel, content);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'root']);
  const mergeBaseSha = run(['rev-parse', 'HEAD']);

  run(['checkout', '-q', '-b', 'feature']);
  run(['checkout', '-q', 'main']);
  options.baseChange(tools);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base change']);
  const baseTipSha = run(['rev-parse', 'HEAD']);

  run(['checkout', '-q', 'feature']);
  options.localChange?.(tools);

  return {
    ...tools,
    baseBranch: 'main',
    mergeBaseSha,
    baseTipSha,
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}
