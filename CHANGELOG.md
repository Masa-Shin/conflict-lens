# Changelog

All notable changes to the Conflict Lens extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-06-11

### Changed

- The default highlight color is now a softer orange (previously yellow), so it no longer blends with the yellow "modified line" gutter bars some themes use for Git changes. Override via `conflictLens.changedLineBackground` in `workbench.colorCustomizations` as before.

### Fixed

- The Japanese hover and badge text now attributes the change to the base branch (「{0} 側で変更されています」); the previous wording read as if the local file had been edited.

## [1.2.0] - 2026-06-10

### Added

- After fetching the base branch from the update notification, a notification now reports how many places may conflict with your local changes, listing up to three affected files (plus an "and n more" line when there are more). Nothing is shown when everything merges cleanly. Controlled by `conflictLens.notifyConflictsAfterFetch` (on by default).
- `Conflict Lens: Show Conflict Files` — list the files that would conflict if the base branch were merged now, with the number of conflicting places per file; selecting one opens it.

### Changed

- The remote-update notification now reads "<base> has been updated on the remote." — clearer wording, and without the redundant "Conflict Lens" prefix (VS Code already shows the source).

## [1.1.0] - 2026-06-10

### Fixed

- Filenames containing glob characters (`*`, `?`, `[ ]`) are now matched literally; previously their diffs and highlights could be dropped or attributed to the wrong file (git pathspecs are treated as literal via `GIT_LITERAL_PATHSPECS`).
- `list_base_changes` and `get_base_changes` now also report `generatedAt`, so an agent can judge snapshot freshness from any tool (previously only `get_base_context` did).
- A transient git error on one file no longer drops the whole highlight refresh: each editor is updated independently, so the others still repaint.
- A file whose merge-base version is very large no longer re-runs git on every keystroke; the oversized base diff is no longer refetched once seen.
- Conflict Preview normalizes line endings before merging, so a CRLF working copy against LF blobs no longer manufactures spurious conflicts.

## [1.0.2] - 2026-06-09

### Fixed

- Disabling the extension (`conflictLens.enabled`) now also stops the MCP integration and removes its state file, instead of continuing to write it.
- Disabling the extension now also stops the remote-base polling and its "moved upstream" prompt, which previously kept running.
- The MCP state file is now removed when the repository drops out of the live state (not only when the integration is toggled off), so the server stops serving a stale snapshot.
- `get_base_changes` returns a `stale` status instead of erroring when the recorded base endpoints can no longer be resolved (e.g. after a gc or rebase).
- Path resolution is now realpath-aware, so a file in a workspace opened through a symbolic link is no longer mistaken for being outside the repository.
- The Claude Code registration command points at a version-independent path (the extension's global storage), so it keeps working after the extension updates instead of needing re-registration.
- `get_base_context` now reports `generatedAt` and notes that its snapshot may be stale, so an agent can tell when to re-query.

### Internal

- The MCP server version is taken from `package.json` at build time rather than a hardcoded constant.

## [1.0.1] - 2026-06-09

Corrective release to publish the base-context MCP server (`get_base_context`, `list_base_changes`, `get_base_changes`) intended for 1.0.0.

## [1.0.0] - 2026-06-09

### Added

- AI agent integration over MCP (Model Context Protocol). With `conflictLens.mcp.enabled` (on by default), the extension keeps a small state file under `.git/conflict-lens/` recording the resolved base branch, its merge-base and tip, and the files the base changed. A bundled stdio MCP server (`dist/mcp-server.js`) exposes this to MCP clients such as Claude Code through three tools: `get_base_context` (the resolved base branch and merge-base), `list_base_changes` (the files the base branch changed), and `get_base_changes` (a file's base-side diff). An AI agent can use them to account for what the base branch changed while it edits — for example, to avoid conflicting with the base, or to flag a likely conflict to you. Run **Copy Claude Code MCP Registration Command** to register it with Claude Code; other MCP clients launch `node <extension>/dist/mcp-server.js`.

### Internal

- Added a VS Code integration test suite (`@vscode/test-electron`) on a dedicated CI job (Linux + xvfb), driving real git fixtures end to end: activation and command registration; base-branch auto-detection (both `origin/main` and the `master` fallback); Show Base Branch Changes content and direction, including a file deleted on the base; Preview Conflict for single, multiple, no-conflict, and modify/delete cases; picking up a fetched upstream move; re-evaluation after switching the current branch; the on-demand commands still working while the extension is disabled; and a repository with no base branch degrading gracefully.
- Added unit coverage for the MCP layer: the state file, path resolution, base-change queries, the tool handlers, and an in-memory MCP round-trip.

## [0.1.1] - 2026-06-07

### Changed

- Japanese hover and badge text now reads "{0} と比べて変更されています", keeping the "relative to the base branch" sense (it previously read as "changed by {0}").

### Fixed

- A rare incorrect badge that could appear if the repository root changed while a file's path was still being resolved.

## [0.1.0] - 2026-06-07

First stable release.

### Added

- Japanese localization. When VS Code's display language is set to Japanese, the command palette entries, settings descriptions, status bar, notifications, hover links, and all other messages are shown in Japanese. Other languages continue to fall back to English.

### Fixed

- The **Show Base Branch Changes** and **Preview Conflict** right-click menu entries now appear for any file the base branch has changed, not only files that currently show highlights. They were previously hidden when the local buffer had deleted every line the base touched (a modify/delete conflict — exactly when Preview Conflict is most useful) or when the highlights were withheld because the file was too large.
- Highlights, the Explorer "≠" badge, and the Show Base Changes / Preview Conflict commands no longer break when the workspace is opened through a symbolic link. All of them now resolve files through realpath, so the file's real location inside the repository is recognized regardless of the symlinked path. Accented file names (e.g. `café.ts`) are also matched in the badge regardless of Unicode normalization form.

## [0.0.5] - 2026-06-07

### Changed

- The base branch you choose with **Select Base Branch** is now stored per workspace (local to you) instead of in a `conflictLens.baseBranch` setting, so your choice never leaks into the repository or onto teammates. The `conflictLens.baseBranch` setting has been removed; pick a base branch from the status bar or the **Select Base Branch** command.
- When VS Code's built-in Git auto-fetch (`git.autofetch`) is enabled, Conflict Lens no longer polls the remote or prompts you to fetch. It relies on auto-fetch and refreshes the highlights on its own when the base branch updates.
- Removed the notification shown after clicking **Fetch**; the highlights refresh on their own, which is feedback enough.

## [0.0.4] - 2026-06-07

Maintenance release; no user-facing changes.

### Internal

- Added Dependabot configuration for npm and GitHub Actions dependencies.
- Raised the test timeout for git-backed test suites so they don't flake on the Windows CI runner.

## [0.0.3] - 2026-06-07

### Fixed

- Automatic base branch detection was never reaching repositories that don't use `origin/main`. The `conflictLens.baseBranch` default was `origin/main` rather than empty, so the extension treated it as an explicit setting and warned `'origin/main' is invalid` on `master`-based or non-`origin` repositories instead of falling back to detection. The default is now empty, so detection (remote default branch → `main` → `master`) runs out of the box.

## [0.0.2] - 2026-06-07

### Fixed

- Files under the repository root could be treated as outside it — and therefore left unhighlighted — when the resolved root and file paths differed (Windows extended-length `\\?\` paths, or a root reached through a symlink). Both sides are now canonicalized the same way.

### Changed

- README: added Marketplace install instructions and corrected the large-file limit note.

## [0.0.1] - 2026-06-02

Initial pre-release.

### Added

- Periodic checks against the remote base branch (`git ls-remote`), with a fetch prompt when it has moved upstream.
- Yellow line highlights for lines the base branch has touched since the merge-base.
- A `≠` badge in the Explorer for files the base branch has touched.
- `Conflict Lens: Show Changed Files` — list all files changed on the base branch.
- `Conflict Lens: Show Base Branch Changes` — open a side-by-side diff between the base branch and the current buffer.
- `Conflict Lens: Preview Conflict` — on demand, open the predicted merge result with standard `<<<<<<<` / `=======` / `>>>>>>>` markers in a new editor.
- `Conflict Lens: Select Base Branch`, `Refresh`, `Enable`, `Disable`, `Toggle`, `Show Output Channel`.
- Configurable remote name (`conflictLens.remoteName`) for auto-detecting the base branch.
