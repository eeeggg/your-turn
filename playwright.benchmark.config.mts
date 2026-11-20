import { defineConfig } from '@playwright/test';

export default defineConfig<{ desktopDiagnostics: boolean }>({
  testDir: 'tests/ui',
  testMatch: '*.benchmark.ts',
  outputDir: 'test-results/benchmark-diagnostics',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: { desktopDiagnostics: false },
});
