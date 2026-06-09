import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { BlobReader } from '../git/blob';
import { GitCatFileBatch, createBlobReaderFromBatch } from '../git/cat-file-batch';
import { createGitRunner } from '../git/runner';
import { createMcpServer } from './server';
import type { ToolContext } from './tools';

/**
 * The git binary. The server runs in the shell Claude Code launched it from,
 * so `git` on PATH is the natural choice. (The extension resolves a possibly
 * custom git path; aligning the two is a future refinement.)
 */
const GIT_PATH = 'git';

const runner = createGitRunner(GIT_PATH);

// Long-lived `cat-file --batch`, lazily created per repository and reused
// across calls. Keyed by repo root so a (rare) root change recreates it.
let blobBatch: GitCatFileBatch | undefined;
let blobBatchRoot: string | undefined;
let blobReader: BlobReader | undefined;

function getReadBlob(repoRoot: string): BlobReader {
  if (blobReader && blobBatchRoot === repoRoot) return blobReader;
  blobBatch?.dispose();
  blobBatch = new GitCatFileBatch({ gitPath: GIT_PATH, cwd: repoRoot });
  blobBatchRoot = repoRoot;
  blobReader = createBlobReaderFromBatch(blobBatch);
  return blobReader;
}

function shutdown(): void {
  blobBatch?.dispose();
}

async function main(): Promise<void> {
  const ctx: ToolContext = { cwd: process.cwd(), runner, getReadBlob };
  const server = createMcpServer(ctx);
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP channel; diagnostics must go to stderr only.
  process.stderr.write(`conflict-lens MCP server failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
