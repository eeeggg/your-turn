import {
  yourTurnContainerControl,
  agentsViewRow,
  chatCompactions,
  chatTranscript,
  promptInput,
  quickInputRow
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ listsSessions: true, compaction: true });

test('loaded and live compactions retain their transcript position and user-controlled summary expansion', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await agentsViewRow(window, 'Compaction session').click();
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
