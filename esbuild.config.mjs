import { build, context } from 'esbuild';

/**
 * Build configuration for the Conflict Lens VSCode extension.
 *
 * - bundle: VSCode loads a single CJS file
 * - external: ['vscode'] because the VSCode API is provided at runtime
 * - sourcemap: 'linked' for stack traces in production
 */
const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: isProduction ? false : 'linked',
  minify: isProduction,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log('esbuild: watching for changes...');
} else {
  await build(buildOptions);
}
