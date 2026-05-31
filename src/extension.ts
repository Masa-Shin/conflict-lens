import * as vscode from 'vscode';

const EXTENSION_NAME = 'Conflict Lens';

let logChannel: vscode.LogOutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logChannel = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
  context.subscriptions.push(logChannel);
  logChannel.info(`${EXTENSION_NAME} activated.`);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.name = EXTENSION_NAME;
  statusBarItem.text = `${EXTENSION_NAME}: (initializing)`;
  statusBarItem.tooltip = `${EXTENSION_NAME}: open output channel`;
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
        const message = `${EXTENSION_NAME}: '${label}' is not implemented yet.`;
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
