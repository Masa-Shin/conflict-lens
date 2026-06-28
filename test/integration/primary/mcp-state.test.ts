import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { ensureBaseReady, waitFor, workspaceRoot } from '../helpers';

import type { ConflictLensState } from '../../../src/mcp/state-file';

function statePath(): string {
  return path.join(workspaceRoot(), '.git', 'conflict-lens', 'state.json');
}

function readState(): ConflictLensState | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ConflictLensState;
  } catch {
    return undefined;
  }
}

function gitOut(args: string[]): string {
  return execFileSync('git', args, { cwd: workspaceRoot() }).toString().trim();
}

async function setMcpEnabled(value: boolean | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration('conflictLens')
    .update('mcp.enabled', value, vscode.ConfigurationTarget.Workspace);
}

describe('MCP state file', () => {
  before(async () => {
    await ensureBaseReady();
  });

  // Leave the setting at its default for the suites that follow.
  after(async () => {
    await setMcpEnabled(undefined);
  });

  it('writes a resolved snapshot once the base branch is known', async () => {
    const written = await waitFor(() => readState()?.baseBranch === 'origin/master', {
      timeoutMs: 15000,
      intervalMs: 200,
    });
    assert.ok(written, `no resolved snapshot appeared at ${statePath()}`);

    const state = readState();
    assert.ok(state, 'snapshot vanished between polls');
    assert.strictEqual(state.schemaVersion, 1);
    assert.strictEqual(state.repoRoot, fs.realpathSync(workspaceRoot()));
    assert.strictEqual(state.baseTipSha, gitOut(['rev-parse', 'origin/master']));
    assert.strictEqual(state.mergeBaseSha, gitOut(['merge-base', 'HEAD', 'origin/master']));
    assert.deepStrictEqual(
      [...state.changedFiles].sort(),
      ['changed.txt', 'conflict.txt', 'deleted.txt', 'multi.txt', 'upstream.txt'],
      'the snapshot must list exactly the base-changed files',
    );
    assert.ok(
      !Number.isNaN(Date.parse(state.generatedAt)),
      `generatedAt must be a timestamp, got: ${state.generatedAt}`,
    );
  });

  it('removes the snapshot when the integration is turned off', async () => {
    await setMcpEnabled(false);
    const removed = await waitFor(() => !fs.existsSync(statePath()), {
      timeoutMs: 15000,
      intervalMs: 200,
    });
    assert.ok(removed, 'state file should be deleted when conflictLens.mcp.enabled is false');
  });

  it('writes the snapshot again when turned back on', async () => {
    await setMcpEnabled(true);
    const rewritten = await waitFor(() => readState()?.baseBranch === 'origin/master', {
      timeoutMs: 15000,
      intervalMs: 200,
    });
    assert.ok(rewritten, 'state file should be re-created when the integration is re-enabled');
  });
});
