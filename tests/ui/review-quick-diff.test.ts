import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  yourTurnContainerControl,
  editorTab,
  promptInput,
  quickInput,
  quickInputRow,
  reviewQuickDiff,
  reviewStatus,
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ reviewPresentation: 'quickDiff' });

async function openFile(window: Parameters<typeof editorTab>[0], name: string): Promise<void> {
  await window.keyboard.press('Control+P');
  await quickInput(window).fill(name);
  await expect(quickInputRow(window, name)).toBeVisible();
  await window.keyboard.press('Enter');
  await expect(editorTab(window, name)).toHaveClass(/active/);
}

async function connectFakeAgent(window: Parameters<typeof editorTab>[0]): Promise<void> {
  await yourTurnContainerControl(window).click();
  const agent = window.getByRole('treeitem', { name: /fake-v1/ });
  await agent.hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
}

test("a completed turn preserves the already-open reviewed file's quick diff", async ({ window, workspace }, testInfo) => {
  await Promise.all([
    writeFile(join(workspace, 'a.ts'), 'one\n2\n3\n4\n5\n6\n7\n8\n9\n10\na before\n'),
    writeFile(join(workspace, 'b.ts'), 'one\n2\n3\n4\n5\n6\n7\n8\n9\n10\nb before\n'),
  ]);
  await openFile(window, 'a.ts');
  await openFile(window, 'b.ts');
  await editorTab(window, 'a.ts').click();
  await expect(editorTab(window, 'a.ts')).toHaveClass(/active/);

  await connectFakeAgent(window);
  await expect(yourTurnContainerControl(window)).toHaveAttribute('aria-selected', 'true');
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill(`review-open ${workspace}`);
  await prompt.press('Enter');

  await expect(reviewStatus(window)).toContainText('1 of 2');
  await expect(editorTab(window, 'a.ts')).toHaveClass(/active/);
  await expect(reviewQuickDiff(window, 'a.ts')).toBeVisible();

  await editorTab(window, 'b.ts').click();
  await expect(editorTab(window, 'b.ts')).toHaveClass(/active/);
  await expect(reviewStatus(window)).toContainText('2 of 2');
  await expect(reviewQuickDiff(window, 'b.ts')).toBeVisible();

  await prompt.fill(`again ${workspace}`);
  await prompt.press('Enter');
  await expect(reviewStatus(window)).toContainText('2 of 2');
  await expect(editorTab(window, 'b.ts')).toHaveClass(/active/);
  await expect(reviewQuickDiff(window, 'b.ts')).toBeVisible();

  await editorTab(window, 'b.ts').click();
  await expect(reviewQuickDiff(window, 'b.ts')).toBeVisible();
  await editorTab(window, 'a.ts').click();
  await expect(editorTab(window, 'a.ts')).toHaveClass(/active/);
  await expect(reviewStatus(window)).toContainText('1 of 2');
  await expect(reviewQuickDiff(window, 'a.ts')).toBeVisible();
  await expect(reviewQuickDiff(window, 'a.ts')).toContainText('1 of 2 changes');

  await window.screenshot({ path: testInfo.outputPath('review-quick-diff-open.png') });
});
