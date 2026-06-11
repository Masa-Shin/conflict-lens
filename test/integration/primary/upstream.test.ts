import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  closeAllEditors,
  ensureBaseReady,
  findDiffTabFor,
  waitFor,
  workspaceFile,
  workspaceRoot,
} from '../helpers';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'CI',
  GIT_AUTHOR_EMAIL: 'ci@example.com',
  GIT_COMMITTER_NAME: 'CI',
  GIT_COMMITTER_EMAIL: 'ci@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV }).toString();
}

describe('upstream moves', () => {
  before(async () => {
    await ensureBaseReady();
  });

  it('reflects a new base commit after the base ref is fetched', async () => {
    const root = workspaceRoot();
    const originUrl = git(['remote', 'get-url', 'origin'], root).trim();

    // A teammate pushes a newer commit to the base branch, via a throwaway clone.
    const clone = mkdtempSync(join(tmpdir(), 'conflict-lens-it-clone-'));
    git(['clone', originUrl, clone], tmpdir());
    writeFileSync(join(clone, 'upstream.txt'), 'u\nUPSTREAM-newer\nw\n');
    git(['commit', '-am', 'newer base'], clone);
    git(['push', 'origin', 'HEAD:master'], clone);

    // The user's repo fetches it (what the extension's fetch action does).
    git(['fetch', 'origin'], root);

    const file = workspaceFile('upstream.txt');
    const updated = await waitFor(async () => {
      // Close first so we only ever read the freshly opened diff.
      await closeAllEditors();
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      const diff = findDiffTabFor('upstream.txt');
      if (!diff) return false;
      const baseSide = diff.original.scheme === 'file' ? diff.modified : diff.original;
      const baseText = (await vscode.workspace.openTextDocument(baseSide)).getText();
      return baseText.includes('UPSTREAM-newer');
    });

    assert.ok(updated, 'the diff never reflected the newer upstream commit after fetch');
  });

  it('notifies about conflicting places after a manual git fetch (no toast involved)', async () => {
    const root = workspaceRoot();
    const originUrl = git(['remote', 'get-url', 'origin'], root).trim();

    // Local, uncommitted edit to the middle line of upstream.txt…
    writeFileSync(join(root, 'upstream.txt'), 'u\nLOCAL-edit\nw\n');

    // …while a teammate pushes a different change to the same line.
    const clone = mkdtempSync(join(tmpdir(), 'conflict-lens-it-clone2-'));
    git(['clone', originUrl, clone], tmpdir());
    writeFileSync(join(clone, 'upstream.txt'), 'u\nUPSTREAM-second\nw\n');
    git(['commit', '-am', 'second upstream change'], clone);
    git(['push', 'origin', 'HEAD:master'], clone);

    // Capture the warning toast the conflict scan raises. Patching the API
    // object works because the test shares the extension host's vscode
    // module instance.
    const original = vscode.window.showWarningMessage;
    let captured: string | undefined;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (
      message: string,
    ) => {
      captured = message;
      return undefined;
    };
    try {
      // A plain CLI fetch — no Conflict Lens toast, no Fetch button. The
      // extension must notice the base tip moving on its own.
      git(['fetch', 'origin'], root);

      // vscode.git learns about an external fetch through its file watcher,
      // whose latency is unbounded in CI. Nudge its model with `status()`
      // on each poll so the state-change event the extension listens to
      // fires deterministically; the notification path itself is unchanged.
      const gitApi = vscode.extensions
        .getExtension<{ getAPI(version: 1): { repositories: { status(): Promise<void> }[] } }>(
          'vscode.git',
        )
        ?.exports.getAPI(1);
      const notified = await waitFor(async () => {
        await gitApi?.repositories[0]?.status();
        return captured !== undefined;
      });
      assert.ok(notified, 'no conflict notification appeared after a manual fetch');
      // The workspace fixture carries other conflicting files, so the top-3
      // list is not guaranteed to include upstream.txt — assert the header.
      assert.match(captured ?? '', /place\(s\) may conflict with the base branch/);
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
      // Leave the workspace as we found it for the suites that follow.
      git(['checkout', '--', 'upstream.txt'], root);
    }
  });
});
