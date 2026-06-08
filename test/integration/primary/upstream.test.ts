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
});
