import { describe, expect, it } from 'vitest';

import {
  MIN_GIT_VERSION,
  compareMajorMinor,
  parseGitVersion,
  resolveGitEnvironment,
  type VscodeExtensionLike,
} from '../../../src/git/binary';
import type { VscodeGitApi } from '../../../src/git/vscode-git-api';

describe('parseGitVersion', () => {
  it('parses upstream format', () => {
    const v = parseGitVersion('git version 2.45.2\n');
    expect(v).toEqual({ raw: '2.45.2', major: 2, minor: 45, patch: 2 });
  });

  it('parses Apple Git format with trailing parenthesized vendor info', () => {
    const v = parseGitVersion('git version 2.39.3 (Apple Git-146)\n');
    expect(v).toEqual({ raw: '2.39.3', major: 2, minor: 39, patch: 3 });
  });

  it('accepts X.Y without patch', () => {
    const v = parseGitVersion('git version 2.30');
    expect(v).toEqual({ raw: '2.30', major: 2, minor: 30, patch: 0 });
  });

  it('returns undefined for unrecognized output', () => {
    expect(parseGitVersion('')).toBeUndefined();
    expect(parseGitVersion('hg version 6.5\n')).toBeUndefined();
    expect(parseGitVersion('garbage')).toBeUndefined();
  });
});

describe('compareMajorMinor', () => {
  const v = (major: number, minor: number) => ({
    raw: `${major}.${minor}`,
    major,
    minor,
    patch: 0,
  });

  it('compares by major first', () => {
    expect(compareMajorMinor(v(3, 0), { major: 2, minor: 99 })).toBeGreaterThan(0);
    expect(compareMajorMinor(v(1, 99), { major: 2, minor: 0 })).toBeLessThan(0);
  });

  it('compares by minor when major equal', () => {
    expect(compareMajorMinor(v(2, 38), { major: 2, minor: 30 })).toBeGreaterThan(0);
    expect(compareMajorMinor(v(2, 29), { major: 2, minor: 30 })).toBeLessThan(0);
    expect(compareMajorMinor(v(2, 30), { major: 2, minor: 30 })).toBe(0);
  });

  it('considers 2.30 the minimum supported boundary', () => {
    expect(compareMajorMinor(v(2, 29), MIN_GIT_VERSION)).toBeLessThan(0);
    expect(compareMajorMinor(v(2, 30), MIN_GIT_VERSION)).toBe(0);
  });
});

describe('resolveGitEnvironment', () => {
  function makeExt(
    overrides: Partial<VscodeExtensionLike & { api?: VscodeGitApi }>,
  ): VscodeExtensionLike {
    const baseApi: VscodeGitApi = {
      git: { path: '/usr/bin/git' },
      repositories: [],
      onDidOpenRepository: (() => ({ dispose: () => undefined })) as never,
      onDidCloseRepository: (() => ({ dispose: () => undefined })) as never,
    };
    const ext: VscodeExtensionLike = {
      isActive: overrides.isActive ?? true,
      activate: overrides.activate ?? (() => Promise.resolve(undefined)),
      exports:
        'exports' in overrides ? overrides.exports : { getAPI: () => overrides.api ?? baseApi },
    };
    return ext;
  }

  it('returns vscode-git-unavailable when the extension is undefined', async () => {
    const result = await resolveGitEnvironment(undefined);
    expect(result.kind).toBe('vscode-git-unavailable');
  });

  it('returns vscode-git-unavailable when exports.getAPI is missing', async () => {
    const ext = makeExt({ exports: undefined });
    const result = await resolveGitEnvironment(ext);
    expect(result.kind).toBe('vscode-git-unavailable');
  });

  // An API whose git.path is empty, so resolution terminates at
  // `git-not-found` *before* spawning anything — keeping the outcome
  // deterministic and independent of the host git.
  const emptyPathApi: VscodeGitApi = {
    git: { path: '' },
    repositories: [],
    onDidOpenRepository: (() => ({ dispose: () => undefined })) as never,
    onDidCloseRepository: (() => ({ dispose: () => undefined })) as never,
  };

  it('activates the extension when it is not already active', async () => {
    let activated = false;
    const ext = makeExt({
      isActive: false,
      activate: async () => {
        activated = true;
      },
      api: emptyPathApi,
    });
    const result = await resolveGitEnvironment(ext);
    expect(activated).toBe(true);
    // Empty git.path makes the terminal kind deterministic (no spawn).
    expect(result.kind).toBe('git-not-found');
  });

  it('does not call activate when the extension is already active', async () => {
    let activated = false;
    const ext = makeExt({
      isActive: true,
      activate: async () => {
        activated = true;
      },
      api: emptyPathApi,
    });
    await resolveGitEnvironment(ext);
    expect(activated).toBe(false);
  });

  it('returns git-not-found when getAPI returns an empty git.path', async () => {
    const ext = makeExt({ api: emptyPathApi });
    const result = await resolveGitEnvironment(ext);
    expect(result.kind).toBe('git-not-found');
  });

  it('resolves successfully against the host git', async () => {
    const ext = makeExt({});
    const result = await resolveGitEnvironment(ext);
    if (result.kind === 'ok') {
      // The success path must hand back a fully populated environment:
      // a runner bound to the resolved binary, a parsed version at or
      // above the supported floor, and the cached gitApi handle.
      const { runner, version, gitApi } = result.environment;
      expect(runner.gitPath).toBe('/usr/bin/git');
      expect(version.major).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(version.minor)).toBe(true);
      expect(compareMajorMinor(version, MIN_GIT_VERSION)).toBeGreaterThanOrEqual(0);
      expect(gitApi).toBeDefined();
    } else {
      // Acceptable when the test host has git < 2.30 or no git at all.
      expect(['git-too-old', 'git-not-found']).toContain(result.kind);
    }
  });
});
