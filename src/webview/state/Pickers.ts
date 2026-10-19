import type {
  SessionConfigId,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionConfigSelectOption,
  SessionConfigValueId,
  SessionModeId,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

export type PickerId = { kind: 'mode' } | { kind: 'config'; configId: SessionConfigId };

export type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>;

/** An item in the open dropdown: a mode ID, or a value ID of the config option. */
export interface PickerItemId {
  picker: PickerId;
  item: string;
}

/** The session's mode and config option pickers, which one has its dropdown open, and the item under the pointer there. */
export interface PickersState {
  readonly modes: SessionModeState | null;
  readonly configOptions: readonly SessionConfigOption[];
  readonly open: PickerId | null;
  /** Only ever an item of the open dropdown. */
  readonly hovered: PickerItemId | null;
}

export type PickerAction =
  | { type: 'pickerToggled'; picker: PickerId }
  | { type: 'pickersClosed' }
  | { type: 'pickerItemHovered'; hovered: PickerItemId }
  | { type: 'pickerItemLeft' }
  | { type: 'modeChosen'; modeId: SessionModeId }
  | { type: 'configValueChosen'; configId: SessionConfigId; value: SessionConfigValueId };

export const initialPickers: PickersState = { modes: null, configOptions: [], open: null, hovered: null };

/** A run of a select option's values, under its group's name when the agent grouped them. */
export interface ValueGroup {
  /** Unique among the option's groups. */
  id: string;
  header?: string;
  values: readonly SessionConfigSelectOption[];
}

/** The config options to show as pickers: selects with values to choose from. Other types have no picker yet. */
export function configPickers(state: PickersState): SelectConfigOption[] {
  return state.configOptions.filter(
    (option): option is SelectConfigOption => option.type === 'select' && option.options.length > 0,
  );
}

/** The legacy mode picker, shown only for agents without config options, which the ACP spec says replace modes. */
export function showsModePicker(state: PickersState): boolean {
  return state.configOptions.length === 0 && (state.modes?.availableModes.length ?? 0) > 0;
}

export function isOpen(state: PickersState, picker: PickerId): boolean {
  return state.open !== null && samePicker(state.open, picker);
}

/** The hovered item's description, which the tooltip shows; null when it has none. */
export function tooltipText(state: PickersState): string | null {
  const { hovered } = state;
  if (!hovered) {
    return null;
  }
  const { picker, item } = hovered;
  const description =
    picker.kind === 'mode'
      ? state.modes?.availableModes.find((mode) => mode.id === item)?.description
      : configPickers(state)
          .filter((option) => option.id === picker.configId)
          .flatMap((option) => valueGroups(option).flatMap((group) => group.values))
          .find((value) => value.value === item)?.description;
  return description || null;
}

export function valueGroups(option: SelectConfigOption): ValueGroup[] {
  return option.options.map((entry) =>
    'group' in entry
      ? { id: `group:${entry.group}`, header: entry.name || entry.group, values: entry.options }
      : { id: `value:${entry.value}`, values: [entry] },
  );
}

export function currentValue(option: SelectConfigOption): SessionConfigSelectOption | undefined {
  return valueGroups(option)
    .flatMap((group) => group.values)
    .find((value) => value.value === option.currentValue);
}

export function categoryIcon(category: SessionConfigOptionCategory | null | undefined): string {
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
      return settled(
        action.session
          ? { ...state, modes: action.session.modes, configOptions: action.session.configOptions ?? [] }
          : initialPickers,
      );
    case 'clearTranscript':
      return settled(initialPickers);
    case 'modesUpdate':
      return settled({ ...state, modes: action.modes });
    case 'configOptionsUpdate':
      return settled({ ...state, configOptions: action.configOptions ?? [] });
    case 'sessionUpdate':
      switch (action.update.sessionUpdate) {
        case 'current_mode_update':
          return state.modes
            ? settled({ ...state, modes: { ...state.modes, currentModeId: action.update.currentModeId } })
            : stateOnly(state);
        case 'config_option_update':
          return settled({ ...state, configOptions: action.update.configOptions });
        default:
          return stateOnly(state);
      }
    case 'pickerToggled':
      return stateOnly({ ...state, open: isOpen(state, action.picker) ? null : action.picker, hovered: null });
    case 'pickersClosed':
      return stateOnly(closed(state));
    case 'pickerItemHovered': {
      const { hovered } = action;
      const same = state.hovered && samePicker(state.hovered.picker, hovered.picker) && state.hovered.item === hovered.item;
      return stateOnly(same || !isOpen(state, hovered.picker) ? state : { ...state, hovered });
    }
    case 'pickerItemLeft':
      return stateOnly(state.hovered === null ? state : { ...state, hovered: null });
    case 'modeChosen': {
      const { modes } = state;
      if (!modes || action.modeId === modes.currentModeId) {
        return stateOnly(closed(state));
      }
      return {
        state: { ...closed(state), modes: { ...modes, currentModeId: action.modeId } },
        outgoing: [{ type: 'setMode', modeId: action.modeId }],
      };
    }
    case 'configValueChosen': {
      const { configId, value } = action;
      const option = state.configOptions.find((candidate) => candidate.id === configId);
      if (option?.type !== 'select' || option.currentValue === value) {
        return stateOnly(closed(state));
      }
      // The agent answers with the authoritative options, which replace this guess.
      const chosen = { ...option, currentValue: value };
      return {
        state: {
          ...closed(state),
          configOptions: state.configOptions.map((candidate) => (candidate === option ? chosen : candidate)),
        },
        outgoing: [{ type: 'setConfigOption', configId, value }],
      };
    }
    default:
      return stateOnly(state);
  }
}

function samePicker(a: PickerId, b: PickerId): boolean {
  return a.kind === 'mode' ? b.kind === 'mode' : b.kind === 'config' && a.configId === b.configId;
}

function closed(state: PickersState): PickersState {
  return state.open === null ? state : { ...state, open: null, hovered: null };
}

/** Closes the open dropdown if its picker is no longer shown, so it does not reopen if the picker returns. */
function settled(state: PickersState): Transition<PickersState, WebviewToExtensionMessage> {
  const { open } = state;
  const shown =
    open === null ||
    (open.kind === 'mode'
      ? showsModePicker(state)
      : configPickers(state).some((option) => option.id === open.configId));
  return stateOnly(shown ? state : closed(state));
}

function stateOnly(state: PickersState): Transition<PickersState, WebviewToExtensionMessage> {
  return { state, outgoing: [] };
}
