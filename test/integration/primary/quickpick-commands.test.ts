import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { closeAllEditors, ensureBaseReady, waitFor } from '../helpers';

/**
 * Replace `vscode.window.showQuickPick` for the duration of `run`, capturing
 * the items the command offered and answering with `choose(items)`. Patching
 * the API object works because the test shares the extension host's vscode
 * module instance (same technique as upstream.test.ts for toasts).
 */
async function withQuickPickStub(
  choose: (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined,
  run: () => Promise<void>,
): Promise<{ readonly items: readonly vscode.QuickPickItem[] | undefined }> {
  const original = vscode.window.showQuickPick;
  let captured: readonly vscode.QuickPickItem[] | undefined;
  (vscode.window as { showQuickPick: unknown }).showQuickPick = async (
    itemsOrThenable: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
  ) => {
    const items = await itemsOrThenable;
    captured = items;
    return choose(items);
  };
  try {
    await run();
  } finally {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = original;
  }
  return { items: captured };
}

/** Wait until the active editor is the working-tree file named `fileName`. */
async function activeEditorBecomes(fileName: string): Promise<boolean> {
  return waitFor(
    () => {
      const doc = vscode.window.activeTextEditor?.document;
      return doc?.uri.scheme === 'file' && doc.uri.path.endsWith(`/${fileName}`);
    },
    { timeoutMs: 10000, intervalMs: 100 },
  );
}

describe('list-and-pick commands', () => {
  before(async () => {
    await ensureBaseReady();
  });

  beforeEach(async () => {
    await closeAllEditors();
  });

  describe('Show Changed Files', () => {
    it('lists every base-changed file, sorted, and opens the picked one', async () => {
      const { items } = await withQuickPickStub(
        (offered) => offered.find((i) => i.label === 'changed.txt'),
        async () => {
          await vscode.commands.executeCommand('conflictLens.showChangedFiles');
        },
      );

      assert.deepStrictEqual(
        items?.map((i) => i.label),
        ['changed.txt', 'conflict.txt', 'deleted.txt', 'multi.txt', 'upstream.txt'],
        'the offered list must be exactly the base-changed files, sorted',
      );
      // Every one of these still exists in the working tree, so none may
      // carry the "not in the current branch" marker.
      assert.ok(
        items.every((i) => i.description === undefined),
        `no item should be flagged as missing locally, got: ${JSON.stringify(items)}`,
      );

      assert.ok(await activeEditorBecomes('changed.txt'), 'the picked file never opened');
    });

    it('opens nothing when the picker is dismissed', async () => {
      await withQuickPickStub(
        () => undefined,
        async () => {
          await vscode.commands.executeCommand('conflictLens.showChangedFiles');
        },
      );
      assert.strictEqual(
        vscode.window.activeTextEditor,
        undefined,
        'dismissing the picker must not open an editor',
      );
    });
  });

  describe('Show Conflict Files', () => {
    it('lists conflicting files, most conflicting first, and opens the picked one', async () => {
      const { items } = await withQuickPickStub(
        (offered) => offered.find((i) => i.label === 'conflict.txt'),
        async () => {
          await vscode.commands.executeCommand('conflictLens.showConflictFiles');
        },
      );

      // multi.txt has two conflicting regions, the others one each
      // (deleted.txt via modify/delete); ties order by path.
      assert.deepStrictEqual(
        items?.map((i) => i.label),
        ['multi.txt', 'conflict.txt', 'deleted.txt'],
        'expected the conflicting files ordered by conflict count, then path',
      );
      assert.match(items[0].description ?? '', /2/, 'multi.txt must report two places');
      assert.match(items[1].description ?? '', /1/, 'conflict.txt must report one place');

      assert.ok(await activeEditorBecomes('conflict.txt'), 'the picked file never opened');
    });

    it('opens nothing when the picker is dismissed', async () => {
      await withQuickPickStub(
        () => undefined,
        async () => {
          await vscode.commands.executeCommand('conflictLens.showConflictFiles');
        },
      );
      assert.strictEqual(
        vscode.window.activeTextEditor,
        undefined,
        'dismissing the picker must not open an editor',
      );
    });
  });

  describe('Select Base Branch', () => {
    it('offers the remote-tracking branches and marks the current base', async () => {
      const { items } = await withQuickPickStub(
        () => undefined, // enumerate only; cancel without changing anything
        async () => {
          await vscode.commands.executeCommand('conflictLens.selectBaseBranch');
        },
      );

      assert.deepStrictEqual(
        items?.map((i) => i.label),
        ['origin/master'],
        'expected exactly the remote-tracking branches (origin/HEAD excluded)',
      );
      assert.strictEqual(items[0].description, '(current)');
    });

    it('keeps working after a base branch is picked', async () => {
      await withQuickPickStub(
        (offered) => offered[0],
        async () => {
          await vscode.commands.executeCommand('conflictLens.selectBaseBranch');
        },
      );
      // The selection persists and triggers a re-resolve; the diff command
      // must still resolve the base afterwards.
      await ensureBaseReady();
    });
  });
});
