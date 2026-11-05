import {
  yourTurnContainerControl,
  chatUserMessages,
  promptInput,
  sessionUsage,
  sessionUsageDetails
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test('usage has no pointer focus box and retains keyboard focus and native activation', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill('usage');
  await prompt.press('Enter');
  const usage = sessionUsage(window);
  const details = sessionUsageDetails(window);
  await expect(usage).toHaveText('254,264 / 272,000 tokens · $11.93');

  await usage.click();
  await expect(details).toBeVisible();
  await expect(usage).toHaveCSS('outline-style', 'none');
  await details.click();
  await expect(details).toHaveCSS('outline-style', 'none');
  await window.screenshot({ path: testInfo.outputPath('usage-pointer-details.png') });
  await usage.click();
  await expect(details).toBeHidden();

  await prompt.click();
  await prompt.press('Tab');
  await expect(usage).toBeFocused();
  await expect(usage).toHaveCSS('outline-style', 'solid');
  await expect(usage).toHaveCSS('outline-width', '2px');
  await usage.press('Enter');
  await expect(details).toBeVisible();
  await usage.press('Tab');
  await expect(details).toBeFocused();
  await expect(details).toHaveCSS('outline-style', 'solid');
  await expect(details).toHaveCSS('outline-width', '2px');
  await window.screenshot({ path: testInfo.outputPath('usage-keyboard-details.png') });
  await details.press('Escape');
  await expect(details).toBeHidden();
  await expect(usage).toBeFocused();
  await usage.press('Space');
  await expect(details).toBeVisible();
  await usage.press('Space');
  await expect(details).toBeHidden();
  await usage.click();
  await expect(details).toBeVisible();
  await expect(usage).toHaveCSS('outline-style', 'none');
  await expect(chatUserMessages(window)).toHaveCount(1);
});

test('dismissing usage restores the prior prompt focus and caret without overriding keyboard navigation', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill('usage');
  await prompt.press('Enter');
  const usage = sessionUsage(window);
  const details = sessionUsageDetails(window);
  await expect(usage).toBeVisible();
  await prompt.fill('unfinished prompt');
  await prompt.press('Home');
  await prompt.press('ArrowRight');

  await usage.click();
  await expect(details).toBeVisible();
  await details.click();
  await details.press('Escape');
  await expect(details).toBeHidden();
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 1]);

  await usage.click();
  await expect(details).toBeVisible();
  await usage.click();
  await expect(details).toBeHidden();
  await expect(prompt).toBeFocused();
  await window.screenshot({ path: testInfo.outputPath('usage-restored-prompt-focus.png') });

  await prompt.press('Tab');
  await usage.press('Enter');
  await expect(details).toBeVisible();
  await usage.press('Tab');
  await expect(details).toBeFocused();
  await details.press('Escape');
  await expect(usage).toBeFocused();
  await usage.press('Enter');
  await expect(details).toBeVisible();
  await usage.press('Shift+Tab');
  await expect(prompt).toBeFocused();
  await expect(details).toBeHidden();
  await expect(prompt).toHaveValue('unfinished prompt');
  await expect(chatUserMessages(window)).toHaveCount(1);
});
