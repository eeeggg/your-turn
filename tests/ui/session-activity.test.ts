import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  yourTurnContainerControl,
  chooseAgentAction,
  chatStop,
  chatTranscript,
  chatUserMessages,
  chatViewTitle,
  promptInput,
  queuedPrompts,
  sessionTabs
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ agentVersion: 'v2' });

test('Stop returns for autonomous foreground work and cancels the active session', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await chooseAgentAction(window, 'fake-v2', 'Connect to Agent');
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  const tabs = sessionTabs(window);
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await expect(chatViewTitle(window)).toHaveText('Chat FakeAgent');
  await prompt.fill(`autonomous ${workspace}`);
  await prompt.press('Enter');
  await expect(chatTranscript(window)).toContainText('Initial foreground complete.');
  await expect(chatStop(window)).toBeDisabled();
  await expect(tabs.locator('.activity-dot')).toHaveCount(0);
  await writeFile(join(workspace, 'foreground.trigger'), 'start');
  await expect(chatTranscript(window)).toContainText('Autonomous foreground running.');
  await prompt.hover();
  await expect(chatStop(window)).toBeEnabled();
  await expect(tabs.getByLabel('Actively working')).toBeVisible();
  await prompt.fill('steer-check');
  await prompt.press('Enter');
  await prompt.fill('switch model-b');
  await prompt.press('Enter');
  const queue = queuedPrompts(window);
  const rows = queue.locator('.queued-prompt');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('button', { name: 'Steer now', exact: true })).toBeVisible();
  await expect(rows.nth(0).getByRole('button', { name: 'Stop and send now', exact: true })).toBeVisible();
  const queuedText = rows.nth(0).getByRole('button', { name: 'Edit queued prompt', exact: true });
  await queuedText.focus();
  await queuedText.press('Enter');
  const editor = rows.nth(0).getByRole('textbox', { name: 'Queued prompt text', exact: true });
  await expect(editor).toBeFocused();
  const rowBounds = await rows.nth(0).boundingBox();
  const editorBounds = await editor.boundingBox();
  expect(rowBounds).not.toBeNull();
  expect(editorBounds).not.toBeNull();
  if (!rowBounds || !editorBounds) { throw new Error('Queued prompt editor has no rendered bounds'); }
  expect(editorBounds.width).toBeGreaterThan(rowBounds.width - 35);
  await window.screenshot({ path: testInfo.outputPath('queued-prompt-editor.png') });
  await editor.press('Escape');
  await expect(queuedText).toBeFocused();
  await queuedText.press('Space');
  await expect(editor).toBeFocused();
  await editor.press('Escape');
  await expect(rows.nth(1).getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0);
  await rows.nth(0).getByRole('button', { name: 'Steer now', exact: true }).click();
  await expect(chatTranscript(window)).toContainText('Steering received without cancellation.');
  await expect(rows).toHaveCount(1);
  await expect(chatUserMessages(window)).toHaveCount(2);
  await expect(chatStop(window)).toBeEnabled();
  await expect(tabs.getByLabel('Actively working')).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath('autonomous-stop.png') });
  await rows.nth(0).getByRole('button', { name: 'Stop and send now', exact: true }).click();
  await expect(chatTranscript(window)).toContainText('cancel-ack');
  await expect(chatUserMessages(window)).toHaveCount(3);
  await expect(queue).toHaveCount(0);
  await expect(chatStop(window)).toBeDisabled();
});

test('picker-row cancel supports keyboard activation during autonomous work without a hover tooltip', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await chooseAgentAction(window, 'fake-v2', 'Connect to Agent');
  const prompt = promptInput(window);
  const stop = chatStop(window);
  await expect(prompt).toBeEnabled();
  await expect(stop).toBeVisible();
  await expect(stop).toBeDisabled();
  await expect(stop).not.toHaveAttribute('title');
  await prompt.fill(`autonomous ${workspace}`);
  await prompt.press('Enter');
  await expect(chatTranscript(window)).toContainText('Initial foreground complete.');
  await expect(stop).toBeDisabled();
  await writeFile(join(workspace, 'foreground.trigger'), 'start');
  await expect(chatTranscript(window)).toContainText('Autonomous foreground running.');
  await expect(stop).toBeEnabled();
  const stopBounds = await stop.boundingBox();
  const promptBounds = await prompt.boundingBox();
  expect(stopBounds).not.toBeNull();
  expect(promptBounds).not.toBeNull();
  if (!stopBounds || !promptBounds) { throw new Error('Cancel or prompt has no rendered bounds'); }
  expect(stopBounds.y + stopBounds.height).toBeLessThanOrEqual(promptBounds.y);
  expect(Math.abs(stopBounds.x + stopBounds.width - promptBounds.x - promptBounds.width)).toBeLessThanOrEqual(2);
  await stop.focus();
  await expect(stop).toBeFocused();
  await window.screenshot({ path: testInfo.outputPath('picker-row-cancel.png') });
  await stop.press('Enter');
  await expect(chatTranscript(window)).toContainText('cancel-ack');
  await expect(stop).toBeDisabled();
});
