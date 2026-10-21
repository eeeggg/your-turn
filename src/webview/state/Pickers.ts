import type { Picker, PickerCategory, PickerValue, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

/** A value in the open dropdown. */
export interface PickerItemId {
  pickerId: string;
  value: string;
}

/** The session's pickers, which one has its dropdown open, and the value under the pointer there. */
export interface PickersState {
  readonly pickers: readonly Picker[];
  readonly open: string | null;
  /** Only ever a value of the open dropdown. */
  readonly hovered: PickerItemId | null;
}

export type PickerAction =
  | { type: 'pickerToggled'; pickerId: string }
  | { type: 'pickersClosed' }
  | { type: 'pickerItemHovered'; hovered: PickerItemId }
  | { type: 'pickerItemLeft' }
  | { type: 'pickerValueChosen'; pickerId: string; value: string };

export const initialPickers: PickersState = { pickers: [], open: null, hovered: null };

export function isOpen(state: PickersState, pickerId: string): boolean {
  return state.open === pickerId;
}

/** The hovered value's description, which the tooltip shows; null when it has none. */
export function tooltipText(state: PickersState): string | null {
  const { hovered } = state;
  if (!hovered) {
    return null;
  }
  const picker = state.pickers.find((candidate) => candidate.id === hovered.pickerId);
  return (picker && values(picker).find((value) => value.id === hovered.value)?.description) || null;
}

export function currentValue(picker: Picker): PickerValue | undefined {
  return values(picker).find((value) => value.id === picker.current);
}

export function categoryIcon(category: PickerCategory): string {
  switch (category) {
    case 'mode':
      return '⚡';
    case 'model':
      return '🧠';
    case 'thought_level':
      return '💭';
    default:
      return '⚙';
  }
}

export function updatePickers(
  state: PickersState,
  action: Action,
): Transition<PickersState, WebviewToExtensionMessage> {
  switch (action.type) {
    case 'state':
      return settled(action.session ? { ...state, pickers: action.session.pickers } : initialPickers);
    case 'clearTranscript':
      return settled(initialPickers);
    case 'pickers':
      return settled({ ...state, pickers: action.pickers });
    case 'pickerToggled':
      return stateOnly({ ...state, open: isOpen(state, action.pickerId) ? null : action.pickerId, hovered: null });
    case 'pickersClosed':
      return stateOnly(closed(state));
    case 'pickerItemHovered': {
      const { hovered } = action;
      const same = state.hovered?.pickerId === hovered.pickerId && state.hovered.value === hovered.value;
      return stateOnly(same || !isOpen(state, hovered.pickerId) ? state : { ...state, hovered });
    }
    case 'pickerItemLeft':
      return stateOnly(state.hovered === null ? state : { ...state, hovered: null });
    case 'pickerValueChosen': {
      const { pickerId, value } = action;
      const picker = state.pickers.find((candidate) => candidate.id === pickerId);
      if (!picker || picker.current === value) {
        return stateOnly(closed(state));
      }
      // The extension answers with the session's pickers, which replace this guess.
      const chosen = { ...picker, current: value };
      return {
        state: { ...closed(state), pickers: state.pickers.map((candidate) => (candidate === picker ? chosen : candidate)) },
        outgoing: [{ type: 'pickerValueChosen', pickerId, value }],
      };
    }
    default:
      return stateOnly(state);
  }
}

function values(picker: Picker): PickerValue[] {
  return picker.groups.flatMap((group) => group.values);
}

function closed(state: PickersState): PickersState {
  return state.open === null ? state : { ...state, open: null, hovered: null };
}

/** Closes the open dropdown if its picker is no longer shown, so it does not reopen if the picker returns. */
function settled(state: PickersState): Transition<PickersState, WebviewToExtensionMessage> {
  const { open } = state;
  const shown = open === null || state.pickers.some((picker) => picker.id === open);
  return stateOnly(shown ? state : closed(state));
}

function stateOnly(state: PickersState): Transition<PickersState, WebviewToExtensionMessage> {
  return { state, outgoing: [] };
}
