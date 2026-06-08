# Changelog

All notable changes to the Conflict Lens extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal

- Added VS Code integration tests (`@vscode/test-electron`) run on a dedicated CI job (Linux + xvfb). They cover activation and command registration, plus end-to-end checks against a real git fixture: base-branch auto-detection falling through to `master`, the base side of Show Base Branch Changes carrying the base branch's content, and Preview Conflict producing real conflict markers for a file changed on both sides.

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
