import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	tests: [{ files: 'dist/test/**/*.test.js' }],
	coverage: {
		// Globs match absolute paths. The default exclude drops test files, and with them the src/ code bundled into each one.
		// Both match the bundles before their sourcemaps are applied, so the bundled node_modules still show in the
		// report: https://github.com/microsoft/vscode-test-cli/issues/37
		include: [`${import.meta.dirname}/dist/**`],
		exclude: [],
		reporter: ['text', 'html'],
	},
});
