import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, loadChatPage, sessionSnapshot, update, type ChatPage } from './chatPage';

let page: ChatPage;

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

const modelOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [
    { value: 'a', name: 'Model A', description: 'Fast' },
    { value: 'b', name: 'Model B' },
  ],
} satisfies SessionConfigOption;

const legacyModes = {
  availableModes: [
    { id: 'ask', name: 'Ask', description: 'Questions only' },
    { id: 'code', name: 'Code' },
  ],
  currentModeId: 'ask',
} satisfies SessionModeState;

function pickers(): HTMLElement[] {
  return [...page.byId('configOptionsContainer').querySelectorAll<HTMLElement>('.picker-wrap')];
}

function picker(configId: string): HTMLElement {
  const wrap = pickers().find((el) => el.dataset['configId'] === configId);
  if (!wrap) {
    throw new Error(`no picker for ${configId}`);
  }
  return wrap;
}

function label(wrap: HTMLElement): string | null | undefined {
  return wrap.querySelector('.picker-btn .picker-label')?.textContent;
}

function item(dropdown: Element, value: string): HTMLElement {
  const el = [...dropdown.querySelectorAll<HTMLElement>('.picker-dropdown-item')].find(
    (candidate) => candidate.dataset['value'] === value || candidate.textContent.includes(value),
  );
  if (!el) {
    throw new Error(`no item ${value}`);
  }
  return el;
}

describe('session config option pickers', () => {
  it('renders a picker for each select option and skips the rest', () => {
    page = loadChatPage();
    page.sendUnchecked({
      type: 'state',
      activeSessionId: 's1',
      session: {
        ...sessionSnapshot(),
        configOptions: [
          modelOption,
          { id: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
          { id: 'empty', name: 'Empty', type: 'select', currentValue: null, options: [] },
        ],
      },
    });

    expect(pickers().map((el) => el.dataset['configId'])).toEqual(['model']);
    const wrap = picker('model');
    expect(label(wrap)).toBe('Model A');
    expect(wrap.querySelector('.picker-icon')?.textContent).toBe('🧠');
    expect(wrap.querySelector<HTMLButtonElement>('.picker-btn')?.title).toBe('Fast');
  });

  it('hides the legacy mode picker when config options are present', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption], modes: legacyModes });

    expect(page.byId('modePickerWrap').classList.contains('hidden')).toBe(true);
  });

  it('opens and closes the dropdown from its button and closes on outside clicks', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });
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

  it('posts setConfigOption and updates the label when a new value is chosen', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });
    page.takePosted();
    const wrap = picker('model');
    wrap.querySelector<HTMLElement>('.picker-btn')?.click();

    item(wrap, 'b').click();

    expect(page.takePosted()).toEqual([{ type: 'setConfigOption', configId: 'model', value: 'b' }]);
    expect(label(picker('model'))).toBe('Model B');
    expect(item(picker('model'), 'b').classList.contains('selected')).toBe(true);
    expect(picker('model').querySelector('.picker-dropdown')?.classList.contains('open')).toBe(false);
  });

  it('posts nothing when the current value is chosen again', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });
    page.takePosted();

    item(picker('model'), 'a').click();

    expect(page.takePosted()).toEqual([]);
  });

  it('renders grouped options under group headers', () => {
    page = loadChatPage();
    connect(page, {
      configOptions: [
        {
          ...modelOption,
          currentValue: 'c',
          options: [
            { group: 'fast', name: 'Fast models', options: [{ value: 'a', name: 'Model A' }] },
            { group: 'smart', name: 'Smart models', options: [{ value: 'c', name: 'Model C' }] },
          ],
        },
      ],
    });

    const headers = [...picker('model').querySelectorAll('.picker-dropdown-group-header')];
    expect(headers.map((el) => el.textContent)).toEqual(['Fast models', 'Smart models']);
    expect(label(picker('model'))).toBe('Model C');
  });

  it('replaces the pickers on configOptionsUpdate and config_option_update', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });

    page.send({ type: 'configOptionsUpdate', configOptions: [{ ...modelOption, currentValue: 'b' }] });
    expect(label(picker('model'))).toBe('Model B');

    update(page, 'config_option_update', { configOptions: [{ ...modelOption, id: 'other', name: 'Other' }] });
    expect(pickers().map((el) => el.dataset['configId'])).toEqual(['other']);
  });

  it('shows the description of a hovered item in the tooltip', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });
    const wrap = picker('model');
    wrap.querySelector<HTMLElement>('.picker-btn')?.click();

    item(wrap, 'a').dispatchEvent(new page.window.MouseEvent('mouseover', { bubbles: true }));

    const tooltip = page.byId('pickerTooltip');
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(tooltip.textContent).toBe('Fast');
  });
});

describe('legacy mode picker', () => {
  it('is shown when the agent has modes but no config options', () => {
    page = loadChatPage();
    connect(page, { modes: legacyModes });

    expect(page.byId('modePickerWrap').classList.contains('hidden')).toBe(false);
    expect(page.byId('modePickerLabel').textContent).toBe('Ask');
    expect(page.byId('modePickerLabel').title).toBe('Questions only');
  });

  it('posts setMode when a different mode is chosen', () => {
    page = loadChatPage();
    connect(page, { modes: legacyModes });
    page.takePosted();

    page.byId('modePickerBtn').click();
    expect(page.byId('modeDropdown').classList.contains('open')).toBe(true);
    item(page.byId('modeDropdown'), 'Code').click();

    expect(page.takePosted()).toEqual([{ type: 'setMode', modeId: 'code' }]);
    expect(page.byId('modePickerLabel').textContent).toBe('Code');
    expect(page.byId('modeDropdown').classList.contains('open')).toBe(false);
  });

  it('follows current_mode_update from the agent', () => {
    page = loadChatPage();
    connect(page, { modes: legacyModes });

    update(page, 'current_mode_update', { currentModeId: 'code' });

    expect(page.byId('modePickerLabel').textContent).toBe('Code');
  });

  it('is hidden again when modesUpdate carries no modes', () => {
    page = loadChatPage();
    connect(page, { modes: legacyModes });

    page.send({ type: 'modesUpdate', modes: null });

    expect(page.byId('modePickerWrap').classList.contains('hidden')).toBe(true);
  });

  it("is hidden when the next session's agent has no modes", () => {
    page = loadChatPage();
    connect(page, { modes: legacyModes });

    connect(page, { sessionId: 's2', agentName: 'Other Agent' });

    expect(page.byId('modePickerWrap').classList.contains('hidden')).toBe(true);
  });

  it('stays hidden when modesUpdate arrives for an agent with config options', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });

    page.send({ type: 'modesUpdate', modes: legacyModes });

    expect(page.byId('modePickerWrap').classList.contains('hidden')).toBe(true);
    expect(pickers().map((el) => el.dataset['configId'])).toEqual(['model']);
  });
});

describe('without a session', () => {
  it('shows no pickers once the session ends or the transcript is cleared', () => {
    page = loadChatPage();
    connect(page, { configOptions: [modelOption] });
    page.send({ type: 'state', activeSessionId: null, session: null });
    expect(pickers()).toEqual([]);

    connect(page, { modes: legacyModes });
    page.send({ type: 'clearTranscript' });
    expect(page.byId('modePickerWrap').classList.contains('hidden')).toBe(true);
  });
});
