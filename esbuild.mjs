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

/** @type {import('esbuild').BuildOptions} */
const integrationTests = {
	...common,
	entryPoints: ['tests/integration/**/*.test.ts', 'tests/integration/fixtures/*.ts'],
	outbase: 'tests/integration',
	outdir: 'dist/test',
	format: 'cjs',
	platform: 'node',
	// Mocha's suite and test only work from the copy the test runner loaded.
	external: ['vscode', 'mocha'],
};

rmSync('dist', { recursive: true, force: true });
try {
	const builds = production ? [extension, webview] : [extension, webview, integrationTests];
	await Promise.all(builds.map((options) => esbuild.build(options)));
} catch {
	// esbuild has already printed the errors.
	process.exit(1);
}
