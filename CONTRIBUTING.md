# Contributing to Conflict Lens

Thanks for your interest in improving Conflict Lens! This guide covers how to set up
the project, make changes, and open a pull request.

## Prerequisites

- Node.js 20 (the version CI runs on)
- VS Code 1.74 or later
- Git 2.30 or later

## Getting started

```sh
git clone https://github.com/Masa-Shin/conflict-lens.git
cd conflict-lens
npm ci
```

To try your changes in a real editor, run:

```sh
npm run dev
```

This builds the extension and opens a new VS Code window with it loaded, so you can
verify behavior against an actual git repository.

## Development workflow

| Command | What it does |
|---|---|
| `npm run build` | Bundle the extension with esbuild |
| `npm run watch` | Rebuild on every change |
| `npm run dev` | Build, then launch a VS Code window with the extension loaded |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm test` | Run the unit tests once (Vitest) |
| `npm run test:watch` | Run the tests in watch mode |
| `npm run build:prod` | Type-check, then produce a production bundle |

Before opening a pull request, make sure the same checks CI runs pass locally:

```sh
npm run typecheck
npm test
npm run build:prod
```

## Project layout

```
src/
  extension.ts   Activation, command registration, and wiring
  cache/         LRU cache
  diff/          Diff mapping and weak-highlight computation
  git/           Git plumbing: ls-remote, fetch, diff, merge-file, state, etc.
  ui/            Editor decorations and Explorer file-decoration badges
  util/          Shared helpers (text, error handling)
  l10n.ts        Localization helper
test/
  unit/          Vitest unit tests, mirroring the src/ structure
  __mocks__/     The VS Code API mock used in tests
l10n/            Translated message bundles
```

Tests live under `test/unit/` and mirror the source tree, so a change in
`src/git/diff.ts` should have a matching `test/unit/git/diff.test.ts`.

## Tests

We use [Vitest](https://vitest.dev/). The VS Code API is mocked in
`test/__mocks__/vscode.ts`, so the unit tests run without launching an editor.
Please add or update tests for any behavior change, and keep `npm test` green.

## Pull requests

1. Create a branch off `main`.
2. Make your change, with tests where it makes sense.
3. Run `npm run typecheck`, `npm test`, and `npm run build:prod` locally.
4. Add an entry under `## [Unreleased]` in `CHANGELOG.md` if your change is
   user-facing. The changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
   and the project uses [Semantic Versioning](https://semver.org/).
5. Open the pull request against `main`. CI runs the type check, tests, and a
   production build on Linux, macOS, and Windows.

## Reporting bugs and requesting features

Please use the [issue tracker](https://github.com/Masa-Shin/conflict-lens/issues).
For bugs, the output of `Conflict Lens: Show Output Channel` is very helpful, along
with your VS Code and Git versions and the steps to reproduce.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
