import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { canPrompt, type ActiveSession } from '@/webview/state/ActiveSession';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

/** What the user is writing, and the slash command popup over it. */
export interface PromptBoxState {
  readonly text: string;
  /** Position of the highlighted command among the matching ones. */
  readonly highlighted: number;
  /** Escape closed the popup; editing the text reopens it. */
  readonly dismissed: boolean;
}

export type PromptBoxAction =
  | { type: 'promptEdited'; text: string }
  | { type: 'promptSent' }
  | { type: 'turnCancelled' }
  | { type: 'slashCommandHighlighted'; index: number }
  | { type: 'slashHighlightMoved'; by: 1 | -1 }
  | { type: 'slashCommandChosen'; name: string }
  | { type: 'slashPopupDismissed' };

export const initialPromptBox: PromptBoxState = { text: '', highlighted: 0, dismissed: false };

/** The commands whose names start with what follows the `/`; none while the popup is closed. */
export function matchingCommands(box: PromptBoxState, session: ActiveSession | null): readonly AvailableCommand[] {
  const { text } = box;
  if (box.dismissed || !canPrompt(session) || !text.startsWith('/')) {
    return [];
  }
  const query = text.slice(1).toLowerCase();
  return session.availableCommands.filter((command) => command.name.toLowerCase().startsWith(query));
}

/** The highlighted command's position, kept within the matches when the agent's commands change under the popup. */
export function highlightedIndex(box: PromptBoxState, matches: readonly AvailableCommand[]): number {
  return Math.min(box.highlighted, matches.length - 1);
}

export function placeholder(session: ActiveSession | null): string {
  return session && session.availableCommands.length > 0 ? 'Type a message or / for commands...' : 'Type a message...';
}

export function updatePromptBox(
  box: PromptBoxState,
  action: Action,
  session: ActiveSession | null,
): Transition<PromptBoxState, WebviewToExtensionMessage> {
  switch (action.type) {
    case 'promptEdited':
      return stateOnly({ text: action.text, highlighted: 0, dismissed: false });
    case 'promptSent':
      return send(box, box.text, session);
    case 'turnCancelled':
      return { state: box, outgoing: [{ type: 'cancelTurn' }] };
    case 'slashCommandHighlighted':
      return stateOnly(action.index === box.highlighted ? box : { ...box, highlighted: action.index });
    case 'slashHighlightMoved': {
      const matches = matchingCommands(box, session);
      const highlighted = Math.max(0, Math.min(highlightedIndex(box, matches) + action.by, matches.length - 1));
      return stateOnly(matches.length === 0 || highlighted === box.highlighted ? box : { ...box, highlighted });
    }
    case 'slashCommandChosen': {
      const command = session?.availableCommands.find((candidate) => candidate.name === action.name);
      if (!command) {
        return stateOnly(box);
      }
      return command.input
        ? stateOnly({ text: `/${command.name} `, highlighted: 0, dismissed: false })
        : send(box, `/${command.name}`, session);
    }
    case 'slashPopupDismissed':
      return stateOnly(box.dismissed ? box : { ...box, dismissed: true });
    default:
      return stateOnly(box);
  }
}

function send(
  box: PromptBoxState,
  text: string,
  session: ActiveSession | null,
): Transition<PromptBoxState, WebviewToExtensionMessage> {
  const prompt = text.trim();
  if (!prompt || !canPrompt(session)) {
    return stateOnly(box);
  }
  return { state: initialPromptBox, outgoing: [{ type: 'sendPrompt', text: prompt }] };
}

function stateOnly(box: PromptBoxState): Transition<PromptBoxState, WebviewToExtensionMessage> {
  return { state: box, outgoing: [] };
}
