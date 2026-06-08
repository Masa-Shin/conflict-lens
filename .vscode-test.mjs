import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

/**
 * Build a throwaway git repository for the integration tests and return its
 * path. It exercises the real end-to-end behaviour the unit tests can't:
 *
 *  - Branch `master` with an `origin/master` remote-tracking ref (and
 *    `origin/HEAD` -> master) but NO `origin/main`, so base-branch
 *    auto-detection must fall through to `master` — the path the 0.0.3
 *    default-baseBranch bug broke.
 *  - `changed.txt`: modified on the base only (HEAD left it alone) — a
 *    base-side change with no conflict, for "Show Base Branch Changes".
 *  - `conflict.txt`: modified on BOTH the base and HEAD on the same line,
 *    so a trial merge conflicts — for "Preview Conflict".
 *
 * Layout (HEAD = feature, base = origin/master):
 *
 *   A (master, pushed to origin)   ── merge-base
 *   ├─ B (master advanced: edits changed.txt and conflict.txt, pushed)
 *   └─ C (feature from A: edits conflict.txt differently)  ← HEAD
 *
 * Runs in Node before VS Code launches; the folder is then opened as the
 * test workspace so the built-in git extension detects it.
 */
function createFixtureWorkspace() {
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
  const git = (args) => execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
  const write = (name, content) => writeFileSync(join(repo, name), content);

  // A: common ancestor.
  git(['init', '-b', 'master']);
  write('changed.txt', 'a\nb\nc\n');
  write('conflict.txt', 'x\ny\nz\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['branch', 'feature']); // feature pinned at A

  execFileSync('git', ['init', '--bare', '-b', 'master'], { cwd: origin, env, stdio: 'ignore' });
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'master']); // origin/master = A

  // B: advance the base branch.
  write('changed.txt', 'a\nB-base\nc\n');
  write('conflict.txt', 'x\nY-base\nz\n');
  git(['add', '.']);
  git(['commit', '-m', 'base changes']);
  git(['push', 'origin', 'master']); // origin/master = B
  git(['fetch', 'origin']);
  git(['remote', 'set-head', 'origin', 'master']); // refs/remotes/origin/HEAD -> master

  // C: diverge HEAD so conflict.txt conflicts with the base.
  git(['checkout', 'feature']); // HEAD = feature = A
  write('conflict.txt', 'x\nY-head\nz\n');
  git(['add', '.']);
  git(['commit', '-m', 'head change']);

  return repo;
}

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: createFixtureWorkspace(),
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
