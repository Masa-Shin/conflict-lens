import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

/**
 * Build a throwaway git repository for the integration tests and return its
 * path. The repo lives on `master` and has an `origin/master`
 * remote-tracking ref (plus `origin/HEAD` -> master) but deliberately NO
 * `origin/main`. That forces Conflict Lens's base-branch auto-detection to
 * fall through to `master` — the exact path the 0.0.3 default-baseBranch bug
 * broke — so the suite regresses against it.
 *
 * Runs in Node before VS Code launches; the folder is then opened as the
 * test workspace so the built-in git extension detects it.
 */
function createMasterFixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'conflict-lens-it-'));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo, { recursive: true });
  mkdirSync(origin, { recursive: true });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'CI',
    GIT_AUTHOR_EMAIL: 'ci@example.com',
    GIT_COMMITTER_NAME: 'CI',
    GIT_COMMITTER_EMAIL: 'ci@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (args, cwd) => execFileSync('git', args, { cwd, env, stdio: 'ignore' });

  git(['init', '-b', 'master'], repo);
  writeFileSync(join(repo, 'file.txt'), 'line1\nline2\nline3\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init'], repo);

  git(['init', '--bare', '-b', 'master'], origin);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-u', 'origin', 'master'], repo);
  git(['fetch', 'origin'], repo);
  // Point refs/remotes/origin/HEAD at master so symbolic-ref detection works.
  git(['remote', 'set-head', 'origin', 'master'], repo);

  return repo;
}

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: createMasterFixtureWorkspace(),
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
