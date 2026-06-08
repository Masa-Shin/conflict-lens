import * as assert from 'node:assert';

import * as vscode from 'vscode';

import {
  ensureBaseReady,
  findDiffTabFor,
  findOpenDoc,
  findPreviewTab,
  waitFor,
  workspaceFile,
} from '../helpers';

describe('scenarios', () => {
  before(async () => {
    await ensureBaseReady();
  });

  it('produces one conflict block per conflicting region', async () => {
    const file = workspaceFile('multi.txt'); // lines 2 and 5 changed on both sides
    const opened = await waitFor(async () => {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.previewConflict');
      return findOpenDoc('conflict-lens-preview', 'multi') !== undefined;
    });
    assert.ok(opened, 'no preview opened for the multi-conflict file');

    const text = findOpenDoc('conflict-lens-preview', 'multi')!.getText();
    const markerCount = text.split('<<<<<<<').length - 1;
    assert.strictEqual(markerCount, 2, `expected 2 conflict regions, got ${markerCount}:\n${text}`);
    assert.ok(text.includes('TWO-head') && text.includes('TWO-base'), 'first region missing sides');
    assert.ok(
      text.includes('NINETEEN-head') && text.includes('NINETEEN-base'),
      'second region missing sides',
    );
  });

  it('shows the base side as absent for a file deleted on the base', async () => {
    const file = workspaceFile('deleted.txt'); // present locally, deleted on base
    const opened = await waitFor(async () => {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      return findDiffTabFor('deleted.txt') !== undefined;
    });
    assert.ok(opened, 'no diff opened for the base-deleted file');

    const diff = findDiffTabFor('deleted.txt')!;
    const baseSide = diff.original.scheme === 'file' ? diff.modified : diff.original;
    const baseText = (await vscode.workspace.openTextDocument(baseSide)).getText();
    // The base no longer has this file, so the base side must not carry the
    // local content ("keep me"); the provider renders an "absent" notice.
    assert.ok(
      !baseText.includes('keep me'),
      `base side should not carry the local content for a base-deleted file, got:\n${baseText}`,
    );
  });

  it('does not open a preview for a modify/delete conflict', async () => {
    // deleted.txt is modified locally but deleted on the base, so there is no
    // base-side content to merge against. Preview Conflict notifies instead of
    // opening a preview.
    const file = workspaceFile('deleted.txt');
    await vscode.window.showTextDocument(file, { preview: false });
    await vscode.commands.executeCommand('conflictLens.previewConflict');
    assert.strictEqual(
      findPreviewTab('deleted'),
      undefined,
      'a preview opened for a modify/delete conflict',
    );
  });

  describe('while the extension is disabled', () => {
    after(async () => {
      await vscode.commands.executeCommand('conflictLens.enable');
    });

    it('still opens the on-demand diff (explicit command, not automatic)', async () => {
      await vscode.commands.executeCommand('conflictLens.disable');
      const file = workspaceFile('changed.txt');
      const opened = await waitFor(async () => {
        await vscode.window.showTextDocument(file, { preview: false });
        await vscode.commands.executeCommand('conflictLens.showBaseChanges');
        return findDiffTabFor('changed.txt') !== undefined;
      });
      assert.ok(opened, 'Show Base Branch Changes should still work on demand when disabled');
      // The preview command should likewise remain available.
      assert.ok(findPreviewTab('changed') === undefined, 'unexpected preview for a clean file');
    });
  });
});
