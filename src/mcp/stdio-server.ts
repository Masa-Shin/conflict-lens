import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createGitRunner } from '../git/runner';
import { createMcpServer } from './server';
import type { ToolContext } from './tools';

/**
 * The git binary. The server runs in the shell Claude Code launched it from,
 * so `git` on PATH is the natural choice. (The extension resolves a possibly
 * custom git path; aligning the two is a future refinement.)
 */
const GIT_PATH = 'git';

async function main(): Promise<void> {
  const ctx: ToolContext = { cwd: process.cwd(), runner: createGitRunner(GIT_PATH) };
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP channel; diagnostics must go to stderr only.
  process.stderr.write(`conflict-lens MCP server failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
