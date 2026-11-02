import { describe, expect, it, onTestFinished } from 'vitest';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { connect, loadChatPage } from './chatPage';

const question: Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number] = {
  interactionId: 'q1', sessionId: 's1', agentName: 'Agent', message: 'Confirm?', title: 'Question', description: null, draft: null,
  fields: [{ name: 'enabled', kind: 'boolean', title: 'Enabled', description: null, required: false, choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null, default: false }],
};

describe('bundled question delivery', () => {
  it('preserves prompt composition and posts the standard response through the production message boundary', async () => {
    const page = loadChatPage();
    connect(page);
    page.typePrompt('unfinished prompt');
    const prompt = page.byId<HTMLTextAreaElement>('promptInput');
    prompt.focus();
    prompt.setSelectionRange(2, 5);
    page.takePosted();
    page.send({ type: 'questions', questions: [question] });
    expect(page.document.querySelector('[aria-label="Elicitations"]')).toBeNull();
    expect(page.document.activeElement).toBe(prompt);
    page.send({ type: 'questionOpen', interactionId: 'q1' });
    expect(page.document.activeElement?.textContent).toBe('Question');
    const surface = page.document.querySelector('[aria-label="Elicitations"]');
    const collapsed = new Promise<void>((resolve) => {
      const observer = new page.window.MutationObserver(() => {
        if (!page.document.querySelector('[aria-label="Elicitations"]')) { observer.disconnect(); resolve(); }
      });
      observer.observe(page.document.body, { childList: true, subtree: true });
      onTestFinished(() => observer.disconnect());
    });
    surface?.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await collapsed;
    expect(page.document.querySelector('[aria-label="Elicitations"]')).toBeNull();
    const notification = page.document.querySelector<HTMLButtonElement>('.question-notification');
    expect(notification).not.toBeNull();
    const opened = new Promise<void>((resolve) => {
      const observer = new page.window.MutationObserver(() => {
        if (page.document.querySelector('[aria-label="Elicitations"]')) { observer.disconnect(); resolve(); }
      });
      observer.observe(page.document.body, { childList: true, subtree: true });
      onTestFinished(() => observer.disconnect());
    });
    notification?.click();
    await opened;
    const heading = page.document.querySelector('h3');
    expect(page.document.activeElement).toBe(heading);
    const form = page.document.querySelector('form');
    expect(form).not.toBeNull();
    form?.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(page.takePosted()).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: { enabled: false } }]);
    expect(page.document.querySelector('.question-record')).toBeNull();
    page.send({ type: 'questionSettled', record: {
      interactionId: 'q1', sessionId: 's1', agentName: 'Agent', message: 'Confirm?', title: 'Question', description: null, fields: question.fields,
      response: { action: 'accept', content: { enabled: false } },
    } });
    const record = page.document.querySelector<HTMLDetailsElement>('.question-record');
    expect(record?.open).toBe(false);
    expect(record?.querySelector('summary')?.textContent).toBe('Elicitation — Submitted: Question');
    expect(record?.querySelector('dd')?.textContent).toBe('false');
    page.send({ type: 'questions', questions: [] });
    expect(page.document.querySelector('[aria-label="Elicitations"]')).toBeNull();
    expect([prompt.value, prompt.selectionStart, prompt.selectionEnd]).toEqual(['unfinished prompt', 2, 5]);
    page.send({ type: 'loadSessionStart' });
    page.send({ type: 'loadSessionEnd', ok: true });
    expect(page.document.querySelector('.question-record')).toBeNull();
  });
});
