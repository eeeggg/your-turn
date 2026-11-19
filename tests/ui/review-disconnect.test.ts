import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentMoreActions, agentsViewRow, chatStop, chatTranscript, chooseAgentAction, editorTab,
  modifiedReviewEditor, plainFileEditor, plainFileInput, plainFileTab, promptInput,
  quickInput, quickInputRow, reviewDiffEditor, reviewLens, reviewStatus, reviewTabs,
  reviewTitleAction, sessionTabs, yourTurnContainerControl,
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

const original = Array.from({ length: 30 }, (_, index) => `l${index + 1}\n`).join('');
const agentText = original.replace('l2\n', 'AGENT changed\n').replace('l15\n', 'l15\nAGENT added\n').replace('l28\n', '');
test.use({ controlledNativeDiff: true, loadsSessions: true, workspaceFiles: { 'm.ts': original, 'other.ts': 'unrelated\n' } });

test.describe('mixed-agent review', () => {
  test.use({ mixedAgents: true, reviewPresentation: 'diffEditor', controlledNativeDiff: false });

  test('opens a completed background review only when its tab is selected', async ({ window, workspace }, testInfo) => {
    await window.keyboard.press('Control+P');
    await quickInput(window).fill('other.ts');
    await quickInputRow(window, 'other.ts').click();
    await expect(plainFileTab(window, 'other.ts')).toHaveClass(/active/);
    await yourTurnContainerControl(window).click();

    const prompt = promptInput(window);
    const transcript = chatTranscript(window);
    const tabs = sessionTabs(window).getByRole('tab');
    const send = async (text: string) => {
      await expect(prompt).toBeEnabled();
      await prompt.fill(text);
      await prompt.press('Enter');
    };
    await chooseAgentAction(window, 'fake-v1', 'New Session');
    await expect(tabs).toHaveCount(1);
    await send(`question-hidden ${workspace}`);
    await expect(transcript).toContainText('Question armed.');

    await chooseAgentAction(window, 'fake-v1', 'New Session');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await send(`review-after-trigger ${workspace}`);
    await expect(transcript).toContainText('Background review armed.');

    await chooseAgentAction(window, 'fake-v2', 'New Session');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await send(`autonomous ${workspace}`);
    await expect(transcript).toContainText('Initial foreground complete.');
    await expect(chatStop(window)).toBeDisabled();
    await writeFile(join(workspace, 'foreground.trigger'), 'start');
    await expect(transcript).toContainText('Autonomous foreground running.');
    for (const index of [0, 1, 2]) { await expect(tabs.nth(index)).toHaveAccessibleDescription(/Actively working/); }

    await writeFile(join(workspace, 'background-review.trigger'), 'complete');
    await expect(tabs.nth(1)).toHaveAccessibleDescription(/Finished while unselected/);
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(chatStop(window)).toBeEnabled();
    await expect(transcript).not.toContainText('Background review armed.');
    await expect(plainFileTab(window, 'other.ts')).toHaveClass(/active/);
    await expect(reviewTabs(window)).toHaveCount(0);

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(transcript).toContainText('Background review armed.');
    await expect(modifiedReviewEditor(window)).toContainText('AGENT changed');
    await expect(reviewTabs(window)).toHaveCount(1);
    for (const index of [0, 2]) { await expect(tabs.nth(index)).toHaveAccessibleDescription(/Actively working/); }
    await window.screenshot({ path: testInfo.outputPath('mixed-agent-deferred-review.png') });
  });
});

test('disconnect retires a pending native review without losing unsaved editing or resolving changes', async ({ window, workspace, nativeDiffControl }, testInfo) => {
  if (!nativeDiffControl) { throw new Error('Native diff control is not enabled'); }
  await window.keyboard.press('Control+P');
  await quickInput(window).fill('other.ts');
  await quickInputRow(window, 'other.ts').click();
  await expect(plainFileTab(window, 'other.ts')).toHaveClass(/active/);
  await yourTurnContainerControl(window).click();
  await chooseAgentAction(window, 'fake-v1', 'New Session');
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
    await chooseAgentAction(window, 'fake-v1', 'Disconnect Agent');
    await expect(promptInput(window)).toBeDisabled();
    await agentsViewRow(window, 'fake-v1').hover();
    await agentMoreActions(window, 'fake-v1').click();
    await expect(quickInputRow(window, 'Connect to Agent')).toBeVisible();
    await window.keyboard.press('Escape');
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

  await expect(sessionTabs(window).getByRole('tab')).toHaveCount(1);
  await sessionTabs(window).getByRole('tab').click();
  await expect(promptInput(window)).toBeEnabled();
  await expect(reviewStatus(window)).toContainText('1 of 1');
  await reviewTitleAction(window, 'Open Review').click();
  await expect(modifiedReviewEditor(window)).toContainText('UNSAVED l1');
  await expect(reviewLens(window, 'Keep Change')).toHaveCount(3);
});
