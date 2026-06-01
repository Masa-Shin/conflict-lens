import * as vscode from 'vscode';

import {
  resolveBaseBranch,
  type BaseBranchResolution,
  type BaseBranchSource,
} from './git/base-branch';
import {
  resolveGitEnvironment,
  type GitEnvironment,
  type GitEnvironmentResult,
} from './git/binary';
import { listRemoteBranches } from './git/branches';
import {
  detectTargetRepository,
  type TargetRepository,
  type TargetRepositoryResult,
} from './git/repository';
import { detectGitState, type GitState } from './git/state';
import { t } from './l10n';
import { assertNever, stringifyError } from './util/error';

const EXTENSION_NAME = 'Conflict Lens';
/**
 * Re-evaluate git state at most once per this many milliseconds. Matches the
 * spec §3.4 internal-constant for FileDecorationProvider coalesce so that
 * "git add"-driven `Repository.state.onDidChange` storms do not turn into
 * spawn storms. See spec §4.1 "発火頻度のガード".
 */
const STATE_EVALUATION_DEBOUNCE_MS = 100;
const CONFIG_NAMESPACE = 'conflictLens';
const BASE_BRANCH_SETTING = 'baseBranch';

interface RuntimeState {
  logChannel: vscode.LogOutputChannel;
  statusBarItem: vscode.StatusBarItem;
}

interface LiveContext {
  environment: GitEnvironment;
  repository: TargetRepository;
  gitState: GitState;
  baseBranch: string | undefined;
  baseBranchSource: BaseBranchSource | undefined;
}

type ExtensionState =
  | { kind: 'initializing' }
  | { kind: 'unavailable'; reason: string; tooltip?: string }
  | { kind: 'live'; context: LiveContext };

let runtime: RuntimeState | undefined;
let currentState: ExtensionState = { kind: 'initializing' };
let oneShotNotificationsShown: Set<string> = new Set();

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
  oneShotNotificationsShown = new Set();
  setState({ kind: 'initializing' });

  registerCommands(context);

  void initialize(context).catch((err: unknown) => {
    logChannel.error(`Initialization failed: ${stringifyError(err)}`);
    setState({
      kind: 'unavailable',
      reason: '(error)',
      tooltip: t('{0}: initialization failed. See output channel.', EXTENSION_NAME),
    });
  });
}

async function initialize(context: vscode.ExtensionContext): Promise<void> {
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

  const primaryFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repoResult: TargetRepositoryResult = await detectTargetRepository({
    gitApi: environment.gitApi,
    runner: environment.runner,
    primaryWorkspaceFolderPath: primaryFolder,
  });

  if (repoResult.kind !== 'ok') {
    handleRepositoryFailure(repoResult);
    return;
  }
  log?.info(`Target repository: ${repoResult.repository.rootPath}.`);

  const initialGitState = await safeDetectGitState(environment, repoResult.repository);
  log?.info(`Initial git state: ${initialGitState.kind}.`);

  const liveContext: LiveContext = {
    environment,
    repository: repoResult.repository,
    gitState: initialGitState,
    baseBranch: undefined,
    baseBranchSource: undefined,
  };
  setState({ kind: 'live', context: liveContext });

  await refreshBaseBranch();

  const reevaluateState = debounce(async () => {
    try {
      const next = await safeDetectGitState(environment, repoResult.repository);
      setState((prev) => {
        if (prev.kind !== 'live') return prev;
        if (gitStatesEqual(prev.context.gitState, next)) return prev;
        runtime?.logChannel.info(
          `Git state changed: ${prev.context.gitState.kind} → ${next.kind}.`,
        );
        return { kind: 'live', context: { ...prev.context, gitState: next } };
      });
    } catch (err) {
      runtime?.logChannel.warn(`State re-evaluation failed: ${stringifyError(err)}`);
    }
  }, STATE_EVALUATION_DEBOUNCE_MS);

  context.subscriptions.push(
    repoResult.repository.handle.state.onDidChange(() => {
      reevaluateState();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(`${CONFIG_NAMESPACE}.${BASE_BRANCH_SETTING}`)) return;
      await refreshBaseBranch();
    }),
  );
}

async function refreshBaseBranch(): Promise<void> {
  if (currentState.kind !== 'live') return;
  const { environment, repository } = currentState.context;
  const log = runtime?.logChannel;
  const configured = readConfiguredBaseBranch(repository.handle.rootUri);

  let resolution: BaseBranchResolution;
  try {
    resolution = await resolveBaseBranch({
      runner: environment.runner,
      repoRootPath: repository.rootPath,
      configured,
    });
  } catch (err) {
    log?.warn(`resolveBaseBranch threw: ${stringifyError(err)}`);
    return;
  }

  if (resolution.kind === 'ok') {
    log?.info(
      `Base branch resolved: ${resolution.baseBranch} (${resolution.source}).`,
    );
    setState((prev) => {
      if (prev.kind !== 'live') return prev;
      return {
        kind: 'live',
        context: {
          ...prev.context,
          baseBranch: resolution.baseBranch,
          baseBranchSource: resolution.source,
        },
      };
    });
    return;
  }

  if (resolution.kind === 'configured-invalid') {
    log?.warn(
      `Configured baseBranch "${resolution.configured}" is invalid: ` +
        `${resolution.validation.kind}.`,
    );
    setState((prev) => {
      if (prev.kind !== 'live') return prev;
      return {
        kind: 'live',
        context: { ...prev.context, baseBranch: undefined, baseBranchSource: undefined },
      };
    });
    notifyOnce(
      'configured-invalid',
      t(
        "{0}: configured base branch '{1}' is invalid or not fetched.",
        EXTENSION_NAME,
        resolution.configured,
      ),
      { action: 'select-base-branch' },
    );
    return;
  }

  // none-found
  log?.info('No base branch could be detected.');
  setState((prev) => {
    if (prev.kind !== 'live') return prev;
    return {
      kind: 'live',
      context: { ...prev.context, baseBranch: undefined, baseBranchSource: undefined },
    };
  });
  notifyOnce(
    'none-found',
    t(
      '{0}: could not detect a base branch. Run Select Base Branch to set one.',
      EXTENSION_NAME,
    ),
    { action: 'select-base-branch' },
  );
}

function readConfiguredBaseBranch(scope: vscode.Uri | undefined): string | undefined {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE, scope);
  const value = cfg.get<string>(BASE_BRANCH_SETTING);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

type NotificationAction = 'select-base-branch';

function notifyOnce(
  key: string,
  message: string,
  options: { action?: NotificationAction } = {},
): void {
  if (oneShotNotificationsShown.has(key)) return;
  oneShotNotificationsShown.add(key);
  if (options.action === 'select-base-branch') {
    // Capture the localized label once so we can compare it back to `choice`
    // safely. Comparing against the English literal 'Select' would break the
    // moment a localized bundle ships.
    const label = t('Select');
    void vscode.window
      .showInformationMessage(message, label)
      .then((choice) => {
        if (choice === label) {
          void vscode.commands.executeCommand('conflictLens.selectBaseBranch');
        }
      });
  } else {
    void vscode.window.showInformationMessage(message);
  }
}

async function safeDetectGitState(
  environment: GitEnvironment,
  repository: TargetRepository,
): Promise<GitState> {
  try {
    return await detectGitState(environment.runner, repository.rootPath, {
      onWarn: (msg) => runtime?.logChannel.warn(msg),
    });
  } catch (err) {
    runtime?.logChannel.warn(`detectGitState threw: ${stringifyError(err)}`);
    return { kind: 'ready', detached: false, bisecting: false };
  }
}

function gitStatesEqual(a: GitState, b: GitState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ready' && b.kind === 'ready') {
    return a.detached === b.detached && a.bisecting === b.bisecting;
  }
  return true;
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
      const version = result.version.raw;
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
      // Unreachable: callers branch on result.kind before invoking this
      // helper. Kept as an exhaustiveness witness; assertNever would catch
      // a missing variant if GitEnvironmentResult grows another option.
      return;
    default:
      assertNever(result);
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
        tooltip: t('{0}: workspace is not a git repository.', EXTENSION_NAME),
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
      // Unreachable: see comment in handleGitEnvironmentFailure.
      return;
    default:
      assertNever(result);
  }
}

function setState(
  next: ExtensionState | ((prev: ExtensionState) => ExtensionState),
): void {
  if (!runtime) return;
  const resolved =
    typeof next === 'function'
      ? (next as (p: ExtensionState) => ExtensionState)(currentState)
      : next;
  currentState = resolved;
  renderStatusBar(resolved);
}

function renderStatusBar(state: ExtensionState): void {
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
    case 'live': {
      const { context } = state;
      const baseLabel = context.baseBranch ?? '(no base)';
      const stateLabel = localizedStateLabel(context.gitState);
      if (context.gitState.kind === 'ready') {
        statusBarItem.text = stateLabel
          ? `${EXTENSION_NAME}: ${baseLabel} ${stateLabel}`
          : `${EXTENSION_NAME}: ${baseLabel}`;
      } else {
        statusBarItem.text = `${EXTENSION_NAME}: ${stateLabel}`;
      }
      statusBarItem.tooltip = tooltipFor(context);
      return;
    }
    default:
      assertNever(state);
  }
}

/**
 * Translate a GitState to a status-bar suffix. Equivalent in shape to
 * `statusLabelFor` from src/git/state.ts, but routed through `t()` so the
 * label survives bundle replacement. The pure helper is intentionally kept
 * in state.ts so that unit tests do not depend on vscode.
 */
function localizedStateLabel(state: GitState): string {
  switch (state.kind) {
    case 'no-commits':
      return t('(no commits)');
    case 'rebasing':
      return t('(rebasing)');
    case 'merging':
      return t('(merging)');
    case 'cherry-picking':
      return t('(cherry-picking)');
    case 'reverting':
      return t('(reverting)');
    case 'ready': {
      if (!state.detached && !state.bisecting) return '';
      const mods: string[] = [];
      if (state.detached) mods.push(t('detached'));
      if (state.bisecting) mods.push(t('bisecting'));
      return `(${mods.join(', ')})`;
    }
    default:
      return assertNever(state);
  }
}

function tooltipFor(context: LiveContext): string {
  switch (context.gitState.kind) {
    case 'no-commits':
      return t('{0}: repository has no commits yet.', EXTENSION_NAME);
    case 'rebasing':
      return t('{0}: highlighting paused while rebase is in progress.', EXTENSION_NAME);
    case 'merging':
      return t('{0}: highlighting paused while merge is in progress.', EXTENSION_NAME);
    case 'cherry-picking':
      return t(
        '{0}: highlighting paused while cherry-pick is in progress.',
        EXTENSION_NAME,
      );
    case 'reverting':
      return t('{0}: highlighting paused while revert is in progress.', EXTENSION_NAME);
    case 'ready':
      if (context.baseBranch) {
        return t(
          '{0}: comparing against {1}. Click to open the output channel.',
          EXTENSION_NAME,
          context.baseBranch,
        );
      }
      return t('{0}: no base branch selected.', EXTENSION_NAME);
    default:
      return assertNever(context.gitState);
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('conflictLens.showOutputChannel', () => {
      runtime?.logChannel.show();
    }),
    vscode.commands.registerCommand(
      'conflictLens.selectBaseBranch',
      selectBaseBranchCommand,
    ),
  );

  const stubs: ReadonlyArray<[command: string, label: string]> = [
    ['conflictLens.enable', 'Enable'],
    ['conflictLens.disable', 'Disable'],
    ['conflictLens.toggle', 'Toggle'],
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

async function selectBaseBranchCommand(): Promise<void> {
  if (currentState.kind === 'initializing') {
    void vscode.window.showInformationMessage(
      t('{0}: still initializing, please retry shortly.', EXTENSION_NAME),
    );
    return;
  }
  if (currentState.kind === 'unavailable') {
    void vscode.window.showInformationMessage(
      t('{0}: not available in this workspace.', EXTENSION_NAME),
    );
    return;
  }
  const { environment, repository } = currentState.context;
  let listing;
  try {
    listing = await listRemoteBranches(environment.runner, repository.rootPath);
  } catch (err) {
    runtime?.logChannel.warn(`listRemoteBranches threw: ${stringifyError(err)}`);
    void vscode.window.showWarningMessage(
      t('{0}: failed to enumerate remote branches.', EXTENSION_NAME),
    );
    return;
  }
  if (listing.branches.length === 0) {
    void vscode.window.showWarningMessage(
      t(
        '{0}: no remote-tracking branches found. Run git fetch first.',
        EXTENSION_NAME,
      ),
    );
    return;
  }

  const currentBase = currentState.context.baseBranch;
  const items = listing.branches.map((branch) => ({
    label: branch,
    description: branch === currentBase ? '(current)' : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `${EXTENSION_NAME}: Select Base Branch`,
    placeHolder: t('Choose a remote-tracking branch to compare against'),
    matchOnDescription: true,
  });
  if (!picked) return;

  try {
    await vscode.workspace
      .getConfiguration(CONFIG_NAMESPACE, repository.handle.rootUri)
      .update(BASE_BRANCH_SETTING, picked.label, vscode.ConfigurationTarget.Workspace);
  } catch (err) {
    runtime?.logChannel.warn(`Saving baseBranch failed: ${stringifyError(err)}`);
    void vscode.window.showWarningMessage(
      t('{0}: failed to save selection.', EXTENSION_NAME),
    );
    return;
  }
  // Re-evaluation is triggered by onDidChangeConfiguration.
}

function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let handle: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = undefined;
      fn(...args);
    }, delayMs);
  };
}

export function deactivate(): void {
  runtime = undefined;
  currentState = { kind: 'initializing' };
  oneShotNotificationsShown = new Set();
}
