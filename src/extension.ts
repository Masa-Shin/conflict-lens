import * as path from 'node:path';

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
  createBlobReaderFromBatch,
  GitCatFileBatch,
} from './git/cat-file-batch';
import { listChangedFilesOnBase } from './git/changed-files';
import { resolveMergeBase } from './git/diff';
import type { BlobReader } from './git/blob';
import { runMergeTree } from './git/merge-tree';
import {
  checkRemoteForUpdates,
  splitRemoteBranch,
} from './git/remote-check';
import {
  detectTargetRepository,
  isFileWithinRepository,
  type TargetRepository,
  type TargetRepositoryResult,
} from './git/repository';
import { detectGitState, type GitState } from './git/state';
import { subtractRanges } from './diff/range-ops';
import { t } from './l10n';
import {
  FileDecorationCoordinator,
  type FileDecorationSettings,
} from './ui/file-decoration';
import {
  StrongDecorationCoordinator,
  type StrongHighlightInputs,
} from './ui/strong-decoration';
import {
  WeakDecorationCoordinator,
  type WeakDecorationSettings,
  type WeakHighlightInputs,
} from './ui/weak-decoration';
import { assertNever, stringifyError } from './util/error';

const EXTENSION_NAME = 'Conflict Lens';
/**
 * Re-evaluate git state at most once per this many milliseconds. Matches the
 * spec §3.4 internal-constant for FileDecorationProvider coalesce so that
 * "git add"-driven `Repository.state.onDidChange` storms do not turn into
 * spawn storms. See spec §4.1 "発火頻度のガード".
 */
const STATE_EVALUATION_DEBOUNCE_MS = 100;
const DECORATION_REFRESH_DEBOUNCE_MS = 50;
/**
 * Per-document debounce for buffer-following refresh. Higher than the
 * global decoration refresh because typing fires `onDidChangeTextDocument`
 * on every keystroke; recomputing too aggressively would saturate git with
 * spawns and produce visible flicker while the diff is still running.
 */
const DOCUMENT_REFRESH_DEBOUNCE_MS = 200;
const CONFIG_NAMESPACE = 'conflictLens';
const BASE_BRANCH_SETTING = 'baseBranch';
const ENABLED_SETTING = 'enabled';
const SHOW_OVERVIEW_RULER_SETTING = 'showOverviewRuler';
const SHOW_GUTTER_ICON_SETTING = 'showGutterIcon';
const ENABLE_CONFLICT_PREDICTION_SETTING = 'enableConflictPrediction';
const SHOW_FILE_DECORATION_COLORS_SETTING = 'showFileDecorationColors';
const SHOW_FILE_DECORATION_BADGES_SETTING = 'showFileDecorationBadges';
const REMOTE_CHECK_INTERVAL_SETTING = 'remoteCheckIntervalMinutes';
const AUTO_FETCH_SETTING = 'autoFetchOnRemoteUpdate';
const LARGE_FILE_HUNK_THRESHOLD_SETTING = 'largeFileHunkThreshold';
/**
 * Custom URI scheme used by the "Open Diff" command to feed the
 * base-side blob into VSCode's built-in diff editor. URIs look like
 * `conflict-lens://base/<repo-relative-path>?<ref>` where the query
 * carries the git ref (typically `origin/main`); the content provider
 * fetches the blob via the same long-lived `cat-file --batch` that
 * powers the highlight pipeline.
 */
const DIFF_PROVIDER_SCHEME = 'conflict-lens';

interface RuntimeState {
  logChannel: vscode.LogOutputChannel;
  statusBarItem: vscode.StatusBarItem;
  weakDecorations: WeakDecorationCoordinator;
  strongDecorations: StrongDecorationCoordinator;
  fileDecorations: FileDecorationCoordinator;
}

interface LiveContext {
  environment: GitEnvironment;
  repository: TargetRepository;
  gitState: GitState;
  baseBranch: string | undefined;
  baseBranchSource: BaseBranchSource | undefined;
  /**
   * Long-lived `git cat-file --batch` for blob reads. Created once per
   * activation on the resolved git binary and disposed via the extension
   * context. Wrapped in `readBlob` and reused for every refresh.
   */
  catFileBatch: GitCatFileBatch;
  readBlob: BlobReader;
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

  const weakGutterIconUri = vscode.Uri.joinPath(
    context.extensionUri,
    'media',
    'changed-line.svg',
  );
  const strongGutterIconUri = vscode.Uri.joinPath(
    context.extensionUri,
    'media',
    'conflict-line.svg',
  );
  const initialSettings = readWeakDecorationSettings();
  const weakDecorations = new WeakDecorationCoordinator(
    weakGutterIconUri,
    initialSettings,
    '(no base)',
  );
  const strongDecorations = new StrongDecorationCoordinator(
    strongGutterIconUri,
    initialSettings,
    '(no base)',
  );
  const fileDecorations = new FileDecorationCoordinator(
    readFileDecorationSettings(),
  );
  const diffContentProvider = new BaseSideContentProvider(() =>
    currentState.kind === 'live' ? currentState.context.readBlob : undefined,
  );
  context.subscriptions.push(
    weakDecorations,
    strongDecorations,
    fileDecorations,
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_PROVIDER_SCHEME,
      diffContentProvider,
    ),
  );

  runtime = {
    logChannel,
    statusBarItem,
    weakDecorations,
    strongDecorations,
    fileDecorations,
  };
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

  const folders = vscode.workspace.workspaceFolders;
  const primaryFolder = folders?.[0]?.uri.fsPath;
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

  // Spec §3.1.3 / §5.5: MVP monitors only the first workspace folder.
  // Surface the limit once per session so users with a multi-root
  // workspace know why other folders look unmonitored.
  if (folders && folders.length > 1) {
    notifyOnce(
      'multi-root',
      t(
        '{0}: multi-root workspace detected. Only the first folder ({1}) is monitored.',
        EXTENSION_NAME,
        folders[0].name,
      ),
    );
  }

  const initialGitState = await safeDetectGitState(environment, repoResult.repository);
  log?.info(`Initial git state: ${initialGitState.kind}.`);

  const catFileBatch = new GitCatFileBatch({
    gitPath: environment.runner.gitPath,
    cwd: repoResult.repository.rootPath,
  });
  context.subscriptions.push({ dispose: () => catFileBatch.dispose() });
  const readBlob = createBlobReaderFromBatch(catFileBatch);

  const liveContext: LiveContext = {
    environment,
    repository: repoResult.repository,
    gitState: initialGitState,
    baseBranch: undefined,
    baseBranchSource: undefined,
    catFileBatch,
    readBlob,
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
      // HEAD may have moved (commit, checkout). Re-run weak highlights too.
      scheduleDecorationRefresh();
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
      const baseChanged = event.affectsConfiguration(
        `${CONFIG_NAMESPACE}.${BASE_BRANCH_SETTING}`,
      );
      const enabledChanged = event.affectsConfiguration(
        `${CONFIG_NAMESPACE}.${ENABLED_SETTING}`,
      );
      const strongEnabledChanged = event.affectsConfiguration(
        `${CONFIG_NAMESPACE}.${ENABLE_CONFLICT_PREDICTION_SETTING}`,
      );
      const visualsChanged =
        event.affectsConfiguration(`${CONFIG_NAMESPACE}.${SHOW_GUTTER_ICON_SETTING}`) ||
        event.affectsConfiguration(`${CONFIG_NAMESPACE}.${SHOW_OVERVIEW_RULER_SETTING}`);
      const fileDecorationsChanged =
        event.affectsConfiguration(
          `${CONFIG_NAMESPACE}.${SHOW_FILE_DECORATION_COLORS_SETTING}`,
        ) ||
        event.affectsConfiguration(
          `${CONFIG_NAMESPACE}.${SHOW_FILE_DECORATION_BADGES_SETTING}`,
        );
      const thresholdChanged = event.affectsConfiguration(
        `${CONFIG_NAMESPACE}.${LARGE_FILE_HUNK_THRESHOLD_SETTING}`,
      );

      if (baseChanged) await refreshBaseBranch();
      if (visualsChanged) applyWeakDecorationSettings();
      if (fileDecorationsChanged) applyFileDecorationSettings();
      if (
        enabledChanged ||
        visualsChanged ||
        strongEnabledChanged ||
        fileDecorationsChanged ||
        thresholdChanged
      ) {
        // Threshold changes alter the cache-key dimension, so existing
        // entries are not stale — they live under different keys.
        // Refresh suffices.
        scheduleDecorationRefresh();
      }
      if (
        event.affectsConfiguration(
          `${CONFIG_NAMESPACE}.${REMOTE_CHECK_INTERVAL_SETTING}`,
        )
      ) {
        startOrRestartRemoteCheckTimer();
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => scheduleDecorationRefresh()),
    vscode.window.onDidChangeVisibleTextEditors(() => scheduleDecorationRefresh()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      // Skip schemes we never decorate (output, git, search, etc.).
      if (doc.uri.scheme !== 'file') return;
      // No textual changes (e.g., dirty-state toggle): nothing to recompute.
      if (event.contentChanges.length === 0) return;
      scheduleDocumentRefresh(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      cancelDocumentRefresh(doc);
    }),
  );

  // Initial pass for any editors already open at activation.
  scheduleDecorationRefresh();
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
    applyWeakDecorationSettings();
    applyFileDecorationSettings();
    scheduleDecorationRefresh();
    // A successful resolution clears the dedupe keys for base-branch
    // notifications so that if the user later breaks the configuration
    // again we will warn them once more this session.
    oneShotNotificationsShown.delete('configured-invalid');
    oneShotNotificationsShown.delete('none-found');
    lastNotifiedRemoteSha = undefined;
    startOrRestartRemoteCheckTimer();
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
    scheduleDecorationRefresh();
    stopRemoteCheckTimer();
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
  scheduleDecorationRefresh();
  stopRemoteCheckTimer();
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

function isEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return cfg.get<boolean>(ENABLED_SETTING, true);
}

function readWeakDecorationSettings(): WeakDecorationSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return {
    showOverviewRuler: cfg.get<boolean>(SHOW_OVERVIEW_RULER_SETTING, true),
    showGutterIcon: cfg.get<boolean>(SHOW_GUTTER_ICON_SETTING, true),
  };
}

function readFileDecorationSettings(): FileDecorationSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return {
    showColors: cfg.get<boolean>(SHOW_FILE_DECORATION_COLORS_SETTING, true),
    showBadges: cfg.get<boolean>(SHOW_FILE_DECORATION_BADGES_SETTING, true),
  };
}

/**
 * Push the latest visual / label values into the coordinator. Always safe
 * to call; the coordinator no-ops when nothing changed and returns `true`
 * only when the underlying decoration type was rebuilt (which means callers
 * should follow up with a full refresh). We do the follow-up refresh in
 * `scheduleDecorationRefresh`, which is invoked separately by the config
 * event handler.
 */
function applyWeakDecorationSettings(): void {
  if (!runtime) return;
  const baseLabel = currentBaseBranchLabel();
  const settings = readWeakDecorationSettings();
  runtime.weakDecorations.refreshVisuals(settings, baseLabel);
  runtime.strongDecorations.refreshVisuals(settings, baseLabel);
}

function applyFileDecorationSettings(): void {
  if (!runtime) return;
  runtime.fileDecorations.updateSettings(
    readFileDecorationSettings(),
    currentBaseBranchLabel(),
  );
}

function currentBaseBranchLabel(): string {
  if (currentState.kind === 'live' && currentState.context.baseBranch) {
    return currentState.context.baseBranch;
  }
  return '(no base)';
}

function isStrongHighlightEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return cfg.get<boolean>(ENABLE_CONFLICT_PREDICTION_SETTING, true);
}

function readLargeFileHunkThreshold(): number {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const raw = cfg.get<number>(LARGE_FILE_HUNK_THRESHOLD_SETTING, 200);
  // Coerce non-finite or negative input to "no gate" so a broken
  // settings.json cannot suppress every highlight.
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

let decorationRefreshPending = false;
let decorationRefreshTimer: NodeJS.Timeout | undefined;
const documentRefreshTimers = new Map<string, NodeJS.Timeout>();

/**
 * Coalesce decoration refresh requests. A burst of events
 * (`onDidChangeActiveTextEditor` + `onDidChangeVisibleTextEditors` fired
 * when the user splits the editor) becomes a single recompute.
 */
function scheduleDecorationRefresh(): void {
  if (decorationRefreshPending) return;
  decorationRefreshPending = true;
  decorationRefreshTimer = setTimeout(() => {
    decorationRefreshPending = false;
    decorationRefreshTimer = undefined;
    void refreshDecorationsNow().catch((err) => {
      runtime?.logChannel.warn(`refreshDecorations failed: ${stringifyError(err)}`);
    });
  }, DECORATION_REFRESH_DEBOUNCE_MS);
  decorationRefreshTimer.unref?.();
}

/**
 * Debounced per-document recompute triggered by `onDidChangeTextDocument`.
 * A fast typist would otherwise cause one git diff + blob fetch per
 * keystroke; coalescing keeps it bounded to one recompute per ~200ms per
 * document.
 */
function scheduleDocumentRefresh(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = documentRefreshTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    documentRefreshTimers.delete(key);
    void refreshDocumentNow(document).catch((err) => {
      runtime?.logChannel.warn(
        `document refresh failed for ${document.uri.fsPath}: ${stringifyError(err)}`,
      );
    });
  }, DOCUMENT_REFRESH_DEBOUNCE_MS);
  timer.unref?.();
  documentRefreshTimers.set(key, timer);
}

function cancelDocumentRefresh(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = documentRefreshTimers.get(key);
  if (!existing) return;
  clearTimeout(existing);
  documentRefreshTimers.delete(key);
}

async function refreshDocumentNow(document: vscode.TextDocument): Promise<void> {
  if (!runtime || !isEnabled() || currentState.kind !== 'live') return;
  const ctx = currentState.context;
  if (ctx.gitState.kind !== 'ready' || !ctx.baseBranch) return;
  if (document.isClosed) return;

  const editors = vscode.window.visibleTextEditors.filter(
    (e) => e.document === document,
  );
  if (editors.length === 0) return;

  const mergeBaseSha = await resolveMergeBase(
    ctx.environment.runner,
    ctx.repository.rootPath,
    ctx.baseBranch,
  );
  if (!mergeBaseSha) return;

  const inputs: WeakHighlightInputs = {
    runner: ctx.environment.runner,
    repoRootPath: ctx.repository.rootPath,
    baseBranch: ctx.baseBranch,
    mergeBaseSha,
    readBlob: ctx.readBlob,
    largeFileHunkThreshold: readLargeFileHunkThreshold(),
  };
  const strongEnabled = isStrongHighlightEnabled();

  await Promise.all(editors.map((e) => applyToEditor(e, inputs, strongEnabled)));
}

async function refreshDecorationsNow(): Promise<void> {
  if (!runtime) return;
  const { weakDecorations, strongDecorations, fileDecorations } = runtime;
  const editors = vscode.window.visibleTextEditors;

  const clearAll = () => {
    for (const editor of editors) {
      weakDecorations.clear(editor);
      strongDecorations.clear(editor);
    }
    fileDecorations.clear();
  };

  if (!isEnabled() || currentState.kind !== 'live') {
    clearAll();
    return;
  }
  const ctx = currentState.context;
  if (ctx.gitState.kind !== 'ready' || !ctx.baseBranch) {
    clearAll();
    return;
  }

  const mergeBaseSha = await resolveMergeBase(
    ctx.environment.runner,
    ctx.repository.rootPath,
    ctx.baseBranch,
  );
  if (!mergeBaseSha) {
    clearAll();
    return;
  }

  const inputs: WeakHighlightInputs = {
    runner: ctx.environment.runner,
    repoRootPath: ctx.repository.rootPath,
    baseBranch: ctx.baseBranch,
    mergeBaseSha,
    readBlob: ctx.readBlob,
    largeFileHunkThreshold: readLargeFileHunkThreshold(),
  };
  const strongEnabled = isStrongHighlightEnabled();

  await Promise.all([
    ...editors.map((editor) => applyToEditor(editor, inputs, strongEnabled)),
    fileDecorations
      .refresh(
        {
          runner: inputs.runner,
          repoRootPath: inputs.repoRootPath,
          baseBranch: inputs.baseBranch,
          mergeBaseSha,
        },
        strongEnabled,
      )
      .catch((err) => {
        runtime?.logChannel.warn(
          `fileDecorations.refresh failed: ${stringifyError(err)}`,
        );
      }),
  ]);
}

/**
 * Validate the editor's document path against the repo and dispatch the
 * weak and (optionally) strong coordinators in parallel. The two
 * coordinators have independent caches and in-flight maps, so running
 * them concurrently does not create cross-coordinator races.
 */
async function applyToEditor(
  editor: vscode.TextEditor,
  inputs: WeakHighlightInputs,
  strongEnabled: boolean,
): Promise<void> {
  if (!runtime) return;
  const { weakDecorations, strongDecorations } = runtime;
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' || doc.isUntitled) {
    weakDecorations.clear(editor);
    strongDecorations.clear(editor);
    return;
  }
  const within = await isFileWithinRepository(doc.uri.fsPath, inputs.repoRootPath);
  if (!within) {
    weakDecorations.clear(editor);
    strongDecorations.clear(editor);
    return;
  }
  // path.relative may yield "" for the repo root itself or platform-specific
  // separators on Windows. Git expects forward slashes for path arguments;
  // we normalize so that the cache key and the git command line agree on
  // the same string.
  const relative = path.relative(inputs.repoRootPath, doc.uri.fsPath);
  const normalized = relative.split(path.sep).join('/');
  if (normalized === '' || normalized.startsWith('..')) {
    weakDecorations.clear(editor);
    strongDecorations.clear(editor);
    return;
  }

  // Compute both pipelines in parallel; the orchestrator subtracts the
  // strong ranges from the weak set so that a line predicted to
  // conflict is rendered with the strong color only, instead of
  // stacking the two semi-transparent backgrounds on top of each other.
  const strongInputs: StrongHighlightInputs = inputs;
  const startVersion = doc.version;
  let weakRanges, strongRanges;
  try {
    [weakRanges, strongRanges] = await Promise.all([
      weakDecorations
        .computeRanges(normalized, inputs, doc)
        .catch((err) => {
          runtime?.logChannel.warn(
            `weakDecorations.compute failed for ${normalized}: ${stringifyError(err)}`,
          );
          return [];
        }),
      strongEnabled
        ? strongDecorations
            .computeRanges(normalized, strongInputs, doc)
            .catch((err) => {
              runtime?.logChannel.warn(
                `strongDecorations.compute failed for ${normalized}: ${stringifyError(err)}`,
              );
              return [];
            })
        : Promise.resolve([]),
    ]);
  } catch (err) {
    runtime?.logChannel.warn(
      `applyToEditor compute failed for ${normalized}: ${stringifyError(err)}`,
    );
    return;
  }
  if (doc.isClosed || doc.version !== startVersion) return;

  const suppressedWeak = subtractRanges(weakRanges, strongRanges);
  weakDecorations.applyRanges(editor, suppressedWeak);
  if (strongEnabled) {
    strongDecorations.applyRanges(editor, strongRanges);
  } else {
    strongDecorations.clear(editor);
  }
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

// ---------------------------------------------------------------------------
// Remote-update monitor (Phase 11)
// ---------------------------------------------------------------------------

let remoteCheckTimer: NodeJS.Timeout | undefined;
let inflightRemoteCheck: AbortController | undefined;
/**
 * Cache of the remote SHA we have most recently warned the user about,
 * so that successive timer ticks against the same upstream state do not
 * re-fire the notification. Reset whenever the local tracking ref
 * catches up (i.e. the check transitions to `up-to-date`).
 */
let lastNotifiedRemoteSha: string | undefined;

function readRemoteCheckIntervalMinutes(): number {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return cfg.get<number>(REMOTE_CHECK_INTERVAL_SETTING, 5);
}

function isAutoFetchEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return cfg.get<boolean>(AUTO_FETCH_SETTING, false);
}

/**
 * (Re)start the remote-check interval timer. Idempotent — safe to call
 * any number of times; previous timers are cleared first. Skips the
 * timer entirely when we are not live, when the base branch is unset,
 * or when the interval setting is `0` (the user-facing disable).
 */
function startOrRestartRemoteCheckTimer(): void {
  stopRemoteCheckTimer();
  if (currentState.kind !== 'live') return;
  if (!currentState.context.baseBranch) return;
  const intervalMin = readRemoteCheckIntervalMinutes();
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) return;
  const intervalMs = intervalMin * 60_000;
  remoteCheckTimer = setInterval(() => {
    void performRemoteCheck();
  }, intervalMs);
  remoteCheckTimer.unref?.();
}

function stopRemoteCheckTimer(): void {
  if (remoteCheckTimer) {
    clearInterval(remoteCheckTimer);
    remoteCheckTimer = undefined;
  }
  if (inflightRemoteCheck) {
    inflightRemoteCheck.abort();
    inflightRemoteCheck = undefined;
  }
}

async function performRemoteCheck(): Promise<void> {
  if (currentState.kind !== 'live') return;
  const ctx = currentState.context;
  if (!ctx.baseBranch || ctx.gitState.kind !== 'ready') return;

  inflightRemoteCheck?.abort();
  const controller = new AbortController();
  inflightRemoteCheck = controller;

  try {
    const result = await checkRemoteForUpdates(
      ctx.environment.runner,
      ctx.repository.rootPath,
      ctx.baseBranch,
      { signal: controller.signal },
    );
    if (controller.signal.aborted) return;
    if (result.kind === 'up-to-date') {
      lastNotifiedRemoteSha = undefined;
      return;
    }
    if (result.kind === 'error') {
      runtime?.logChannel.info(`Remote check: ${result.reason}`);
      return;
    }
    await handleRemoteBehind(ctx, result.remoteSha);
  } catch (err) {
    if (!controller.signal.aborted) {
      runtime?.logChannel.warn(`performRemoteCheck threw: ${stringifyError(err)}`);
    }
  } finally {
    if (inflightRemoteCheck === controller) {
      inflightRemoteCheck = undefined;
    }
  }
}

async function handleRemoteBehind(
  ctx: LiveContext,
  remoteSha: string,
): Promise<void> {
  const baseBranch = ctx.baseBranch;
  if (!baseBranch) return;

  if (isAutoFetchEnabled()) {
    runtime?.logChannel.info(
      `Remote moved (${remoteSha.slice(0, 8)}); auto-fetching ${baseBranch}.`,
    );
    const ok = await tryFetch(ctx, baseBranch);
    if (ok) {
      lastNotifiedRemoteSha = undefined;
      scheduleDecorationRefresh();
    }
    return;
  }

  // Manual mode: notify once per distinct remote SHA so the user is
  // not nagged on every timer tick.
  if (lastNotifiedRemoteSha === remoteSha) return;
  lastNotifiedRemoteSha = remoteSha;
  const fetchLabel = t('Fetch now');
  const choice = await vscode.window.showInformationMessage(
    t('{0}: {1} has moved upstream.', EXTENSION_NAME, baseBranch),
    fetchLabel,
  );
  if (choice !== fetchLabel) return;
  const ok = await tryFetch(ctx, baseBranch);
  if (ok) {
    lastNotifiedRemoteSha = undefined;
    scheduleDecorationRefresh();
  }
}

/**
 * Fetch the base branch's remote via vscode.git's `Repository.fetch`.
 *
 * The runner-spawn fallback was removed because it could not actually
 * succeed for the cases where vscode.git's fetch would have failed:
 * SECURE_ARGS sets `core.sshCommand=` (blocks SSH transport) and
 * SECURE_ENV sets `GIT_ASKPASS=true` / `SSH_ASKPASS=true` (silently
 * fails credential prompts). Relaxing those for one command would
 * undermine the global hardening, so we surface a "run git fetch
 * manually" message instead when the built-in path is unavailable.
 */
async function tryFetch(ctx: LiveContext, baseBranch: string): Promise<boolean> {
  const split = await splitRemoteBranch(
    ctx.environment.runner,
    ctx.repository.rootPath,
    baseBranch,
  );
  if (!split) {
    runtime?.logChannel.warn(`Cannot determine remote for ${baseBranch}.`);
    return false;
  }

  const handle = ctx.repository.handle;
  if (typeof handle.fetch !== 'function') {
    runtime?.logChannel.warn(
      'vscode.git did not surface a fetch method; cannot auto-fetch.',
    );
    void vscode.window.showInformationMessage(
      t(
        '{0}: cannot auto-fetch on this VSCode version. Please run "git fetch" manually.',
        EXTENSION_NAME,
      ),
    );
    return false;
  }

  try {
    await handle.fetch({ remote: split.remote, ref: split.branch });
    runtime?.logChannel.info(`vscode.git fetched ${split.remote}/${split.branch}.`);
    void vscode.window.showInformationMessage(
      t('{0}: fetched updates for {1}.', EXTENSION_NAME, baseBranch),
    );
    return true;
  } catch (err) {
    runtime?.logChannel.warn(
      `vscode.git fetch failed for ${split.remote}/${split.branch}: ${stringifyError(err)}`,
    );
    void vscode.window.showWarningMessage(
      t(
        '{0}: failed to fetch {1}. See output channel; you may need to run "git fetch" manually.',
        EXTENSION_NAME,
        baseBranch,
      ),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------

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
    vscode.commands.registerCommand('conflictLens.enable', () =>
      setEnabledCommand(true),
    ),
    vscode.commands.registerCommand('conflictLens.disable', () =>
      setEnabledCommand(false),
    ),
    vscode.commands.registerCommand('conflictLens.toggle', toggleEnabledCommand),
    vscode.commands.registerCommand('conflictLens.refresh', refreshCommand),
    vscode.commands.registerCommand(
      'conflictLens.showChangedFiles',
      showChangedFilesCommand,
    ),
    vscode.commands.registerCommand('conflictLens.openDiff', openDiffCommand),
  );
}

/**
 * Serves the base-side blob via VSCode's TextDocumentContentProvider so
 * the diff editor can render a read-only view. The actual blob bytes
 * come from the same `BlobReader` the highlight pipeline uses, so they
 * benefit from the persistent `cat-file --batch` connection.
 */
class BaseSideContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly getReadBlob: () => BlobReader | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const readBlob = this.getReadBlob();
    if (!readBlob) return '';
    const ref = uri.query;
    const filePath = uri.path.replace(/^\//, '');
    if (!ref || !filePath) return '';
    try {
      return await readBlob(ref, filePath);
    } catch (err) {
      // Render the error as a comment-like header inside the diff so the
      // user sees *why* the base side is empty instead of a silent blank.
      return `// Conflict Lens: ${stringifyError(err)}\n`;
    }
  }
}

async function showChangedFilesCommand(): Promise<void> {
  if (currentState.kind !== 'live') {
    void vscode.window.showInformationMessage(
      t('{0}: not available in this workspace.', EXTENSION_NAME),
    );
    return;
  }
  const ctx = currentState.context;
  if (!ctx.baseBranch) {
    void vscode.window.showInformationMessage(
      t('{0}: no base branch selected.', EXTENSION_NAME),
    );
    return;
  }

  const runner = ctx.environment.runner;
  const repoRoot = ctx.repository.rootPath;
  const baseBranch = ctx.baseBranch;
  const strongEnabled = isStrongHighlightEnabled();
  let files: string[];
  let conflictedSet = new Set<string>();
  try {
    const [changedArr, mergeTreeResult] = await Promise.all([
      listChangedFilesOnBase(runner, repoRoot, baseBranch),
      strongEnabled
        ? runMergeTree(runner, repoRoot, baseBranch)
        : Promise.resolve({ kind: 'clean' as const, treeSha: '' }),
    ]);
    files = changedArr;
    if (mergeTreeResult.kind === 'conflicted') {
      conflictedSet = new Set(mergeTreeResult.conflictedPaths);
    }
  } catch (err) {
    runtime?.logChannel.warn(`showChangedFiles failed: ${stringifyError(err)}`);
    void vscode.window.showWarningMessage(
      t('{0}: failed to list changed files.', EXTENSION_NAME),
    );
    return;
  }
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      t('{0}: no files changed relative to {1}.', EXTENSION_NAME, baseBranch),
    );
    return;
  }

  // Sort: conflicted files float to the top so they catch the eye, then
  // alphabetical within each group for a stable order.
  files.sort((a, b) => {
    const ac = conflictedSet.has(a) ? 0 : 1;
    const bc = conflictedSet.has(b) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return a.localeCompare(b);
  });

  const conflictLabel = t('Predicted conflict');
  const items: vscode.QuickPickItem[] = files.map((f) => ({
    label: f,
    description: conflictedSet.has(f) ? conflictLabel : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `${EXTENSION_NAME}: ${baseBranch}`,
    placeHolder: t('Select a file to open'),
    matchOnDescription: true,
  });
  if (!picked) return;

  try {
    const uri = vscode.Uri.file(path.join(repoRoot, picked.label));
    await vscode.window.showTextDocument(uri);
  } catch (err) {
    runtime?.logChannel.warn(`showTextDocument failed: ${stringifyError(err)}`);
  }
}

async function openDiffCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(
      t('{0}: no active editor.', EXTENSION_NAME),
    );
    return;
  }
  if (currentState.kind !== 'live' || !currentState.context.baseBranch) {
    void vscode.window.showInformationMessage(
      t('{0}: not available in this workspace.', EXTENSION_NAME),
    );
    return;
  }
  const ctx = currentState.context;
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') return;

  const within = await isFileWithinRepository(doc.uri.fsPath, ctx.repository.rootPath);
  if (!within) {
    void vscode.window.showInformationMessage(
      t('{0}: file is not inside the repository.', EXTENSION_NAME),
    );
    return;
  }
  const relative = path.relative(ctx.repository.rootPath, doc.uri.fsPath);
  const normalized = relative.split(path.sep).join('/');
  if (normalized === '' || normalized.startsWith('..')) return;

  const baseUri = vscode.Uri.from({
    scheme: DIFF_PROVIDER_SCHEME,
    authority: 'base',
    path: `/${normalized}`,
    query: ctx.baseBranch,
  });

  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      baseUri,
      doc.uri,
      `${ctx.baseBranch} ↔ ${normalized}`,
      { preview: true },
    );
  } catch (err) {
    runtime?.logChannel.warn(`vscode.diff failed: ${stringifyError(err)}`);
  }
}

async function setEnabledCommand(value: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  try {
    await cfg.update(ENABLED_SETTING, value, vscode.ConfigurationTarget.Workspace);
  } catch (err) {
    runtime?.logChannel.warn(`Saving enabled=${value} failed: ${stringifyError(err)}`);
  }
}

async function toggleEnabledCommand(): Promise<void> {
  await setEnabledCommand(!isEnabled());
}

/**
 * Force a full recompute: drop every line-decoration cache, reset the
 * file-decoration soft cache, and re-resolve the base branch. The
 * subsequent refresh runs the full pipeline (diff, blob fetch, merge-file,
 * etc.) instead of serving from the LRU.
 */
async function refreshCommand(): Promise<void> {
  if (!runtime) return;
  runtime.weakDecorations.invalidateAll();
  runtime.strongDecorations.invalidateAll();
  runtime.fileDecorations.clear();
  await refreshBaseBranch();
  scheduleDecorationRefresh();
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
  if (decorationRefreshTimer) {
    clearTimeout(decorationRefreshTimer);
    decorationRefreshTimer = undefined;
  }
  decorationRefreshPending = false;
  for (const timer of documentRefreshTimers.values()) clearTimeout(timer);
  documentRefreshTimers.clear();
  stopRemoteCheckTimer();
  lastNotifiedRemoteSha = undefined;
  runtime = undefined;
  currentState = { kind: 'initializing' };
  oneShotNotificationsShown = new Set();
}
