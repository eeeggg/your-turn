//@ts-check
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	target: 'es2022',
	logLevel: 'warning',
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
	...common,
	entryPoints: ['src/extension.ts'],
	format: 'cjs',
	platform: 'node',
	outfile: 'dist/extension.js',
	external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
	...common,
	entryPoints: ['src/webview/chat.ts'],
	format: 'iife',
	platform: 'browser',
	outfile: 'dist/webview/chat.js',
};

// Only production bundles the extension host; development runs tsc's per-file
// output from dist/, so production starts from an empty dist/ to keep it out of the VSIX.
if (production) {
	rmSync('dist', { recursive: true, force: true });
}
try {
	await Promise.all((production ? [extension, webview] : [webview]).map((options) => esbuild.build(options)));
} catch {
	// esbuild has already printed the errors.
	process.exit(1);
}
