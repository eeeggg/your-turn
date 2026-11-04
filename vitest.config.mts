import { defineConfig } from 'vitest/config';

// CLI positional filters alone are case-insensitive substrings. The coordinator
// supplies validated source paths to keep discovery exact.
const selectedFiles = process.env['TEST_FILES']?.split(',');

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // View tests opt into jsdom with a @vitest-environment comment.
          environment: 'node',
          include: selectedFiles?.filter((file) => file.startsWith('tests/unit/')) ?? ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'webview',
          // Each test builds its own jsdom window, so the runner itself needs no DOM.
          environment: 'node',
          include: selectedFiles?.filter((file) => file.startsWith('tests/webview/')) ?? ['tests/webview/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // These only run as the bundle in the webview suite, which is not measured.
        'src/webview/Main.tsx',
        'src/webview/VsCodeApi.ts',
        // These need the real `vscode` module; `npm run coverage:integration` measures them.
        'src/extension.ts',
        'src/adapters/**',
      ],
      reporter: ['text', 'html'],
      reportsDirectory: 'test-results/unit/coverage',
    },
  },
});
