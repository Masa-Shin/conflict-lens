# Changelog

All notable changes to the Conflict Lens extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
