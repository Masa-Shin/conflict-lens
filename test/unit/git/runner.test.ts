import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMEOUT_MS,
  SECURE_ARGS,
  SECURE_ENV,
  composeGitEnv,
  createGitRunner,
} from '../../../src/git/runner';

describe('SECURE_ARGS', () => {
  it('starts with --no-pager so a hostile core.pager cannot run', () => {
    expect(SECURE_ARGS[0]).toBe('--no-pager');
  });

  it.each([
    ['core.pager=cat'],
    ['core.editor=false'],
    ['core.fsmonitor=false'],
    ['gpg.program=false'],
    ['protocol.ext.allow=never'],
    ['protocol.file.allow=user'],
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

  it.each([
    ['credential.helper'],
    // core.sshCommand and core.askpass were previously forced to empty
    // here as "security hardening", but doing so breaks every git network
    // command — git tries to fork an empty-string program and fails with
    // `cannot run :` / `unable to fork`. Leave them at user/system defaults.
    ['core.sshCommand'],
    ['core.askpass'],
  ])('does NOT override %s so network commands keep working', (key) => {
    const override = SECURE_ARGS.find((arg) => arg.startsWith(`${key}=`));
    expect(override).toBeUndefined();
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

describe('composeGitEnv', () => {
  it('lets SECURE_ENV override a weakening caller value', () => {
    const env = composeGitEnv({ GIT_TERMINAL_PROMPT: '1', LC_ALL: 'en_US.UTF-8' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  it('lets SECURE_ENV override an ambient process.env value', () => {
    const prev = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = '1';
    try {
      expect(composeGitEnv().GIT_TERMINAL_PROMPT).toBe('0');
    } finally {
      if (prev === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = prev;
    }
  });

  it('passes through a caller variable that SECURE_ENV does not set', () => {
    expect(composeGitEnv({ CONFLICT_LENS_TEST_VAR: 'x' }).CONFLICT_LENS_TEST_VAR).toBe('x');
  });

  it('layers a caller variable above process.env for non-hardened keys', () => {
    const prev = process.env.CONFLICT_LENS_TEST_VAR;
    process.env.CONFLICT_LENS_TEST_VAR = 'from-process';
    try {
      expect(composeGitEnv({ CONFLICT_LENS_TEST_VAR: 'from-caller' }).CONFLICT_LENS_TEST_VAR).toBe(
        'from-caller',
      );
    } finally {
      if (prev === undefined) delete process.env.CONFLICT_LENS_TEST_VAR;
      else process.env.CONFLICT_LENS_TEST_VAR = prev;
    }
  });
});

describe('createGitRunner integration', () => {
  it('runs git --version successfully using the host git', async () => {
    const runner = createGitRunner('git');
    const result = await runner.run(['--version'], { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.stdout).toMatch(/^git version /);
  });

  it('reports non-zero exit on unknown subcommands without throwing', async () => {
    const runner = createGitRunner('git');
    const result = await runner.run(['this-command-does-not-exist'], { cwd: process.cwd() });
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('truncates the result when stdout exceeds maxBufferBytes', async () => {
    const runner = createGitRunner('git');
    // `git --help` prints a sizable manpage-like blob; cap the buffer
    // ridiculously low (10 bytes) so the truncation path fires
    // deterministically on every host.
    const result = await runner.run(['help', '-a'], {
      cwd: process.cwd(),
      maxBufferBytes: 10,
    });
    expect(result.truncated).toBe(true);
  });
});
