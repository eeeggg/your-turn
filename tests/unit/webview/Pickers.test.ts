import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/RootState';
import {
  categoryIcon,
  configPickers,
  currentValue,
  isOpen,
  showsModePicker,
  tooltipText,
  valueGroups,
  type PickerId,
  type PickersState,
  type SelectConfigOption,
} from '@/webview/Pickers';
import { createStore } from '@/webview/Store';

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
    { value: 'b', name: 'Model B' },
  ],
} satisfies SessionConfigOption;

const effortOption = {
  id: 'effort',
  name: 'Effort',
  type: 'select',
  currentValue: 'low',
  options: [
    { group: 'cheap', name: 'Cheap', options: [{ value: 'low', name: 'Low', description: 'Quick' }] },
    { group: 'dear', name: '', options: [{ value: 'high', name: 'High' }] },
  ],
} satisfies SessionConfigOption;

const mode: PickerId = { kind: 'mode' };
const model: PickerId = { kind: 'config', configId: 'model' };

function snapshot(session: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    agentName: 'Fake Agent',
    cwd: '/work',
    modes: null,
    configOptions: null,
    availableCommands: [],
    ...session,
  };
}

function chatView() {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message));
  return {
    pickers: (): PickersState => store.getSnapshot().pickers,
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    connect: (session: Partial<SessionSnapshot>) =>
      store.dispatch({ type: 'state', activeSessionId: 's1', session: snapshot(session) }),
    takePosted: () => posted.splice(0),
  };
}

describe('which pickers are shown', () => {
  it('shows a picker for each select option with values, and none for other types', () => {
    const view = chatView();

    view.connect({
      configOptions: [
        modelOption,
        { id: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
        { id: 'empty', name: 'Empty', type: 'select', currentValue: 'x', options: [] },
      ],
    });

    expect(configPickers(view.pickers()).map((option) => option.id)).toEqual(['model']);
  });

  it('shows the mode picker only for an agent with modes and no config options', () => {
    const view = chatView();

    view.connect({ modes });
    expect(showsModePicker(view.pickers())).toBe(true);

    view.connect({ modes, configOptions: [modelOption] });
    expect(showsModePicker(view.pickers())).toBe(false);

    view.connect({ modes: { availableModes: [], currentModeId: 'ask' } });
    expect(showsModePicker(view.pickers())).toBe(false);
  });

  it("drops the previous session's modes when the next session has none", () => {
    const view = chatView();
    view.connect({ modes });

    view.connect({ sessionId: 's2' });

    expect(showsModePicker(view.pickers())).toBe(false);
  });

  it('keeps the mode picker hidden when modesUpdate arrives for an agent with config options', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });

    view.send({ type: 'modesUpdate', modes });

    expect(showsModePicker(view.pickers())).toBe(false);
  });

  it('shows the mode picker once the agent replaces its config options with none', () => {
    const view = chatView();
    view.connect({ modes, configOptions: [modelOption] });

    view.send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate: 'config_option_update', configOptions: [] } });

    expect(showsModePicker(view.pickers())).toBe(true);
  });

  it('shows no pickers without a session or after the transcript is cleared', () => {
    const view = chatView();
    view.connect({ modes, configOptions: [modelOption] });
    view.send({ type: 'state', activeSessionId: null, session: null });
    expect(view.pickers()).toEqual({ modes: null, configOptions: [], open: null, hovered: null });

    view.connect({ modes, configOptions: [modelOption] });
    view.send({ type: 'clearTranscript' });
    expect(view.pickers()).toEqual({ modes: null, configOptions: [], open: null, hovered: null });
  });
});

describe('updates from the agent', () => {
  it('replaces the config options on configOptionsUpdate, treating null as none', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });

    view.send({ type: 'configOptionsUpdate', configOptions: [effortOption] });
    expect(configPickers(view.pickers()).map((option) => option.id)).toEqual(['effort']);

    view.send({ type: 'configOptionsUpdate', configOptions: null });
    expect(view.pickers().configOptions).toEqual([]);
  });

  it('follows current_mode_update, and ignores it without modes', () => {
    const view = chatView();
    view.send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } });
    expect(view.pickers().modes).toBeNull();

    view.connect({ modes });
    view.send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } });
    expect(view.pickers().modes?.currentModeId).toBe('code');
  });

  it('leaves the pickers alone for messages about other parts of the chat view', () => {
    const view = chatView();
    view.connect({ modes, configOptions: [modelOption] });
    const before = view.pickers();

    view.send({ type: 'promptStart' }, { type: 'error', message: 'x' });

    expect(view.pickers()).toBe(before);
  });

  it('leaves the pickers alone for other session updates', () => {
    const view = chatView();
    view.connect({ modes, configOptions: [modelOption] });
    const before = view.pickers();

    view.send({
      type: 'sessionUpdate',
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    });

    expect(view.pickers()).toBe(before);
  });
});

describe('opening and closing a dropdown', () => {
  it('opens a picker, closes it when toggled again, and keeps one open at a time', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption, effortOption] });
    const effort: PickerId = { kind: 'config', configId: 'effort' };

    view.send({ type: 'pickerToggled', picker: model });
    expect(isOpen(view.pickers(), model)).toBe(true);

    view.send({ type: 'pickerToggled', picker: effort });
    expect(isOpen(view.pickers(), model)).toBe(false);
    expect(isOpen(view.pickers(), effort)).toBe(true);

    view.send({ type: 'pickerToggled', picker: effort });
    expect(view.pickers().open).toBeNull();
  });

  it('closes on pickersClosed, and changes nothing when none is open', () => {
    const view = chatView();
    view.connect({ modes });
    const closed = view.pickers();
    view.send({ type: 'pickersClosed' });
    expect(view.pickers()).toBe(closed);

    view.send({ type: 'pickerToggled', picker: mode });
    view.send({ type: 'pickersClosed' });
    expect(view.pickers().open).toBeNull();
  });

  it("closes the dropdown when its picker goes away, so it does not reopen when the picker returns", () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });
    view.send({ type: 'pickerToggled', picker: model });

    view.send({ type: 'configOptionsUpdate', configOptions: [effortOption] });
    view.send({ type: 'configOptionsUpdate', configOptions: [modelOption] });

    expect(view.pickers().open).toBeNull();
  });

  it('keeps the dropdown open when the agent updates the options it shows', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });
    view.send({ type: 'pickerToggled', picker: model });

    view.send({ type: 'configOptionsUpdate', configOptions: [{ ...modelOption, currentValue: 'b' }] });

    expect(isOpen(view.pickers(), model)).toBe(true);
  });
});

describe('choosing a value', () => {
  it('posts setMode for a different mode, shows it as current, and closes the dropdown', () => {
    const view = chatView();
    view.connect({ modes });
    view.send({ type: 'pickerToggled', picker: mode });

    view.send({ type: 'modeChosen', modeId: 'code' });

    expect(view.takePosted()).toEqual([{ type: 'setMode', modeId: 'code' }]);
    expect(view.pickers().modes?.currentModeId).toBe('code');
    expect(view.pickers().open).toBeNull();
  });

  it('posts nothing for the current mode, or without modes, and still closes the dropdown', () => {
    const view = chatView();
    view.connect({ modes });
    view.send({ type: 'pickerToggled', picker: mode }, { type: 'modeChosen', modeId: 'ask' });
    expect(view.pickers().open).toBeNull();

    view.send({ type: 'clearTranscript' }, { type: 'modeChosen', modeId: 'code' });

    expect(view.takePosted()).toEqual([]);
  });

  it('posts setConfigOption for a different value and shows it until the agent answers', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption, effortOption] });
    view.send({ type: 'pickerToggled', picker: model });

    view.send({ type: 'configValueChosen', configId: 'model', value: 'b' });

    expect(view.takePosted()).toEqual([{ type: 'setConfigOption', configId: 'model', value: 'b' }]);
    expect(view.pickers().configOptions).toEqual([{ ...modelOption, currentValue: 'b' }, effortOption]);
    expect(view.pickers().open).toBeNull();

    view.send({ type: 'configOptionsUpdate', configOptions: [modelOption] });
    expect(view.pickers().configOptions).toEqual([modelOption]);
  });

  it('posts nothing for the current value, an unknown option, or an option that is not a select', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption, { id: 'flag', name: 'Flag', type: 'boolean', currentValue: true }] });

    view.send(
      { type: 'configValueChosen', configId: 'model', value: 'a' },
      { type: 'configValueChosen', configId: 'missing', value: 'a' },
      { type: 'configValueChosen', configId: 'flag', value: 'false' },
    );

    expect(view.takePosted()).toEqual([]);
  });
});

describe('the tooltip', () => {
  it("shows the description of a hovered item in the open dropdown", () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });
    view.send({ type: 'pickerToggled', picker: model });

    view.send({ type: 'pickerItemHovered', hovered: { picker: model, item: 'a' } });

    expect(tooltipText(view.pickers())).toBe('Fast');
  });

  it('shows mode and grouped value descriptions', () => {
    const view = chatView();
    view.connect({ modes });
    view.send({ type: 'pickerToggled', picker: mode }, { type: 'pickerItemHovered', hovered: { picker: mode, item: 'ask' } });
    expect(tooltipText(view.pickers())).toBe('Questions only');

    const effort: PickerId = { kind: 'config', configId: 'effort' };
    view.connect({ configOptions: [effortOption] });
    view.send({ type: 'pickerToggled', picker: effort }, { type: 'pickerItemHovered', hovered: { picker: effort, item: 'low' } });
    expect(tooltipText(view.pickers())).toBe('Quick');
  });

  it('shows nothing for an item without a description, or one that is gone', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });
    view.send({ type: 'pickerToggled', picker: model }, { type: 'pickerItemHovered', hovered: { picker: model, item: 'b' } });
    expect(tooltipText(view.pickers())).toBeNull();

    view.send({ type: 'pickerItemHovered', hovered: { picker: model, item: 'a' } });
    view.send({ type: 'configOptionsUpdate', configOptions: [{ ...modelOption, options: [{ value: 'b', name: 'Model B' }] }] });
    expect(tooltipText(view.pickers())).toBeNull();
  });

  it('ignores hovering a closed dropdown, and repeated hovers of the same item', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption] });
    view.send({ type: 'pickerItemHovered', hovered: { picker: model, item: 'a' } });
    expect(view.pickers().hovered).toBeNull();

    view.send({ type: 'pickerToggled', picker: model }, { type: 'pickerItemHovered', hovered: { picker: model, item: 'a' } });
    const hovered = view.pickers();
    view.send({ type: 'pickerItemHovered', hovered: { picker: model, item: 'a' } });
    expect(view.pickers()).toBe(hovered);
  });

  it('hides when the pointer leaves, a dropdown is toggled or closed, or a value is chosen', () => {
    const view = chatView();
    view.connect({ configOptions: [modelOption, effortOption] });
    const hover = { type: 'pickerItemHovered', hovered: { picker: model, item: 'a' } } as const;
    const open = { type: 'pickerToggled', picker: model } as const;

    view.send(open, hover, { type: 'pickerItemLeft' });
    expect(view.pickers().hovered).toBeNull();

    view.send(hover, { type: 'pickerToggled', picker: { kind: 'config', configId: 'effort' } });
    expect(view.pickers().hovered).toBeNull();

    view.send(open, hover, { type: 'pickersClosed' });
    expect(view.pickers().hovered).toBeNull();

    view.send(open, hover, { type: 'configValueChosen', configId: 'model', value: 'b' });
    expect(view.pickers().hovered).toBeNull();
  });
});

describe('what a config picker shows', () => {
  const effort = effortOption as SelectConfigOption;

  it("groups values under their group's name, or its ID when the name is empty", () => {
    expect(valueGroups(effort).map((group) => group.header)).toEqual(['Cheap', 'dear']);
    expect(valueGroups(modelOption).map((group) => group.header)).toEqual([undefined, undefined]);
  });

  it("shows the ACP category's icon, and a gear for other categories", () => {
    expect(['mode', 'model', 'thought_level', 'model_config', null, undefined].map(categoryIcon)).toEqual([
      '⚡',
      '🧠',
      '💭',
      '⚙',
      '⚙',
      '⚙',
    ]);
  });

  it('finds the current value inside groups', () => {
    expect(currentValue({ ...effort, currentValue: 'high' })?.name).toBe('High');
    expect(currentValue({ ...effort, currentValue: 'none' })).toBeUndefined();
  });
});
