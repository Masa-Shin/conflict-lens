import * as fs from 'node:fs';
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
import { createBlobReaderFromBatch, GitCatFileBatch } from './git/cat-file-batch';
import { listChangedFilesOnBase } from './git/changed-files';
import { isPathBinaryAgainstRef, resolveMergeBase, resolveRefToCommit } from './git/diff';
import type { BlobReader } from './git/blob';
import { runMergeFile } from './git/merge-file';
import { checkRemoteForUpdates, splitRemoteBranch } from './git/remote-check';
import {
  detectTargetRepository,
  repoRelativePathViaRealpath,
  type TargetRepository,
  type TargetRepositoryResult,
} from './git/repository';
import { detectGitState, isStateBlockingHighlights, type GitState } from './git/state';
import { t } from './l10n';
import {
  STATE_SCHEMA_VERSION,
  deleteConflictLensState,
  writeConflictLensState,
  type ConflictLensState,
} from './mcp/state-file';
import { FileDecorationCoordinator, type FileDecorationSettings } from './ui/file-decoration';
import {
  WeakDecorationCoordinator,
  type HighlightOutcome,
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
/**
 * Workspace-state key prefix for the selected base branch. The repo root
 * path is appended so a multi-root workspace keeps an independent choice
 * per repository. Stored via `context.workspaceState`, not in settings.
 */
const BASE_BRANCH_STATE_KEY = 'conflictLens.baseBranch';
const REMOTE_NAME_SETTING = 'remoteName';
const ENABLED_SETTING = 'enabled';
const SHOW_OVERVIEW_RULER_SETTING = 'showOverviewRuler';
const SHOW_FILE_DECORATION_BADGES_SETTING = 'showFileDecorationBadges';
const REMOTE_CHECK_INTERVAL_SETTING = 'remoteCheckIntervalMinutes';
/**
 * Toggle for the Claude Code / MCP integration. On by default: the extension
 * keeps a small state file fresh under `.git/conflict-lens/` so the MCP
 * server can report the base branch and what it changed. Turn it off to stop
 * writing the file.
 */
const MCP_ENABLED_SETTING = 'mcp.enabled';
/**
 * Custom URI scheme used by the "Show Base Branch Changes" command to
 * feed the base-side blob into VSCode's built-in diff editor. URIs look like
 * `conflict-lens://base/<repo-relative-path>?<ref>` where the query
 * carries the git ref (typically `origin/main`); the content provider
 * fetches the blob via the same long-lived `cat-file --batch` that
 * powers the highlight pipeline.
 */
const DIFF_PROVIDER_SCHEME = 'conflict-lens';

/**
 * Scheme for the read-only "Preview Conflict" virtual document. Kept
 * separate from `DIFF_PROVIDER_SCHEME` because that provider derives its
 * content from a URI alone (a blob ref), whereas the conflict preview
 * depends on the live editor buffer and must be stashed by the command.
 */
const CONFLICT_PREVIEW_SCHEME = 'conflict-lens-preview';

interface RuntimeState {
  logChannel: vscode.LogOutputChannel;
  statusBarItem: vscode.StatusBarItem;
  weakDecorations: WeakDecorationCoordinator;
  fileDecorations: FileDecorationCoordinator;
  conflictPreviews: ConflictPreviewContentProvider;
  /**
   * Per-workspace storage for the selected base branch. Local to each
   * developer and never written to `.vscode/settings.json`, so one
   * person's choice never leaks into the repository or onto teammates.
   */
  workspaceState: vscode.Memento;
}

interface LiveContext {
  environment: GitEnvironment;
  repository: TargetRepository;
  gitState: GitState;
  baseBranch: string | undefined;
  baseBranchSource: BaseBranchSource | undefined;
  /**
   * Merge-base SHA between HEAD and `baseBranch`, refreshed exactly when
   * either side can have moved: base resolution, git state change (HEAD
   * moved), and after a successful base-only fetch. Cached here so the
   * per-keystroke refresh path can read it instead of spawning
   * `git merge-base` on every event.
   */
  mergeBaseSha: string | undefined;
  /**
   * The commit `baseBranch` currently points to (its tip). Tracked
   * alongside `mergeBaseSha` because a fast-forward of the base ref
   * (e.g. `git fetch` picking up new upstream commits) leaves the
   * merge-base untouched while still changing what the base-side diff
   * produces. Detecting that movement is what triggers cache
   * invalidation when the user is on a feature branch and the upstream
   * advances.
   */
  baseTipSha: string | undefined;
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

/**
 * Extension entry point, invoked once by VS Code when an activation event
 * fires (see `activationEvents` / `main` in package.json). Its job is to
 * build the long-lived UI surfaces synchronously — so that `runtime` is
 * populated before any event handler or command can run — and then kick
 * off the asynchronous git probing in `initialize`.
 *
 * Everything created here is registered on `context.subscriptions`, which
 * VS Code disposes for us on deactivation; we never tear these down by hand.
 * The synchronous half deliberately performs no git work: it cannot fail in
 * a way that leaves the extension half-built, and the status bar shows
 * "(initializing)" the instant the user opens the window.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Log output channel — the single sink for diagnostics, surfaced to the
  // user via the "Show Output Channel" command. Created first so every later
  // step can log into it.
  const logChannel = vscode.window.createOutputChannel(EXTENSION_NAME, {
    log: true,
  });
  context.subscriptions.push(logChannel);
  logChannel.info(t('{0} activated.', EXTENSION_NAME));

  // Primary status-bar item: always visible, shows the current base branch /
  // git state and acts as the click target for "Select Base Branch".
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = EXTENSION_NAME;
  statusBarItem.command = 'conflictLens.selectBaseBranch';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Build the coordinators and content providers that own the actual UI:
  //  - weakDecorations: the in-editor base-change highlights.
  //  - fileDecorations: the Explorer badges + the changed-files set.
  //  - diffContentProvider: feeds base-side blobs into the built-in diff
  //    editor; reads through whatever `readBlob` the live context exposes.
  //  - conflictPreviews: backs the read-only "Preview Conflict" document.
  const initialSettings = readWeakDecorationSettings();
  const weakDecorations = new WeakDecorationCoordinator(initialSettings, '(no base)');
  const fileDecorations = new FileDecorationCoordinator(readFileDecorationSettings());
  const diffContentProvider = new BaseSideContentProvider(() =>
    currentState.kind === 'live' ? currentState.context.readBlob : undefined,
  );
  const conflictPreviews = new ConflictPreviewContentProvider();
  // Register the providers and hand their disposal to VS Code. The decoration
  // provider drives Explorer badges; the two content providers serve the
  // custom `conflict-lens://` and `conflict-lens-preview://` schemes.
  context.subscriptions.push(
    weakDecorations,
    fileDecorations,
    conflictPreviews,
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_PROVIDER_SCHEME, diffContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(CONFLICT_PREVIEW_SCHEME, conflictPreviews),
  );

  // Publish the assembled UI as module-level `runtime`. Every command and
  // event handler reads through this, so it must be set before
  // `registerCommands` / `initialize` wire anything up. `setState` then paints
  // the initial "(initializing)" status bar.
  runtime = {
    logChannel,
    statusBarItem,
    weakDecorations,
    fileDecorations,
    conflictPreviews,
    workspaceState: context.workspaceState,
  };
  oneShotNotificationsShown = new Set();
  setState({ kind: 'initializing' });

  // Register the user-facing commands. Safe to do now even though git is not
  // probed yet: each command reads live state at invocation time and no-ops
  // when the extension is not yet "live".
  registerCommands(context);

  // Stage the bundled MCP server at a version-independent path so a registered
  // `claude mcp add` command keeps working across extension updates (the
  // install directory is versioned and replaced on update).
  try {
    stageMcpServer(context);
  } catch (err) {
    runtime?.logChannel.warn(`MCP server staging failed: ${stringifyError(err)}`);
  }

  // Hand off to the asynchronous half: resolve git, the target repository and
  // the base branch, then start the event listeners. Failures are caught here
  // and parked in the `unavailable` state rather than thrown, so a bad git
  // setup degrades to an explanatory status bar instead of crashing activation.
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
  log?.info(`Git ${environment.version.raw} resolved at ${environment.runner.gitPath}.`);

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
    mergeBaseSha: undefined,
    baseTipSha: undefined,
    catFileBatch,
    readBlob,
  };
  setState({ kind: 'live', context: liveContext });

  await refreshBaseBranch();

  const reevaluateState = debounce(async () => {
    try {
      const next = await safeDetectGitState(environment, repoResult.repository);
      let stateChanged = false;
      setState((prev) => {
        if (prev.kind !== 'live') return prev;
        if (gitStatesEqual(prev.context.gitState, next)) return prev;
        runtime?.logChannel.info(
          `Git state changed: ${prev.context.gitState.kind} → ${next.kind}.`,
        );
        stateChanged = true;
        return { kind: 'live', context: { ...prev.context, gitState: next } };
      });
      if (stateChanged) {
        runtime?.weakDecorations.invalidateAll();
      }
      // Always re-resolve the merge-base. A `state.onDidChange` event may
      // signal a base-side fetch (vscode.git auto-fetch, or a manual
      // `git fetch`) that moves `refs/remotes/<base>` without touching
      // HEAD; in that case the gitState comparison reports "no change"
      // yet the merge-base may still shift. `refreshMergeBase` invalidates
      // the cache itself whenever the SHA actually moves, so the only
      // cost of always calling it is the one `git merge-base` spawn.
      await refreshMergeBase();
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
      const baseChanged = event.affectsConfiguration(`${CONFIG_NAMESPACE}.${REMOTE_NAME_SETTING}`);
      const enabledChanged = event.affectsConfiguration(`${CONFIG_NAMESPACE}.${ENABLED_SETTING}`);
      const visualsChanged = event.affectsConfiguration(
        `${CONFIG_NAMESPACE}.${SHOW_OVERVIEW_RULER_SETTING}`,
      );
      const fileDecorationsChanged = event.affectsConfiguration(
        `${CONFIG_NAMESPACE}.${SHOW_FILE_DECORATION_BADGES_SETTING}`,
      );

      if (baseChanged) await refreshBaseBranch();
      if (visualsChanged) applyWeakDecorationSettings();
      if (fileDecorationsChanged) applyFileDecorationSettings();
      if (enabledChanged || visualsChanged || fileDecorationsChanged) {
        scheduleDecorationRefresh();
      }
      // Disabling the extension must also stop the remote-check polling (and
      // re-enabling restarts it); the timer otherwise keeps prompting to fetch.
      if (enabledChanged) {
        startOrRestartRemoteCheckTimer();
      }
      if (event.affectsConfiguration(`${CONFIG_NAMESPACE}.${REMOTE_CHECK_INTERVAL_SETTING}`)) {
        startOrRestartRemoteCheckTimer();
      }
      if (
        enabledChanged ||
        event.affectsConfiguration(`${CONFIG_NAMESPACE}.${MCP_ENABLED_SETTING}`)
      ) {
        syncMcpStateNow();
      }
      // git.autofetch flips whether we poll at all: turning it off starts
      // the timer, turning it on stops it.
      if (event.affectsConfiguration('git.autofetch')) {
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
      repoRelativePathCache.delete(doc.uri.toString());
    }),
    // Window-focus listener: when the user returns to VS Code we run a
    // remote check too (subject to throttling). The interval timer
    // alone leaves up to `remoteCheckIntervalMinutes` of staleness;
    // focus-triggered checks close that gap for the realistic case of
    // "I just got back from looking at GitHub, was something pushed?".
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      maybePerformRemoteCheck();
    }),
  );

  // Initial pass for any editors already open at activation.
  scheduleDecorationRefresh();
}

/**
 * Resolve the merge-base SHA against the current base branch and stash
 * it in the live context. Called whenever HEAD or the base branch can
 * have moved (base resolution, git state change, base-only fetch).
 * Keeping the value here lets the per-keystroke refresh path skip the
 * `git merge-base` spawn entirely.
 */
async function refreshMergeBase(): Promise<void> {
  if (currentState.kind !== 'live') return;
  const ctx = currentState.context;
  if (!ctx.baseBranch) {
    if (ctx.mergeBaseSha !== undefined || ctx.baseTipSha !== undefined) {
      setState({
        kind: 'live',
        context: { ...ctx, mergeBaseSha: undefined, baseTipSha: undefined },
      });
    }
    return;
  }
  const resolvedFor = ctx.baseBranch;
  // Resolve both SHAs in parallel. We need the base tip alongside the
  // merge-base because a base-side fast-forward (the typical `git fetch`
  // outcome) shifts the tip without moving the merge-base, and the
  // base-diff is a function of both endpoints.
  const [mergeBaseSha, baseTipSha] = await Promise.all([
    resolveMergeBase(ctx.environment.runner, ctx.repository.rootPath, resolvedFor).catch((err) => {
      runtime?.logChannel.warn(`resolveMergeBase threw: ${stringifyError(err)}`);
      return undefined;
    }),
    resolveRefToCommit(ctx.environment.runner, ctx.repository.rootPath, resolvedFor).catch(
      (err) => {
        runtime?.logChannel.warn(`resolveRefToCommit threw: ${stringifyError(err)}`);
        return undefined;
      },
    ),
  ]);
  // Re-read state after the await: a concurrent `refreshBaseBranch` may
  // have switched the base out from under us, in which case our SHAs
  // attach to an old base and must be discarded.
  if (currentState.kind !== 'live') return;
  const after = currentState.context;
  if (after.baseBranch !== resolvedFor) return;
  if (after.mergeBaseSha === mergeBaseSha && after.baseTipSha === baseTipSha) return;
  setState({
    kind: 'live',
    context: { ...after, mergeBaseSha, baseTipSha },
  });
  // Either the merge-base or the base tip moved, so every cached
  // base-diff was computed against now-stale endpoints. Drop them so the
  // next refresh recomputes from the new positions.
  runtime?.weakDecorations.invalidateAll();
}

async function refreshBaseBranch(): Promise<void> {
  if (currentState.kind !== 'live') return;
  const { environment, repository } = currentState.context;
  const log = runtime?.logChannel;
  const configured = readStoredBaseBranch(repository.rootPath);
  const remoteName = readConfiguredRemoteName(repository.handle.rootUri);

  let resolution: BaseBranchResolution;
  try {
    resolution = await resolveBaseBranch({
      runner: environment.runner,
      repoRootPath: repository.rootPath,
      configured,
      remoteName,
    });
  } catch (err) {
    log?.warn(`resolveBaseBranch threw: ${stringifyError(err)}`);
    return;
  }

  if (resolution.kind === 'ok') {
    log?.info(`Base branch resolved: ${resolution.baseBranch} (${resolution.source}).`);
    setState((prev) => {
      if (prev.kind !== 'live') return prev;
      return {
        kind: 'live',
        context: {
          ...prev.context,
          baseBranch: resolution.baseBranch,
          baseBranchSource: resolution.source,
          mergeBaseSha: undefined,
          baseTipSha: undefined,
        },
      };
    });
    // Base just changed; drop any cached merge-base derivatives before
    // resolving the new one.
    runtime?.weakDecorations.invalidateAll();
    await refreshMergeBase();
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
        context: {
          ...prev.context,
          baseBranch: undefined,
          baseBranchSource: undefined,
        },
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
      context: {
        ...prev.context,
        baseBranch: undefined,
        baseBranchSource: undefined,
      },
    };
  });
  scheduleDecorationRefresh();
  stopRemoteCheckTimer();
  notifyOnce(
    'none-found',
    t('{0}: could not detect a base branch. Run Select Base Branch to set one.', EXTENSION_NAME),
    { action: 'select-base-branch' },
  );
}

function baseBranchStateKey(repoRootPath: string): string {
  return `${BASE_BRANCH_STATE_KEY}:${repoRootPath}`;
}

function readStoredBaseBranch(repoRootPath: string): string | undefined {
  const value = runtime?.workspaceState.get<string>(baseBranchStateKey(repoRootPath));
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Whether VS Code's built-in Git auto-fetch is on for this scope. The
 * `git.autofetch` setting is `true`, `false`, or `"all"`. When it is on,
 * VS Code keeps the base branch's remote-tracking ref fresh on its own and
 * our state-change handler re-resolves the merge-base when it lands, so
 * Conflict Lens does not need to prompt the user to fetch.
 */
function isVscodeGitAutofetchEnabled(scope: vscode.Uri | undefined): boolean {
  const value = vscode.workspace.getConfiguration('git', scope).get<boolean | string>('autofetch');
  return value === true || value === 'all';
}

function readConfiguredRemoteName(scope: vscode.Uri | undefined): string {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE, scope);
  const value = cfg.get<string>(REMOTE_NAME_SETTING);
  if (typeof value !== 'string') return 'origin';
  const trimmed = value.trim();
  return trimmed.length === 0 ? 'origin' : trimmed;
}

function isEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return cfg.get<boolean>(ENABLED_SETTING, true);
}

function readWeakDecorationSettings(): WeakDecorationSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return {
    showOverviewRuler: cfg.get<boolean>(SHOW_OVERVIEW_RULER_SETTING, true),
  };
}

function readFileDecorationSettings(): FileDecorationSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return {
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
}

function applyFileDecorationSettings(): void {
  if (!runtime) return;
  runtime.fileDecorations.updateSettings(readFileDecorationSettings(), currentBaseBranchLabel());
}

function currentBaseBranchLabel(): string {
  if (currentState.kind === 'live' && currentState.context.baseBranch) {
    return currentState.context.baseBranch;
  }
  return '(no base)';
}

let decorationRefreshPending = false;
let decorationRefreshTimer: NodeJS.Timeout | undefined;
const documentRefreshTimers = new Map<string, NodeJS.Timeout>();

/**
 * Monotonic token stamped on each `refreshDecorationsNow` run. The
 * pending flag is cleared before the body starts (so the next request
 * can coalesce), which means a slow git can let a newer run begin
 * before the older one finishes its awaits. Each run captures the
 * generation at entry and bails after every await once a newer run has
 * bumped it — so the older run never commits its stale changed-list or
 * paints over the newer result. Same class of fix as commit 13c686c.
 */
let decorationRefreshGeneration = 0;

/**
 * Per-document memo of repo-relative path resolution. `applyToEditor` runs
 * on the typing hot path; without this it would `lstat` + `realpath` the
 * active file on every keystroke-debounce flush even though the result is
 * stable for the session. Keyed by document URI; the value is the
 * normalized repo-relative path, or `null` when the file is outside the
 * repo / invalid. Entries are dropped when the document closes.
 */
const repoRelativePathCache = new Map<string, string | null>();

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
  if (isStateBlockingHighlights(ctx.gitState) || !ctx.baseBranch) return;
  if (document.isClosed) return;
  // Without cached base SHAs nothing downstream can produce useful
  // ranges, but typing is not where we want to spawn `git merge-base`
  // — base/HEAD events refresh them for us. Skip silently.
  if (!ctx.mergeBaseSha || !ctx.baseTipSha) return;

  const editors = vscode.window.visibleTextEditors.filter((e) => e.document === document);
  if (editors.length === 0) return;

  const inputs: WeakHighlightInputs = {
    runner: ctx.environment.runner,
    repoRootPath: ctx.repository.rootPath,
    baseBranch: ctx.baseBranch,
    mergeBaseSha: ctx.mergeBaseSha,
    baseTipSha: ctx.baseTipSha,
    readBlob: ctx.readBlob,
  };

  const activeEditor = vscode.window.activeTextEditor;
  // allSettled, not all: one file's transient git error must not drop the
  // whole pass's highlights — the other editors still update.
  const settled = await Promise.allSettled(
    editors.map((editor) =>
      applyToEditor(editor, inputs).then((result) => ({
        editor,
        ...result,
      })),
    ),
  );
  for (const r of settled) {
    if (r.status === 'rejected') {
      runtime?.logChannel.warn(
        `Decoration refresh failed for an editor: ${stringifyError(r.reason)}`,
      );
    }
  }
  const editorResults = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));

  // Only touch the active-editor indicators when the active editor was among
  // the ones we just refreshed. If the user is editing a buffer while focused
  // on a different editor, the focused editor's state is owned by another
  // refresh path and must not be overwritten here.
  const activeResult = editorResults.find((r) => r.editor === activeEditor);
  if (activeResult !== undefined) {
    applyActiveOutcome(activeResult.outcome, activeResult.baseChanged);
  }
}

async function refreshDecorationsNow(): Promise<void> {
  if (!runtime) return;
  const generation = ++decorationRefreshGeneration;
  const isSuperseded = () => generation !== decorationRefreshGeneration;
  const { weakDecorations, fileDecorations } = runtime;
  const editors = vscode.window.visibleTextEditors;

  const clearAll = () => {
    for (const editor of editors) {
      weakDecorations.clear(editor);
    }
    fileDecorations.clear();
    applyActiveOutcome('clean', false);
  };

  if (!isEnabled() || currentState.kind !== 'live') {
    clearAll();
    return;
  }
  const ctx = currentState.context;
  if (isStateBlockingHighlights(ctx.gitState) || !ctx.baseBranch) {
    clearAll();
    return;
  }
  if (!ctx.mergeBaseSha || !ctx.baseTipSha) {
    clearAll();
    return;
  }
  const mergeBaseSha = ctx.mergeBaseSha;
  const baseTipSha = ctx.baseTipSha;

  const inputs: WeakHighlightInputs = {
    runner: ctx.environment.runner,
    repoRootPath: ctx.repository.rootPath,
    baseBranch: ctx.baseBranch,
    mergeBaseSha,
    baseTipSha,
    readBlob: ctx.readBlob,
  };

  // Sequence: populate the changed-files set first so that the
  // per-editor pre-filter in `applyToEditor` can skip git work for
  // files the base has not touched. The post-fetch case (where every
  // base-diff cache entry was just invalidated) is where this matters
  // most — without the pre-filter, every visible editor would spawn a
  // `git diff` in parallel.
  try {
    await fileDecorations.refresh(
      {
        runner: inputs.runner,
        repoRootPath: inputs.repoRootPath,
        baseBranch: inputs.baseBranch,
        mergeBaseSha,
        baseTipSha,
      },
      isSuperseded,
    );
  } catch (err) {
    runtime?.logChannel.warn(`fileDecorations.refresh failed: ${stringifyError(err)}`);
  }

  // A newer refresh started while we awaited the changed-list. Discard
  // rather than let our per-editor pass paint against a baseline that
  // is about to be replaced; the newer run owns the paint from here.
  if (isSuperseded()) return;

  const activeEditor = vscode.window.activeTextEditor;
  // allSettled, not all: one file's transient git error must not drop the
  // whole pass's highlights — the other editors still update.
  const settled = await Promise.allSettled(
    editors.map((editor) =>
      applyToEditor(editor, inputs).then((result) => ({
        editor,
        ...result,
      })),
    ),
  );
  for (const r of settled) {
    if (r.status === 'rejected') {
      runtime?.logChannel.warn(
        `Decoration refresh failed for an editor: ${stringifyError(r.reason)}`,
      );
    }
  }
  const editorResults = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));

  if (isSuperseded()) return;

  // The right-click menu and the suppression indicator are gated on the
  // *active* editor's result, so resolve that editor's entry out of the
  // batch.
  const activeResult = editorResults.find((r) => r.editor === activeEditor);
  applyActiveOutcome(activeResult?.outcome ?? 'clean', activeResult?.baseChanged ?? false);
}

/**
 * Reflect the active editor's highlight outcome into the two UI surfaces
 * that depend on it:
 *  - `conflictLens.hasBaseChange` context key — gates the editor right-click
 *    menu ("Preview Conflict" / "Show Base Branch Changes"). These make sense
 *    whenever the base touched the file, even if no highlights are visible
 *    (the local buffer deleted every changed region, or they were withheld as
 *    too large). Mirrored into a context key because `when` clauses can only
 *    read context keys, not extension state.
 *  - the main status-bar item — its appearance encodes the active file's
 *    state (highlighted / changed-but-too-large / unchanged); see
 *    `renderStatusBar`. The outcome is stashed so a later state change can
 *    re-render with the same per-file context.
 */
interface EditorApplyResult {
  readonly outcome: HighlightOutcome;
  /** Whether the base branch has changed this file (drives the menu gate). */
  readonly baseChanged: boolean;
}

let lastHasBaseChange: boolean | undefined;
let lastActiveOutcome: HighlightOutcome = 'clean';
function applyActiveOutcome(outcome: HighlightOutcome, baseChanged: boolean): void {
  if (baseChanged !== lastHasBaseChange) {
    lastHasBaseChange = baseChanged;
    void vscode.commands.executeCommand('setContext', 'conflictLens.hasBaseChange', baseChanged);
  }
  if (outcome !== lastActiveOutcome) {
    lastActiveOutcome = outcome;
    renderStatusBar(currentState);
  }
}

/**
 * Validate the editor's document path against the repo and dispatch the
 * weak coordinator. Returns the editor's highlight outcome plus whether the
 * base changed the file, used to drive the `conflictLens.hasBaseChange`
 * context key (right-click menu) and the suppression status-bar indicator.
 * Editors that are out of scope count as `clean` with no base change.
 */
async function applyToEditor(
  editor: vscode.TextEditor,
  inputs: WeakHighlightInputs,
): Promise<EditorApplyResult> {
  if (!runtime) return { outcome: 'clean', baseChanged: false };
  const { weakDecorations, fileDecorations } = runtime;
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' || doc.isUntitled) {
    weakDecorations.clear(editor);
    return { outcome: 'clean', baseChanged: false };
  }
  const normalized = await resolveRepoRelativePath(doc, inputs.repoRootPath);
  if (normalized === undefined) {
    weakDecorations.clear(editor);
    return { outcome: 'clean', baseChanged: false };
  }

  // If the changed-files set is already populated for the current
  // (base, mergeBase, baseTip) trio and this file is not in it, the
  // base has demonstrably not touched it. Skip the entire pipeline
  // rather than spawning `git diff` only to discover an empty hunk
  // list. `undefined` means the set has not been refreshed yet for
  // this trio, in which case we fall through and let the normal
  // pipeline run + cache.
  const baseChange = fileDecorations.hasBaseChange(
    inputs.baseBranch,
    inputs.mergeBaseSha,
    inputs.baseTipSha,
    normalized,
  );
  if (baseChange === false) {
    weakDecorations.clear(editor);
    return { outcome: 'clean', baseChanged: false };
  }

  const outcome = await weakDecorations.update({
    editor,
    relativeFilePath: normalized,
    inputs,
  });
  // The suppression indicator means "the base changed this file but its
  // highlights were withheld" — it is only meaningful once we know the
  // base actually touched the file. When the changed-files set has not
  // been populated for this trio yet (`baseChange === undefined`, e.g. an
  // edit on the editor-driven path lands before the full refresh's fetch
  // completes), the size gate can report `suppressed` for a file the base
  // may never have touched, flashing the indicator on a huge but unchanged
  // file. Downgrade that to `clean`; the next full refresh populates the
  // set and settles a genuinely-changed file back to `suppressed`.
  if (outcome === 'suppressed' && baseChange === undefined) {
    return { outcome: 'clean', baseChanged: false };
  }
  // The right-click menu (Show Base Changes / Preview Conflict) should be
  // available whenever the base touched this file — even if no highlights
  // are visible right now because the local buffer deleted every changed
  // region, or they were withheld as too large. That is exactly the set of
  // files that carry the Explorer "≠" badge.
  const baseChanged = baseChange === true || outcome === 'highlighted' || outcome === 'suppressed';
  return { outcome, baseChanged };
}

/**
 * Resolve `doc` to its normalized repo-relative path (forward slashes, as
 * git and the cache key expect), or `undefined` when the file is outside
 * the repo or otherwise ineligible. Memoized per document URI because the
 * underlying `lstat` + `realpath` sit on the typing hot path; the mapping
 * is stable for the session and the entry is cleared on document close.
 */
async function resolveRepoRelativePath(
  doc: vscode.TextDocument,
  repoRootPath: string,
): Promise<string | undefined> {
  const key = doc.uri.toString();
  const cached = repoRelativePathCache.get(key);
  if (cached !== undefined) return cached ?? undefined;

  // Resolve through realpath so the relative path is computed in the repo's
  // real namespace, matching the file-tree badge and the git changed-set
  // keys. Computing it from the raw fsPath would yield a `..`-prefixed
  // (i.e. "outside") path whenever the workspace is opened via a symlink,
  // dropping the highlight even though the file is genuinely inside.
  const normalized = await repoRelativePathViaRealpath(doc.uri.fsPath, repoRootPath);
  repoRelativePathCache.set(key, normalized ?? null);
  return normalized;
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
    void vscode.window.showInformationMessage(message, label).then((choice) => {
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

/**
 * Wall-clock timestamp of the most recently *initiated* remote check.
 * Shared by both the interval timer and the window-focus listener so
 * that whichever fires first counts; the other path back-offs until
 * `REMOTE_CHECK_THROTTLE_MS` has elapsed. Set at initiation (not
 * completion) so two near-simultaneous triggers cannot both start.
 */
let lastRemoteCheckAt = 0;

/**
 * Minimum gap between two remote checks regardless of which trigger
 * caused them. Picked to absorb the window-focus event bursts that
 * happen when the user rapidly alt-tabs between the editor and
 * another app, without making the focus trigger so lazy that it
 * defeats the purpose of running it at all. The interval timer is
 * always at least 1 minute (the `remoteCheckIntervalMinutes` minimum
 * non-zero value), so it is unaffected by this throttle in practice.
 */
const REMOTE_CHECK_THROTTLE_MS = 30_000;

function readRemoteCheckIntervalMinutes(): number {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return cfg.get<number>(REMOTE_CHECK_INTERVAL_SETTING, 5);
}

/**
 * Common entry point for both the interval timer and the
 * window-focus listener. Bails out when remote checking is
 * disabled (`remoteCheckIntervalMinutes <= 0`) or when the
 * throttle is still active.
 */
function maybePerformRemoteCheck(): void {
  if (!isEnabled()) return;
  if (readRemoteCheckIntervalMinutes() <= 0) return;
  // When VS Code's own auto-fetch is on it keeps the base tracking ref
  // fresh, so the ls-remote poll (whose only purpose is to prompt for a
  // fetch) is redundant. Read fresh so toggling the setting takes effect
  // on the next focus tick without any extra wiring.
  if (
    currentState.kind === 'live' &&
    isVscodeGitAutofetchEnabled(currentState.context.repository.handle.rootUri)
  ) {
    return;
  }
  const now = Date.now();
  if (now - lastRemoteCheckAt < REMOTE_CHECK_THROTTLE_MS) return;
  lastRemoteCheckAt = now;
  void performRemoteCheck();
}

/**
 * (Re)start the remote-check interval timer. Idempotent — safe to call
 * any number of times; previous timers are cleared first. Skips the
 * timer entirely when we are not live, when the base branch is unset,
 * or when the interval setting is `0` (the user-facing disable).
 */
function startOrRestartRemoteCheckTimer(): void {
  stopRemoteCheckTimer();
  if (!isEnabled()) return;
  if (currentState.kind !== 'live') return;
  if (!currentState.context.baseBranch) return;
  // Skip the periodic poll entirely when VS Code auto-fetch is on; its
  // fetches keep the base ref fresh and the state-change handler refreshes
  // the highlights. Re-evaluated whenever git.autofetch changes.
  if (isVscodeGitAutofetchEnabled(currentState.context.repository.handle.rootUri)) return;
  const intervalMin = readRemoteCheckIntervalMinutes();
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) return;
  const intervalMs = intervalMin * 60_000;
  remoteCheckTimer = setInterval(() => {
    maybePerformRemoteCheck();
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
  // Clearing the throttle as well so that whatever trigger fires next
  // (timer restart, focus event) is allowed to run immediately rather
  // than waiting out the previous window.
  lastRemoteCheckAt = 0;
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

async function handleRemoteBehind(ctx: LiveContext, remoteSha: string): Promise<void> {
  const baseBranch = ctx.baseBranch;
  if (!baseBranch) return;

  // Notify at most once per distinct remote SHA so the user is not
  // re-prompted on every timer tick. A non-modal toast carries a single
  // "Fetch" action; clicking it fetches *only* the base branch (not the
  // whole remote) and refreshes decorations. Dismissing the toast leaves
  // the dedupe key set, so the next prompt fires only when the remote
  // moves to a different SHA.
  if (lastNotifiedRemoteSha === remoteSha) return;
  lastNotifiedRemoteSha = remoteSha;
  runtime?.logChannel.info(`Remote moved (${remoteSha.slice(0, 8)}); notifying for ${baseBranch}.`);
  const fetchLabel = t('Fetch');
  const choice = await vscode.window.showInformationMessage(
    t('{0} has been updated on the remote.', baseBranch),
    fetchLabel,
  );
  if (choice !== fetchLabel) return;
  const ok = await tryFetchBaseOnly(ctx, baseBranch);
  if (ok) {
    lastNotifiedRemoteSha = undefined;
    // The base tip just moved, so the merge-base might have shifted and
    // every cached base-diff is now potentially stale.
    runtime?.weakDecorations.invalidateAll();
    await refreshMergeBase();
    scheduleDecorationRefresh();
  }
}

/**
 * Fetch *only* the base branch via vscode.git's `Repository.fetch`.
 * Passing the ref name to `fetch` runs `git fetch <remote> <ref>`, which
 * updates a single local tracking ref (`refs/remotes/<remote>/<ref>`)
 * and leaves the rest of the remote's refs alone — important so the
 * Fetch-now action does not surprise the user with side effects on
 * other Source Control views.
 *
 * When the running VS Code build does not expose a fetch method, fall
 * back to asking the user to run `git fetch` themselves. We do not
 * spawn git ourselves because SECURE_ARGS / SECURE_ENV intentionally
 * disable the SSH transport and credential prompts that any real
 * network fetch would need.
 */
async function tryFetchBaseOnly(ctx: LiveContext, baseBranch: string): Promise<boolean> {
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
      'vscode.git did not surface a fetch method; cannot fetch from this command.',
    );
    void vscode.window.showInformationMessage(
      t(
        '{0}: cannot fetch on this VS Code version. Please run "git fetch" manually.',
        EXTENSION_NAME,
      ),
    );
    return false;
  }

  try {
    await handle.fetch({ remote: split.remote, ref: split.branch });
    runtime?.logChannel.info(`vscode.git fetched ${split.remote}/${split.branch}.`);
    // No success toast: the user clicked Fetch and the highlights refresh on
    // their own, which is feedback enough. A "fetched" info toast would just
    // be one more notification to dismiss. Failures still surface below.
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
    // Fallback when detection threw. `undefined` headSha means "unknown":
    // the next successful detection produces a real SHA, which compares
    // unequal here and reliably re-triggers the cache / merge-base refresh
    // chain. Using `undefined` rather than `''` keeps the "unknown" case
    // out of any code path that would otherwise pass it to git as a ref.
    return {
      kind: 'ready',
      headSha: undefined,
      detached: false,
      bisecting: false,
    };
  }
}

function gitStatesEqual(a: GitState, b: GitState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ready' && b.kind === 'ready') {
    return a.headSha === b.headSha && a.detached === b.detached && a.bisecting === b.bisecting;
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
        tooltip: t('{0}: git executable not found. {1}', EXTENSION_NAME, result.reason),
      });
      return;
    case 'git-too-old': {
      const version = result.version.raw;
      log?.warn(`git ${version} is below the minimum supported version (2.30).`);
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t('{0}: git {1} is too old. Requires git 2.30 or newer.', EXTENSION_NAME, version),
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
        tooltip: t('{0}: workspace is a submodule; not supported in MVP.', EXTENSION_NAME),
      });
      return;
    case 'timed-out':
      log?.warn('Timed out waiting for vscode.git to discover the repository.');
      setState({
        kind: 'unavailable',
        reason: '(unavailable)',
        tooltip: t('{0}: timed out waiting for the built-in Git extension.', EXTENSION_NAME),
      });
      return;
    case 'ok':
      // Unreachable: see comment in handleGitEnvironmentFailure.
      return;
    default:
      assertNever(result);
  }
}

function setState(next: ExtensionState | ((prev: ExtensionState) => ExtensionState)): void {
  if (!runtime) return;
  const previous = currentState;
  const resolved =
    typeof next === 'function'
      ? (next as (p: ExtensionState) => ExtensionState)(currentState)
      : next;
  currentState = resolved;
  renderStatusBar(resolved);
  syncMcpStateOnChange(previous, resolved);
}

function isMcpEnabled(): boolean {
  // Defaults to on (matches the package.json default); the fallback only
  // applies if the setting is somehow absent from the registry.
  return vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .get<boolean>(MCP_ENABLED_SETTING, true);
}

/**
 * Whether the MCP state file should be maintained: both the extension as a
 * whole and the MCP integration must be on. Disabling the extension
 * (`conflictLens.enabled`) stops the writes too, not just the highlights.
 */
function isMcpActive(): boolean {
  return isEnabled() && isMcpEnabled();
}

/**
 * Monotonic token guarding the async state-file writes against reordering.
 * A slow `listChangedFilesOnBase` from an earlier change must not overwrite
 * a snapshot produced by a newer one; each write checks it still holds the
 * latest token before touching disk. Same "newest wins" guard as the
 * decoration paint path.
 */
let mcpSyncSeq = 0;

/**
 * The base-relevant fingerprint of a state. The MCP snapshot only depends
 * on these fields, so an unrelated state change (e.g. a status-bar repaint)
 * does not trigger a rewrite.
 */
function mcpStateSignature(state: ExtensionState): string {
  if (state.kind !== 'live') return state.kind;
  const c = state.context;
  // Structural fingerprint of the base-relevant fields. JSON keeps the
  // field boundaries unambiguous without a hand-picked separator.
  return JSON.stringify([
    c.repository.rootPath,
    c.baseBranch ?? '',
    c.mergeBaseSha ?? '',
    c.baseTipSha ?? '',
  ]);
}

/**
 * Refresh the MCP state file when the base endpoints settle on a new value.
 * Fire-and-forget: the file is a side channel and never sits on the UI path.
 */
function syncMcpStateOnChange(previous: ExtensionState, next: ExtensionState): void {
  if (mcpStateSignature(previous) === mcpStateSignature(next)) return;
  // Leaving the live state (the repository dropped out, git became
  // unavailable, etc.) must remove the snapshot, or the MCP server keeps
  // serving stale data authoritatively. Deletion is unconditional here —
  // the file may exist from when the integration was last active.
  if (previous.kind === 'live' && next.kind !== 'live') {
    const repoRoot = previous.context.repository.rootPath;
    ++mcpSyncSeq;
    void deleteConflictLensState(repoRoot).catch((err) => {
      runtime?.logChannel.warn(`MCP state delete failed: ${stringifyError(err)}`);
    });
    return;
  }
  if (!isMcpActive()) return;
  const seq = ++mcpSyncSeq;
  void runMcpStateSync(next, seq).catch((err) => {
    runtime?.logChannel.warn(`MCP state sync failed: ${stringifyError(err)}`);
  });
}

/**
 * Apply the integration's enabled/disabled setting immediately: write the
 * current snapshot when turned on, remove it when turned off so a stale
 * file is never served. Bumping the token first invalidates any in-flight
 * write so a delete cannot be undone by a late writer (and vice versa).
 */
function syncMcpStateNow(): void {
  if (currentState.kind !== 'live') return;
  const repoRoot = currentState.context.repository.rootPath;
  const seq = ++mcpSyncSeq;
  if (!isMcpActive()) {
    void deleteConflictLensState(repoRoot).catch((err) => {
      runtime?.logChannel.warn(`MCP state delete failed: ${stringifyError(err)}`);
    });
    return;
  }
  void runMcpStateSync(currentState, seq).catch((err) => {
    runtime?.logChannel.warn(`MCP state sync failed: ${stringifyError(err)}`);
  });
}

async function runMcpStateSync(state: ExtensionState, seq: number): Promise<void> {
  if (state.kind !== 'live') return;
  const ctx = state.context;
  const repoRoot = ctx.repository.rootPath;
  const remoteName = readConfiguredRemoteName(ctx.repository.handle.rootUri);
  // Base not (yet) fully resolved: record an explicit "unresolved" snapshot
  // so the reader answers "cannot determine" instead of serving a stale
  // conflict set.
  if (!ctx.baseBranch || !ctx.mergeBaseSha || !ctx.baseTipSha) {
    await writeMcpStateIfLatest(seq, {
      schemaVersion: STATE_SCHEMA_VERSION,
      repoRoot,
      baseBranch: ctx.baseBranch ?? null,
      baseTipSha: null,
      mergeBaseSha: null,
      changedFiles: [],
      remoteName,
      generatedAt: new Date().toISOString(),
    });
    return;
  }
  let changedFiles: string[];
  try {
    changedFiles = await listChangedFilesOnBase(ctx.environment.runner, repoRoot, ctx.baseBranch);
  } catch (err) {
    // A failure is not "no files" (see changed-files.ts): keep the previous
    // snapshot rather than write a falsely-empty (looks-safe) list.
    runtime?.logChannel.warn(
      `MCP state sync: listChangedFilesOnBase failed: ${stringifyError(err)}`,
    );
    return;
  }
  await writeMcpStateIfLatest(seq, {
    schemaVersion: STATE_SCHEMA_VERSION,
    repoRoot,
    baseBranch: ctx.baseBranch,
    baseTipSha: ctx.baseTipSha,
    mergeBaseSha: ctx.mergeBaseSha,
    changedFiles,
    remoteName,
    generatedAt: new Date().toISOString(),
  });
}

async function writeMcpStateIfLatest(seq: number, state: ConflictLensState): Promise<void> {
  if (seq !== mcpSyncSeq) return; // a newer change superseded this write
  await writeConflictLensState(state);
}

function renderStatusBar(state: ExtensionState): void {
  if (!runtime) return;
  const { statusBarItem } = runtime;
  // The label is kept to the bare extension name to save space; the base
  // branch and git state live in the tooltip. When highlighting cannot run,
  // the name is struck through; when the active file is changed but too large
  // to highlight, an eye icon replaces the plain name.
  statusBarItem.command = 'conflictLens.selectBaseBranch';
  switch (state.kind) {
    case 'initializing':
      statusBarItem.text = EXTENSION_NAME;
      statusBarItem.tooltip = t('{0}: (initializing)', EXTENSION_NAME);
      return;
    case 'unavailable':
      statusBarItem.text = strikethrough(EXTENSION_NAME);
      statusBarItem.tooltip =
        state.tooltip ?? t('{0}: click to select base branch', EXTENSION_NAME);
      return;
    case 'live': {
      const { context } = state;
      // "Usable" means we are actually highlighting: a base branch is
      // selected and no mid-operation / detached state is blocking it.
      const usable =
        context.baseBranch !== undefined && !isStateBlockingHighlights(context.gitState);
      if (!usable) {
        // Nothing is highlighted and no badges are painted, so strike the
        // name through regardless of which file is active.
        statusBarItem.text = strikethrough(EXTENSION_NAME);
        statusBarItem.tooltip = tooltipFor(context);
        return;
      }
      // The extension is live and highlighting; the active file's outcome
      // only switches in the eye icon for the too-large case. A genuinely
      // unchanged file is not a disabled state, so it keeps the plain name —
      // the strike-through is reserved for the not-usable branch above.
      if (lastActiveOutcome === 'suppressed') {
        statusBarItem.text = `$(eye-closed) ${EXTENSION_NAME}`;
        statusBarItem.tooltip = t(
          '{0}: this file is changed on the base branch, but it is too large to highlight.',
          EXTENSION_NAME,
        );
        return;
      }
      statusBarItem.text = EXTENSION_NAME;
      statusBarItem.tooltip = tooltipFor(context);
      return;
    }
    default:
      assertNever(state);
  }
}

/**
 * Render text with a strikethrough by following each code point with the
 * combining long stroke overlay (U+0336). The status bar does not support
 * markdown or styled text, so this is the only way to strike a label; the
 * space is struck too, keeping the line continuous across words.
 */
function strikethrough(text: string): string {
  const COMBINING_LONG_STROKE = String.fromCharCode(0x0336);
  return Array.from(text, (ch) => `${ch}${COMBINING_LONG_STROKE}`).join('');
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
      return t('{0}: highlighting paused while cherry-pick is in progress.', EXTENSION_NAME);
    case 'reverting':
      return t('{0}: highlighting paused while revert is in progress.', EXTENSION_NAME);
    case 'ready':
      if (context.gitState.detached) {
        return t(
          '{0}: highlighting paused in detached HEAD. Check out a branch to resume.',
          EXTENSION_NAME,
        );
      }
      if (context.baseBranch) {
        return t(
          '{0}: comparing against {1}. Click to change the base branch.',
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
    vscode.commands.registerCommand('conflictLens.selectBaseBranch', selectBaseBranchCommand),
    vscode.commands.registerCommand('conflictLens.enable', () => setEnabledCommand(true)),
    vscode.commands.registerCommand('conflictLens.disable', () => setEnabledCommand(false)),
    vscode.commands.registerCommand('conflictLens.toggle', toggleEnabledCommand),
    vscode.commands.registerCommand('conflictLens.refresh', refreshCommand),
    vscode.commands.registerCommand('conflictLens.showChangedFiles', showChangedFilesCommand),
    vscode.commands.registerCommand('conflictLens.showBaseChanges', showBaseChangesCommand),
    vscode.commands.registerCommand('conflictLens.previewConflict', previewConflictCommand),
    vscode.commands.registerCommand('conflictLens.copyMcpRegistration', () =>
      copyMcpRegistrationCommand(context),
    ),
  );
}

/** Version-independent location of the staged MCP server (survives updates). */
function stagedMcpServerPath(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.globalStorageUri, 'mcp-server.js').fsPath;
}

/**
 * Copy the bundled MCP server into the extension's global storage, whose path
 * does not change when the extension updates, and return that path. The
 * versioned install directory (`…/conflict-lens-1.2.3/`) is removed on update,
 * which would otherwise break a `claude mcp add` registration.
 */
function stageMcpServer(context: vscode.ExtensionContext): string {
  const source = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
  const dest = stagedMcpServerPath(context);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  return dest;
}

/**
 * Copy the one-off shell command that registers the bundled stdio MCP server
 * with Claude Code. Points at the staged copy in global storage (not the
 * versioned install dir) so the registration survives extension updates;
 * quoting guards paths that contain spaces.
 */
async function copyMcpRegistrationCommand(context: vscode.ExtensionContext): Promise<void> {
  let serverPath: string;
  try {
    serverPath = stageMcpServer(context);
  } catch (err) {
    runtime?.logChannel.warn(`MCP server staging failed: ${stringifyError(err)}`);
    serverPath = stagedMcpServerPath(context);
  }
  const registration = `claude mcp add conflict-lens -- node "${serverPath}"`;
  await vscode.env.clipboard.writeText(registration);
  const message = isMcpEnabled()
    ? t(
        '{0}: registration command copied. Paste it in your terminal to register with Claude Code.',
        EXTENSION_NAME,
      )
    : t(
        '{0}: registration command copied. Turn on conflictLens.mcp.enabled so the server can answer.',
        EXTENSION_NAME,
      );
  void vscode.window.showInformationMessage(message);
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

/**
 * Serves the trial-merge "Preview Conflict" output as a read-only virtual
 * document. Unlike the base-side blob (which a URI fully describes via its
 * ref), the merged text depends on the live editor buffer, so the command
 * computes it and stashes it here keyed by URI. `set` re-fires `onDidChange`
 * so reopening after an edit refreshes the same tab instead of leaving stale
 * content behind.
 */
class ConflictPreviewContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly contents = new Map<string, string>();
  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.didChangeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.didChangeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.contents.clear();
    this.didChangeEmitter.dispose();
  }
}

/**
 * Build the read-only preview URI for a repo-relative path. The basename
 * carries a " (Conflict Preview)" marker so the tab is not mistaken for the
 * real file, while the original extension stays last so VSCode still infers
 * the right language for syntax highlighting.
 */
function buildConflictPreviewUri(relativeFilePath: string): vscode.Uri {
  const parsed = path.posix.parse(relativeFilePath);
  const base = `${parsed.name} (Conflict Preview)${parsed.ext}`;
  const previewPath = parsed.dir ? `${parsed.dir}/${base}` : base;
  return vscode.Uri.from({
    scheme: CONFLICT_PREVIEW_SCHEME,
    authority: 'conflict',
    path: `/${previewPath}`,
  });
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
    void vscode.window.showInformationMessage(t('{0}: no base branch selected.', EXTENSION_NAME));
    return;
  }

  const runner = ctx.environment.runner;
  const repoRoot = ctx.repository.rootPath;
  const baseBranch = ctx.baseBranch;
  let files: string[];
  try {
    files = await listChangedFilesOnBase(runner, repoRoot, baseBranch);
  } catch (err) {
    runtime?.logChannel.warn(`showChangedFiles failed: ${stringifyError(err)}`);
    void vscode.window.showWarningMessage(t('{0}: failed to list changed files.', EXTENSION_NAME));
    return;
  }
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      t('{0}: no files changed relative to {1}.', EXTENSION_NAME, baseBranch),
    );
    return;
  }

  files.sort((a, b) => a.localeCompare(b));

  // Some entries are files the base added (or that this branch deleted), so
  // they have no copy in the working tree. Flag them in the list and, when
  // picked, tell the user instead of silently failing to open a missing file.
  const presence = await Promise.all(files.map((f) => fileExists(path.join(repoRoot, f))));
  interface ChangedFileItem extends vscode.QuickPickItem {
    readonly relativeFilePath: string;
    readonly existsLocally: boolean;
  }
  const items: ChangedFileItem[] = files.map((f, i) => ({
    label: f,
    relativeFilePath: f,
    existsLocally: presence[i],
    description: presence[i] ? undefined : t('not in the current branch'),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `${EXTENSION_NAME}: ${baseBranch}`,
    placeHolder: t('Select a file to open'),
  });
  if (!picked) return;

  if (!picked.existsLocally) {
    void vscode.window.showInformationMessage(
      t('{0}: {1} does not exist in the current branch.', EXTENSION_NAME, picked.relativeFilePath),
    );
    return;
  }

  try {
    const uri = vscode.Uri.file(path.join(repoRoot, picked.relativeFilePath));
    await vscode.window.showTextDocument(uri);
  } catch (err) {
    runtime?.logChannel.warn(`showTextDocument failed: ${stringifyError(err)}`);
  }
}

/** True when `absolutePath` exists in the working tree (any file type). */
async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.promises.access(absolutePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the active editor down to (context, baseBranch, doc, repo-relative
 * path) or return `undefined` after surfacing the appropriate user-facing
 * message. Shared by `showBaseChangesCommand` and `previewConflictCommand`
 * because their entry-point validation is identical.
 */
async function resolveActiveTarget(targetUri?: string): Promise<
  | {
      ctx: LiveContext;
      baseBranch: string;
      doc: vscode.TextDocument;
      relativeFilePath: string;
    }
  | undefined
> {
  // When invoked from a weak-highlight hover, the hovered document's URI is
  // passed explicitly: hovering does not move focus, so in a split layout
  // `activeTextEditor` may be a different file than the one under the cursor.
  // Prefer the hovered document and fall back to the active editor only for
  // direct invocations (command palette, right-click menu) that omit it.
  let doc: vscode.TextDocument | undefined;
  if (targetUri) {
    doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === targetUri);
  }
  if (!doc) {
    doc = vscode.window.activeTextEditor?.document;
  }
  if (!doc) {
    void vscode.window.showInformationMessage(t('{0}: no active editor.', EXTENSION_NAME));
    return undefined;
  }
  if (currentState.kind !== 'live') {
    void vscode.window.showInformationMessage(
      t('{0}: not available in this workspace.', EXTENSION_NAME),
    );
    return undefined;
  }
  const ctx = currentState.context;
  // Capture baseBranch into a typed-as-string local before any await:
  // narrowing on `currentState` (a module-level let) is pessimistically
  // widened across awaits, but a const binding survives.
  const baseBranch = ctx.baseBranch;
  if (!baseBranch) {
    void vscode.window.showInformationMessage(
      t('{0}: not available in this workspace.', EXTENSION_NAME),
    );
    return undefined;
  }
  if (doc.uri.scheme !== 'file') return undefined;

  const normalized = await repoRelativePathViaRealpath(doc.uri.fsPath, ctx.repository.rootPath);
  if (normalized === undefined) {
    void vscode.window.showInformationMessage(
      t('{0}: file is not inside the repository.', EXTENSION_NAME),
    );
    return undefined;
  }

  // Both commands render the file as text (a diff editor / a trial-merge
  // document). A binary file would come through as garbled UTF-8, so bail
  // out with a clear message instead. The weak highlight already never
  // appears on binary files, so the hover entry points cannot reach here;
  // this guard covers the command-palette / status-bar invocations.
  if (
    await isPathBinaryAgainstRef(
      ctx.environment.runner,
      ctx.repository.rootPath,
      baseBranch,
      normalized,
    )
  ) {
    void vscode.window.showInformationMessage(
      t('{0}: {1} is a binary file; nothing to compare as text.', EXTENSION_NAME, normalized),
    );
    return undefined;
  }

  return { ctx, baseBranch, doc, relativeFilePath: normalized };
}

/**
 * Open a diff editor that shows how this file looks on the base branch
 * compared to the user's local buffer. Paired visually with the weak
 * (yellow) highlight, which marks the lines base touched.
 */
async function showBaseChangesCommand(line?: number, targetUri?: string): Promise<void> {
  const target = await resolveActiveTarget(targetUri);
  if (!target) return;
  const { ctx, baseBranch, doc, relativeFilePath } = target;

  // Pin the base side to the commit the branch points at *right now*. The
  // virtual-document URI is keyed solely on its components, and the content
  // provider never fires onDidChange, so a URI that carried only the branch
  // name (`origin/main`) would be byte-for-byte identical before and after a
  // fetch — VSCode would then serve the stale, cached base content. Embedding
  // the resolved tip SHA makes the URI change whenever base moves, and also
  // pins the read so base cannot shift between URI construction and content
  // fetch. Fall back to the branch name if resolution fails.
  const baseSha = await resolveRefToCommit(
    ctx.environment.runner,
    ctx.repository.rootPath,
    baseBranch,
  );
  const baseRef = baseSha ?? baseBranch;

  // LEFT side: the user's local buffer (the starting point).
  // RIGHT side: the file as it currently exists on the base branch's
  // tip — the thing the user wants to look at. Putting base on the
  // right matches the mental model "show me what base currently has",
  // and the read-only side ends up where the user is looking.
  const baseUri = vscode.Uri.from({
    scheme: DIFF_PROVIDER_SCHEME,
    authority: 'base',
    path: `/${relativeFilePath}`,
    query: baseRef,
  });

  // When invoked from a hover, the hovered hunk's first line (0-based)
  // is passed so the diff editor opens scrolled to that spot. Direct
  // invocations omit the arg: for the right-click menu the caret sits
  // where the user clicked, so fall back to that cursor line to open at
  // the spot they were looking at rather than the top of the file. Guard
  // on the active editor showing this same file so a stale split-view
  // editor cannot supply a line for the wrong document.
  let targetLine =
    typeof line === 'number' && Number.isFinite(line) && line >= 0 ? line : undefined;
  if (targetLine === undefined) {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === doc.uri.toString()) {
      targetLine = active.selection.active.line;
    }
  }
  const selection =
    targetLine !== undefined ? new vscode.Range(targetLine, 0, targetLine, 0) : undefined;

  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      doc.uri,
      baseUri,
      `${relativeFilePath} ↔ ${baseBranch}`,
      { preview: true, selection },
    );
  } catch (err) {
    runtime?.logChannel.warn(`vscode.diff failed: ${stringifyError(err)}`);
  }
}

/**
 * Open a preview document showing the trial-merge output (with the same
 * `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` markers `git merge` itself
 * would write). Reachable from the weak-highlight hover and the command
 * palette; when the trial merge resolves cleanly, surfaces a "no
 * conflicts" notification instead of opening an empty document.
 */
async function previewConflictCommand(targetUri?: string): Promise<void> {
  const target = await resolveActiveTarget(targetUri);
  if (!target) return;
  const { ctx, baseBranch, doc, relativeFilePath } = target;
  await openConflictView(ctx, baseBranch, doc, relativeFilePath);
}

/**
 * Open the trial-merge output (with the same `<<<<<<<` / `|||||||` /
 * `=======` / `>>>>>>>` markers that `git merge` itself would write)
 * as a read-only virtual document so the user can preview exactly what
 * the conflict will look like once they actually merge — without a new
 * unsaved file appearing in the workspace.
 */
async function openConflictView(
  ctx: LiveContext,
  baseBranch: string,
  doc: vscode.TextDocument,
  relativeFilePath: string,
): Promise<void> {
  // Prefer the cached merge-base maintained by the live context; fall
  // back to a fresh resolution only when it is missing (initial open
  // before the first event populated it).
  const mergeBaseSha =
    ctx.mergeBaseSha ??
    (await resolveMergeBase(ctx.environment.runner, ctx.repository.rootPath, baseBranch));
  if (!mergeBaseSha) {
    void vscode.window.showInformationMessage(
      t('{0}: cannot determine merge-base with {1}.', EXTENSION_NAME, baseBranch),
    );
    return;
  }

  let baseContent: string;
  let theirsContent: string;
  try {
    [baseContent, theirsContent] = await Promise.all([
      ctx.readBlob(mergeBaseSha, relativeFilePath),
      ctx.readBlob(baseBranch, relativeFilePath),
    ]);
  } catch (err) {
    runtime?.logChannel.warn(`openConflictView readBlob failed: ${stringifyError(err)}`);
    void vscode.window.showInformationMessage(
      t('{0}: cannot read base-side content for the conflict view.', EXTENSION_NAME),
    );
    return;
  }

  let merged;
  try {
    merged = await runMergeFile(
      ctx.environment.runner,
      ctx.repository.rootPath,
      doc.getText(),
      baseContent,
      theirsContent,
    );
  } catch (err) {
    runtime?.logChannel.warn(`openConflictView merge-file failed: ${stringifyError(err)}`);
    void vscode.window.showInformationMessage(
      t('{0}: failed to generate the conflict view.', EXTENSION_NAME),
    );
    return;
  }

  if (merged.conflictCount === 0) {
    void vscode.window.showInformationMessage(
      t('{0}: no conflicts detected in {1}.', EXTENSION_NAME, relativeFilePath),
    );
    return;
  }

  const previewUri = buildConflictPreviewUri(relativeFilePath);
  runtime?.conflictPreviews.set(previewUri, merged.content);
  let previewDoc = await vscode.workspace.openTextDocument(previewUri);
  // The URI extension usually resolves to the right language, but pin it to
  // the source editor's languageId so previews match the original file even
  // when extension-based detection would differ.
  if (previewDoc.languageId !== doc.languageId) {
    previewDoc = await vscode.languages.setTextDocumentLanguage(previewDoc, doc.languageId);
  }
  await vscode.window.showTextDocument(previewDoc, { preview: true });
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
      t('{0}: no remote-tracking branches found. Run git fetch first.', EXTENSION_NAME),
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
    await runtime?.workspaceState.update(baseBranchStateKey(repository.rootPath), picked.label);
  } catch (err) {
    runtime?.logChannel.warn(`Saving baseBranch failed: ${stringifyError(err)}`);
    void vscode.window.showWarningMessage(t('{0}: failed to save selection.', EXTENSION_NAME));
    return;
  }
  // Workspace state has no change event, so re-resolve explicitly.
  await refreshBaseBranch();
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
  repoRelativePathCache.clear();
  stopRemoteCheckTimer();
  lastNotifiedRemoteSha = undefined;
  runtime = undefined;
  currentState = { kind: 'initializing' };
  oneShotNotificationsShown = new Set();
}
