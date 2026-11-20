import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const batch = process.env['BENCHMARK_BATCH_DIR'];
if (!batch) { throw new Error('Benchmark output directory is not prepared; use npm run benchmark'); }

export default defineConfig<{ desktopDiagnostics: boolean }>({
  testDir: 'tests/ui',
  testMatch: '*.benchmark.ts',
  outputDir: join(batch, 'diagnostics'),
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: { desktopDiagnostics: false },
});
