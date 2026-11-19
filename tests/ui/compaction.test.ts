import {
  yourTurnContainerControl,
  agentsViewRow,
  chatCompactions,
  chatTranscript,
  chatTranscriptScroll,
  jumpToEnd,
  promptInput,
  selectListedSession,
  quickInputRow
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ listsSessions: true, compaction: true });

test('tool-call status batches follow the transcript until the user scrolls up', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, 'Compaction session');
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill('stream-tools');
  await prompt.press('Enter');
  await expect(quickInputRow(window, 'Stream first batch')).toBeVisible();
  const scroll = chatTranscriptScroll(window);
  const bottom = () => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  const atBottom = () => scroll.evaluate((element) => new Promise<void>((resolve) => {
    const check = () => {
      if (element.scrollHeight - element.clientHeight - element.scrollTop <= 2) {
        element.removeEventListener('scroll', check);
        resolve();
      }
    };
    element.addEventListener('scroll', check);
    check();
  }));
  await atBottom();
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await quickInputRow(window, 'Stream first batch').click();
  const transcript = chatTranscript(window);
  await expect(transcript).toContainText('Batch 1 finished.');
  await expect(quickInputRow(window, 'Stream second batch')).toBeVisible();
  await atBottom();
  await expect(transcript.getByText('Batch 1 finished.', { exact: true })).toBeInViewport();
  expect(await bottom()).toBeLessThanOrEqual(2);

  await scroll.hover();
  await window.mouse.wheel(0, -700);
  await expect(jumpToEnd(window)).toBeVisible();
  const readingPosition = await scroll.evaluate((element) => element.scrollTop);
  await quickInputRow(window, 'Stream second batch').click();
  await expect(transcript).toContainText('Batch 2 finished.');
  await expect(quickInputRow(window, 'Finish tool stream')).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(readingPosition);
  expect(await bottom()).toBeGreaterThan(100);
  await expect(jumpToEnd(window)).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath('tool-stream-reading-position.png') });
  await quickInputRow(window, 'Finish tool stream').click();
});

test('loaded and live compactions retain their transcript position and user-controlled summary expansion', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, 'Compaction session');
  const compactions = chatCompactions(window);
  const historical = compactions.nth(0);
  await expect(historical.locator('summary')).toHaveText('Compaction completed');
  await expect(historical.locator('..')).toHaveAttribute('id', 'messages');
  await expect(historical).not.toHaveAttribute('open');
  await historical.locator('summary').click();
  await expect(historical.locator('.compaction-content')).toHaveText('Historical summary.');
  await expect(historical.locator('[data-streamdown="strong"]')).toHaveText('summary');
  await historical.locator('summary').click();

  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill('compact');
  await prompt.press('Enter');
  const live = compactions.nth(1);
  const content = live.locator('.compaction-content');
  await expect(quickInputRow(window, 'Continue summary')).toBeVisible();
  await expect(live.locator('summary')).toHaveText('Compacting…');
  await expect(live.locator('..')).toHaveClass(/\bturn\b/);
  await expect(content).toBeVisible();
  await expect(content).toHaveText('Live summary.');
  await expect(content.locator('[data-streamdown="strong"]')).toHaveText('summary');
  await expect(chatTranscript(window)).toContainText('After live compaction.');
  const text = await chatTranscript(window).textContent() ?? '';
  const positions = ['Compaction completed', 'Historical question', 'Historical answer', 'Before live compaction.', 'Compacting…', 'After live compaction.']
    .map((part) => text.indexOf(part));
  expect(positions.every((position, index) => position >= 0 && position > (positions[index - 1] ?? -1))).toBe(true);
  await live.locator('summary').click();
  await expect(live).not.toHaveAttribute('open');
  await quickInputRow(window, 'Continue summary').click();
  await expect(quickInputRow(window, 'Complete compaction')).toBeVisible();
  await expect(content).toHaveText('Live summary. More detail.');
  await expect(content).toBeHidden();
  await live.locator('summary').click();
  await expect(content).toBeVisible();
  await quickInputRow(window, 'Complete compaction').click();
  await expect(live.locator('summary')).toHaveText(/^Compaction completed in [1-9]\d*s$/);
  await expect(content).toBeHidden();
  await live.locator('summary').click();
  await expect(content).toBeVisible();
  await expect(content).toHaveText('Live summary. More detail.');
  await expect(compactions).toHaveCount(2);
  await expect(chatTranscript(window)).toContainText('Turn finished.');
  await expect(chatTranscript(window)).toHaveText(/Before live compaction\.[\s\S]*Compaction completed[\s\S]*After live compaction\.[\s\S]*Turn finished\./);
  await window.screenshot({ path: testInfo.outputPath('compaction-replay-and-live.png') });
});
