import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { GitCatFileBatch, createBlobReaderFromBatch } from '../../../src/git/cat-file-batch';
import { createGitRunner } from '../../../src/git/runner';
import { createMcpServer } from '../../../src/mcp/server';
import { STATE_SCHEMA_VERSION, writeConflictLensState } from '../../../src/mcp/state-file';
import type { ToolContext } from '../../../src/mcp/tools';
import { setupScenario, type Scenario } from './repo-fixture';

const runner = createGitRunner('git');

let scenario: Scenario;
let batch: GitCatFileBatch;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

function parseText(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}

beforeEach(async () => {
  // Base deletes layout.tsx; locally it is edited → a real conflict.
  scenario = setupScenario({
    root: { 'layout.tsx': 'l1\nl2\nl3\nl4\nl5\n' },
    baseChange: (t) => t.remove('layout.tsx'),
    localChange: (t) => t.write('layout.tsx', 'l1\nl2\nEDITED\nl4\nl5\n'),
  });
  await writeConflictLensState({
    schemaVersion: STATE_SCHEMA_VERSION,
    repoRoot: scenario.repo,
    baseBranch: scenario.baseBranch,
    baseTipSha: scenario.baseTipSha,
    mergeBaseSha: scenario.mergeBaseSha,
    changedFiles: ['layout.tsx'],
    remoteName: 'origin',
    generatedAt: '2026-06-08T00:00:00.000Z',
  });
  batch = new GitCatFileBatch({ gitPath: 'git', cwd: scenario.repo });
  const ctx: ToolContext = {
    cwd: scenario.repo,
    runner,
    getReadBlob: () => createBlobReaderFromBatch(batch),
  };
  server = createMcpServer(ctx);
  client = new Client({ name: 'test-client', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  batch.dispose();
  scenario.cleanup();
});

describe('createMcpServer (in-memory MCP round-trip)', () => {
  it('exposes the four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_base_changes',
      'get_conflicts',
      'list_base_changes',
      'list_conflicts',
    ]);
  });

  it('advertises usage instructions to steer the client', () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('conflict');
  });

  it('lists base changes', async () => {
    const result = await client.callTool({ name: 'list_base_changes', arguments: {} });
    expect(parseText(result)).toEqual({
      status: 'ok',
      baseBranch: 'main',
      files: ['layout.tsx'],
    });
  });

  it('reports the base-side deletion in full', async () => {
    const result = await client.callTool({
      name: 'get_base_changes',
      arguments: { path: 'layout.tsx' },
    });
    expect(parseText(result)).toMatchObject({ status: 'ok', change: 'deleted' });
  });

  it('lists the conflicting file', async () => {
    const result = await client.callTool({ name: 'list_conflicts', arguments: {} });
    expect(parseText(result)).toEqual({
      status: 'ok',
      baseBranch: 'main',
      files: [{ path: 'layout.tsx', kind: 'base_deleted_local_modified' }],
    });
  });

  it('reports the conflict for a file', async () => {
    const result = await client.callTool({
      name: 'get_conflicts',
      arguments: { path: 'layout.tsx' },
    });
    expect(parseText(result)).toMatchObject({
      conflicting: true,
      kind: 'base_deleted_local_modified',
    });
  });

  it('rejects a call that violates the input schema', async () => {
    let threw = false;
    let result: unknown;
    try {
      result = await client.callTool({ name: 'get_conflicts', arguments: {} });
    } catch {
      threw = true;
    }
    expect(threw || (result as { isError?: boolean })?.isError).toBeTruthy();
  });
});
