import * as assert from 'node:assert';
import * as path from 'node:path';

import * as vscode from 'vscode';

/** Poll `predicate` until it returns true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 30000, intervalMs = 1000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** True if any open tab is a diff whose either side is `fileName`. */
function hasBaseChangesDiffFor(fileName: string): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        (input.original.path.endsWith(fileName) || input.modified.path.endsWith(fileName))
      ) {
        return true;
      }
    }
  }
  return false;
}

describe('base branch auto-detection (master fallback)', () => {
  // The fixture workspace (see .vscode-test.mjs) is a `master` repo with an
  // `origin/master` tracking ref but no `origin/main`. If auto-detection only
  // ever tried `origin/main` (the old default-baseBranch bug), no base would
  // resolve and "Show Base Branch Changes" would notify instead of opening a
  // diff — so a diff opening proves master was detected end to end.
  it('resolves the base so Show Base Branch Changes opens a diff', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'no workspace folder was opened for the test');

    const file = vscode.Uri.file(path.join(folder.uri.fsPath, 'file.txt'));

    // The extension resolves the base asynchronously after activation, so
    // retry: re-focus the file and run the command until the diff appears.
    const opened = await waitFor(async () => {
      await vscode.window.showTextDocument(file, { preview: false });
      await vscode.commands.executeCommand('conflictLens.showBaseChanges');
      return hasBaseChangesDiffFor('file.txt');
    });

    assert.ok(
      opened,
      'Show Base Branch Changes never opened a diff — the base branch was not auto-detected',
    );
  });
});
