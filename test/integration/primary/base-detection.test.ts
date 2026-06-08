import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { findDiffTabFor, waitFor, workspaceFile } from '../helpers';

describe('Show Base Branch Changes (master auto-detection)', () => {
  // The fixture workspace (see .vscode-test.mjs) is a `master` repo whose
  // only remote-tracking base is origin/master — no origin/main. If
  // auto-detection only ever tried origin/main (the old default-baseBranch
  // bug), no base would resolve and the command would notify instead of
  // opening a diff. So a diff opening proves the whole chain works:
  // activate -> detect repo -> auto-detect base (master) -> merge-base ->
  // command.
  it('opens a diff and shows the base branch content for a base-changed file', async () => {
    const file = workspaceFile('changed.txt');

    const opened = await waitFor(async () => {
      // The base resolves asynchronously after activation; retry until ready.
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      return findDiffTabFor('changed.txt') !== undefined;
    });
    assert.ok(opened, 'Show Base Branch Changes never opened a diff — base was not auto-detected');

    // The right (read-only) side of the diff is served by the extension's
    // virtual content provider; it must carry the BASE branch's version of
    // the file (which changed line 2 to "B-base"), not the local working copy.
    const diff = findDiffTabFor('changed.txt');
    assert.ok(diff, 'diff tab vanished');
    const baseSide = diff.original.scheme === 'file' ? diff.modified : diff.original;
    const baseDoc = await vscode.workspace.openTextDocument(baseSide);
    const baseText = baseDoc.getText();
    assert.ok(
      baseText.includes('B-base'),
      `base side should contain the base branch change "B-base", got:\n${baseText}`,
    );
    assert.ok(
      !baseText.includes('\nb\n'),
      `base side should not contain the pre-change line "b", got:\n${baseText}`,
    );
  });
});
