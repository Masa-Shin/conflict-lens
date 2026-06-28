import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { waitFor } from '../helpers';

const EXTENSION_ID = 'Masa-Shin.conflict-lens';

/**
 * Run `command` (repeatedly — the extension may still be initializing) until
 * one of the toasts it raises matches `expected`, capturing toasts by
 * patching the shared vscode module instance (same technique as
 * upstream.test.ts in the primary suite).
 */
async function commandToast(command: string, expected: string): Promise<string | undefined> {
  const originalInfo = vscode.window.showInformationMessage;
  const originalWarning = vscode.window.showWarningMessage;
  const seen: string[] = [];
  const capture = async (message: string) => {
    seen.push(message);
    return undefined;
  };
  (vscode.window as { showInformationMessage: unknown }).showInformationMessage = capture;
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = capture;
  try {
    await waitFor(
      async () => {
        await vscode.commands.executeCommand(command);
        return seen.includes(expected);
      },
      { timeoutMs: 20000, intervalMs: 500 },
    );
    return seen.find((m) => m === expected) ?? seen.at(-1);
  } finally {
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
  }
}

describe('while no base branch can be resolved', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  it('Show Changed Files explains that no base branch is selected', async () => {
    assert.strictEqual(
      await commandToast(
        'conflictLens.showChangedFiles',
        'Conflict Lens: no base branch selected.',
      ),
      'Conflict Lens: no base branch selected.',
    );
  });

  it('Show Conflict Files explains that no base branch is selected', async () => {
    assert.strictEqual(
      await commandToast(
        'conflictLens.showConflictFiles',
        'Conflict Lens: no base branch selected.',
      ),
      'Conflict Lens: no base branch selected.',
    );
  });

  it('Select Base Branch explains that there are no remote-tracking branches', async () => {
    assert.strictEqual(
      await commandToast(
        'conflictLens.selectBaseBranch',
        'Conflict Lens: no remote-tracking branches found. Run git fetch first.',
      ),
      'Conflict Lens: no remote-tracking branches found. Run git fetch first.',
    );
  });
});
