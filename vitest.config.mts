import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
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
      include: ['src/**/*.ts'],
      // chat.ts only runs as the bundle in the webview suite, which is not measured.
      exclude: ['src/test/**', 'src/webview/chat.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
