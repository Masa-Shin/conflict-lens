import * as vscode from 'vscode';

import {
  resolveGitEnvironment,
  type GitEnvironment,
  type GitEnvironmentResult,
  type ParsedGitVersion,
} from './git/binary';
import {
  detectTargetRepository,
  type TargetRepository,
  type TargetRepositoryResult,
} from './git/repository';
import { t } from './l10n';

const EXTENSION_NAME = 'Conflict Lens';

interface RuntimeState {
  logChannel: vscode.LogOutputChannel;
  statusBarItem: vscode.StatusBarItem;
}

type ExtensionState =
  | { kind: 'initializing' }
  | { kind: 'unavailable'; reason: string; tooltip?: string }
  | { kind: 'ready'; environment: GitEnvironment; repository: TargetRepository };

let runtime: RuntimeState | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logChannel = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
  context.subscriptions.push(logChannel);
  logChannel.info(t('{0} activated.', EXTENSION_NAME));

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.name = EXTENSION_NAME;
  statusBarItem.command = 'conflictLens.showOutputChannel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  runtime = { logChannel, statusBarItem };
  setState({ kind: 'initializing' });

  registerCommands(context);

  // Fire-and-forget initialization. Any failure is surfaced via state changes.
  void initialize(context).catch((err: unknown) => {
    logChannel.error(`Initialization failed: ${stringifyError(err)}`);
    setState({
      kind: 'unavailable',
      reason: '(error)',
      tooltip: t('{0}: initialization failed. See output channel.', EXTENSION_NAME),
    });
  });
}

async function initialize(_context: vscode.ExtensionContext): Promise<void> {
  const log = runtime?.logChannel;
  const gitExt = vscode.extensions.getExtension('vscode.git');

  const envResult: GitEnvironmentResult = await resolveGitEnvironment(gitExt);
  if (envResult.kind !== 'ok') {
    handleGitEnvironmentFailure(envResult);
    return;
  }
  const { environment } = envResult;
  log?.info(
    `Git ${environment.version.raw} resolved at ${environment.runner.gitPath} ` +
      `(conflict prediction: ${environment.supportsConflictPrediction ? 'enabled' : 'disabled'}).`,
  );

  const gitApi = (
    gitExt!.exports as { getAPI(version: number): import('./git/vscode-git-api').VscodeGitApi }
  ).getAPI(1);
  const primaryFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repoResult: TargetRepositoryResult = await detectTargetRepository({
    gitApi,
    runner: environment.runner,
    primaryWorkspaceFolderPath: primaryFolder,
  });

  if (repoResult.kind !== 'ok') {
    handleRepositoryFailure(repoResult);
    return;
  }
  log?.info(`Target repository: ${repoResult.repository.rootPath}.`);
  setState({
    kind: 'ready',
    environment,
    repository: repoResult.repository,
  });
}

function handleGitEnvironmentFailure(result: GitEnvironmentResult): void {
  const log = runtime?.logChannel;
  switch (result.kind) {
    case 'vscode-git-unavailable':
      log?.warn(`vscode.git unavailable: ${result.reason}`);
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t(
          '{0}: built-in Git extension is unavailable. {1}',
          EXTENSION_NAME,
          result.reason,
        ),
      });
      return;
    case 'git-not-found':
      log?.warn(`git binary unavailable: ${result.reason}`);
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t(
          '{0}: git executable not found. {1}',
          EXTENSION_NAME,
          result.reason,
        ),
      });
      return;
    case 'git-too-old': {
      const version = formatVersion(result.version);
      log?.warn(`git ${version} is below the minimum supported version (2.30).`);
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t(
          '{0}: git {1} is too old. Requires git 2.30 or newer.',
          EXTENSION_NAME,
          version,
        ),
      });
      return;
    }
    case 'ok':
      // Handled by caller.
      return;
  }
}

function handleRepositoryFailure(result: TargetRepositoryResult): void {
  const log = runtime?.logChannel;
  switch (result.kind) {
    case 'no-workspace':
      log?.info('No workspace folder; staying inactive.');
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t('{0}: open a folder to use Conflict Lens.', EXTENSION_NAME),
      });
      return;
    case 'not-a-repository':
      log?.info('Workspace is not a git repository.');
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t(
          '{0}: workspace is not a git repository.',
          EXTENSION_NAME,
        ),
      });
      return;
    case 'submodule':
      log?.info(`Workspace is a submodule of ${result.superprojectPath}; skipping.`);
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t(
          '{0}: workspace is a submodule; not supported in MVP.',
          EXTENSION_NAME,
        ),
      });
      return;
    case 'timed-out':
      log?.warn('Timed out waiting for vscode.git to discover the repository.');
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t(
          '{0}: timed out waiting for the built-in Git extension.',
          EXTENSION_NAME,
        ),
      });
      return;
    case 'ok':
      // Handled by caller.
      return;
  }
}

function setState(state: ExtensionState): void {
  if (!runtime) return;
  const { statusBarItem } = runtime;
  switch (state.kind) {
    case 'initializing':
      statusBarItem.text = t('{0}: (initializing)', EXTENSION_NAME);
      statusBarItem.tooltip = t('{0}: open output channel', EXTENSION_NAME);
      return;
    case 'unavailable':
      statusBarItem.text = `${EXTENSION_NAME}: ${state.reason}`;
      statusBarItem.tooltip =
        state.tooltip ?? t('{0}: open output channel', EXTENSION_NAME);
      return;
    case 'ready':
      // Base branch isn't chosen yet; that lands in Phase 4.
      statusBarItem.text = `${EXTENSION_NAME}: (no base)`;
      statusBarItem.tooltip = t('{0}: open output channel', EXTENSION_NAME);
      return;
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('conflictLens.showOutputChannel', () => {
      runtime?.logChannel.show();
    }),
  );

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
        runtime?.logChannel.warn(message);
        void vscode.window.showInformationMessage(message);
      }),
    );
  }
}

function formatVersion(v: ParsedGitVersion): string {
  return v.raw;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function deactivate(): void {
  runtime = undefined;
}
