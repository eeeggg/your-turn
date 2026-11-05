import { describe, expect, it } from 'vitest';
import type { Picker, SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import {
  categoryIcon,
  currentValue,
  isOpen,
  tooltipText,
  type PickersState
} from '@/webview/state/Pickers';
import { createStore } from '@/webview/state/Store';

const model: Picker = {
  id: 'model',
  category: 'model',
  name: 'Model',
  description: null,
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: 'Fast' }, { id: 'b', name: 'Model B', description: null }] }],
};

const effort: Picker = {
  id: 'effort',
  category: 'other',
  name: 'Effort',
  description: null,
  current: 'low',
  groups: [
    { header: 'Cheap', values: [{ id: 'low', name: 'Low', description: 'Quick' }] },
    { header: 'dear', values: [{ id: 'high', name: 'High', description: null }] },
  ],
};

function snapshot(session: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { sessionId: 's1', agentName: 'Fake Agent', cwd: '/work', pickers: [], commands: [], ...session };
}

function chatView() {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message));
  return {
    pickers: (): PickersState => store.getSnapshot().pickers,
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    connect: (pickers: Picker[]) =>
      store.dispatch({ type: 'state', activeSessionId: 's1', session: snapshot({ pickers }) }),
    takePosted: () => posted.splice(0),
  };
}

const empty: PickersState = { pickers: [], open: null, hovered: null };

describe('which pickers are shown', () => {
  it("shows the session's pickers, and replaces them when the extension sends new ones", () => {
    const view = chatView();

    view.connect([model]);
    expect(view.pickers().pickers).toEqual([model]);

    view.send({ type: 'pickers', pickers: [effort, model] });
    expect(view.pickers().pickers).toEqual([effort, model]);

    view.send({ type: 'pickers', pickers: [] });
    expect(view.pickers().pickers).toEqual([]);
  });

  it("drops the previous session's pickers when the next session has none", () => {
    const view = chatView();
    view.connect([model]);

    view.connect([]);

    expect(view.pickers().pickers).toEqual([]);
  });

  it('shows no pickers without a session or after the transcript is cleared', () => {
    const view = chatView();
    view.connect([model]);
    view.send({ type: 'state', activeSessionId: null, session: null });
    expect(view.pickers()).toEqual(empty);

    view.connect([model]);
    view.send({ type: 'clearTranscript' });
    expect(view.pickers()).toEqual(empty);
  });

  it('leaves the pickers alone for messages about other parts of the chat view', () => {
    const view = chatView();
    view.connect([model]);
    const before = view.pickers();

    view.send({ type: 'promptStart' }, { type: 'error', message: 'x' }, { type: 'agentText', messageId: null, text: 'hi' });

    expect(view.pickers()).toBe(before);
  });
});

describe('opening and closing a dropdown', () => {
  it('opens a picker, closes it when toggled again, and keeps one open at a time', () => {
    const view = chatView();
    view.connect([model, effort]);

    view.send({ type: 'pickerToggled', pickerId: 'model' });
    expect(isOpen(view.pickers(), 'model')).toBe(true);

    view.send({ type: 'pickerToggled', pickerId: 'effort' });
    expect(isOpen(view.pickers(), 'model')).toBe(false);
    expect(isOpen(view.pickers(), 'effort')).toBe(true);

    view.send({ type: 'pickerToggled', pickerId: 'effort' });
    expect(view.pickers().open).toBeNull();
  });

  it('closes on pickersClosed, and changes nothing when none is open', () => {
    const view = chatView();
    view.connect([model]);
    const closed = view.pickers();
    view.send({ type: 'pickersClosed' });
    expect(view.pickers()).toBe(closed);

    view.send({ type: 'pickerToggled', pickerId: 'model' });
    view.send({ type: 'pickersClosed' });
    expect(view.pickers().open).toBeNull();
  });

  it('closes the dropdown when its picker goes away, so it does not reopen when the picker returns', () => {
    const view = chatView();
    view.connect([model]);
    view.send({ type: 'pickerToggled', pickerId: 'model' });

    view.send({ type: 'pickers', pickers: [effort] });
    view.send({ type: 'pickers', pickers: [model] });

    expect(view.pickers().open).toBeNull();
  });

  it('keeps the dropdown open when the extension updates the picker it shows', () => {
    const view = chatView();
    view.connect([model]);
    view.send({ type: 'pickerToggled', pickerId: 'model' });

    view.send({ type: 'pickers', pickers: [{ ...model, current: 'b' }] });

    expect(isOpen(view.pickers(), 'model')).toBe(true);
  });
});

describe('choosing a value', () => {
  it('posts the choice of a different value, shows it as current until the extension answers, and closes the dropdown', () => {
    const view = chatView();
    view.connect([model, effort]);
    view.send({ type: 'pickerToggled', pickerId: 'model' });

    view.send({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

    expect(view.takePosted()).toEqual([{ type: 'pickerValueChosen', pickerId: 'model', value: 'b' }]);
    expect(view.pickers().pickers).toEqual([{ ...model, current: 'b' }, effort]);
    expect(view.pickers().open).toBeNull();

    view.send({ type: 'pickers', pickers: [model, effort] });
    expect(view.pickers().pickers).toEqual([model, effort]);
  });

  it('posts nothing for the current value or an unknown picker, and still closes the dropdown', () => {
    const view = chatView();
    view.connect([model]);
    view.send({ type: 'pickerToggled', pickerId: 'model' }, { type: 'pickerValueChosen', pickerId: 'model', value: 'a' });
    expect(view.pickers().open).toBeNull();

    view.send({ type: 'pickerValueChosen', pickerId: 'missing', value: 'a' });

    expect(view.takePosted()).toEqual([]);
  });
});

describe('the tooltip', () => {
  it('shows the description of a hovered value in the open dropdown, also inside groups', () => {
    const view = chatView();
    view.connect([model, effort]);

    view.send({ type: 'pickerToggled', pickerId: 'model' }, { type: 'pickerItemHovered', hovered: { pickerId: 'model', value: 'a' } });
    expect(tooltipText(view.pickers())).toBe('Fast');

    view.send({ type: 'pickerToggled', pickerId: 'effort' }, { type: 'pickerItemHovered', hovered: { pickerId: 'effort', value: 'low' } });
    expect(tooltipText(view.pickers())).toBe('Quick');
  });

  it('shows nothing for a value without a description, or one that is gone', () => {
    const view = chatView();
    view.connect([model]);
    view.send({ type: 'pickerToggled', pickerId: 'model' }, { type: 'pickerItemHovered', hovered: { pickerId: 'model', value: 'b' } });
    expect(tooltipText(view.pickers())).toBeNull();

    view.send({ type: 'pickerItemHovered', hovered: { pickerId: 'model', value: 'a' } });
    view.send({ type: 'pickers', pickers: [{ ...model, groups: [{ header: null, values: [{ id: 'b', name: 'Model B', description: null }] }] }] });
    expect(tooltipText(view.pickers())).toBeNull();
  });

  it('ignores hovering a closed dropdown, and repeated hovers of the same value', () => {
    const view = chatView();
    view.connect([model]);
    const hover = { type: 'pickerItemHovered', hovered: { pickerId: 'model', value: 'a' } } as const;
    view.send(hover);
    expect(view.pickers().hovered).toBeNull();

    view.send({ type: 'pickerToggled', pickerId: 'model' }, hover);
    const hovered = view.pickers();
    view.send(hover);
    expect(view.pickers()).toBe(hovered);
  });

  it('hides when the pointer leaves, a dropdown is toggled or closed, or a value is chosen', () => {
    const view = chatView();
    view.connect([model, effort]);
    const hover = { type: 'pickerItemHovered', hovered: { pickerId: 'model', value: 'a' } } as const;
    const open = { type: 'pickerToggled', pickerId: 'model' } as const;

    view.send(open, hover, { type: 'pickerItemLeft' });
    expect(view.pickers().hovered).toBeNull();

    view.send(hover, { type: 'pickerToggled', pickerId: 'effort' });
    expect(view.pickers().hovered).toBeNull();

    view.send(open, hover, { type: 'pickersClosed' });
    expect(view.pickers().hovered).toBeNull();

    view.send(open, hover, { type: 'pickerValueChosen', pickerId: 'model', value: 'b' });
    expect(view.pickers().hovered).toBeNull();
  });
});

describe('what a picker shows', () => {
  it("shows the category's icon, and a gear for other categories", () => {
    expect((['mode', 'model', 'thought_level', 'other'] as const).map(categoryIcon)).toEqual(['⚡', '🧠', '💭', '⚙']);
  });

  it('finds the current value inside groups', () => {
    expect(currentValue({ ...effort, current: 'high' })?.name).toBe('High');
    expect(currentValue({ ...effort, current: 'none' })).toBeUndefined();
  });
});
