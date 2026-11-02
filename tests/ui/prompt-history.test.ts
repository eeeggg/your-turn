import type { Locator, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acpContainerControl, chatTranscript, chatUserMessages, promptInput, questionSurface, queuedPrompts } from './workbench';
import { expect, test } from './window';

/** The fake agent ends a turn at once for a prompt starting `noted `. */
const oldest = 'noted oldest';
const firstLine = `noted ${'wrapping words '.repeat(20).trim()}`;
const multiline = `${firstLine}\nmiddle line\nlast line`;
const newest = 'noted newest';

async function connectFakeAgent(window: Page): Promise<void> {
  await acpContainerControl(window).click();
  const agent = window.getByRole('treeitem', { name: /fake-v1/ });
  await agent.hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
}

/** The prompt box's text and caret; the webview handles each key before Playwright's press returns. */
function shown(prompt: Locator): Promise<{ value: string; caret: [number, number] }> {
  return prompt.evaluate((input: HTMLTextAreaElement) => ({ value: input.value, caret: [input.selectionStart, input.selectionEnd] }));
}

test('Up and Down move within a wrapped multiline prompt and recall prompts only from its edges, sending nothing', async ({ window }, testInfo) => {
  await connectFakeAgent(window);
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  for (const text of [oldest, multiline, newest]) {
    await prompt.fill(text);
    await prompt.press('Enter');
  }
  await expect(chatUserMessages(window)).toHaveCount(3);

  await prompt.press('ArrowUp');
  expect(await shown(prompt)).toEqual({ value: newest, caret: [0, 0] });
  await prompt.press('ArrowUp');
  expect(await shown(prompt)).toEqual({ value: multiline, caret: [0, 0] });

  await prompt.press('End');
  const firstVisualLineEnd = (await shown(prompt)).caret[0];
  expect(firstVisualLineEnd).toBeGreaterThan(0);
  expect(firstVisualLineEnd).toBeLessThan(firstLine.length);
  await window.screenshot({ path: testInfo.outputPath('wrapped-recall.png') });
  await prompt.press('ArrowUp');
  expect(await shown(prompt)).toEqual({ value: multiline, caret: [0, 0] });
  await prompt.press('ArrowUp');
  expect(await shown(prompt)).toEqual({ value: oldest, caret: [0, 0] });

  await prompt.press('ArrowDown');
  expect(await shown(prompt)).toEqual({ value: oldest, caret: [oldest.length, oldest.length] });
  await prompt.press('ArrowDown');
  expect(await shown(prompt)).toEqual({ value: multiline, caret: [multiline.length, multiline.length] });
  await prompt.press('Home');
  await prompt.press('ArrowDown');
  expect(await shown(prompt)).toEqual({ value: multiline, caret: [multiline.length, multiline.length] });
  await prompt.press('ArrowDown');
  expect(await shown(prompt)).toEqual({ value: newest, caret: [newest.length, newest.length] });
  await prompt.press('ArrowDown');
  expect(await shown(prompt)).toEqual({ value: '', caret: [0, 0] });

  expect(await chatUserMessages(window).count()).toBe(3);
});

test('queued controls preserve inline focus, composer drafts and queue order across agent idle', async ({ window, workspace }, testInfo) => {
  await connectFakeAgent(window);
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill(`question-hidden ${workspace}`);
  await prompt.press('Enter');
  await expect(chatTranscript(window)).toContainText('Question armed.');
  const long = `noted ${'queued wrapping text '.repeat(35)}\nlast line`;
  for (const text of [long, 'noted duplicate', 'noted duplicate']) {
    await prompt.fill(text);
    await prompt.press('Enter');
  }
  await prompt.fill('composer draft');
  const queue = queuedPrompts(window);
  const rows = queue.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  const expand = rows.nth(0).getByRole('button', { name: 'Expand queued prompt', exact: true });
  await expand.focus();
  await expand.press('Enter');
  await expect(rows.nth(0).getByRole('button', { name: 'Collapse queued prompt', exact: true })).toHaveAttribute('aria-expanded', 'true');
  const expanded = await rows.nth(0).locator('.queued-text').evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight }));
  expect(expanded.scroll).toBeLessThanOrEqual(expanded.height + 1);
  await window.screenshot({ path: testInfo.outputPath('expanded-queued-prompt.png') });
  await rows.nth(0).getByRole('button', { name: 'Collapse queued prompt', exact: true }).press('Enter');
  await rows.nth(1).getByRole('button', { name: 'Edit queued prompt', exact: true }).click();
  const laterEditor = rows.nth(1).getByRole('textbox', { name: 'Queued prompt text', exact: true });
  await expect(laterEditor).toBeFocused();
  await laterEditor.fill('unsaved duplicate');
  await rows.nth(2).getByRole('button', { name: 'Cancel queued prompt', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(laterEditor).toHaveValue('unsaved duplicate');
  await laterEditor.press('Escape');
  await expect(rows.nth(1).getByRole('button', { name: 'Edit queued prompt', exact: true })).toBeFocused();
  await expect(rows.nth(1)).toContainText('noted duplicate');
  await rows.nth(1).getByRole('button', { name: 'Edit queued prompt', exact: true }).press('Enter');
  await laterEditor.fill(' \n ');
  await laterEditor.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(prompt).toHaveValue('composer draft');
  await expect(chatUserMessages(window)).toHaveCount(1);
  await rows.nth(0).getByRole('button', { name: 'Edit queued prompt', exact: true }).click();
  const editor = queue.getByRole('textbox', { name: 'Queued prompt text', exact: true });
  await editor.fill('noted edited head');
  await writeFile(join(workspace, 'question.trigger'), 'show');
  const surface = questionSurface(window);
  await expect(surface.getByLabel('Count *', { exact: true })).toBeVisible();
  await surface.getByLabel('Count *', { exact: true }).fill('0');
  await surface.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(chatTranscript(window)).toContainText('Received question response:');
  // Delivery controls disappear only after the agent ends foreground work.
  await expect(queue.getByRole('button', { name: 'Stop send now', exact: true })).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0);
  await expect(editor).toHaveValue('noted edited head');
  await expect(chatUserMessages(window)).toHaveCount(1);
  await expect(prompt).toHaveValue('composer draft');
  await window.screenshot({ path: testInfo.outputPath('editing-queued-prompt-after-idle.png') });
  await editor.press('Enter');
  await expect(queue).toBeHidden();
  await expect(chatUserMessages(window)).toHaveCount(2);
  await expect(chatUserMessages(window).nth(1)).toContainText('noted edited head');
  await expect(prompt).toHaveValue('composer draft');
  await prompt.fill('');
  await prompt.press('ArrowUp');
  await expect(prompt).toHaveValue('noted edited head');
  await prompt.press('ArrowUp');
  await expect(prompt).toHaveValue('noted duplicate');
  await prompt.press('ArrowUp');
  await expect(prompt).toHaveValue('noted duplicate');
  await expect(chatUserMessages(window)).toHaveCount(2);
});
