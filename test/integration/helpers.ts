import * as vscode from 'vscode';

/** Poll `predicate` until it returns true or the timeout elapses. */
export async function waitFor(
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

/** The first open diff tab whose either side ends with `fileName`, if any. */
export function findDiffTabFor(fileName: string): vscode.TabInputTextDiff | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        (input.original.path.endsWith(fileName) || input.modified.path.endsWith(fileName))
      ) {
        return input;
      }
    }
  }
  return undefined;
}

/** An open text document with the given URI scheme whose path contains `namePart`. */
export function findOpenDoc(scheme: string, namePart: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (doc) => doc.uri.scheme === scheme && doc.uri.path.includes(namePart),
  );
}

/** A `file:` URI for `name` under the test workspace folder. */
export function workspaceFile(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder was opened for the test');
  return vscode.Uri.joinPath(folder.uri, name);
}
