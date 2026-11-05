import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  yourTurnContainerControl,
  editorTab,
  modifiedReviewEditor,
  promptInput,
  removedReviewLines,
  reviewDiffEditor,
  reviewedFile,
  reviewStatus,
  reviewTitleAction,
  sourceControl
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ workspaceFiles: { 'a.ts': 'one\ntwo\n', 'gone.ts': 'removed content\nsecond removed line\n' } });

test('SCM deletion clicks show removed content and deletion identity while review navigation preserves absence', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill(`review ${workspace}`);
  await prompt.press('Enter');
  await expect(reviewStatus(window)).toContainText('1 of 3');
  await sourceControl(window).click();
  await reviewedFile(window, 'gone.ts').dblclick();
  await expect(reviewDiffEditor(window)).toBeVisible();
  await expect(editorTab(window, 'gone.ts (Deleted) — Review')).toHaveClass(/active/);
  await expect(reviewStatus(window)).toContainText('3 of 3');
  await expect(reviewDiffEditor(window)).toContainText('removed content');
  await expect(removedReviewLines(window).first()).toBeVisible();
  // Native inline diff renders removed lines inside the modified editor's view zones.
  await expect(modifiedReviewEditor(window)).toHaveAttribute('data-uri', /your-turn-review-diff:.*#absent$/);
  await expect(reviewTitleAction(window, 'Keep File')).toBeEnabled();
  await window.screenshot({ path: testInfo.outputPath('deleted-native-review.png') });
  await reviewStatus(window).click();
  await expect(reviewStatus(window)).toContainText('1 of 3');
  await reviewTitleAction(window, 'Previous File Under Review').click();
  await expect(reviewStatus(window)).toContainText('3 of 3');
  await expect(editorTab(window, 'gone.ts (Deleted) — Review')).toHaveClass(/active/);
  await expect(access(join(workspace, 'gone.ts'))).rejects.toThrow();
  await reviewTitleAction(window, 'Keep File').click();
  await expect(reviewStatus(window)).toContainText('1 of 2');
  await expect(editorTab(window, 'gone.ts (Deleted) — Review')).toHaveCount(0);
  await expect(access(join(workspace, 'gone.ts'))).rejects.toThrow();
  expect(await readFile(join(workspace, 'a.ts'), 'utf8')).toBe('one\nTWO\n');
});
