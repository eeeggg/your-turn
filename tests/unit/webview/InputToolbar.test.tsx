// @vitest-environment jsdom
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/RootState';
import { InputToolbar } from '@/webview/InputToolbar';
import { createStore } from '@/webview/Store';
import { StoreContext } from '@/webview/StoreContext';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const modes: SessionModeState = {
  availableModes: [
    { id: 'ask', name: 'Ask', description: 'Questions only' },
    { id: 'code', name: 'Code' },
  ],
  currentModeId: 'ask',
};

const modelOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [
    { value: 'a', name: 'Model A', description: 'Fast' },
    { value: 'b', name: 'Model B', description: 'Smart' },
    { value: 'c', name: '' },
  ],
} satisfies SessionConfigOption;

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
    activeSessionId: 's1',
    session: { sessionId: 's1', agentName: 'Fake', cwd: '/work', modes: null, configOptions: null, availableCommands: [], ...session },
  });
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

describe('config option pickers', () => {
  it("shows the current value's name and description, and the category's icon", () => {
    const { container } = renderToolbar({ configOptions: [modelOption] });

    const button = element(container, '[data-config-id="model"] .picker-btn');
    expect(button.title).toBe('Fast');
    expect(element(button, '.picker-icon').textContent).toBe('🧠');
    expect(element(button, '.picker-label').textContent).toBe('Model A');
  });

  it("falls back to the option's description, then its name, when the value has none", () => {
    const { container, send } = renderToolbar({ configOptions: [{ ...modelOption, currentValue: 'c', description: 'Which model' }] });
    expect(element(container, '.picker-btn').title).toBe('Which model');
    expect(element(container, '.picker-label').textContent).toBe('Model');

    send({ type: 'configOptionsUpdate', configOptions: [{ ...modelOption, currentValue: 'c', category: 'other' }] });
    expect(element(container, '.picker-btn').title).toBe('Model');
    expect(element(container, '.picker-icon').textContent).toBe('⚙');

    send({ type: 'configOptionsUpdate', configOptions: [{ ...modelOption, currentValue: 'c', name: '' }] });
    expect(element(container, '.picker-label').textContent).toBe('Option');
  });

  it('marks the current value and labels a nameless value by its ID', () => {
    const { container } = renderToolbar({ configOptions: [modelOption] });

    const items = [...container.querySelectorAll<HTMLElement>('.picker-dropdown-item')];
    expect(items.map((el) => [el.dataset['value'], el.textContent, el.classList.contains('selected')])).toEqual([
      ['a', '✓Model A', true],
      ['b', 'Model B', false],
      ['c', 'c', false],
    ]);
    expect(items[0]?.title).toBe('Fast');
  });

  it('shows group headers above their values', () => {
    const { container } = renderToolbar({
      configOptions: [
        {
          ...modelOption,
          options: [
            { group: 'fast', name: 'Fast models', options: [{ value: 'a', name: 'Model A' }] },
            { group: 'smart', name: 'Smart models', options: [{ value: 'b', name: 'Model B' }] },
          ],
        },
      ],
    });

    const dropdown = element(container, '.picker-dropdown');
    expect([...dropdown.children].map((el) => el.textContent)).toEqual(['Fast models', '✓Model A', 'Smart models', 'Model B']);
  });

  it('opens from its button without the click reaching the document, and posts the chosen value', () => {
    const { container, takePosted } = renderToolbar({ configOptions: [modelOption] });
    const reachedDocument = vi.fn();
    document.addEventListener('click', reachedDocument);
    takePosted();

    fireEvent.click(element(container, '.picker-btn'));
    expect(element(container, '.picker-dropdown').classList.contains('open')).toBe(true);
    fireEvent.click(item(container, 'Model B'));

    document.removeEventListener('click', reachedDocument);
    expect(reachedDocument).not.toHaveBeenCalled();
    expect(takePosted()).toEqual([{ type: 'setConfigOption', configId: 'model', value: 'b' }]);
    expect(element(container, '.picker-label').textContent).toBe('Model B');
    expect(element(container, '.picker-dropdown').classList.contains('open')).toBe(false);
  });
});

describe('the mode picker', () => {
  it('is rendered hidden for an agent without modes', () => {
    renderToolbar({});

    expect(document.getElementById('modePickerWrap')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('modePickerLabel')?.textContent).toBe('Mode');
  });

  it("shows the current mode's name, with its description on the label", () => {
    const { send } = renderToolbar({ modes });
    const label = screen.getByText('Ask', { selector: '#modePickerLabel' });
    expect(label.title).toBe('Questions only');

    send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } });
    expect(label.textContent).toBe('Code');
    expect(label.hasAttribute('title')).toBe(false);
  });

  it('posts setMode for the chosen mode', () => {
    const { container, takePosted } = renderToolbar({ modes });
    takePosted();

    fireEvent.click(element(container, '#modePickerBtn'));
    expect(element(container, '#modeDropdown').classList.contains('open')).toBe(true);
    fireEvent.click(item(container, 'Code'));

    expect(takePosted()).toEqual([{ type: 'setMode', modeId: 'code' }]);
    expect(element(container, '#modeDropdown').classList.contains('open')).toBe(false);
  });
});

describe('the tooltip', () => {
  function hoverable() {
    const toolbar = renderToolbar({ configOptions: [modelOption] });
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
