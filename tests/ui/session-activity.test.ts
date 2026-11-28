import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  activeChildSessions,
  yourTurnContainerControl,
  chooseAgentAction,
  chatStop,
  chatTranscript,
  chatTranscriptScroll,
  chatUserMessages,
  chatViewTitle,
  childTranscript,
  promptInput,
  queuedPrompts,
  sessionTabs
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ agentVersion: 'v2' });

test('subagent row variants align their icons, titles, and Open buttons', async ({ window }) => {
  await yourTurnContainerControl(window).click();
  await chooseAgentAction(window, 'fake-v2', 'New Session');
  const prompt = promptInput(window);
  await prompt.fill('compare delegation chevrons');
  await prompt.press('Enter');
  const transcript = chatTranscript(window);
  const group = transcript.getByRole('button', { name: '1 tool call', exact: true });
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  const layout = (label: string, scope = transcript) => scope.getByText(label, { exact: true }).evaluate((title) => {
    const icon = title.previousElementSibling;
    const open = title.closest('.child-row, div.border-l-2')?.querySelector('button[data-child-entry]');
    if (!icon || !open) { throw new Error('Missing row icon or Open button'); }
    let opacity = 1;
    for (let node: Element | null = title; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return { iconX: icon.getBoundingClientRect().left, titleX: title.getBoundingClientRect().left,
      openX: open.getBoundingClientRect().left, font: getComputedStyle(title).font, opacity };
  });
  const toolX = await group.locator('svg').evaluate((icon) => icon.getBoundingClientRect().left);
  const held = await layout('Inspect fixtures', activeChildSessions(window));
  expect(held.iconX).toBe(toolX);
  expect(held.titleX - held.iconX).toBe(20);
  expect(held.opacity).toBe(1);
  for (const label of ['Inspect logs — Announced', 'Inspect fixtures — Assigned', 'Inspect logs — Finished']) {
    expect(await layout(label), label).toEqual(held);
  }
});

test('Back from child inspection restores the parent reading position and keyboard focus', async ({ window }) => {
  await yourTurnContainerControl(window).click();
  await chooseAgentAction(window, 'fake-v2', 'New Session');
  const prompt = promptInput(window);
  await prompt.fill('inspect child');
  await prompt.press('Enter');
  const transcript = chatTranscript(window);
  await expect(transcript).toContainText('Parent transcript ends here.');
  await expect(chatStop(window)).toBeDisabled();
  const scroll = chatTranscriptScroll(window);
  await expect(transcript.getByText('Parent transcript ends here.', { exact: true })).toBeInViewport();
  await scroll.hover();
  await window.mouse.wheel(0, -700);
  await expect(transcript.getByText('Parent transcript ends here.', { exact: true })).not.toBeInViewport();
  await expect(transcript.getByText('Review fixtures — Announced', { exact: true })).toBeVisible();
  const opener = transcript.getByRole('button', { name: 'Open child transcript' });
  await opener.evaluate((button) => button.focus({ preventScroll: true }));
  const position = await scroll.evaluate((pane) => pane.scrollTop);
  expect(position).toBeGreaterThan(0);
  await opener.press('Enter');
  const child = childTranscript(window);
  await expect(child).toContainText('Child transcript detail.');
  const back = child.getByRole('button', { name: 'Back' });
  await expect(back).toBeFocused();
  await back.press('Enter');
  await expect(child).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(scroll).toHaveJSProperty('scrollTop', position);

  const completion = transcript.getByRole('button', { name: 'Review fixtures — Cancelled' });
  await completion.focus();
  await expect(completion).toBeInViewport();
  const completionPosition = await scroll.evaluate((pane) => pane.scrollTop);
  await completion.press('Enter');
  await expect(child).toContainText('Child transcript detail.');
  await back.press('Enter');
  await expect(completion).toBeFocused();
  await expect(scroll).toHaveJSProperty('scrollTop', completionPosition);
});

test('Stop returns for autonomous foreground work and cancels the active session', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await chooseAgentAction(window, 'fake-v2', 'New Session');
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
  await chooseAgentAction(window, 'fake-v2', 'New Session');
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
