import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import {
  agentsViewRow, chatTranscript, chatUserMessages, measureTranscriptSwitch, promptInput,
  selectListedSession, sessionTabs, yourTurnContainerControl,
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ listsSessions: true, fakeAgentEnv: { ACP_TEST_TAB_SWITCH_BENCHMARK: '1' } });

const fixture = {
  short: { tab: 'Short benchmark session', marker: 'Short benchmark transcript complete.', turns: 4 },
  long: { tab: 'Long benchmark session', marker: 'Long benchmark transcript complete.', turns: 120 },
  reallyLong: { tab: 'Really Long session (benchmark)', marker: 'Really Long benchmark transcript complete.', turns: 720 },
};
const repeatCount = 9;

async function benchmark(window: Page, id: string, size: 'long' | 'reallyLong', outbound: string, inbound: string) {
  const long = fixture[size];
  const results = resolve(__dirname, '../../test-results');
  const editor = JSON.parse(await readFile(join(results, 'ui-editor.json'), 'utf8')) as { version: string; commit: string };
  const dist = join(results, 'ui-extension', 'dist');
  const build = createHash('sha256');
  for (const file of ['extension.js', 'webview/chat.js', 'webview/chat.css', 'test/fixtures/fakeAgent-v1.js']) {
    build.update(await readFile(join(dist, file)));
  }

  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  for (const { tab, marker, turns } of [long, fixture.short]) {
    await selectListedSession(window, tab);
    await expect(chatTranscript(window).getByText(marker, { exact: true })).toBeVisible();
    await expect(chatUserMessages(window)).toHaveCount(turns);
    await expect(promptInput(window)).toBeEnabled();
  }

  const samples: Record<'shortToLong' | 'longToShort', number[]> = { shortToLong: [], longToShort: [] };
  for (let round = 0; round <= repeatCount; round++) {
    for (const direction of ['shortToLong', 'longToShort'] as const) {
      const target = direction === 'shortToLong' ? long : fixture.short;
      samples[direction].push(await measureTranscriptSwitch(window, target.tab, target.marker));
      await expect(sessionTabs(window).getByRole('tab', { name: target.tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    }
  }
  const summarize = ([firstMs, ...repeatMs]: number[]) => ({
    firstMs, repeatMs, repeatMedianMs: [...repeatMs].sort((a, b) => a - b)[Math.floor(repeatCount / 2)],
  });
  const output = {
    metric: 'webview click to target transcript DOM update',
    environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    vscode: { version: editor.version, commit: editor.commit },
    buildSha256: build.digest('hex'),
    workload: { id, short: fixture.short, [size]: long },
    [outbound]: summarize(samples.shortToLong),
    [inbound]: summarize(samples.longToShort),
  };
  const outputRoot = join(results, 'benchmarks');
  await mkdir(outputRoot, { recursive: true });
  const run = await mkdtemp(join(outputRoot, 'tab-switch-'));
  const path = join(run, 'samples.json');
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Tab-switch samples: ${path}`);
}

test('measures Short ↔ Long', async ({ window }) => {
  await benchmark(window, 'tab-switch-v1', 'long', 'shortToLong', 'longToShort');
});

test('measures Short ↔ Really Long', async ({ window }) => {
  await benchmark(window, 'tab-switch-really-long-v1', 'reallyLong', 'shortToReallyLong', 'reallyLongToShort');
});
