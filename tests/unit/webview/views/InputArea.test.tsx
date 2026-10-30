// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, SlashCommand, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { InputArea } from '@/webview/views/InputArea';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';

const init: SlashCommand = { name: 'init', description: 'Initialize the project', takesInput: false, hint: null };
const review: SlashCommand = { name: 'review', description: 'Review changes', takesInput: true, hint: 'What to review' };

let scrolledIntoView: Element[];

beforeEach(() => {
  scrolledIntoView = [];
  // jsdom does not implement scrolling.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledIntoView.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderInputArea() {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message));
  const send = (action: Action) => act(() => store.dispatch(action));
  const { container } = render(
    <StoreContext value={store}>
      <InputArea />
    </StoreContext>,
  );
  const part = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const found = container.querySelector<T>(selector);
    if (!found) {
      throw new Error(`nothing matches ${selector}`);
    }
    return found;
  };
  const prompt = () => part<HTMLTextAreaElement>('#promptInput');
  return {
    container,
    send,
    part,
    prompt,
    items: () => [...container.querySelectorAll<HTMLElement>('.slash-popup-item')],
    popupOpen: () => part('#slashPopup').classList.contains('open'),
    connect: (session: Partial<SessionSnapshot> = {}) =>
      send({
        type: 'state',
        activeSessionId: 's1',
        session: { sessionId: 's1', agentName: 'Fake', cwd: '/work', pickers: [], commands: [init, review], ...session },
      }),
    type: (text: string) => fireEvent.change(prompt(), { target: { value: text } }),
    press: (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(prompt(), { key, ...init }),
    takePosted: () => posted.splice(0),
    usage: () => store.getSnapshot().transcript.usage,
  };
}

describe('input area', () => {
  it('is disabled without a session and while one loads', () => {
    const view = renderInputArea();
    const disabled = () => [view.part('#inputArea').classList.contains('disabled'), view.prompt().disabled];
    expect(disabled()).toEqual([true, true]);

    view.connect();
    expect(disabled()).toEqual([false, false]);

    view.send({ type: 'loadSessionStart' });
    expect(disabled()).toEqual([true, true]);
  });

  it('shows what is typed and sends it on Enter, but not on Shift+Enter or while composing', () => {
    const view = renderInputArea();
    view.connect();

    view.type('hello');
    expect(view.prompt().value).toBe('hello');

    view.press('Enter', { shiftKey: true });
    view.press('Enter', { isComposing: true });
    expect(view.takePosted()).toEqual([]);

    // Enter's own newline would land in the box the send has just emptied.
    expect(view.press('Enter')).toBe(false);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'hello' }]);
    expect(view.prompt().value).toBe('');
  });

  it('leaves other keys to the prompt box while the popup is closed', () => {
    const view = renderInputArea();
    view.connect();
    view.type('hello');

    for (const key of ['ArrowDown', 'Tab', 'Escape']) {
      expect(view.press(key)).toBe(true);
    }
    expect(view.takePosted()).toEqual([]);
  });

  it('shows the placeholder for the session', () => {
    const view = renderInputArea();
    expect(view.prompt().placeholder).toBe('Type a message...');

    view.connect();
    expect(view.prompt().placeholder).toBe('Type a message or / for commands...');
  });
});

describe('session usage', () => {
  const report: Action = { type: 'usage', usage: { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } } };
  const control = (view: ReturnType<typeof renderInputArea>) => within(view.container).getByRole('button', { name: 'Session usage' });
  const details = (view: ReturnType<typeof renderInputArea>) => within(view.container).getByRole('region', { name: 'Session usage details' });
  const fields = (view: ReturnType<typeof renderInputArea>) => [...details(view).querySelectorAll('dt, dd')].map((item) => item.textContent);

  it('shows nothing before a report arrives', () => {
    const view = renderInputArea();
    view.connect();

    expect(within(view.container).queryByRole('button', { name: 'Session usage' })).toBeNull();
    expect(within(view.container).queryByRole('region', { name: 'Session usage details' })).toBeNull();
  });

  it('shows reported context and cost below the prompt, opening labeled details only when clicked', () => {
    const view = renderInputArea();
    view.connect();
    view.send(report);
    const button = control(view);

    expect(button.textContent).toBe('90,000 / 200,000 tokens · €0.12');
    expect(view.prompt().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(within(view.container).queryByRole('region', { name: 'Session usage details' })).toBeNull();

    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(details(view).id);
    expect(fields(view)).toEqual(['Tokens in context', '90,000', 'Context window limit', '200,000', 'Session cost', '€0.12 EUR']);
    expect(within(details(view)).getByText('Reported by the agent. Cost is cumulative for this session.')).toBeDefined();
    expect(view.takePosted()).toEqual([]);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(within(view.container).queryByRole('region', { name: 'Session usage details' })).toBeNull();
  });

  it('omits cost from the readout and details when none is reported', () => {
    const view = renderInputArea();
    view.connect();
    view.send({ type: 'usage', usage: { used: 1234, size: 5678, cost: null } });

    expect(control(view).textContent).toBe('1,234 / 5,678 tokens');
    fireEvent.click(control(view));
    expect(fields(view)).toEqual(['Tokens in context', '1,234', 'Context window limit', '5,678']);
    expect(within(details(view)).getByText('Reported by the agent.')).toBeDefined();
  });

  it('shows zero context and zero cost as reported values', () => {
    const view = renderInputArea();
    view.connect();
    view.send({ type: 'usage', usage: { used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } } });

    expect(control(view).textContent).toBe('0 / 0 tokens · ¥0.00');
    fireEvent.click(control(view));
    expect(fields(view)).toEqual(['Tokens in context', '0', 'Context window limit', '0', 'Session cost', '¥0.00 JPY']);
  });

  it('groups long token counts without abbreviation and rounds small costs only in the presentation', () => {
    const view = renderInputArea();
    view.connect();
    const usage = { used: 9007199254740990, size: 9007199254740991, cost: { amount: 0.000000123456789, currency: 'KWD' } };
    view.send({ type: 'usage', usage });

    expect(control(view).textContent).toBe('9,007,199,254,740,990 / 9,007,199,254,740,991 tokens · KWD\u00a00.00');
    fireEvent.click(control(view));
    expect(fields(view)).toEqual(['Tokens in context', '9,007,199,254,740,990', 'Context window limit', '9,007,199,254,740,991', 'Session cost', 'KWD\u00a00.00']);
    expect(view.usage()).toEqual(usage);
  });

  it.each([
    { amount: 11.931669815, currency: 'USD', collapsed: '$11.93', expanded: '$11.93 USD' },
    { amount: 11.939, currency: 'USD', collapsed: '$11.94', expanded: '$11.94 USD' },
    { amount: 1.005, currency: 'EUR', collapsed: '€1.01', expanded: '€1.01 EUR' },
    { amount: 11.939, currency: 'CAD', collapsed: 'CA$11.94', expanded: 'CA$11.94 CAD' },
    { amount: 11.939, currency: 'KWD', collapsed: 'KWD\u00a011.94', expanded: 'KWD\u00a011.94' },
    { amount: 11.939, currency: 'ZZZ', collapsed: '11.94 ZZZ', expanded: '11.94 ZZZ' },
    { amount: 11.939, currency: 'CNH', collapsed: '11.94 CNH', expanded: '11.94 CNH' },
    { amount: 11.939, currency: 'usd', collapsed: '11.94 usd', expanded: '11.94 usd' },
    { amount: 11.939, currency: 'credits', collapsed: '11.94 credits', expanded: '11.94 credits' },
  ])('presents $currency $amount with normal two-place rounding and unambiguous details', ({ amount, currency, collapsed, expanded }) => {
    const view = renderInputArea();
    view.connect();
    const usage = { used: 254264, size: 272000, cost: { amount, currency } };
    view.send({ type: 'usage', usage });

    expect(control(view).textContent).toBe(`254,264 / 272,000 tokens · ${collapsed}`);
    fireEvent.click(control(view));
    expect(fields(view)).toEqual(['Tokens in context', '254,264', 'Context window limit', '272,000', 'Session cost', expanded]);
    expect(view.usage()).toEqual(usage);
  });

  it('updates the readout and open details live, removing an old cost and preserving the prompt draft', () => {
    const view = renderInputArea();
    view.connect();
    view.type('unfinished prompt');
    view.send(report);
    fireEvent.click(control(view));

    view.send({ type: 'usage', usage: { used: 15000, size: 100000, cost: null } });

    expect(control(view).getAttribute('aria-expanded')).toBe('true');
    expect(control(view).textContent).toBe('15,000 / 100,000 tokens');
    expect(fields(view)).toEqual(['Tokens in context', '15,000', 'Context window limit', '100,000']);
    expect(view.prompt().value).toBe('unfinished prompt');
    expect(view.takePosted()).toEqual([]);
  });

  it('uses a focusable native button and handles Escape without sending or clearing a prompt', () => {
    const view = renderInputArea();
    view.connect();
    view.type('unfinished prompt');
    view.send(report);
    const button = control(view) as HTMLButtonElement;

    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('90,000 / 200,000 tokens · €0.12');
    button.focus();
    // Browsers send a click with no pointer detail for native keyboard activation.
    fireEvent.click(button, { detail: 0 });
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(details(view), { key: 'Escape' });

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(view.prompt().value).toBe('unfinished prompt');
    expect(view.takePosted()).toEqual([]);
  });

  it('keeps details open when focus moves inside them, and dismisses them when focus returns to the prompt', () => {
    const view = renderInputArea();
    view.connect();
    view.send(report);
    const button = control(view);
    act(() => button.focus());
    fireEvent.click(button);

    act(() => details(view).focus());
    expect(button.getAttribute('aria-expanded')).toBe('true');

    act(() => view.prompt().focus());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(within(view.container).queryByRole('region', { name: 'Session usage details' })).toBeNull();
  });

  it.each(['Escape', 'click'] as const)('restores the prior prompt focus and selection on %s dismissal', (dismiss) => {
    const view = renderInputArea();
    view.connect();
    view.send(report);
    view.type('unfinished prompt');
    const prompt = view.prompt();
    act(() => prompt.focus());
    prompt.setSelectionRange(2, 7);
    const button = control(view);
    fireEvent.pointerDown(button);
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    act(() => details(view).focus());

    if (dismiss === 'Escape') {
      fireEvent.keyDown(details(view), { key: 'Escape' });
    } else {
      fireEvent.pointerDown(button);
      act(() => button.focus());
      fireEvent.click(button, { detail: 1 });
    }

    expect(within(view.container).queryByRole('region', { name: 'Session usage details' })).toBeNull();
    expect(document.activeElement).toBe(prompt);
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([2, 7]);
    expect(prompt.value).toBe('unfinished prompt');
    expect(view.takePosted()).toEqual([]);
  });

  it('keeps newly chosen focus and remembers a different return target on the next opening', () => {
    const view = renderInputArea();
    view.connect({ pickers: [{ id: 'model', name: 'Model', category: 'model', description: null, current: 'a', groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }] }] }] });
    view.send(report);
    const button = control(view);
    const picker = view.part<HTMLButtonElement>('.picker-btn');
    act(() => view.prompt().focus());
    fireEvent.pointerDown(button);
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });

    act(() => picker.focus());
    expect(within(view.container).queryByRole('region', { name: 'Session usage details' })).toBeNull();
    expect(document.activeElement).toBe(picker);

    fireEvent.pointerDown(button);
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    fireEvent.keyDown(button, { key: 'Escape' });

    expect(document.activeElement).toBe(picker);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(view.takePosted()).toEqual([]);
  });

  it.each(['disabled', 'removed'] as const)('falls back to the readout when the return target is %s', (unavailable) => {
    const view = renderInputArea();
    view.connect();
    view.send(report);
    const button = control(view);
    act(() => view.prompt().focus());
    fireEvent.pointerDown(button);
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    act(() => details(view).focus());
    if (unavailable === 'disabled') {
      view.send({ type: 'sessionEnded', message: 'Fake exited.' });
    } else {
      view.prompt().remove();
    }

    fireEvent.keyDown(details(view), { key: 'Escape' });

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('removes the control on load start and starts a fresh report with details closed', () => {
    const view = renderInputArea();
    view.connect();
    view.send(report);
    fireEvent.click(control(view));

    view.send({ type: 'loadSessionStart' });
    expect(within(view.container).queryByRole('button', { name: 'Session usage' })).toBeNull();
    view.send(report);
    expect(control(view).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps details usable with an ended session transcript even though the prompt is disabled', () => {
    const view = renderInputArea();
    view.connect();
    view.send(report);
    view.send({ type: 'sessionEnded', message: 'Fake exited.' });
    view.send({ type: 'state', activeSessionId: null, session: null });

    expect(view.prompt().disabled).toBe(true);
    expect((control(view) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(control(view));
    expect(fields(view)).toEqual(['Tokens in context', '90,000', 'Context window limit', '200,000', 'Session cost', '€0.12 EUR']);
  });
});

describe('slash command popup', () => {
  it("lists matching commands with their descriptions and any input hint, and scrolls the highlighted one into view", () => {
    const view = renderInputArea();
    view.connect();

    view.type('/');

    expect(view.popupOpen()).toBe(true);
    expect(view.items().map((item) => [item.querySelector('.cmd-name')?.textContent, item.querySelector('.cmd-hint')?.textContent ?? null, item.querySelector('.cmd-desc')?.textContent])).toEqual([
      ['/init', null, 'Initialize the project'],
      ['/review', 'What to review', 'Review changes'],
    ]);
    expect(scrolledIntoView).toEqual([view.items()[0]]);
  });

  it('moves the highlight with the arrow keys and the pointer, keeping the keys from the prompt box', () => {
    const view = renderInputArea();
    view.connect();
    view.type('/');
    const active = () => view.items().map((item) => item.classList.contains('active'));

    expect(view.press('ArrowDown')).toBe(false);
    expect(active()).toEqual([false, true]);
    expect(scrolledIntoView.at(-1)).toBe(view.items()[1]);

    expect(view.press('ArrowUp')).toBe(false);
    expect(active()).toEqual([true, false]);

    const second = view.items()[1];
    assert.exists(second);
    fireEvent.mouseEnter(second);
    expect(active()).toEqual([false, true]);
  });

  it('chooses the highlighted command with Tab or Enter', () => {
    const view = renderInputArea();
    view.connect();

    view.type('/in');
    expect(view.press('Enter')).toBe(false);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: '/init' }]);

    view.type('/re');
    expect(view.press('Tab')).toBe(false);
    expect(view.prompt().value).toBe('/review ');
    expect(view.popupOpen()).toBe(false);
  });

  it('adds a line on Shift+Enter instead of choosing', () => {
    const view = renderInputArea();
    view.connect();
    view.type('/');

    expect(view.press('Enter', { shiftKey: true })).toBe(true);
    expect(view.popupOpen()).toBe(true);
  });

  it('chooses a command by click and returns focus to the prompt box', () => {
    const view = renderInputArea();
    view.connect();
    view.type('/');

    const review = view.items()[1];
    assert.exists(review);
    fireEvent.click(review);

    expect(view.prompt().value).toBe('/review ');
    expect(document.activeElement).toBe(view.prompt());
  });

  it('closes on Escape without sending', () => {
    const view = renderInputArea();
    view.connect();
    view.type('/');

    expect(view.press('Escape')).toBe(false);

    expect(view.popupOpen()).toBe(false);
    expect(view.items()).toEqual([]);
    expect(view.takePosted()).toEqual([]);
  });
});

describe('resize handle', () => {
  it('sets the input area height while dragged, between 90 and 400 pixels, until released', () => {
    const view = renderInputArea();
    const area = view.part('#inputArea');
    vi.spyOn(area, 'offsetHeight', 'get').mockReturnValue(140);
    const handle = view.part('#resizeHandle');

    expect(fireEvent.mouseDown(handle, { clientY: 500 })).toBe(false);
    fireEvent.mouseMove(document, { clientY: 450 });
    expect(area.style.height).toBe('190px');

    fireEvent.mouseMove(document, { clientY: 0 });
    expect(area.style.height).toBe('400px');

    fireEvent.mouseMove(document, { clientY: 1000 });
    expect(area.style.height).toBe('90px');

    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientY: 450 });
    expect(area.style.height).toBe('90px');
  });

  it('leaves the height to the layout until it is dragged', () => {
    const view = renderInputArea();

    expect(view.part('#inputArea').style.height).toBe('');
  });
});
