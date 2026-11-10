import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentsViewRow, connectAgentAction, disconnectAgentAction, editorTab,
  modifiedReviewEditor, plainFileEditor, plainFileInput, plainFileTab, promptInput,
  quickInput, quickInputRow, reviewDiffEditor, reviewLens, reviewStatus, reviewTabs,
  reviewTitleAction, yourTurnContainerControl,
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

const original = Array.from({ length: 30 }, (_, index) => `l${index + 1}\n`).join('');
const agentText = original.replace('l2\n', 'AGENT changed\n').replace('l15\n', 'l15\nAGENT added\n').replace('l28\n', '');
test.use({ controlledNativeDiff: true, workspaceFiles: { 'm.ts': original, 'other.ts': 'unrelated\n' } });

test('disconnect retires a pending native review without losing unsaved editing or resolving changes', async ({ window, workspace, nativeDiffControl }, testInfo) => {
  if (!nativeDiffControl) { throw new Error('Native diff control is not enabled'); }
  await window.keyboard.press('Control+P');
  await quickInput(window).fill('other.ts');
  await quickInputRow(window, 'other.ts').click();
  await expect(plainFileTab(window, 'other.ts')).toHaveClass(/active/);
  await yourTurnContainerControl(window).click();
  const agent = agentsViewRow(window, 'fake-v1');
  await agent.hover();
  await connectAgentAction(window).click();
  await expect(promptInput(window)).toBeEnabled();
  await promptInput(window).fill(`review-diff ${workspace}`);
  await promptInput(window).press('Enter');
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
  await window.keyboard.press('Control+P');
  await quickInput(window).fill('m.ts');
  await quickInputRow(window, 'm.ts').click();
  await expect(plainFileEditor(window)).toContainText('AGENT changed');
  await editorTab(window, 'm.ts — Review').click({ button: 'middle' });
  await expect(reviewTabs(window)).toHaveCount(0);
  await plainFileInput(window).press('Control+Home');
  await window.keyboard.type('UNSAVED ');
  await expect(plainFileTab(window, 'm.ts')).toHaveClass(/\bdirty\b/);
  await nativeDiffControl.request('arm', 'armed');
  await reviewTitleAction(window, 'Open Review').click();
  await nativeDiffControl.request('pending', 'pending');
  try {
    await agent.hover();
    await disconnectAgentAction(window).click();
    await expect(promptInput(window)).toBeDisabled();
    await agent.hover();
    await expect(connectAgentAction(window)).toBeVisible();
    await plainFileTab(window, 'other.ts').click();
    await expect(plainFileEditor(window)).toContainText('unrelated');
  } finally {
    await nativeDiffControl.request('release', 'settled');
  }
  await expect(reviewTabs(window)).toHaveCount(0);
  await expect(reviewDiffEditor(window)).toHaveCount(0);
  await expect(plainFileTab(window, 'other.ts')).toHaveCount(1);
  await expect(plainFileTab(window, 'm.ts')).toHaveClass(/\bdirty\b/);
  await plainFileTab(window, 'other.ts').click();
  await plainFileInput(window).press('Control+Home');
  await window.keyboard.type('typed-in-other ');
  await expect(plainFileEditor(window)).toContainText('typed-in-other unrelated');
  await plainFileTab(window, 'm.ts').click();
  await expect(plainFileEditor(window)).toContainText('UNSAVED l1');
  await expect(plainFileEditor(window)).not.toContainText('typed-in-other');
  expect(await readFile(join(workspace, 'm.ts'), 'utf8')).toBe(agentText);
  await window.screenshot({ path: testInfo.outputPath('review-disconnect-unsaved.png') });

  await agent.hover();
  await connectAgentAction(window).click();
  await expect(promptInput(window)).toBeEnabled();
  await expect(reviewStatus(window)).toContainText('1 of 1');
  await reviewTitleAction(window, 'Open Review').click();
  await expect(modifiedReviewEditor(window)).toContainText('UNSAVED l1');
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
});
