import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acpChatWebview, acpContainerControl, chatTranscript, explorerControl, nativeQuestionNotification, pendingQuestions, promptInput, questionNotification, questionRecords, questionSurface, queuedPrompts, quickInputRow, sessionUsage, sessionUsageDetails } from './workbench';
import { expect, test } from './window';

for (const agentVersion of ['v1', 'v2'] as const) {
  test.describe(`${agentVersion} URL questions`, () => {
    test.use({ agentVersion });

    test('shows the full destination on hover and returns decline or dismissal without opening a browser', async ({ window }, testInfo) => {
      await acpContainerControl(window).click();
      await window.getByRole('treeitem', { name: new RegExp(`fake-${agentVersion}`) }).hover();
      await window.getByRole('button', { name: 'Connect to Agent' }).click();
      const prompt = promptInput(window);
      await expect(prompt).toBeEnabled();
      await prompt.fill('url-elicitation');
      await prompt.press('Enter');
      const open = quickInputRow(window, 'Open URL');
      await expect(open).toBeVisible();
      await expect(open).toContainText('example.org');
      await open.getByText(`https://example.org/connect?state=${'a'.repeat(180)}`, { exact: true }).hover();
      await expect(window.getByRole('tooltip')).toContainText(`https://example.org/connect?state=${'a'.repeat(180)}`);
      await window.screenshot({ path: testInfo.outputPath('url-elicitation-consent.png') });
      await window.keyboard.press('ArrowDown');
      await window.keyboard.press('Enter');
      await expect(chatTranscript(window)).toContainText('URL response: {"action":"decline"}');
      await expect(questionRecords(window)).toHaveCount(0);
      await prompt.fill('url-elicitation');
      await prompt.press('Enter');
      await expect(open).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(chatTranscript(window)).toContainText('URL response: {"action":"cancel"}');
      await expect(questionRecords(window)).toHaveCount(0);
    });
  });

  test.describe(`${agentVersion} authentication questions`, () => {
    test.use({ agentVersion, authenticationQuestion: true });

    test('answers a form during authentication and retries session creation without a response record', async ({ window }, testInfo) => {
      await acpContainerControl(window).click();
      await window.getByRole('treeitem', { name: new RegExp(`fake-${agentVersion}`) }).hover();
      await window.getByRole('button', { name: 'Connect to Agent' }).click();
      await quickInputRow(window, 'Authenticate').click();
      const prompt = promptInput(window);
      const surface = questionSurface(window);
      await expect(surface.getByRole('heading', { name: 'Authentication preference', exact: true })).toBeVisible();
      await expect(prompt).toBeDisabled();
      await expect(questionRecords(window)).toHaveCount(0);
      await surface.getByLabel('Enabled *', { exact: true }).selectOption('false');
      await window.screenshot({ path: testInfo.outputPath('authentication-elicitation.png') });
      await surface.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(prompt).toBeEnabled();
      await expect(surface).toBeHidden();
      await prompt.fill('verify-authentication');
      await prompt.press('Enter');
      await expect(chatTranscript(window)).toContainText('Authentication response: {"action":"accept","content":{"enabled":false}}; session creation attempts: 2');
      await expect(questionRecords(window)).toHaveCount(0);
    });

    test('cleans up a cancelled authentication form and permits a fresh connection', async ({ window }) => {
      await acpContainerControl(window).click();
      const agent = window.getByRole('treeitem', { name: new RegExp(`fake-${agentVersion}`) });
      await agent.hover();
      await window.getByRole('button', { name: 'Connect to Agent' }).click();
      await quickInputRow(window, 'Authenticate').click();
      const surface = questionSurface(window);
      await expect(surface.getByRole('heading', { name: 'Authentication preference', exact: true })).toBeVisible();
      await surface.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(window.getByText(/Authentication failed:.*Authentication preference not accepted/).first()).toBeVisible();
      await expect(surface).toBeHidden();
      await expect(questionNotification(window)).toBeHidden();
      await expect(promptInput(window)).toBeDisabled();
      await expect(questionRecords(window)).toHaveCount(0);
      await agent.hover();
      await window.getByRole('button', { name: 'Connect to Agent' }).click();
      await quickInputRow(window, 'Authenticate').click();
      await expect(surface.getByRole('heading', { name: 'Authentication preference', exact: true })).toBeVisible();
      await expect(surface.getByLabel('Enabled *', { exact: true })).toHaveValue('');
      await surface.getByLabel('Enabled *', { exact: true }).selectOption('false');
      await surface.getByRole('button', { name: 'Submit', exact: true }).click();
      const prompt = promptInput(window);
      await expect(prompt).toBeEnabled();
      await prompt.fill('verify-authentication');
      await prompt.press('Enter');
      await expect(chatTranscript(window)).toContainText('Authentication response: {"action":"accept","content":{"enabled":false}}; session creation attempts: 2');
      await expect(questionRecords(window)).toHaveCount(0);
    });
  });
}

test.describe('v2 pre-session questions', () => {
  test.use({ agentVersion: 'v2', preSessionQuestion: true });

  test('answers a request-scoped setup form before session creation completes without creating a session record', async ({ window }, testInfo) => {
    await acpContainerControl(window).click();
    await window.getByRole('treeitem', { name: /fake-v2/ }).hover();
    await window.getByRole('button', { name: 'Connect to Agent' }).click();
    const prompt = promptInput(window);
    await expect(questionNotification(window)).toBeVisible();
    await expect(prompt).toBeDisabled();
    const surface = questionSurface(window);
    await expect(surface.getByRole('heading', { name: 'Before session setup', exact: true })).toBeVisible();
    await expect(questionRecords(window)).toHaveCount(0);
    await surface.getByLabel('Enabled *', { exact: true }).selectOption('false');
    await window.screenshot({ path: testInfo.outputPath('pre-session-elicitation.png') });
    await surface.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(surface).toBeHidden();
    await expect(prompt).toBeEnabled();
    await expect(questionRecords(window)).toHaveCount(0);
    await prompt.fill('verify-pre-session');
    await prompt.press('Enter');
    await expect(chatTranscript(window)).toContainText('Setup response before session creation: {"action":"accept","content":{"enabled":false}}');
    await expect(questionRecords(window)).toHaveCount(0);
  });
});

test.describe('v2 concurrent questions', () => {
  test.use({ agentVersion: 'v2' });

  test('withdrawing a form rejects a stale submission without changing another draft or its replacement', async ({ window, workspace }, testInfo) => {
    await acpContainerControl(window).click();
    await window.getByRole('treeitem', { name: /fake-v2/ }).hover();
    await window.getByRole('button', { name: 'Connect to Agent' }).click();
    const prompt = promptInput(window);
    await expect(prompt).toBeEnabled();
    await prompt.evaluate((input) => {
      const page = input.ownerDocument.defaultView;
      page?.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
        if (event.data.type !== 'questions') { return; }
        if (event.data.questions.some((question) => question.title === 'Replacement settings')) {
          input.dataset['liveQuestions'] = JSON.stringify(event.data);
        }
        const first = event.data.questions.find((question) => question.title === 'Withdrawn settings');
        if (first) { input.dataset['withdrawnQuestion'] = JSON.stringify(first); }
      });
    });
    await prompt.fill(`questions-withdraw ${workspace}`);
    await prompt.press('Enter');
    await expect(questionNotification(window)).toHaveAccessibleName('Two elicitations are awaiting your response');
    await questionNotification(window).click();
    const surface = questionSurface(window);
    await surface.getByRole('form', { name: 'Surviving settings', exact: true }).getByLabel('Answer *', { exact: true }).fill('preserved draft');
    await window.getByRole('button', { name: 'ACP: Cancel Current Turn', exact: true }).click();
    await expect(chatTranscript(window)).toContainText('cancel-ack');
    await expect(questionNotification(window)).toHaveAccessibleName('Two elicitations are awaiting your response');
    await expect(surface.getByRole('form', { name: 'Surviving settings', exact: true }).getByLabel('Answer *', { exact: true })).toHaveValue('preserved draft');
    await expect(questionRecords(window)).toHaveCount(0);
    await writeFile(join(workspace, 'questions-withdraw.trigger'), 'withdraw');
    await expect(chatTranscript(window)).toContainText('Withdrawal error: -32800');
    await expect(surface.getByRole('form', { name: 'Withdrawn settings', exact: true })).toBeHidden();
    await expect(surface.getByRole('form', { name: 'Replacement settings', exact: true })).toBeVisible();
    await expect(surface.getByRole('form', { name: 'Surviving settings', exact: true }).getByLabel('Answer *', { exact: true })).toHaveValue('preserved draft');
    await expect(questionRecords(window)).toHaveCount(0);
    // Recreate an obsolete page's control, but submit through the real webview-to-core path.
    await prompt.evaluate((input) => {
      const saved = input.dataset['withdrawnQuestion'];
      if (!saved) { throw new Error('No withdrawn request captured'); }
      const question = JSON.parse(saved) as Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number];
      input.ownerDocument.defaultView?.dispatchEvent(new MessageEvent('message', { data: { type: 'questions', questions: [question] } }));
    });
    await surface.getByLabel('Answer *', { exact: true }).fill('obsolete answer');
    await surface.getByRole('button', { name: 'Submit', exact: true }).click();
    await prompt.evaluate((input) => {
      const saved = input.dataset['liveQuestions'];
      if (!saved) { throw new Error('No live snapshot captured'); }
      const message: unknown = JSON.parse(saved);
      input.ownerDocument.defaultView?.dispatchEvent(new MessageEvent('message', { data: message }));
    });
    await expect(surface.getByRole('form', { name: 'Surviving settings', exact: true }).getByLabel('Answer *', { exact: true })).toHaveValue('preserved draft');
    await expect(surface.getByRole('form', { name: 'Replacement settings', exact: true })).toBeVisible();
    await expect(questionRecords(window)).toHaveCount(0);
    await surface.getByRole('form', { name: 'Surviving settings', exact: true }).getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(chatTranscript(window)).toContainText('Surviving answer: {"answer":"preserved draft"}');
    await surface.getByRole('form', { name: 'Replacement settings', exact: true }).getByLabel('Answer *', { exact: true }).fill('replacement answer');
    await surface.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(chatTranscript(window)).toContainText('Replacement answer: {"answer":"replacement answer"}');
    await expect(questionRecords(window)).toHaveCount(2);
    await expect(surface).toBeHidden();
    await window.screenshot({ path: testInfo.outputPath('withdrawal-preserves-live-questions.png') });
  });

  test('answering concurrent forms does not release a queued prompt before agent idle', async ({ window, workspace }, testInfo) => {
    await acpContainerControl(window).click();
    await window.getByRole('treeitem', { name: /fake-v2/ }).hover();
    await window.getByRole('button', { name: 'Connect to Agent' }).click();
    const prompt = promptInput(window);
    await expect(prompt).toBeEnabled();
    await prompt.fill(`questions-concurrent ${workspace}`);
    await prompt.press('Enter');
    await expect(questionNotification(window)).toHaveAccessibleName('Two elicitations are awaiting your response');
    await prompt.fill('after-questions');
    await prompt.press('Enter');
    await expect(queuedPrompts(window)).toContainText('after-questions');
    await window.screenshot({ path: testInfo.outputPath('pending-elicitations-with-queued-prompt.png') });
    await questionNotification(window).click();
    const surface = questionSurface(window);
    await surface.getByRole('button', { name: 'Next elicitation', exact: true }).click();
    const second = surface.getByRole('form', { name: 'Second settings', exact: true });
    await second.getByLabel('Enabled *', { exact: true }).selectOption('false');
    await second.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(chatTranscript(window)).toContainText('Second response: {"action":"accept","content":{"enabled":false}}');
    await expect(queuedPrompts(window)).toContainText('after-questions');
    await window.screenshot({ path: testInfo.outputPath('elicitation-queue-composer.png') });
    await expect(questionRecords(window)).toHaveCount(1);
    await surface.getByLabel('Count *', { exact: true }).fill('0');
    await surface.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(chatTranscript(window)).toContainText('First response: {"action":"accept","content":{"count":0}}');
    await expect(chatTranscript(window)).toContainText('Answers settled; waiting to report idle.');
    await expect(surface).toBeHidden();
    await expect(questionRecords(window)).toHaveCount(2);
    await expect(questionRecords(window).nth(0)).not.toHaveAttribute('open');
    await expect(questionRecords(window).nth(1)).not.toHaveAttribute('open');
    await expect(queuedPrompts(window)).toContainText('after-questions');
    await window.screenshot({ path: testInfo.outputPath('v2-answers-before-agent-idle.png') });
    await writeFile(join(workspace, 'questions-idle.trigger'), 'idle');
    await expect(chatTranscript(window)).toContainText('Queued prompt received after agent idle.');
    await expect(queuedPrompts(window)).toBeHidden();
  });
});

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
  await expect(surface.getByRole('navigation')).toHaveCount(0);
  await surface.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(surface.getByText('Submit without answers?', { exact: true })).toBeVisible();
  await expect(surface.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  const confirmation = await surface.getByRole('group', { name: 'Submit without answers?', exact: true }).boundingBox();
  const viewport = await pendingQuestions(window).boundingBox();
  if (!confirmation || !viewport) { throw new Error('Confirmation and scrolling viewport must have layout boxes'); }
  expect(confirmation.y).toBeGreaterThanOrEqual(viewport.y);
  await window.screenshot({ path: testInfo.outputPath('empty-elicitation-confirmation.png') });
  await surface.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(surface.getByRole('button', { name: 'Submit', exact: true })).toBeFocused();
  await surface.getByRole('button', { name: 'Decline', exact: true }).hover();
  await expect(surface.getByRole('tooltip')).toHaveCount(0);
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
  await expect(surface.getByRole('button', { name: 'Next elicitation', exact: true })).toBeVisible();
  await expect(lastField).toBeFocused();
  await expect(lastField).toHaveValue('keep this draft');
  expect(await scrolling.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  expect(await chatTranscript(window).evaluate((element) => element.scrollTop)).toBe(transcriptScroll);
  const next = surface.getByRole('button', { name: 'Next elicitation', exact: true });
  await expect(surface.getByRole('status', { name: 'Elicitation position' })).toHaveCount(0);
  await expect(next).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await next.hover();
  expect(await next.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(lastField).toHaveCSS('border-top-width', '2px');
  await next.click();
  await expect(next).toBeFocused();
  await expect(surface.getByRole('heading', { name: 'Second settings', exact: true })).toBeInViewport();
  await window.screenshot({ path: testInfo.outputPath('long-elicitation-arrow-navigation.png') });
  const previous = surface.getByRole('button', { name: 'Previous elicitation', exact: true });
  await previous.click();
  await expect(previous).toBeFocused();
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
  await surface.getByRole('button', { name: 'Collapse elicitations', exact: true }).click();
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
  await expect(surface.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
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
