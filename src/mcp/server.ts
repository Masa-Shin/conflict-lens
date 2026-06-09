import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getBaseChanges, getBaseContext, listBaseChanges, type ToolContext } from './tools';

const SERVER_NAME = 'conflict-lens';
// Injected from package.json at build time via esbuild `define`. Undefined
// under plain test transforms (no define), so fall back to a dev marker.
declare const __CONFLICT_LENS_VERSION__: string | undefined;
const SERVER_VERSION =
  typeof __CONFLICT_LENS_VERSION__ === 'string' ? __CONFLICT_LENS_VERSION__ : '0.0.0-dev';

/**
 * Sent in the MCP handshake. Clients (e.g. Claude Code) may inject this into
 * the model's context: what the server tells you, when to use it, and which
 * tool does what.
 */
const INSTRUCTIONS = [
  'This server tells you about the base branch your work will be merged into: which branch is',
  'the base, and what that base changed (the changed files and their diffs). Use it when you',
  'need to account for changes on the base branch — for example, to edit without conflicting',
  'with the base’s changes, to review what the base changed, or to check with the user when an',
  'edit looks likely to conflict.',
  '',
  '- get_base_context — which branch is the base (and the merge-base)',
  '- list_base_changes — the files the base branch changed',
  '- get_base_changes — the base-side diff for a given file',
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
 * The tools only relay what the extension knows about the base branch (the
 * resolved base/merge-base and the changes it made). Actual conflict
 * simulation is left to git.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'get_base_context',
    {
      title: 'Get the resolved base branch and merge-base',
      description:
        'Returns the base branch the extension resolved (may be a PR base or a branch the user ' +
        'selected, not necessarily origin/main), its tip SHA, and the merge-base with HEAD. Get ' +
        'the base ref here before comparing or merging; for a definitive conflict check, run git ' +
        'merge-tree against it yourself.',
      inputSchema: {},
    },
    async () => jsonResult(await getBaseContext(ctx)),
  );

  server.registerTool(
    'list_base_changes',
    {
      title: 'List files changed on the base branch',
      description:
        'Lists the files the base branch changed relative to the merge-base, or checks whether ' +
        'given paths are among them. Reads cached state; no git runs. Check this before editing ' +
        'to see which files the base already touched — those are where your edits risk ' +
        'conflicting.',
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
        'Returns the base branch’s change to one file as the diff from the merge-base to the ' +
        'base tip (added / modified / deleted; whole-file deletion in full). Use before editing ' +
        'a file the base also changed: the lines it changed are where your edits would conflict.',
      inputSchema: {
        path: z.string().describe('Repo-relative or absolute path to the file.'),
      },
    },
    async ({ path: filePath }) => jsonResult(await getBaseChanges(ctx, filePath)),
  );

  return server;
}
