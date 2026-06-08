import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { findOpenDoc, waitFor, workspaceFile } from './helpers';

const PREVIEW_SCHEME = 'conflict-lens-preview';

describe('Preview Conflict', () => {
  // conflict.txt is edited differently on the base (origin/master, "Y-base")
  // and on HEAD ("Y-head") relative to the merge-base, so a trial merge must
  // conflict. This exercises the core prediction path end to end: merge-base
  // resolution -> reading both blobs -> git merge-file -> the read-only
  // preview document carrying real conflict markers.
  it('opens a preview containing conflict markers for a conflicting file', async () => {
    const file = workspaceFile('conflict.txt');

    const opened = await waitFor(async () => {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.previewConflict');
      return findOpenDoc(PREVIEW_SCHEME, 'conflict') !== undefined;
    });
    assert.ok(opened, 'Preview Conflict never opened a preview document');

    const preview = findOpenDoc(PREVIEW_SCHEME, 'conflict');
    assert.ok(preview, 'preview document vanished');
    const text = preview.getText();

    assert.ok(text.includes('<<<<<<<'), `missing "<<<<<<<" marker, got:\n${text}`);
    assert.ok(text.includes('======='), `missing "=======" marker, got:\n${text}`);
    assert.ok(text.includes('>>>>>>>'), `missing ">>>>>>>" marker, got:\n${text}`);
    // Both sides of the conflict should be present.
    assert.ok(text.includes('Y-head'), `missing the HEAD side "Y-head", got:\n${text}`);
    assert.ok(text.includes('Y-base'), `missing the base side "Y-base", got:\n${text}`);
  });
});
