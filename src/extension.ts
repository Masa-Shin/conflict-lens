import * as vscode from 'vscode';

import { t } from './l10n';

const EXTENSION_NAME = 'Conflict Lens';

let logChannel: vscode.LogOutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logChannel = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
  context.subscriptions.push(logChannel);
  logChannel.info(t('{0} activated.', EXTENSION_NAME));

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.name = EXTENSION_NAME;
  statusBarItem.text = t('{0}: (initializing)', EXTENSION_NAME);
  statusBarItem.tooltip = t('{0}: open output channel', EXTENSION_NAME);
  statusBarItem.command = 'conflictLens.showOutputChannel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  registerCommands(context);
}

function registerCommands(context: vscode.ExtensionContext): void {
  // Show Output Channel is the only fully-implemented command at this stage.
  context.subscriptions.push(
    vscode.commands.registerCommand('conflictLens.showOutputChannel', () => {
      logChannel?.show();
    }),
  );

  // Remaining commands are registered as stubs that announce the gap, so that
  // invoking them through the command palette does not fail with
  // "command not found".
  const stubs: ReadonlyArray<[command: string, label: string]> = [
    ['conflictLens.enable', 'Enable'],
    ['conflictLens.disable', 'Disable'],
    ['conflictLens.toggle', 'Toggle'],
    ['conflictLens.selectBaseBranch', 'Select Base Branch'],
    ['conflictLens.refresh', 'Refresh'],
    ['conflictLens.showChangedFiles', 'Show Changed Files'],
    ['conflictLens.openDiff', 'Open Diff'],
  ];

  for (const [command, label] of stubs) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        const message = t("{0}: '{1}' is not implemented yet.", EXTENSION_NAME, label);
        logChannel?.warn(message);
        void vscode.window.showInformationMessage(message);
      }),
    );
  }
}

export function deactivate(): void {
  // Resources registered via context.subscriptions are disposed by VSCode.
  logChannel = undefined;
  statusBarItem = undefined;
}
