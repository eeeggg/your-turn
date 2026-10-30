import type { SlashCommand, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { canPrompt, type ActiveSession } from '@/webview/state/ActiveSession';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';
import { promptHistory, type TranscriptState } from '@/webview/state/Transcript';

/** The prompt the text was recalled from, counted back from the newest of its session's history. */
interface Recall {
  readonly index: number;
  readonly sessionId: string;
  /** Where the caret goes once the text shows: the start after an older prompt, the end after a newer one. */
  readonly caret: 'start' | 'end';
}

/** What the user is writing, and the slash command popup over it. */
export interface PromptBoxState {
  readonly text: string;
  /** Position of the highlighted command among the matching ones. */
  readonly highlighted: number;
  /** Escape closed the popup; editing the text reopens it. */
  readonly dismissed: boolean;
  /** Null while not browsing the history. An edit keeps it, so clearing the edit moves on from where it was. */
  readonly recall: Recall | null;
  /** What the latest history move said, for a screen reader; empty once the text is edited. */
  readonly announcement: string;
}

export type PromptBoxAction =
  | { type: 'promptEdited'; text: string }
  | { type: 'promptSent' }
  | { type: 'slashCommandHighlighted'; index: number }
  | { type: 'slashHighlightMoved'; by: 1 | -1 }
  | { type: 'slashCommandChosen'; name: string }
  | { type: 'slashPopupDismissed' }
  | { type: 'historyMoved'; to: 'older' | 'newer' };

export const initialPromptBox: PromptBoxState = { text: '', highlighted: 0, dismissed: false, recall: null, announcement: '' };

/** The commands whose names start with what follows the `/`; none while the popup is closed. */
export function matchingCommands(box: PromptBoxState, session: ActiveSession | null): readonly SlashCommand[] {
  const { text } = box;
  if (box.dismissed || !canPrompt(session) || !text.startsWith('/')) {
    return [];
  }
  const query = text.slice(1).toLowerCase();
  return session.commands.filter((command) => command.name.toLowerCase().startsWith(query));
}

/** The highlighted command's position, kept within the matches when the agent's commands change under the popup. */
export function highlightedIndex(box: PromptBoxState, matches: readonly SlashCommand[]): number {
  return Math.min(box.highlighted, matches.length - 1);
}

export function placeholder(session: ActiveSession | null): string {
  return session && session.commands.length > 0 ? 'Type a message or / for commands...' : 'Type a message...';
}

export function updatePromptBox(
  previous: PromptBoxState,
  action: Action,
  session: ActiveSession | null,
  transcript: TranscriptState,
): Transition<PromptBoxState, WebviewToExtensionMessage> {
  const box = withRecallKept(previous, action, session);
  switch (action.type) {
    case 'promptEdited':
      return stateOnly({ text: action.text, highlighted: 0, dismissed: false, recall: box.recall, announcement: '' });
    case 'promptSent':
      return send(box, box.text, session);
    case 'slashCommandHighlighted':
      return stateOnly(action.index === box.highlighted ? box : { ...box, highlighted: action.index });
    case 'slashHighlightMoved': {
      const matches = matchingCommands(box, session);
      const highlighted = Math.max(0, Math.min(highlightedIndex(box, matches) + action.by, matches.length - 1));
      return stateOnly(matches.length === 0 || highlighted === box.highlighted ? box : { ...box, highlighted });
    }
    case 'slashCommandChosen': {
      const command = session?.commands.find((candidate) => candidate.name === action.name);
      if (!command) {
        return stateOnly(box);
      }
      return command.takesInput
        ? stateOnly({ ...initialPromptBox, text: `/${command.name} ` })
        : send(box, `/${command.name}`, session);
    }
    case 'slashPopupDismissed':
      return stateOnly(box.dismissed ? box : { ...box, dismissed: true });
    case 'historyMoved':
      return stateOnly(moved(box, action.to, session, promptHistory(transcript)));
    default:
      return stateOnly(box);
  }
}

/** Whether a move through the history would change the text, so the key that asks for it is not left to the textarea. */
export function historyMoves(box: PromptBoxState, to: 'older' | 'newer', session: ActiveSession | null, transcript: TranscriptState): boolean {
  return moved(box, to, session, promptHistory(transcript)) !== box;
}

/** Browsing ends when the history it was in goes: on another session or none, which a cleared transcript is, or a load. */
function withRecallKept(box: PromptBoxState, action: Action, session: ActiveSession | null): PromptBoxState {
  const { recall } = box;
  const gone = recall !== null && (recall.sessionId !== session?.sessionId || action.type === 'loadSessionStart');
  return gone ? { ...box, recall: null } : box;
}

/**
 * Moves through the history, newest first, unless the text is a draft or an edit of the recalled prompt: text other
 * than the prompt the move starts from, which is the newest when not browsing. Newer than the newest is an empty box.
 */
function moved(box: PromptBoxState, to: 'older' | 'newer', session: ActiveSession | null, history: readonly string[]): PromptBoxState {
  if (!canPrompt(session)) {
    return box;
  }
  const at = box.recall?.index ?? -1;
  const from = history[history.length - 1 - Math.max(at, 0)];
  const next = to === 'older' ? at + 1 : at - 1;
  if ((box.text !== '' && box.text !== from) || next >= history.length || next < -1 || (at === -1 && to === 'newer')) {
    return box;
  }
  if (next === -1) {
    return { ...initialPromptBox, announcement: 'Empty prompt' };
  }
  return {
    text: history[history.length - 1 - next] ?? '',
    highlighted: 0,
    dismissed: true,
    recall: { index: next, sessionId: session.sessionId, caret: to === 'older' ? 'start' : 'end' },
    announcement: `Prompt ${history.length - next} of ${history.length}`,
  };
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
