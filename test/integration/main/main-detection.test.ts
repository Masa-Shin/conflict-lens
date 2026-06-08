import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { findDiffTabFor, waitFor, workspaceFile } from '../helpers';

describe('base branch auto-detection (origin/main)', () => {
  // The conventional case: a repo on `main` with an origin/main tracking ref.
  // Complements the master-fallback fixture by covering the primary path.
  it('detects origin/main and shows its content in the diff', async () => {
    const file = workspaceFile('main-changed.txt');

    const opened = await waitFor(async () => {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      return findDiffTabFor('main-changed.txt') !== undefined;
    });
    assert.ok(
      opened,
      'Show Base Branch Changes never opened a diff — origin/main was not detected',
    );

    const diff = findDiffTabFor('main-changed.txt')!;
    const baseSide = diff.original.scheme === 'file' ? diff.modified : diff.original;
    const baseText = (await vscode.workspace.openTextDocument(baseSide)).getText();
    assert.ok(
      baseText.includes('TWO-on-main'),
      `base side should carry origin/main's content, got:\n${baseText}`,
    );
  });
});
