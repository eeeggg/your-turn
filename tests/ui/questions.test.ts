import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acpChatWebview, acpContainerControl, chatTranscript, explorerControl, nativeQuestionNotification, pendingQuestions, promptInput, questionNotification, questionRecords, questionSurface, sessionUsage, sessionUsageDetails } from './workbench';
import { expect, test } from './window';

test('a question preserves prompt composition and local Escape restores its selection', async ({ window }, testInfo) => {
  await acpContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill('unfinished prompt');
  await prompt.press('Home');
  await prompt.press('ArrowRight');
  await prompt.press('Shift+ArrowRight');
  const message: ExtensionToWebviewMessage = { type: 'questions', questions: [{
    interactionId: 'desktop-question', agentName: 'Schema Agent', sessionId: null, message: 'Please review these settings.', title: 'Settings', description: null, draft: null,
    fields: [{ name: 'answer', kind: 'text', title: 'Answer', description: null, required: false, choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null }],
  }] };
  // Exercise the shipped webview's presentation boundary, not an advertised ACP request.
  await prompt.evaluate((input, message) => input.ownerDocument.defaultView?.dispatchEvent(new MessageEvent('message', { data: message })), message);
  await expect(questionNotification(window)).toBeVisible();
  await expect(questionSurface(window)).toBeHidden();
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 2]);
  await questionNotification(window).click();
  const surface = questionSurface(window);
  await expect(surface).toBeVisible();
  await expect(surface.getByRole('heading', { name: 'Settings' })).toBeFocused();
  await surface.getByLabel('Answer', { exact: true }).fill('saved draft');
  await window.screenshot({ path: testInfo.outputPath('question-open-during-composition.png') });
  await surface.getByLabel('Answer', { exact: true }).press('Escape');
  await expect(surface).toBeHidden();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('unfinished prompt');
  expect(await prompt.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 2]);
  await questionNotification(window).click();
  await expect(surface.getByLabel('Answer', { exact: true })).toHaveValue('saved draft');
});

test('long questions scroll internally and appending a request preserves the active field and scroll position', async ({ window }, testInfo) => {
  await acpContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.focus();
  const first: Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number] = {
    interactionId: 'long-question', agentName: 'Schema Agent', sessionId: null, message: 'Review every field.', title: 'Long settings', description: null, draft: null,
    fields: Array.from({ length: 18 }, (_, index) => ({ name: `field${index}`, kind: 'text', title: `Field ${index + 1}`, description: 'An agent-supplied field description.', required: false, choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null })),
  };
  const message: ExtensionToWebviewMessage = { type: 'questions', questions: [first] };
  await prompt.evaluate((input, message) => input.ownerDocument.defaultView?.dispatchEvent(new MessageEvent('message', { data: message })), message);
  await questionNotification(window).click();
  const surface = questionSurface(window);
  const scrolling = pendingQuestions(window);
  const transcriptScroll = await chatTranscript(window).evaluate((element) => element.scrollTop);
  const lastField = surface.getByLabel('Field 18', { exact: true });
  await lastField.fill('keep this draft');
  await expect(lastField).toBeInViewport();
  const scrollTop = await scrolling.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  expect(await scrolling.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const surfaceBox = await surface.boundingBox();
  const promptBox = await prompt.boundingBox();
  expect(surfaceBox).not.toBeNull();
  expect(promptBox).not.toBeNull();
  if (!surfaceBox || !promptBox) { throw new Error('Question surface and prompt must have layout boxes'); }
  expect(surfaceBox.y + surfaceBox.height).toBeLessThanOrEqual(promptBox.y + promptBox.height);
  const appended: ExtensionToWebviewMessage = { type: 'questions', questions: [first, {
    ...first, interactionId: 'second-question', title: 'Second settings', fields: first.fields.slice(0, 1).map((field) => ({ ...field, name: 'second', title: 'Second answer' })),
  }] };
  await lastField.evaluate((input, message) => input.ownerDocument.defaultView?.dispatchEvent(new MessageEvent('message', { data: message })), appended);
  await expect(surface.getByRole('button', { name: 'Question 2', exact: true })).toBeVisible();
  await expect(lastField).toBeFocused();
  await expect(lastField).toHaveValue('keep this draft');
  expect(await scrolling.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  expect(await chatTranscript(window).evaluate((element) => element.scrollTop)).toBe(transcriptScroll);
  await surface.getByRole('button', { name: 'Question 2', exact: true }).click();
  await expect(surface.getByRole('heading', { name: 'Second settings', exact: true })).toBeFocused();
  await expect(surface.getByRole('heading', { name: 'Second settings', exact: true })).toBeInViewport();
  await window.screenshot({ path: testInfo.outputPath('long-question-numbered-navigation.png') });
  await surface.getByRole('button', { name: 'Question 1', exact: true }).click();
  await expect(surface.getByRole('heading', { name: 'Long settings', exact: true })).toBeFocused();
  await expect(surface.getByRole('heading', { name: 'Long settings', exact: true })).toBeInViewport();
  await expect(lastField).toHaveValue('keep this draft');
});

test('questions and session usage share one expansion space without losing question drafts', async ({ window }, testInfo) => {
  await acpContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill('usage');
  await prompt.press('Enter');
  const usage = sessionUsage(window);
  const details = sessionUsageDetails(window);
  await expect(usage).toHaveText('254,264 / 272,000 tokens · $11.93');
  await prompt.focus();
  const message: ExtensionToWebviewMessage = { type: 'questions', questions: [{
    interactionId: 'usage-question', agentName: 'Schema Agent', sessionId: null, message: 'Review these settings.', title: 'Shared space', description: null, draft: null,
    fields: [{ name: 'answer', kind: 'text', title: 'Answer', description: null, required: false, choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null }],
  }] };
  await prompt.evaluate((input, message) => input.ownerDocument.defaultView?.dispatchEvent(new MessageEvent('message', { data: message })), message);
  await questionNotification(window).click();
  const surface = questionSurface(window);
  await surface.getByLabel('Answer', { exact: true }).fill('draft survives usage');
  await usage.click();
  await expect(details).toBeVisible();
  await expect(surface).toBeHidden();
  await expect(questionNotification(window)).toHaveAttribute('aria-expanded', 'false');
  // Activate without moving focus first, so usage's blur dismissal cannot mask broken expansion ownership.
  await questionNotification(window).evaluate((button: HTMLButtonElement) => button.click());
  await expect(surface).toBeVisible();
  await expect(details).toBeHidden();
  await expect(usage).toHaveAttribute('aria-expanded', 'false');
  await expect(surface.getByRole('heading', { name: 'Shared space', exact: true })).toBeFocused();
  await expect(surface.getByLabel('Answer', { exact: true })).toHaveValue('draft survives usage');
  await window.screenshot({ path: testInfo.outputPath('questions-replace-expanded-usage.png') });
  await surface.getByRole('button', { name: 'Collapse questions', exact: true }).click();
  await expect(surface).toBeHidden();
  await questionNotification(window).click();
  await expect(surface.getByLabel('Answer', { exact: true })).toHaveValue('draft survives usage');
});

test('a hidden agent question stays pending until native Open and submits typed answers with a collapsed record', async ({ window, workspace }, testInfo) => {
  await acpContainerControl(window).click();
  await window.getByRole('treeitem', { name: /fake-v1/ }).hover();
  await window.getByRole('button', { name: 'Connect to Agent' }).click();
  const prompt = promptInput(window);
  await expect(prompt).toBeEnabled();
  await prompt.fill(`question-hidden ${workspace}`);
  await prompt.press('Enter');
  await expect(chatTranscript(window)).toContainText('Question armed.');
  await explorerControl(window).click();
  await expect(acpChatWebview(window)).toBeHidden();
  await writeFile(join(workspace, 'question.trigger'), 'open');
  const notification = nativeQuestionNotification(window);
  await expect(notification).toContainText('fake-v1 has a question for ui-');
  await expect(acpChatWebview(window)).toBeHidden();
  await notification.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(acpChatWebview(window)).toBeVisible();
  const surface = questionSurface(window);
  await expect(surface.getByRole('heading', { name: 'Desktop settings', exact: true })).toBeFocused();
  await expect(questionRecords(window)).toHaveCount(0);
  await surface.getByLabel('Count *', { exact: true }).fill('4');
  await surface.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(surface.getByRole('alert')).toHaveText('Invalid value');
  await expect(surface.getByLabel('Count *', { exact: true })).toHaveValue('4');
  await expect(questionRecords(window)).toHaveCount(0);
  await surface.getByLabel('Count *', { exact: true }).fill('0');
  await expect(surface.getByLabel('Enabled', { exact: true })).toHaveValue('false');
  await surface.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(surface).toBeHidden();
  await expect(chatTranscript(window)).toContainText('Received question response: {"action":"accept","content":{"count":0,"enabled":false}}');
  const record = questionRecords(window);
  await expect(record).toHaveCount(1);
  await expect(record).not.toHaveAttribute('open');
  await record.locator('summary').click();
  await expect(record).toContainText('Choose the settings to send.');
  await expect(record).toContainText('0');
  await expect(record).toContainText('false');
  await window.screenshot({ path: testInfo.outputPath('native-open-typed-question-response.png') });
});
