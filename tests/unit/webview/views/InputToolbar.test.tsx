// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Picker, SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { InputToolbar } from '@/webview/views/InputToolbar';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
const SESSION_ID = 'b6a7edcb-d5c3-40b4-a121-341f88837580';
const target = { configuredName: 'fake', sessionId: SESSION_ID, generation: 1, projection: 1 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const modePicker: Picker = {
  id: 'mode',
  category: 'mode',
  name: 'Mode',
  description: null,
  current: 'ask',
  groups: [{ header: null, values: [{ id: 'ask', name: 'Ask', description: 'Questions only' }, { id: 'code', name: 'Code', description: null }] }],
};

const modelPicker: Picker = {
  id: 'model',
  category: 'model',
  name: 'Model',
  description: null,
  current: 'a',
  groups: [{
    header: null,
    values: [
      { id: 'a', name: 'Model A', description: 'Fast' },
      { id: 'b', name: 'Model B', description: 'Smart' },
      { id: 'c', name: '', description: null },
    ],
  }],
};

function renderToolbar(session: Partial<SessionSnapshot>) {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message));
  const send = (action: Action) => act(() => store.dispatch(action));
  const { container } = render(
    <StoreContext value={store}>
      <InputToolbar />
    </StoreContext>,
  );
  send({
    type: 'state',
    activeSessionId: session.sessionId ?? SESSION_ID,
    session: { sessionId: SESSION_ID, agentName: 'Fake', cwd: '/work', pickers: [], commands: [], ...session },
  });
      send({ type: 'contentSnapshot', queue: [], composer: { text: '', revision: 0 }, target: { ...target, sessionId: session.sessionId ?? SESSION_ID }, revision: 0, entries: [], currentTurn: null, nextId: 1, usage: null, terminals: [] });
  return { container, send, takePosted: () => posted.splice(0) };
}

function element<T extends Element = HTMLElement>(container: HTMLElement, selector: string): T {
  const found = container.querySelector<T & Element>(selector);
  if (!found) {
    throw new Error(`nothing matches ${selector}`);
  }
  return found;
}

function item(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.picker-dropdown-item')].find(
    (candidate) => candidate.querySelector('.item-label')?.textContent === label,
  );
  if (!found) {
    throw new Error(`no item ${label}`);
  }
  return found;
}

function rect(box: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height } as DOMRect;
}

it('refuses to render outside a StoreContext', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  expect(() => render(<InputToolbar />)).toThrow('Chat view components must render inside a StoreContext.');
});

describe('pickers', () => {
  it('keeps cancel at the right of the pickers, disabled when idle, without a tooltip', () => {
    const { container, takePosted } = renderToolbar({ pickers: [modelPicker] });
    const stop = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel current turn' });
    expect(stop.disabled).toBe(true);
    expect(stop.hasAttribute('title')).toBe(false);
    expect(stop.classList.contains('text-muted-foreground')).toBe(true);
    expect(stop.classList.contains('focus-visible:outline-ring')).toBe(true);
    expect(stop.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(element(container, '.toolbar-spacer').nextElementSibling).toBe(stop);
    fireEvent.click(stop);
    expect(takePosted()).toEqual([]);
  });

  it('cancels the displayed session during foreground work and disables again at idle', () => {
    const { send, takePosted } = renderToolbar({});
    const stop = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel current turn' });
    send({ type: 'foregroundActivity', running: true });
    expect(stop.disabled).toBe(false);
    expect(stop.classList.contains('text-failure')).toBe(true);
    fireEvent.click(stop);
    expect(takePosted()).toEqual([{ type: 'cancelTurn', target }]);
    send({ type: 'foregroundActivity', running: false });
    expect(stop.disabled).toBe(true);
    send({ type: 'cancelTurnRequested' });
    expect(takePosted()).toEqual([]);
    send({ type: 'state', activeSessionId: null, session: null });
    expect(stop.disabled).toBe(true);
  });

  it('moves focus into the menu and navigates values without choosing them', () => {
    const { container, takePosted } = renderToolbar({ pickers: [modelPicker] });
    const trigger = element(container, '.picker-btn');
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 });
    expect(document.activeElement).toBe(item(container, 'Model A'));
    let focused = item(container, 'Model A');
    for (const [key, label] of [
      ['ArrowDown', 'Model B'], ['End', 'c'], ['ArrowDown', 'Model A'],
      ['ArrowUp', 'c'], ['Home', 'Model A'],
    ] as const) {
      fireEvent.keyDown(focused, { key });
      focused = item(container, label);
      expect(document.activeElement).toBe(focused);
    }
    expect(takePosted()).toEqual([]);
    fireEvent.keyDown(focused, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('restores trigger focus after choosing a menu value', () => {
    const { container, takePosted } = renderToolbar({ pickers: [modelPicker] });
    const trigger = element(container, '.picker-btn');
    fireEvent.click(trigger);
    const choice = item(container, 'Model B');
    choice.focus();
    fireEvent.click(choice, { detail: 0 });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(takePosted()).toEqual([{ type: 'pickerValueChosen', target, pickerId: 'model', value: 'b' }]);
  });

  it("shows the session's pickers in order, and none for a session without any", () => {
    const pickerIds = (container: HTMLElement) =>
      [...element(container, '#pickers').querySelectorAll<HTMLElement>('[data-picker-id]')].map((el) => el.dataset['pickerId']);

    expect(pickerIds(renderToolbar({ pickers: [modePicker, modelPicker] }).container)).toEqual(['mode', 'model']);
    cleanup();
    expect(pickerIds(renderToolbar({}).container)).toEqual([]);
  });

  it("shows the current value's name and description without category icons", () => {
    const { container } = renderToolbar({ pickers: [modePicker, modelPicker] });

    const model = element(container, '[data-picker-id="model"] .picker-btn');
    expect(model.title).toBe('Fast');
    expect(model.querySelector('.picker-icon')).toBeNull();
    expect(model.getAttribute('aria-haspopup')).toBe('menu');
    expect(model.getAttribute('aria-expanded')).toBe('false');
    expect(model.querySelector('.picker-chevron')?.getAttribute('aria-hidden')).toBe('true');
    expect(element(model, '.picker-label').textContent).toBe('Model A');

    const mode = element(container, '[data-picker-id="mode"] .picker-btn');
    expect(mode.title).toBe('Questions only');
    expect(mode.querySelector('.picker-icon')).toBeNull();
    expect(element(mode, '.picker-label').textContent).toBe('Ask');
  });

  it("falls back to the picker's description, then its name, when the value has none", () => {
    const { container, send } = renderToolbar({ pickers: [{ ...modelPicker, current: 'c', description: 'Which model' }] });
    expect(element(container, '.picker-btn').title).toBe('Which model');
    expect(element(container, '.picker-label').textContent).toBe('Model');

    send({ type: 'pickers', pickers: [{ ...modelPicker, current: 'c', category: 'other' }] });
    expect(element(container, '.picker-btn').title).toBe('Model');
    expect(container.querySelector('.picker-icon')).toBeNull();

    send({ type: 'pickers', pickers: [{ ...modelPicker, current: 'c', name: '' }] });
    expect(element(container, '.picker-label').textContent).toBe('Option');
  });

  it('marks the current value and labels a nameless value by its ID', () => {
    const { container } = renderToolbar({ pickers: [modelPicker] });

    const items = [...container.querySelectorAll<HTMLElement>('.picker-dropdown-item')];
    expect(items.map((el) => [
      el.dataset['value'],
      el.textContent,
      el.classList.contains('selected'),
      el.getAttribute('role'),
      el.getAttribute('aria-checked'),
      el.querySelector('.check svg')?.classList.contains('invisible'),
    ])).toEqual([
      ['a', 'Model A', true, 'menuitemradio', 'true', false],
      ['b', 'Model B', false, 'menuitemradio', 'false', true],
      ['c', 'c', false, 'menuitemradio', 'false', true],
    ]);
    expect(items[0]?.title).toBe('Fast');
  });

  it('shows group headers above their values', () => {
    const { container } = renderToolbar({
      pickers: [{
        ...modelPicker,
        groups: [
          { header: 'Fast models', values: [{ id: 'a', name: 'Model A', description: null }] },
          { header: 'Smart models', values: [{ id: 'b', name: 'Model B', description: null }] },
        ],
      }],
    });

    const dropdown = element(container, '.picker-dropdown');
    expect(dropdown.getAttribute('role')).toBe('menu');
    expect([...dropdown.children].map((el) => el.textContent)).toEqual(['Fast models', 'Model A', 'Smart models', 'Model B']);
  });

  it('opens from its button without the click reaching the document, and posts the chosen value', () => {
    const { container, takePosted } = renderToolbar({ pickers: [modelPicker] });
    const reachedDocument = vi.fn();
    document.addEventListener('click', reachedDocument);
    takePosted();

    fireEvent.click(element(container, '.picker-btn'));
    expect(element(container, '.picker-dropdown').classList.contains('open')).toBe(true);
    fireEvent.click(item(container, 'Model B'));

    document.removeEventListener('click', reachedDocument);
    expect(reachedDocument).not.toHaveBeenCalled();
    expect(takePosted()).toEqual([{ type: 'pickerValueChosen', target, pickerId: 'model', value: 'b' }]);
    expect(element(container, '.picker-label').textContent).toBe('Model B');
    expect(element(container, '.picker-dropdown').classList.contains('open')).toBe(false);
  });
});

describe('the tooltip', () => {
  function hoverable() {
    const toolbar = renderToolbar({ pickers: [modelPicker] });
    fireEvent.click(element(toolbar.container, '.picker-btn'));
    const tooltip = element(toolbar.container, '#pickerTooltip');
    return { ...toolbar, tooltip };
  }

  function layout(
    container: HTMLElement,
    tooltip: HTMLElement,
    boxes: { dropdown: Parameters<typeof rect>[0]; item: Parameters<typeof rect>[0] },
  ) {
    vi.spyOn(element(container, '.picker-dropdown'), 'getBoundingClientRect').mockReturnValue(rect(boxes.dropdown));
    vi.spyOn(item(container, 'Model A'), 'getBoundingClientRect').mockReturnValue(rect(boxes.item));
    vi.spyOn(tooltip, 'getBoundingClientRect').mockReturnValue(rect({ left: -9999, top: -9999, width: 100, height: 40 }));
  }

  it("shows the hovered item's description to the left of its dropdown, level with the item", () => {
    const { container, tooltip } = hoverable();
    layout(container, tooltip, {
      dropdown: { left: 400, top: 200, width: 200, height: 300 },
      item: { left: 400, top: 300, width: 200, height: 20 },
    });

    fireEvent.mouseOver(item(container, 'Model A'));

    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.textContent).toBe('Fast');
    expect([tooltip.style.left, tooltip.style.top]).toEqual(['294px', '300px']);
  });

  it('moves to the right of the dropdown when the left has no room, and stays inside the viewport', () => {
    const { container, tooltip } = hoverable();
    layout(container, tooltip, {
      dropdown: { left: 50, top: 600, width: 200, height: 300 },
      item: { left: 50, top: window.innerHeight - 10, width: 200, height: 20 },
    });

    fireEvent.mouseOver(item(container, 'Model A'));

    expect([tooltip.style.left, tooltip.style.top]).toEqual(['256px', `${window.innerHeight - 44}px`]);
  });

  it('follows the pointer from item to item, and hides when it leaves the items', () => {
    const { container, tooltip } = hoverable();

    fireEvent.mouseOver(item(container, 'Model A'));
    fireEvent.mouseOut(item(container, 'Model A'), { relatedTarget: element(item(container, 'Model B'), '.item-label') });
    expect(tooltip.textContent).toBe('Smart');

    fireEvent.mouseOut(item(container, 'Model B'), { relatedTarget: element(container, '.picker-btn') });
    expect(tooltip.classList.contains('visible')).toBe(false);
  });

  it("stays while the pointer moves within an item's own text", () => {
    const { container, tooltip } = hoverable();
    const hovered = item(container, 'Model A');

    fireEvent.mouseOver(hovered);
    fireEvent.mouseOut(hovered, { relatedTarget: element(hovered, '.item-label') });

    expect(tooltip.textContent).toBe('Fast');
    expect(tooltip.classList.contains('visible')).toBe(true);
  });

  it('hides when the dropdown scrolls or an item without a description is hovered', () => {
    const { container, tooltip } = hoverable();

    fireEvent.mouseOver(item(container, 'Model A'));
    fireEvent.scroll(element(container, '.picker-dropdown'));
    expect(tooltip.classList.contains('visible')).toBe(false);

    fireEvent.mouseOver(item(container, 'Model A'));
    fireEvent.mouseOver(item(container, 'c'));
    expect(tooltip.classList.contains('visible')).toBe(false);
  });
});
