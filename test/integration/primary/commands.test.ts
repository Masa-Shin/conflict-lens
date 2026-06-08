import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { findDiffTabFor, findOpenDoc, waitFor, workspaceFile } from '../helpers';

const PREVIEW_SCHEME = 'conflict-lens-preview';

/**
 * Wait until base detection is ready, i.e. Show Base Branch Changes opens a
 * diff for the base-changed file. Lets the per-test assertions below run a
 * single command instead of each polling for readiness.
 */
async function ensureReady(): Promise<void> {
  const file = workspaceFile('changed.txt');
  const ready = await waitFor(async () => {
    await vscode.window.showTextDocument(file, { preview: false });
    await vscode.commands.executeCommand('conflictLens.showBaseChanges');
    return findDiffTabFor('changed.txt') !== undefined;
  });
  if (!ready) throw new Error('extension never became ready (base branch not detected)');
}

describe('command behaviour', () => {
  before(async () => {
    await ensureReady();
  });

  it('does not open a conflict preview for a file with no conflict', async () => {
    // changed.txt was changed on the base only; HEAD left it alone, so a
    // trial merge is clean and Preview Conflict should notify, not open a doc.
    const file = workspaceFile('changed.txt');
    await vscode.window.showTextDocument(file, { preview: false });
    // executeCommand awaits the handler, so the decision is final on return.
    await vscode.commands.executeCommand('conflictLens.previewConflict');
    assert.strictEqual(
      findOpenDoc(PREVIEW_SCHEME, 'changed'),
      undefined,
      'a conflict preview was opened for a non-conflicting file',
    );
  });

  it('diffs the local working copy against the base branch', async () => {
    const file = workspaceFile('changed.txt');
    await vscode.window.showTextDocument(file, { preview: false });
    await vscode.commands.executeCommand('conflictLens.showBaseChanges');
    const diff = findDiffTabFor('changed.txt');
    assert.ok(diff, 'no diff opened');

    const localSide = diff.original.scheme === 'file' ? diff.original : diff.modified;
    const localText = (await vscode.workspace.openTextDocument(localSide)).getText();
    assert.ok(
      localText.includes('\nb\n'),
      `local side should be the working copy (line "b"), got:\n${localText}`,
    );
    assert.ok(
      !localText.includes('B-base'),
      `local side should not be the base content, got:\n${localText}`,
    );
  });

  it('still resolves the base after Refresh discards the caches', async () => {
    await vscode.commands.executeCommand('conflictLens.refresh');
    const file = workspaceFile('changed.txt');
    const ok = await waitFor(async () => {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      return findDiffTabFor('changed.txt') !== undefined;
    });
    assert.ok(ok, 'Show Base Branch Changes stopped working after Refresh');
  });
});
