import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { execa } from 'execa';
import { generateIcons } from './tools/icons.mjs';

const production = process.argv.includes('--production');
const ui = process.argv.includes('--ui');
if (production && ui) { throw new Error('Desktop instrumentation cannot be used in a production build'); }
const root = ui ? 'test-results/ui-extension' : '.';

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
	entryPoints: [ui ? 'tests/ui/instrumentation/extension.ts' : 'src/extension.ts'],
	format: 'cjs',
	platform: 'node',
	outfile: join(root, 'dist/extension.js'),
	external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
	...common,
	entryPoints: ['src/webview/Main.tsx'],
	format: 'iife',
	platform: 'browser',
	outfile: join(root, 'dist/webview/chat.js'),
	jsx: 'automatic',
	// React picks its development or production build from this.
	define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
};

/** @type {import('esbuild').BuildOptions} */
const integrationTests = {
	...common,
	entryPoints: ['tests/integration/**/*.test.ts', 'tests/integration/fixtures/*.ts'],
	outbase: 'tests/integration',
	outdir: join(root, 'dist/test'),
	format: 'cjs',
	platform: 'node',
	// Mocha's suite and test only work from the copy the test runner loaded.
	external: ['vscode', 'mocha'],
};

const webviewStyles = () =>
	execa(
		'tailwindcss',
		['--input', 'src/webview/chat.css', '--output', join(root, 'dist/webview/chat.css'), ...(production ? ['--minify'] : [])],
		{ preferLocal: true, stdio: 'inherit' },
	);

rmSync(ui ? root : 'dist', { recursive: true, force: true });
try {
	const builds = production ? [extension, webview] : [extension, webview, integrationTests];
	await Promise.all([...builds.map((options) => esbuild.build(options)), webviewStyles(), generateIcons(join(root, 'resources'))]);
	if (ui) {
		/** @type {unknown} */
		const parsed = JSON.parse(readFileSync('package.json', 'utf8'));
		const manifest = /** @type {Record<string, unknown>} */ (parsed);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, main: './dist/extension.js', yourTurnDesktopTest: true }, undefined, 2) + '\n');
	}
} catch {
	// esbuild and Tailwind have already printed the errors.
	process.exit(1);
}
