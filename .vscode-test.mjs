import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	tests: [{ files: 'dist/test/**/*.test.js' }],
});
