import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acpContainerControl, editorSelection, editorTab, gitDiffEditor, gitOpenChanges, gitOpenFile, gitWorkingTreeChange, hideSecondarySideBar, modifiedReviewEditor, modifiedReviewLine, navigateDiff, plainFileEditor, plainFileTab,
  promptInput, quickInput, quickInputRow, reviewChangeStatus, reviewDiffEditor, reviewLens, reviewStatus,
  reviewTitleAction, sourceControl,
} from './workbench';
import { expect, test } from './window';

const original = Array.from({ length: 30 }, (_, index) => `l${index + 1}\n`).join('');
const actions = ['Previous File Under Review', 'Next File Under Review', 'Undo File', 'Keep File', 'Keep All'];
test.use({ workspaceFiles: { 'm.ts': original }, gitRepository: true });

async function startReview(window: Parameters<typeof editorTab>[0], workspace: string): Promise<void> {
  await acpContainerControl(window).click();
  const agent = window.getByRole('treeitem', { name: /fake-v1/ });
  await agent.hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill(`review-diff ${workspace}`);
  await prompt.press('Enter');
  await expect(reviewStatus(window)).toContainText('1 of 1');
  await expect(reviewDiffEditor(window)).toBeVisible();
}

async function openFile(window: Parameters<typeof editorTab>[0]): Promise<void> {
  await window.keyboard.press('Control+P');
  await quickInput(window).fill('m.ts');
  await expect(quickInputRow(window, 'm.ts')).toBeVisible();
  await quickInputRow(window, 'm.ts').click();
  await expect(editorTab(window, 'm.ts')).toHaveClass(/active/);
}

async function saveFile(window: Parameters<typeof editorTab>[0]): Promise<void> {
  await expect(editorTab(window, 'm.ts')).toHaveClass(/\bdirty\b/);
  await window.keyboard.press('Control+S');
  await expect(editorTab(window, 'm.ts')).not.toHaveClass(/\bdirty\b/);
}

test('native review resolves agent hunks while retaining prior user edits in a Git workspace', async ({ window, workspace }, testInfo) => {
  await hideSecondarySideBar(window).click();
  await writeFile(join(workspace, 'm.ts'), original.replace('l1\n', 'USER edit\n'));
  await openFile(window);
  for (const action of actions) {
    await expect(reviewTitleAction(window, action)).toHaveCount(0);
  }
  await expect(reviewTitleAction(window, 'Open ACP Review')).toHaveCount(0);
  await startReview(window, workspace);
  await expect(reviewLens(window, 'Keep Change').first()).toBeVisible();
  await expect(reviewLens(window, 'Undo Change').first()).toBeVisible();
  await expect(reviewTitleAction(window, 'Keep Change')).toHaveCount(0);
  await expect(reviewTitleAction(window, 'Undo Change')).toHaveCount(0);
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toBeEnabled(); }
  await expect(reviewTitleAction(window, 'Previous File Under Review')).toHaveClass(/codicon-arrow-left/);
  await expect(reviewTitleAction(window, 'Next File Under Review')).toHaveClass(/codicon-arrow-right/);
  await modifiedReviewLine(window, 'AGENT changed').click();
  await navigateDiff(window, 'Next');
  await expect(reviewChangeStatus(window)).toHaveText('Change 2 of 3');
  await navigateDiff(window, 'Previous');
  await expect(reviewChangeStatus(window)).toHaveText('Change 1 of 3');
  await window.screenshot({ path: testInfo.outputPath('review-diff-toolbar.png') });

  await reviewLens(window, 'Keep Change').first().click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(2);
  await reviewLens(window, 'Undo Change', 'Change 1 of 2').click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(1);
  await reviewLens(window, 'Undo Change', 'Change 1 of 1').click();
  await expect(reviewStatus(window)).toContainText('0 of 0');
  await expect(reviewDiffEditor(window)).toHaveCount(0);
  await expect(gitDiffEditor(window)).toHaveCount(0);
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(
    original.replace('l1\n', 'USER edit\n').replace('l2\n', 'AGENT changed\n'),
  );
  await window.screenshot({ path: testInfo.outputPath('review-diff-resolved.png') });

  await openFile(window);
  for (const action of actions) {
    await expect(reviewTitleAction(window, action)).toHaveCount(0);
  }
  await expect(reviewTitleAction(window, 'Open ACP Review')).toHaveCount(0);
  await expect(gitOpenChanges(window)).toBeVisible();
  await gitOpenChanges(window).click();
  await expect(gitDiffEditor(window)).toBeVisible();
  await expect(gitDiffEditor(window)).toContainText('USER edit');
  await expect(gitDiffEditor(window)).toContainText('AGENT changed');
  await expect(reviewTitleAction(window, 'Keep Change')).toHaveCount(0);
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toHaveCount(0); }
  await expect(reviewTitleAction(window, 'Open ACP Review')).toHaveCount(0);
  await window.screenshot({ path: testInfo.outputPath('manual-git-after-review.png') });
});

test('modified review text keeps normal typing, save and undo history after hunk resolution', async ({ window, workspace }, testInfo) => {
  await startReview(window, workspace);
  // CodeLens inserts view zones after the text appears, shifting the click target.
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
  await expect(reviewLens(window, 'Keep Change').last()).toBeVisible();
  await expect(modifiedReviewLine(window, 'l30')).toBeVisible();
  await modifiedReviewLine(window, 'l30').click();
  await window.keyboard.press('End');
  await expect(editorSelection(window)).toHaveText('Ln 30, Col 4');
  await window.keyboard.insertText(' MANUAL');
  await expect(modifiedReviewEditor(window)).toContainText('l30 MANUAL');
  await saveFile(window);
  const agentText = original.replace('l2\n', 'AGENT changed\n')
    .replace('l15\n', 'l15\nAGENT added\n').replace('l28\n', '');
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(agentText.replace('l30\n', 'l30 MANUAL\n'));

  await window.keyboard.press('Control+Z');
  await saveFile(window);
  await expect(modifiedReviewEditor(window)).not.toContainText('MANUAL');
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(agentText);
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);

  await reviewLens(window, 'Keep Change').last().click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(2);
  await expect(reviewChangeStatus(window)).toHaveText('Change 1 of 2');
  await reviewLens(window, 'Undo Change', 'Change 1 of 2').click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(1);
  await expect(reviewChangeStatus(window)).toHaveText('Change 1 of 1');
  await reviewLens(window, 'Undo Change', 'Change 1 of 1').click();
  await expect(reviewStatus(window)).toContainText('0 of 0');
  await expect(reviewDiffEditor(window)).toHaveCount(0);
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(original.replace('l28\n', ''));

  await openFile(window);
  await window.keyboard.press('Control+Z');
  await saveFile(window);
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(
    original.replace('l15\n', 'l15\nAGENT added\n').replace('l28\n', ''),
  );
  await expect(reviewStatus(window)).toContainText('0 of 0');
  await expect(reviewDiffEditor(window)).toHaveCount(0);
  await window.screenshot({ path: testInfo.outputPath('review-undo-after-resolution.png') });
});

test('review header keeps its tools during a turn and navigates files after the turn ends', async ({ window, workspace }, testInfo) => {
  await hideSecondarySideBar(window).click();
  await startReview(window, workspace);
  const prompt = promptInput(window);
  await prompt.fill('hold turn');
  await prompt.press('Enter');
  await expect(quickInputRow(window, 'Allow')).toBeVisible();
  for (const action of actions) {
    await expect(reviewTitleAction(window, action)).toBeVisible();
    await expect(reviewTitleAction(window, action)).toBeDisabled();
  }
  await window.screenshot({ path: testInfo.outputPath('review-toolbar-during-turn.png') });
  await gitOpenFile(window).click();
  await expect(plainFileEditor(window)).toContainText('AGENT changed');
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toHaveCount(0); }
  await expect(reviewTitleAction(window, 'Open ACP Review')).toBeVisible();
  await expect(reviewTitleAction(window, 'Open ACP Review')).toBeDisabled();
  await quickInputRow(window, 'Allow').click();
  await expect(prompt).toBeEnabled();
  await expect(reviewDiffEditor(window)).toBeVisible();
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toBeEnabled(); }

  await Promise.all([
    writeFile(join(workspace, 'a.ts'), 'one\n2\n3\n4\n5\n6\n7\n8\n9\n10\na before\n'),
    writeFile(join(workspace, 'b.ts'), 'one\n2\n3\n4\n5\n6\n7\n8\n9\n10\nb before\n'),
  ]);
  await prompt.fill(`review-open ${workspace}`);
  await prompt.press('Enter');
  await expect(reviewStatus(window)).toContainText('1 of 3');
  await expect(reviewTitleAction(window, 'Next File Under Review')).toBeEnabled();
  await reviewTitleAction(window, 'Next File Under Review').click();
  await expect(reviewStatus(window)).toContainText('2 of 3');
  await expect(modifiedReviewEditor(window)).toContainText('a after');
  await reviewTitleAction(window, 'Next File Under Review').click();
  await expect(reviewStatus(window)).toContainText('3 of 3');
  await expect(modifiedReviewEditor(window)).toContainText('b after');
  await reviewTitleAction(window, 'Previous File Under Review').click();
  await expect(reviewStatus(window)).toContainText('2 of 3');
  await expect(modifiedReviewEditor(window)).toContainText('a after');
  await reviewTitleAction(window, 'Previous File Under Review').click();
  await expect(reviewStatus(window)).toContainText('1 of 3');
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
  await reviewLens(window, 'Keep Change', 'Change 1 of 3').click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(2);
  await reviewLens(window, 'Keep Change', 'Change 1 of 2').click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(1);
  await reviewLens(window, 'Keep Change', 'Change 1 of 1').click();
  await expect(reviewStatus(window)).toContainText('1 of 2');
  await expect(modifiedReviewEditor(window)).toContainText('a after');
  await reviewTitleAction(window, 'Undo File').click();
  await expect(reviewStatus(window)).toContainText('1 of 1');
  await expect(modifiedReviewEditor(window)).toContainText('b after');
  await reviewTitleAction(window, 'Keep File').click();
  await expect(reviewStatus(window)).toContainText('0 of 0');
  await expect(reviewDiffEditor(window)).toHaveCount(0);
  await openFile(window);
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toHaveCount(0); }
  await expect(reviewTitleAction(window, 'Open ACP Review')).toHaveCount(0);
});

test('Git Open File during unresolved review opens the real file without resolving changes', async ({ window, workspace }, testInfo) => {
  await hideSecondarySideBar(window).click();
  await startReview(window, workspace);
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
  await modifiedReviewLine(window, 'AGENT changed').click();
  await expect(gitOpenFile(window)).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath('before-open-file.png') });
  await gitOpenFile(window).click();
  await expect(plainFileEditor(window)).toBeVisible();
  await expect(plainFileEditor(window)).toContainText('AGENT changed');
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toHaveCount(0); }
  await expect(reviewTitleAction(window, 'Open ACP Review')).toBeEnabled();
  await expect(reviewStatus(window)).toContainText('1 of 1');
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(
    original.replace('l2\n', 'AGENT changed\n').replace('l15\n', 'l15\nAGENT added\n').replace('l28\n', ''),
  );
  await window.screenshot({ path: testInfo.outputPath('after-open-file.png') });
});

test('explicit review entry reopens the first unresolved file without taking over normal editing', async ({ window, workspace }, testInfo) => {
  await hideSecondarySideBar(window).click();
  await startReview(window, workspace);
  await Promise.all([
    writeFile(join(workspace, 'a.ts'), 'one\n2\n3\n4\n5\n6\n7\n8\n9\n10\na before\n'),
    writeFile(join(workspace, 'b.ts'), 'one\n2\n3\n4\n5\n6\n7\n8\n9\n10\nb before\n'),
  ]);
  await promptInput(window).fill(`review-open ${workspace}`);
  await promptInput(window).press('Enter');
  await expect(reviewStatus(window)).toContainText('1 of 3');
  await reviewTitleAction(window, 'Next File Under Review').click();
  await expect(reviewStatus(window)).toContainText('2 of 3');
  await reviewTitleAction(window, 'Next File Under Review').click();
  await expect(modifiedReviewEditor(window)).toContainText('b after');
  await modifiedReviewLine(window, 'b after').click();
  await gitOpenFile(window).click();
  await expect(plainFileEditor(window)).toContainText('b after');
  for (const action of actions) { await expect(reviewTitleAction(window, action)).toHaveCount(0); }
  await plainFileEditor(window).getByText('one', { exact: true }).click();
  await window.keyboard.press('End');
  await window.keyboard.insertText(' MANUAL');
  await expect(plainFileTab(window, 'b.ts')).toHaveClass(/\bdirty\b/);
  await window.keyboard.press('Control+S');
  await expect(plainFileTab(window, 'b.ts')).not.toHaveClass(/\bdirty\b/);
  await expect(plainFileEditor(window)).toContainText('one MANUAL');
  expect(await readFile(join(workspace, 'b.ts'), 'utf8')).toBe('one MANUAL\n2\n3\n4\n5\n6\n7\n8\n9\n10\nb after\n');
  await window.keyboard.press('Control+Z');
  await expect(plainFileTab(window, 'b.ts')).toHaveClass(/\bdirty\b/);
  await window.keyboard.press('Control+S');
  await expect(plainFileTab(window, 'b.ts')).not.toHaveClass(/\bdirty\b/);
  await expect(plainFileEditor(window)).not.toContainText('MANUAL');
  expect(await readFile(join(workspace, 'b.ts'), 'utf8')).toBe('one\n2\n3\n4\n5\n6\n7\n8\n9\n10\nb after\n');
  await window.screenshot({ path: testInfo.outputPath('normal-editor-during-review.png') });

  await reviewTitleAction(window, 'Open ACP Review').click();
  await expect(modifiedReviewEditor(window)).toContainText('AGENT changed');
  await expect(reviewStatus(window)).toContainText('1 of 3');
  await expect(reviewTitleAction(window, 'Open ACP Review')).toHaveCount(0);
  await modifiedReviewLine(window, 'AGENT changed').click();
  await window.keyboard.press('Control+W');
  await expect(editorTab(window, 'm.ts — ACP Review')).toHaveCount(0);
  await expect(plainFileEditor(window)).toContainText('b after');
  await reviewTitleAction(window, 'Open ACP Review').click();
  await expect(modifiedReviewEditor(window)).toContainText('AGENT changed');
  await reviewTitleAction(window, 'Keep File').click();
  await expect(reviewStatus(window)).toContainText('of 2');

  await writeFile(join(workspace, 'other.ts'), 'unrelated\n');
  await window.keyboard.press('Control+P');
  await quickInput(window).fill('other.ts');
  await quickInputRow(window, 'other.ts').click();
  await expect(plainFileEditor(window)).toContainText('unrelated');
  await reviewTitleAction(window, 'Open ACP Review').click();
  await expect(modifiedReviewEditor(window)).toContainText('a after');
  await expect(reviewStatus(window)).toContainText('1 of 2');
  await window.screenshot({ path: testInfo.outputPath('explicit-review-first-unresolved.png') });
});

test('Git comparisons retain only native controls while ACP review is unresolved', async ({ window, workspace }, testInfo) => {
  await hideSecondarySideBar(window).click();
  await startReview(window, workspace);
  await modifiedReviewLine(window, 'AGENT changed').click();
  await gitOpenFile(window).click();
  await expect(plainFileEditor(window)).toContainText('AGENT changed');
  await sourceControl(window).click();
  await gitWorkingTreeChange(window, 'm.ts').click();
  await expect(gitDiffEditor(window)).toBeVisible();
  await expect(gitDiffEditor(window)).toContainText('AGENT changed');
  for (const action of [...actions, 'Open ACP Review']) { await expect(reviewTitleAction(window, action)).toHaveCount(0); }
  await expect(reviewStatus(window)).toContainText('1 of 1');
  await window.screenshot({ path: testInfo.outputPath('git-comparison-during-review.png') });
  await gitOpenFile(window).click();
  await expect(plainFileEditor(window)).toContainText('AGENT changed');
  await reviewTitleAction(window, 'Open ACP Review').click();
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
  await expect(reviewStatus(window)).toContainText('1 of 1');
});
