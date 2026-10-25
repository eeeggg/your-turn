import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/ui',
  testMatch: '*.test.ts',
  outputDir: 'test-results/ui',
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
});
