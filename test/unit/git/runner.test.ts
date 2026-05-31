import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMEOUT_MS,
  SECURE_ARGS,
  SECURE_ENV,
  createGitRunner,
} from '../../../src/git/runner';

describe('SECURE_ARGS', () => {
  it('starts with --no-pager so a hostile core.pager cannot run', () => {
    expect(SECURE_ARGS[0]).toBe('--no-pager');
  });

  it.each([
    ['core.pager=cat'],
    ['core.sshCommand='],
    ['core.askpass='],
    ['core.editor=false'],
    ['core.fsmonitor=false'],
    ['gpg.program=false'],
    ['protocol.ext.allow=never'],
    ['protocol.file.allow=never'],
    ['uploadpack.packObjectsHook='],
    ['merge.conflictStyle=merge'],
    ['diff.renames=true'],
  ])('neutralizes %s', (cfg) => {
    expect(SECURE_ARGS).toContain(cfg);
  });

  it('points core.hooksPath at the null device for the current platform', () => {
    const expected = process.platform === 'win32' ? 'NUL' : '/dev/null';
    expect(SECURE_ARGS).toContain(`core.hooksPath=${expected}`);
  });

  it('does NOT include credential.helper= so OS keychain auth keeps working', () => {
    // Suppressing the helper for every command breaks HTTPS auth for
    // PAT-protected remotes. Local-only commands do not invoke the helper
    // anyway, so omitting the override is safe. See spec §4.1 (note).
    const helperOverride = SECURE_ARGS.find((arg) => arg.startsWith('credential.helper'));
    expect(helperOverride).toBeUndefined();
  });
});

describe('SECURE_ENV', () => {
  it('suppresses interactive prompts and locale variability', () => {
    expect(SECURE_ENV.GIT_TERMINAL_PROMPT).toBe('0');
    expect(SECURE_ENV.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(SECURE_ENV.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(SECURE_ENV.GIT_ASKPASS).toBe('true');
    expect(SECURE_ENV.SSH_ASKPASS).toBe('true');
    expect(SECURE_ENV.LC_ALL).toBe('C.UTF-8');
  });
});

describe('DEFAULT_TIMEOUT_MS', () => {
  it('is 30 seconds per spec §5.4', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});

describe('createGitRunner integration', () => {
  it('runs git --version successfully using the host git', async () => {
    const runner = createGitRunner('git');
    const result = await runner.run(['--version'], { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toMatch(/^git version /);
  });

  it('reports non-zero exit on unknown subcommands without throwing', async () => {
    const runner = createGitRunner('git');
    const result = await runner.run(['this-command-does-not-exist'], { cwd: process.cwd() });
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
