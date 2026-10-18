import { defineConfig } from 'vitest/config';

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
          include: ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'webview',
          // Each test builds its own jsdom window, so the runner itself needs no DOM.
          environment: 'node',
          include: ['tests/webview/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // These only run as the bundle in the webview suite, which is not measured.
      exclude: ['src/webview/chat.ts', 'src/webview/Main.tsx', 'src/webview/VsCodeApi.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
