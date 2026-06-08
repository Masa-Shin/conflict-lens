import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';

import * as vscode from 'vscode';

import {
  closeAllEditors,
  ensureBaseReady,
  findPreviewTab,
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

function checkout(branch: string): void {
  execFileSync('git', ['checkout', branch], {
    cwd: workspaceRoot(),
    env: GIT_ENV,
    stdio: 'ignore',
  });
}

describe('switching the current branch', () => {
  before(async () => {
    await ensureBaseReady();
  });

  // Leave the repo back on `feature` so the other primary suites are unaffected,
  // even if an assertion above fails.
  after(() => {
    checkout('feature');
  });

  it('re-evaluates the conflict against the newly checked-out branch', async () => {
    const conflict = workspaceFile('conflict.txt');

    // On `feature`, conflict.txt diverges from the base on the same line, so a
    // trial merge conflicts and Preview Conflict opens a preview.
    const conflictsOnFeature = await waitFor(async () => {
      await vscode.window.showTextDocument(conflict, { preview: false });
      await vscode.commands.executeCommand('conflictLens.previewConflict');
      return findPreviewTab('conflict') !== undefined;
    });
    assert.ok(conflictsOnFeature, 'expected a conflict preview while on feature');
    await closeAllEditors();

    // `master` already matches the base for this file, so there is no conflict.
    checkout('master');
    const switched = await waitFor(async () => {
      const text = (await vscode.workspace.openTextDocument(conflict)).getText();
      return text.includes('Y-base') && !text.includes('Y-head');
    });
    assert.ok(switched, 'working tree never switched to the master version of the file');

    await vscode.window.showTextDocument(conflict, { preview: false });
    await vscode.commands.executeCommand('conflictLens.previewConflict');
    assert.strictEqual(
      findPreviewTab('conflict'),
      undefined,
      'a conflict preview opened after switching to a branch with no conflict',
    );
  });
});
