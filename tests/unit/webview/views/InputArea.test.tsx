// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, SlashCommand, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { InputArea } from '@/webview/views/InputArea';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { hookClasses } from '@tests/hookClasses';

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
    send,
    part,
    prompt,
    button: () => part<HTMLButtonElement>('#sendStopBtn'),
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
  };
}

describe('input area', () => {
  it('is disabled without a session and while one loads', () => {
    const view = renderInputArea();
    const disabled = () => [view.part('#inputArea').classList.contains('disabled'), view.prompt().disabled, view.button().disabled];
    expect(disabled()).toEqual([true, true, true]);

    view.connect();
    expect(disabled()).toEqual([false, false, false]);

    view.send({ type: 'loadSessionStart' });
    expect(disabled()).toEqual([true, true, true]);
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

  it('turns Send into Stop while a turn runs, each doing its own job', () => {
    const view = renderInputArea();
    view.connect();
    view.type('hello');

    view.send({ type: 'promptStart' });
    expect([hookClasses(view.button()), view.button().textContent]).toEqual(['send-stop-btn stop', '■ Stop']);
    fireEvent.click(view.button());
    expect(view.takePosted()).toEqual([{ type: 'cancelTurn' }]);

    view.send({ type: 'promptEnd' });
    expect([hookClasses(view.button()), view.button().textContent]).toEqual(['send-stop-btn send', 'Send']);
    fireEvent.click(view.button());
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'hello' }]);
  });

  it('shows the placeholder for the session', () => {
    const view = renderInputArea();
    expect(view.prompt().placeholder).toBe('Type a message...');

    view.connect();
    expect(view.prompt().placeholder).toBe('Type a message or / for commands...');
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
