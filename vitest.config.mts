import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'webview',
          // Each test builds its own jsdom window, so the runner itself needs no DOM.
          environment: 'node',
          include: ['tests/webview/**/*.test.ts'],
        },
      },
    ],
  },
});
