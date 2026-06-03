# Changelog

All notable changes to the Conflict Lens extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
