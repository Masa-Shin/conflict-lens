import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'CI',
  GIT_AUTHOR_EMAIL: 'ci@example.com',
  GIT_COMMITTER_NAME: 'CI',
  GIT_COMMITTER_EMAIL: 'ci@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitRunner(cwd) {
  return (args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' });
}

/**
 * The main fixture: branch `master` whose only remote-tracking base is
 * origin/master (origin/HEAD -> master, NO origin/main), with a spread of
 * files in different states so the bulk of the suite runs in one launch.
 *
 *   A (master, pushed)            ── merge-base
 *   ├─ B (master advanced + pushed: edits/deletes/adds files on the base)
 *   └─ C (feature from A: edits conflict.txt and multi.txt differently)  ← HEAD
 */
function buildPrimaryFixture() {
  const root = freshDir('conflict-lens-it-primary-');
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo, { recursive: true });
  mkdirSync(origin, { recursive: true });
  const git = gitRunner(repo);
  const write = (name, content) => writeFileSync(join(repo, name), content);

  // 20 lines with two well-separated edit points (lines 2 and 19) so a
  // trial merge yields two distinct conflict regions, not one merged block.
  const seq = Array.from({ length: 20 }, (_, i) => String(i + 1));
  const multiAt = (line2, line19) =>
    seq.map((v, i) => (i === 1 ? line2 : i === 18 ? line19 : v)).join('\n') + '\n';

  // A: common ancestor.
  git(['init', '-b', 'master']);
  write('changed.txt', 'a\nb\nc\n');
  write('conflict.txt', 'x\ny\nz\n');
  write('multi.txt', multiAt('2', '19'));
  write('deleted.txt', 'keep me\n');
  write('upstream.txt', 'u\nv\nw\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['branch', 'feature']); // feature pinned at A

  execFileSync('git', ['init', '--bare', '-b', 'master'], {
    cwd: origin,
    env: GIT_ENV,
    stdio: 'ignore',
  });
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'master']); // origin/master = A

  // B: advance the base branch.
  write('changed.txt', 'a\nB-base\nc\n');
  write('conflict.txt', 'x\nY-base\nz\n');
  write('multi.txt', multiAt('TWO-base', 'NINETEEN-base'));
  write('upstream.txt', 'u\nUPSTREAM-base\nw\n');
  execFileSync('git', ['rm', 'deleted.txt'], { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
  git(['add', '.']);
  git(['commit', '-m', 'base changes']);
  git(['push', 'origin', 'master']); // origin/master = B
  git(['fetch', 'origin']);
  git(['remote', 'set-head', 'origin', 'master']);

  // C: diverge HEAD so conflict.txt and multi.txt conflict with the base.
  git(['checkout', 'feature']); // HEAD = feature = A
  write('conflict.txt', 'x\nY-head\nz\n');
  write('multi.txt', multiAt('TWO-head', 'NINETEEN-head'));
  write('deleted.txt', 'keep me\nlocal edit\n'); // modified here, deleted on base
  git(['add', '.']);
  git(['commit', '-m', 'head change']);

  return repo;
}

/**
 * A conventional repo on `main` with an origin/main tracking ref, used to
 * confirm the primary (non-fallback) detection path.
 */
function buildMainFixture() {
  const root = freshDir('conflict-lens-it-main-');
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo, { recursive: true });
  mkdirSync(origin, { recursive: true });
  const git = gitRunner(repo);
  const write = (name, content) => writeFileSync(join(repo, name), content);

  git(['init', '-b', 'main']);
  write('main-changed.txt', 'one\ntwo\nthree\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['branch', 'feature']);

  execFileSync('git', ['init', '--bare', '-b', 'main'], {
    cwd: origin,
    env: GIT_ENV,
    stdio: 'ignore',
  });
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'main']);

  write('main-changed.txt', 'one\nTWO-on-main\nthree\n');
  git(['add', '.']);
  git(['commit', '-m', 'base change']);
  git(['push', 'origin', 'main']);
  git(['fetch', 'origin']);
  git(['remote', 'set-head', 'origin', 'main']);

  git(['checkout', 'feature']);
  return repo;
}

/** A local-only repo with a commit but no remote, so no base can be detected. */
function buildNoBaseFixture() {
  const root = freshDir('conflict-lens-it-nobase-');
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = gitRunner(repo);
  writeFileSync(join(repo, 'solo.txt'), 'alpha\nbeta\ngamma\n');
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return repo;
}

const mocha = { ui: 'bdd', timeout: 60000 };

export default defineConfig([
  {
    label: 'primary',
    files: 'out/test/integration/primary/**/*.test.js',
    workspaceFolder: buildPrimaryFixture(),
    mocha,
  },
  {
    label: 'main',
    files: 'out/test/integration/main/**/*.test.js',
    workspaceFolder: buildMainFixture(),
    mocha,
  },
  {
    label: 'no-base',
    files: 'out/test/integration/no-base/**/*.test.js',
    workspaceFolder: buildNoBaseFixture(),
    mocha,
  },
]);
