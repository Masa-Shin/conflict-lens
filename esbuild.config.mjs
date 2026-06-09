import { build, context } from 'esbuild';

/**
 * Build configuration for the Conflict Lens VSCode extension.
 *
 * Two CJS bundles share one config:
 *  - `dist/extension.js`  — the extension, loaded by VSCode.
 *  - `dist/mcp-server.js` — the stdio MCP server, spawned by Claude Code
 *    (`node dist/mcp-server.js`). It imports no `vscode` API, only the
 *    pure git/diff modules, so it runs standalone in plain Node.
 *
 * - bundle: each consumer loads a single file
 * - external: ['vscode'] because the VSCode API is provided at runtime
 * - sourcemap: 'linked' for stack traces in production
 */
const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: isProduction ? false : 'linked',
  minify: isProduction,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  { ...commonOptions, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  { ...commonOptions, entryPoints: ['src/mcp/stdio-server.ts'], outfile: 'dist/mcp-server.js' },
];

if (isWatch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('esbuild: watching for changes...');
} else {
  await Promise.all(targets.map((options) => build(options)));
}
