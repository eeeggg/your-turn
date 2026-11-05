import { describe, expect, it } from 'vitest';
import type { Picker } from '@/shared/WebviewMessages';
import { connect, loadChatPage, type ChatPage } from '@tests/webview/chatPage';

let page: ChatPage;

const modelPicker: Picker = {
  id: 'model',
  category: 'model',
  name: 'Model',
  description: null,
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: 'Fast' }, { id: 'b', name: 'Model B', description: null }] }],
};

const modePicker: Picker = {
  id: 'mode',
  category: 'mode',
  name: 'Mode',
  description: null,
  current: 'ask',
  groups: [{ header: null, values: [{ id: 'ask', name: 'Ask', description: 'Questions only' }, { id: 'code', name: 'Code', description: null }] }],
};

function pickers(): HTMLElement[] {
  return [...page.byId('pickers').querySelectorAll<HTMLElement>('.picker-wrap')];
}

function pickerIds(): (string | undefined)[] {
  return pickers().map((el) => el.dataset['pickerId']);
}

function picker(pickerId: string): HTMLElement {
  const wrap = pickers().find((el) => el.dataset['pickerId'] === pickerId);
  if (!wrap) {
    throw new Error(`no picker ${pickerId}`);
  }
  return wrap;
}

function label(wrap: HTMLElement): string | null | undefined {
  return wrap.querySelector('.picker-btn .picker-label')?.textContent;
}

function item(wrap: HTMLElement, value: string): HTMLElement {
  const el = [...wrap.querySelectorAll<HTMLElement>('.picker-dropdown-item')].find((candidate) => candidate.dataset['value'] === value);
  if (!el) {
    throw new Error(`no item ${value}`);
  }
  return el;
}

describe('pickers', () => {
  it("renders the session's pickers in order, each with its current value, icon and description", () => {
    page = loadChatPage();
    connect(page, { pickers: [modePicker, modelPicker] });

    expect(pickerIds()).toEqual(['mode', 'model']);
    const model = picker('model');
    expect(label(model)).toBe('Model A');
    expect(model.querySelector('.picker-icon')?.textContent).toBe('🧠');
    expect(model.querySelector<HTMLButtonElement>('.picker-btn')?.title).toBe('Fast');
    const mode = picker('mode');
    expect(label(mode)).toBe('Ask');
    expect(mode.querySelector('.picker-icon')?.textContent).toBe('⚡');
    expect(mode.querySelector<HTMLButtonElement>('.picker-btn')?.title).toBe('Questions only');
  });

  it('opens and closes the dropdown from its button and closes on outside clicks', () => {
    page = loadChatPage();
    connect(page, { pickers: [modelPicker] });
    const wrap = picker('model');
    const button = wrap.querySelector<HTMLElement>('.picker-btn');
    const dropdown = wrap.querySelector('.picker-dropdown');

    button?.click();
    expect(dropdown?.classList.contains('open')).toBe(true);
    button?.click();
    expect(dropdown?.classList.contains('open')).toBe(false);

    button?.click();
    page.document.body.click();
    expect(dropdown?.classList.contains('open')).toBe(false);
  });

  it('posts the chosen value and updates the label when a new value is chosen', () => {
    page = loadChatPage();
    connect(page, { pickers: [modePicker, modelPicker] });
    page.takePosted();
    picker('mode').querySelector<HTMLElement>('.picker-btn')?.click();

    item(picker('mode'), 'code').click();

    expect(page.takePosted()).toEqual([{ type: 'pickerValueChosen', pickerId: 'mode', value: 'code' }]);
    expect(label(picker('mode'))).toBe('Code');
    expect(item(picker('mode'), 'code').classList.contains('selected')).toBe(true);
    expect(picker('mode').querySelector('.picker-dropdown')?.classList.contains('open')).toBe(false);
  });

  it('posts nothing when the current value is chosen again', () => {
    page = loadChatPage();
    connect(page, { pickers: [modelPicker] });
    page.takePosted();

    item(picker('model'), 'a').click();

    expect(page.takePosted()).toEqual([]);
  });

  it('renders grouped values under group headers', () => {
    page = loadChatPage();
    connect(page, {
      pickers: [{
        ...modelPicker,
        current: 'c',
        groups: [
          { header: 'Fast models', values: [{ id: 'a', name: 'Model A', description: null }] },
          { header: 'Smart models', values: [{ id: 'c', name: 'Model C', description: null }] },
        ],
      }],
    });

    const headers = [...picker('model').querySelectorAll('.picker-dropdown-group-header')];
    expect(headers.map((el) => el.textContent)).toEqual(['Fast models', 'Smart models']);
    expect(label(picker('model'))).toBe('Model C');
  });

  it('replaces the pickers with the ones the extension sends', () => {
    page = loadChatPage();
    connect(page, { pickers: [modelPicker] });

    page.send({ type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] });
    expect(label(picker('model'))).toBe('Model B');

    page.send({ type: 'pickers', pickers: [modePicker] });
    expect(pickerIds()).toEqual(['mode']);
  });

  it('shows the description of a hovered item in the tooltip', () => {
    page = loadChatPage();
    connect(page, { pickers: [modelPicker] });
    const wrap = picker('model');
    wrap.querySelector<HTMLElement>('.picker-btn')?.click();

    item(wrap, 'a').dispatchEvent(new page.window.MouseEvent('mouseover', { bubbles: true }));

    const tooltip = page.byId('pickerTooltip');
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.textContent).toBe('Fast');
  });
});

describe('without a session', () => {
  it('shows no pickers once the session ends or the transcript is cleared', () => {
    page = loadChatPage();
    connect(page, { pickers: [modelPicker] });
    page.send({ type: 'state', activeSessionId: null, session: null });
    expect(pickers()).toEqual([]);

    connect(page, { pickers: [modePicker] });
    page.send({ type: 'clearTranscript' });
    expect(pickers()).toEqual([]);
  });

  it("shows none when the next session's agent has none", () => {
    page = loadChatPage();
    connect(page, { pickers: [modePicker] });

    connect(page, { sessionId: 's2', agentName: 'Other Agent' });

    expect(pickers()).toEqual([]);
  });
});
