import type { Locator, Page } from '@playwright/test';
import { acpContainerControl, chatUserMessages, promptInput } from './workbench';
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
