import * as esbuild from 'esbuild';

const isDev = process.argv.includes('--dev');

const sharedOpts = {
  bundle: true,
  sourcemap: isDev,
  minify: !isDev,
};

await Promise.all([
  esbuild.build({
    ...sharedOpts,
    entryPoints: ['src/extension.ts'],
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    outfile: 'dist/extension.js',
  }),
  esbuild.build({
    ...sharedOpts,
    entryPoints: ['src/webview/index.tsx'],
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    outfile: 'dist/webview.js',
  }),
]);
