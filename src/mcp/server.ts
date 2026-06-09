import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  getBaseChanges,
  getConflicts,
  listBaseChanges,
  listConflicts,
  type ToolContext,
} from './tools';

const SERVER_NAME = 'conflict-lens';
const SERVER_VERSION = '0.1.1';

/**
 * Sent in the MCP handshake. Clients (e.g. Claude Code) may inject this into
 * the model's context, so it nudges the agent to reach for these tools —
 * which resolve the base branch and run a real merge for you — instead of
 * driving git by hand when asked about conflicts with the base branch.
 */
const INSTRUCTIONS = [
  'Conflict Lens answers how the working tree relates to its base branch.',
  'Prefer these tools over running git yourself for the following questions; the base branch',
  'and merge-base are resolved automatically and your uncommitted edits are included, so you',
  'do not need to detect the base or stash anything.',
  '',
  '- "Will my current changes conflict when I merge the base?" / "Is anything conflicting?"',
  '  -> get_conflicts (one file) or list_conflicts (all files). These run a real three-way merge.',
  '- "What did the base branch change?" / "Which files moved on the base?"',
  '  -> get_base_changes (one file) or list_base_changes (all files).',
].join('\n');

/** Wrap a payload as an MCP text result carrying pretty-printed JSON. */
export function jsonResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Build the MCP server with the conflict-lens tools wired to `ctx`. Does not
 * connect a transport — the caller connects stdio (production) or an
 * in-memory transport (tests).
 *
 * Two families:
 *  - base changes: what the base branch itself changed (a plain diff).
 *  - conflicts: what actually clashes on merge (a real three-way merge).
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_conflicts',
    {
      title: 'List files that will conflict on merge',
      description:
        'Use when asked "is anything conflicting?" or "will my current changes conflict when I ' +
        'merge the base branch?". Lists every file that actually conflicts when the base branch ' +
        'is merged into your current working tree, decided by a real three-way merge (includes ' +
        'modify/delete). Run this before driving git yourself.',
      inputSchema: {},
    },
    async () => jsonResult(await listConflicts(ctx)),
  );

  server.registerTool(
    'get_conflicts',
    {
      title: 'Get the merge conflicts in a file',
      description:
        'Use when asked whether a specific file conflicts with the base branch, or "does my ' +
        'current edit to this file conflict?". Runs a real three-way merge of your on-disk ' +
        'version against the base and returns the conflicting regions (with `<<<<<<<` markers) ' +
        'or a modify/delete result. An empty result means it merges cleanly.',
      inputSchema: {
        path: z.string().describe('Repo-relative or absolute path to the file.'),
      },
    },
    async ({ path: filePath }) => jsonResult(await getConflicts(ctx, filePath)),
  );

  server.registerTool(
    'list_base_changes',
    {
      title: 'List files changed on the base branch',
      description:
        'Use when asked what the base branch changed, or which files moved on the base. Lists ' +
        'the files the base branch changed relative to the merge-base, or checks whether ' +
        'specific paths are among them. Reads cached state; no git runs. This is what moved on ' +
        'the base — not what will conflict (use list_conflicts for that).',
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe('Repo-relative or absolute paths to check. Omit to list every changed file.'),
      },
    },
    async ({ paths }) => jsonResult(await listBaseChanges(ctx, paths)),
  );

  server.registerTool(
    'get_base_changes',
    {
      title: 'Get the base branch’s diff for a file',
      description:
        'Use when asked how the base branch changed a specific file. Returns the base branch’s ' +
        'own change as the diff from the merge-base to the base tip (added / modified / ' +
        'deleted); a whole-file deletion is reported in full. This is what the base did, ' +
        'regardless of your local edits.',
      inputSchema: {
        path: z.string().describe('Repo-relative or absolute path to the file.'),
      },
    },
    async ({ path: filePath }) => jsonResult(await getBaseChanges(ctx, filePath)),
  );

  return server;
}
