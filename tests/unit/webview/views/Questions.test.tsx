// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action, type RootState } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { Questions } from '@/webview/views/Questions';
import { InputArea } from '@/webview/views/InputArea';

type Question = Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  // jsdom has no layout or scrolling; desktop coverage checks confirmation visibility.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  if (originalScrollIntoView) { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView); }
  else { Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); }
});
const field: Question['fields'][number] = {
  name: 'text', kind: 'text', title: 'Written answer', description: 'Explain your choice', required: false,
  choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null,
};
const question: Question = {
  interactionId: 'q1', agentName: 'Setup Agent', sessionId: null, message: 'Configure https://example.com?',
  title: 'Settings', description: 'Choose settings', draft: null,
  fields: [
    { ...field, minLength: 2, maxLength: 12, pattern: '[a-z]+', default: 'hello' },
    { ...field, name: 'count', title: 'Count', description: null, kind: 'integer', minimum: 0, maximum: 3, required: true, default: 0 },
    { ...field, name: 'ratio', title: 'Ratio', description: null, kind: 'number' },
    { ...field, name: 'enabled', title: 'Enabled', description: null, kind: 'boolean', default: false },
    { ...field, name: 'color', title: 'Color', description: null, choices: [{ value: 'r', title: 'Red', description: 'Warm' }, { value: 'b', title: 'Blue', description: 'Cool' }] },
    { ...field, name: 'tags', title: 'Tags', description: null, kind: 'multiple', minItems: 1, maxItems: 2, choices: [{ value: 'x', title: 'First', description: 'First tag' }, { value: 'y', title: 'Second', description: null }] },
  ],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(initial: RootState = initialState) {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initial, update, (message: WebviewToExtensionMessage) => posted.push(message));
  render(<StoreContext value={store}><Questions><div aria-label="Queued prompts">Queued</div><InputArea /></Questions></StoreContext>);
  const send = (action: Action) => act(() => store.dispatch(action));
  const arrive = (questions = [question]) => send({ type: 'questions', questions });
  const prompt = screen.getByRole<HTMLTextAreaElement>('textbox');
  const connect = () => send({ type: 'state', activeSessionId: 's1', session: { sessionId: 's1', agentName: 'Agent', cwd: '/work', pickers: [], commands: [] } });
  return { send, arrive, prompt, connect, take: () => posted.splice(0) };
}

describe('question surface', () => {
  it('keeps disclosure and navigation icons decorative at their existing sizes', () => {
    const view = setup();
    view.connect();
    view.send({ type: 'usage', usage: { used: 1, size: 2, cost: null } });
    view.arrive([question, { ...question, interactionId: 'q2' }]);
    for (const [label, size] of [
      ['Two elicitations are awaiting your response', '14'],
      ['Previous elicitation', '14'],
      ['Next elicitation', '14'],
      ['Collapse elicitations', '14'],
      ['Session usage', '12'],
    ] as const) {
      const icon = screen.getByRole('button', { name: label }).querySelector('svg');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.getAttribute('width')).toBe(size);
      expect(icon?.getAttribute('height')).toBe(size);
    }
    expect(screen.queryByRole('img')).toBeNull();
    expect(view.take()).toEqual([]);
  });

  it.each([
    [21, 'Twenty-one'],
    [101, 'One hundred one'],
  ])('spells %i elicitation envelopes in sentence case with hyphenated compounds', (count, sentence) => {
    const view = setup();
    view.arrive(Array.from({ length: count }, (_, index) => ({ ...question, interactionId: `q${index}`, fields: [] })));
    expect(screen.getByRole('button', { name: `${sentence} elicitations are awaiting your response` })).toBeDefined();
    expect(screen.queryByRole('status', { name: 'Elicitation position' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous elicitation' }));
    expect(screen.getByRole('navigation').textContent).toBe('');
    expect(view.take()).toEqual([]);
  });

  it('describes requests in English and offers arrow navigation only for concurrent elicitations', () => {
    const view = setup();
    view.arrive();
    expect(screen.getByRole('button', { name: 'An elicitation is awaiting your response' })).toBeDefined();
    expect(screen.queryByRole('navigation')).toBeNull();
    view.arrive([question, { ...question, interactionId: 'q2', title: 'Second request' }]);
    expect(screen.getByRole('button', { name: 'Two elicitations are awaiting your response' })).toBeDefined();
    const next = screen.getByRole('button', { name: 'Next elicitation' });
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
    expect(screen.getByRole('navigation').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Previous elicitation' }));
    expect(screen.queryByRole('status', { name: 'Elicitation position' })).toBeNull();
    view.arrive([question]);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(view.take()).toEqual([]);
  });

  it('confirms an unanswered optional form without turning keep-editing into cancellation', () => {
    const view = setup();
    view.arrive([{ ...question, fields: [field] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(view.take()).toEqual([]);
    expect(screen.getByText('Submit without answers?')).toBeDefined();
    const keepEditing = screen.getByRole('button', { name: 'Keep editing' });
    expect(document.activeElement).toBe(keepEditing);
    fireEvent.click(keepEditing);
    expect(screen.queryByText('Submit without answers?')).toBeNull();
    expect(view.take()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit without answers' }));
    expect(view.take()).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: {} }]);
  });

  it('disables submission for invalid answers and shows no form-button tooltips on focus or hover', () => {
    const view = setup();
    view.arrive([{ ...question, fields: [{ ...field, required: true, minLength: 2 }] }]);
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Written answer *'), { target: { value: 'a' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Written answer *'), { target: { value: 'ab' } });
    expect(submit.disabled).toBe(false);
    for (const label of ['Submit', 'Decline', 'Cancel']) {
      const button = screen.getByRole('button', { name: label });
      fireEvent.focus(button);
      expect(within(screen.getByRole('form')).queryByRole('tooltip')).toBeNull();
      fireEvent.mouseEnter(button);
      expect(within(screen.getByRole('form')).queryByRole('tooltip')).toBeNull();
      expect(button.getAttribute('title')).toBeNull();
      expect(button.getAttribute('aria-describedby')).toBeNull();
      fireEvent.mouseLeave(button);
      fireEvent.blur(button);
    }
    expect(view.take().filter((message) => message.type === 'questionResponse')).toEqual([]);
  });

  it('explicitly opens and focuses the requested question even during composition, ignoring stale targets', () => {
    const view = setup();
    view.connect();
    view.prompt.focus();
    view.arrive([question, { ...question, interactionId: 'q2', title: 'Second request' }]);
    view.send({ type: 'questionOpen', interactionId: 'missing' });
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
    view.send({ type: 'questionOpen', interactionId: 'q2' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Second request' }));
    expect(screen.queryByRole('status', { name: 'Elicitation position' })).toBeNull();
    view.send({ type: 'questionOpen', interactionId: 'q1' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Settings' }));
    view.prompt.focus();
    view.send({ type: 'questionOpen', interactionId: 'q1' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Settings' }));
    expect(view.take()).toEqual([]);
  });
  it('renders all field kinds without a session, preserves defaults and sends typed answers only on Submit', () => {
    const view = setup();
    view.arrive();
    const region = screen.getByRole('region', { name: 'Elicitations' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Settings' }));
    expect(view.prompt.disabled).toBe(true);
    expect(within(region).getByText('Setup Agent')).toBeDefined();
    expect(within(region).getByText('Choose settings')).toBeDefined();
    expect(within(region).queryByRole('link')).toBeNull();
    expect(within(region).getByText(/Do not include passwords/)).toBeDefined();
    const text = screen.getByLabelText<HTMLInputElement>('Written answer');
    expect(text.value).toBe('hello');
    expect(text.getAttribute('minlength')).toBe('2');
    expect(text.getAttribute('maxlength')).toBe('12');
    expect(text.getAttribute('pattern')).toBe('[a-z]+');
    expect(screen.getByLabelText<HTMLInputElement>('Count *').value).toBe('0');
    expect(screen.getByLabelText<HTMLSelectElement>('Enabled').value).toBe('false');
    fireEvent.change(screen.getByLabelText('Ratio'), { target: { value: '1.25' } });
    const color = screen.getByLabelText<HTMLSelectElement>('Color');
    const blue = within(color).getByRole<HTMLOptionElement>('option', { name: 'Blue' });
    fireEvent.change(color, { target: { value: blue.value } });
    expect(screen.getByText('Cool')).toBeDefined();
    fireEvent.click(screen.getByLabelText('First'));
    fireEvent.click(screen.getByLabelText('Second'));
    fireEvent.click(screen.getByLabelText('First'));
    expect(view.take().every((message) => message.type === 'questionDraft')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(view.take()).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: { text: 'hello', count: 0, ratio: 1.25, enabled: false, color: 'b', tags: ['y'] } }]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(true);
    view.send({ type: 'questionErrors', interactionId: 'q1', errors: { text: 'Invalid value' } });
    expect(screen.getByLabelText('Written answer').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Invalid value');
    expect(screen.getByLabelText<HTMLInputElement>('Ratio').value).toBe('1.25');
  });

  it('defers during prompt composition until explicitly opened, then Esc restores selection without answering', () => {
    const view = setup();
    view.connect();
    fireEvent.change(view.prompt, { target: { value: 'unfinished prompt' } });
    view.prompt.focus();
    view.prompt.setSelectionRange(2, 7);
    view.arrive();
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
    const notification = screen.getByRole('button', { name: 'An elicitation is awaiting your response' });
    expect(notification.compareDocumentPosition(screen.getByLabelText('Queued prompts')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(document.activeElement).toBe(view.prompt);
    view.prompt.blur();
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
    view.prompt.focus();
    fireEvent.pointerDown(notification);
    notification.focus();
    fireEvent.click(notification, { detail: 1 });
    const region = screen.getByRole('region', { name: 'Elicitations' });
    expect(region.className).toContain('absolute');
    expect(fireEvent.keyDown(document.activeElement ?? region, { key: 'Escape' })).toBe(false);
    expect(document.activeElement).toBe(view.prompt);
    expect([view.prompt.value, view.prompt.selectionStart, view.prompt.selectionEnd]).toEqual(['unfinished prompt', 2, 7]);
    expect(view.take()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
  });

  it('appends requests without stealing focus or scroll position and navigates without submission', () => {
    const view = setup();
    view.arrive();
    const text = screen.getByLabelText<HTMLInputElement>('Written answer');
    text.focus();
    fireEvent.change(text, { target: { value: 'draft' } });
    const scroll = screen.getByLabelText('Pending elicitations');
    scroll.scrollTop = 75;
    view.arrive([question, { ...question, interactionId: 'q2', title: 'Second request' }]);
    expect(document.activeElement).toBe(text);
    expect(text.value).toBe('draft');
    expect(scroll.scrollTop).toBe(75);
    const second = screen.getByRole('heading', { name: 'Second request' });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({ top: 110 } as DOMRect);
    const next = screen.getByRole('button', { name: 'Next elicitation' });
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
    expect(second).toBeDefined();
    expect(scroll.scrollTop).toBe(175);
    expect(view.take()).toEqual([{ type: 'questionDraft', interactionId: 'q1', draft: { text: 'draft', count: 0, enabled: false } }]);
    const forms = screen.getAllByRole('form');
    fireEvent.click(within(forms[0] as HTMLElement).getByRole('button', { name: 'Decline' }));
    fireEvent.click(within(forms[1] as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(view.take()).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'decline' }, { type: 'questionResponse', interactionId: 'q2', action: 'cancel' }]);
    view.arrive([]);
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
    expect(screen.queryByRole('button', { name: /awaiting your response/ })).toBeNull();
  });

  it('makes usage and questions mutually exclusive and preserves drafts when either expansion closes', () => {
    const view = setup();
    view.connect();
    view.send({ type: 'usage', usage: { used: 1, size: 2, cost: null } });
    const usage = screen.getByRole('button', { name: 'Session usage' });
    fireEvent.click(usage);
    view.arrive();
    expect(screen.queryByRole('region', { name: 'Session usage details' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Written answer'), { target: { value: 'draft' } });
    fireEvent.click(usage);
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Session usage details' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'An elicitation is awaiting your response' }));
    expect(screen.queryByRole('region', { name: 'Session usage details' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Written answer').value).toBe('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse elicitations' }));
    expect(screen.queryByRole('region', { name: 'Elicitations' })).toBeNull();
    expect(view.take()).toEqual([{ type: 'questionDraft', interactionId: 'q1', draft: { text: 'draft', count: 0, enabled: false } }]);
  });

  it('clears optional defaults and retains explicitly empty text and multi-selection', () => {
    const view = setup();
    view.arrive([{ ...question, fields: question.fields.map((entry) => entry.name === 'text' ? { ...entry, minLength: null, pattern: null } : entry.name === 'tags' ? { ...entry, minItems: null } : entry) }]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Enabled' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Enabled').value).toBe('');
    fireEvent.change(screen.getByLabelText('Written answer'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('First'));
    fireEvent.click(screen.getByLabelText('First'));
    view.take();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(view.take()).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: { text: '', count: 0, tags: [] } }]);
  });

  it('shows text constraints and supplied formats without turning URLs into links', () => {
    const view = setup();
    view.arrive([{ ...question, fields: [{ ...field, minLength: 2, maxLength: 12, pattern: '[a-z]+', format: 'future-format' }] }]);
    expect(screen.getByText('Length: minimum 2; maximum 12')).toBeDefined();
    expect(screen.getByText('Pattern: [a-z]+')).toBeDefined();
    expect(screen.getByText('Format: future-format')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('Written answer').type).toBe('text');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('moves focus to a remaining request only when the removed request owned focus', () => {
    const view = setup();
    view.arrive([question, { ...question, interactionId: 'q2', title: 'Second request' }]);
    const first = screen.getAllByRole('form')[0] as HTMLElement;
    within(first).getByLabelText('Written answer').focus();
    view.arrive([{ ...question, interactionId: 'q2', title: 'Second request' }]);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Second request' }));
    expect(screen.queryByRole('navigation')).toBeNull();
    view.connect();
    view.prompt.focus();
    view.arrive([]);
    expect(document.activeElement).toBe(view.prompt);
    expect(view.take()).toEqual([]);
  });

  it('returns to the notification when the previous focus target was removed', () => {
    const view = setup();
    const previous = document.createElement('button');
    document.body.append(previous);
    previous.focus();
    view.arrive();
    previous.remove();
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Settings' }), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'An elicitation is awaiting your response' }));
    expect(view.take()).toEqual([]);
  });

  it('navigates from the request reached by scrolling without moving focus or answering', () => {
    const view = setup();
    view.arrive([question, { ...question, interactionId: 'q2', title: 'Second request' }]);
    const first = screen.getByRole('heading', { name: 'Settings' });
    const second = screen.getByRole('heading', { name: 'Second request' });
    const scroll = screen.getByLabelText('Pending elicitations');
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ bottom: -50 } as DOMRect);
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({ bottom: 100 } as DOMRect);
    fireEvent.scroll(scroll);
    vi.mocked(first.getBoundingClientRect).mockReturnValue({ top: -90 } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Next elicitation' }));
    expect(scroll.scrollTop).toBe(-100);
    expect(document.activeElement).toBe(first);
    expect(view.take()).toEqual([]);
  });

  it('restores focus when the final focused request leaves the surface', () => {
    const view = setup();
    view.connect();
    const usage = { type: 'usage', usage: { used: 1, size: 2, cost: null } } as const;
    view.send(usage);
    const previous = screen.getByRole('button', { name: 'Session usage' });
    previous.focus();
    view.arrive();
    view.arrive([]);
    expect(document.activeElement).toBe(previous);
    expect(view.take()).toEqual([]);
  });

  it('retains saved drafts on recreation and can open an already populated store', () => {
    const initial = update(initialState, { type: 'questions', questions: [{ ...question, draft: {} }] }, 0).state;
    const view = setup(initial);
    fireEvent.click(screen.getByRole('button', { name: 'An elicitation is awaiting your response' }));
    expect(screen.getByLabelText<HTMLInputElement>('Count *').value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Enabled').value).toBe('');
    expect(view.take()).toEqual([]);
  });

  it('keeps an empty-string enum choice distinct from omission and supports an empty form', () => {
    const view = setup();
    view.arrive([{ ...question, fields: [{ ...field, choices: [{ value: '', title: 'Empty answer', description: null }] }] }]);
    const select = screen.getByLabelText<HTMLSelectElement>('Written answer');
    fireEvent.change(select, { target: { value: within(select).getByRole<HTMLOptionElement>('option', { name: 'Empty answer' }).value } });
    view.take();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(view.take()).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: { text: '' } }]);
    view.arrive([{ ...question, interactionId: 'empty', fields: [] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(view.take()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Submit without answers' }));
    expect(view.take()).toEqual([{ type: 'questionResponse', interactionId: 'empty', action: 'accept', content: {} }]);
  });
});
