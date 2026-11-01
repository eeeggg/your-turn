import type {
  ExtensionToWebviewMessage,
  PlanStep,
  SessionSnapshot,
  SlashCommand,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { showsEmptyState, type Turn, type TurnPart } from '@/webview/state/Transcript';

const init: SlashCommand = { name: 'init', description: 'Initialize the project', takesInput: false, hint: null };
const review: SlashCommand = { name: 'review', description: 'Review changes', takesInput: true, hint: 'What to review' };

type ToolCallReport = Omit<Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>, 'type' | 'toolCallId'>;

export function chatView() {
  const posted: WebviewToExtensionMessage[] = [];
  let time = 0;
  const store = createStore(
    initialState,
    update,
    (message: WebviewToExtensionMessage) => posted.push(message),
    () => time,
  );
  const transcript = () => store.getSnapshot().transcript;
  const turns = () => transcript().entries.filter((entry): entry is Turn => entry.kind === 'turn');
  const lastTurn = (): Turn => {
    const turn = turns().at(-1);
    if (!turn) {
      throw new Error('no turn in the transcript');
    }
    return turn;
  };
  const partsOf = <K extends TurnPart['kind']>(kind: K) => lastTurn().parts.filter((part): part is Extract<TurnPart, { kind: K }> => part.kind === kind);
  return {
    transcript,
    turns,
    lastTurn,
    thoughts: () => partsOf('thought'),
    groups: () => partsOf('toolCalls'),
    toolCalls: () => partsOf('toolCalls').flatMap((group) => group.toolCalls),
    /** Each entry as `kind: text`, and a turn as its parts in order, the way a reader would summarize the transcript. */
    summary: () =>
      transcript().entries.map((entry) => (entry.kind === 'turn' ? `turn: ${entry.parts.map(partSummary).join(' | ')}` : entry.kind === 'compaction' ? `compaction: ${entry.compactionId}` : entry.kind === 'question' ? `question: ${entry.record.interactionId}` : `${entry.kind}: ${entry.text}`)),
    emptyState: () => showsEmptyState(transcript(), store.getSnapshot().activeSession),
    at: (now: number) => {
      time = now;
    },
    store,
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    connect: (session: Partial<SessionSnapshot> = {}) => {
      const full = { sessionId: 's1', agentName: 'Fake', cwd: '/work', pickers: [], commands: [init, review], ...session };
      store.dispatch({ type: 'state', activeSessionId: full.sessionId, session: full });
    },
    answer: (text: string, messageId: string | null = null) => store.dispatch({ type: 'agentText', messageId, text }),
    thought: (text: string, messageId: string | null = null) => store.dispatch({ type: 'thoughtText', messageId, text }),
    replayed: (text: string, messageId: string | null = null) => store.dispatch({ type: 'promptText', messageId, text }),
    wholeAnswer: (text: string, messageId: string) => store.dispatch({ type: 'agentMessage', messageId, text }),
    wholeThought: (text: string, messageId: string) => store.dispatch({ type: 'thoughtMessage', messageId, text }),
    wholePrompt: (text: string, messageId: string) => store.dispatch({ type: 'promptMessage', messageId, text }),
    toolCall: (toolCallId: string, report: ToolCallReport = {}) => store.dispatch({ type: 'toolCall', toolCallId, ...report }),
    plan: (...steps: PlanStep[]) => store.dispatch({ type: 'plan', steps }),
    prompt: (text: string) => {
      store.dispatch({ type: 'promptEdited', text });
      store.dispatch({ type: 'promptSent' });
    },
    takePosted: () => posted.splice(0),
  };
}

function partSummary(part: TurnPart): string {
  switch (part.kind) {
    case 'message':
      return part.text;
    case 'thought':
      return `thought ${part.text}`;
    case 'toolCalls':
      return `tools ${part.toolCalls.map((call) => call.toolCallId).join(', ')}`;
    case 'plan':
      return `plan ${part.steps.map((step) => step.text).join(', ')}`;
    case 'compaction':
      return `compaction ${part.compactionId}`;
    case 'question':
      return `question ${part.record.interactionId}`;
  }
}

export const promptEnd: Action = { type: 'promptEnd' };
export const queuedPrompts = (count: number): WebviewToExtensionMessage => ({ type: 'queuedPrompts', count });
