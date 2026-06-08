import * as assert from 'node:assert';

import * as vscode from 'vscode';

const EXTENSION_ID = 'Masa-Shin.conflict-lens';

const CONTRIBUTED_COMMANDS = [
  'conflictLens.enable',
  'conflictLens.disable',
  'conflictLens.toggle',
  'conflictLens.selectBaseBranch',
  'conflictLens.refresh',
  'conflictLens.showChangedFiles',
  'conflictLens.showBaseChanges',
  'conflictLens.previewConflict',
  'conflictLens.showOutputChannel',
];

describe('activation', () => {
  it('is installed and activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} is not installed in the test host`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension did not become active');
  });

  it('registers every contributed command', async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const command of CONTRIBUTED_COMMANDS) {
      assert.ok(registered.includes(command), `command not registered: ${command}`);
    }
  });
});
