import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { findDiffTabFor, workspaceFile } from '../helpers';

const EXTENSION_ID = 'Masa-Shin.conflict-lens';

describe('repository with no detectable base branch', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  it('opens nothing and stays healthy when no base can be detected', async () => {
    const file = workspaceFile('solo.txt');

    // This repo has a commit but no remote, so no base ever resolves. Invoke
    // the command a few times across a window: it must never open a diff (it
    // notifies instead), and the extension must not crash.
    let everOpened = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      if (findDiffTabFor('solo.txt') !== undefined) everOpened = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    assert.strictEqual(everOpened, false, 'a diff was opened even though there is no base branch');
    assert.strictEqual(
      vscode.extensions.getExtension(EXTENSION_ID)?.isActive,
      true,
      'extension should remain active after a no-base command',
    );
  });
});
