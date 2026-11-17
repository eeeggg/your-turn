import type {
  PlanStep,
  SessionSnapshot,
  SlashCommand,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { showsEmptyState, type Turn, type TurnPart } from '@/webview/state/Transcript';
import { onTestFinished, vi } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { setup, sessionInfo } from '@tests/unit/core/ChatViewControllerTestSupport';
import { ContentProjection, isContentReport, type ContentReport, type FixtureAction } from '@tests/ContentProjection';

const init: SlashCommand = { name: 'init', description: 'Initialize the project', takesInput: false, hint: null };
const review: SlashCommand = { name: 'review', description: 'Review changes', takesInput: true, hint: 'What to review' };
export const TRANSCRIPT_SESSION_ID = '27de9d66-0738-44ea-9937-84274196d1a6';
export const OTHER_TRANSCRIPT_SESSION_ID = 'd700a7ad-1b4c-4765-9f5d-0868c136e1ca';

type ToolCallReport = Omit<Extract<ContentReport, { type: 'toolCall' }>, 'type' | 'toolCallId'>;

export function chatView(retained = false) {
  const posted: WebviewToExtensionMessage[] = [];
  const composerEdits: Extract<WebviewToExtensionMessage, { type: 'composerEdited' }>[] = [];
  let time = 0;
  const content = new ContentProjection();
  const store = createStore(
    initialState,
    update,
    (message: WebviewToExtensionMessage) => {
      if (message.type === 'composerEdited') {
        composerEdits.push(message);
        runtime?.sessions.editComposer(message.target, message.target.generation, message.revision, message.text);
        return;
      }
      posted.push(message);
      if (runtime) { void runtime.controller.handleMessage(message); }
    },
    () => time,
  );
  const runtime = retained ? setup(undefined, (sessions) => { for (const prompt of sessions.prompts.splice(0)) { prompt.reply.resolve(undefined); } }) : undefined;
  if (runtime) {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const publish = runtime.environment.post.bind(runtime.environment);
    runtime.environment.post = (message) => {
      publish(message);
      if (message.type === 'viewSnapshot' || message.type === 'contentSnapshot' || message.type === 'contentPatch') { store.dispatch(structuredClone(message)); }
    };
  }
  const ingest = (input: SessionUpdate) => {
    if (!runtime?.sessions.session) { throw new Error('Missing retained session'); }
    runtime.sessions.retained.accept(runtime.sessions.session, input, time);
    runtime.controller.handleSessionUpdate({ input: {
      origin: { identity: { configuredName: runtime.sessions.session.agentName, sessionId: runtime.sessions.session.sessionId }, sourceId: 'fake' },
      update: input, schema: 'v1',
    }, registration: runtime.sessions.session });
    vi.advanceTimersByTime(16);
  };
  const dispatch = (action: FixtureAction) => {
    if (runtime) {
      const registration = runtime.sessions.session;
      if (action.type === 'state' && action.session) {
        if (registration && registration.sessionId !== action.session.sessionId) { runtime.sessions.finishProjectedTurn(time); }
        runtime.sessions.activeId = action.session.sessionId;
        runtime.sessions.session = sessionInfo({ sessionId: action.session.sessionId, agentName: action.session.agentName, availableCommands: action.session.commands });
        runtime.sessions.retained.attach(runtime.sessions.session);
        runtime.sessions.retained.accept(runtime.sessions.session, { kind: 'commands', commands: [] }, time);
      }
      if (action.type === 'loadSessionStart') { runtime.controller.notifyLoadSessionStart(runtime.sessions.activeId ?? ''); }
      if (action.type === 'loadSessionEnd') { runtime.controller.notifyLoadSessionEnd(action.ok); }
      if (action.type === 'usage') {
        ingest({ kind: 'usage', ...action.usage });
        return;
      }
      if (action.type === 'sessionEnded' && registration) {
        runtime.sessions.retained.retireSource(registration.agentId);
        runtime.sessions.retained.turnEnded(registration, time);
        runtime.sessions.retained.promptFailed(registration, action.message);
        runtime.controller.notifyActiveSessionChanged();
      }
      if ((action.type === 'promptEnd' || action.type === 'foregroundActivity' && !action.running) && registration && !store.getSnapshot().activeSession?.loading) {
        runtime.sessions.finishProjectedTurn(time);
      }
      if (action.type === 'foregroundActivity' && action.running || action.type === 'promptStart') {
        runtime.sessions.applyForegroundState(runtime.sessions.activeId ?? '', 'running');
      }
      if (action.type === 'state' && !action.session) {
        if (registration) { runtime.sessions.retained.retireSource(registration.agentId); }
        runtime.sessions.activeId = null;
      }
      if (action.type === 'clearTranscript' && registration) {
        runtime.sessions.retained.release({ configuredName: registration.agentName, sessionId: registration.sessionId });
      }
    }
    const projected = !runtime ? content.project(action, store.getSnapshot().transcript, time, store.getSnapshot().activeSession?.turnRunning, store.getSnapshot().activeSession?.loading) : undefined;
    if (projected) { store.dispatch(projected); }
    if (!isContentReport(action)) { store.dispatch(action); }
    if (runtime && action.type === 'state' && action.session) { runtime.controller.notifyActiveSessionChanged(); }
    if (runtime && (action.type === 'promptEnd' || action.type === 'foregroundActivity' && !action.running)) {
      store.dispatch({ type: 'foregroundActivity', running: runtime.controller.hasRunningTurn });
    }
  };
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
    send: (...actions: FixtureAction[]) => actions.forEach(dispatch),
    connect: (session: Partial<SessionSnapshot> = {}) => {
      const full = { sessionId: TRANSCRIPT_SESSION_ID, agentName: 'Fake', cwd: '/work', pickers: [], commands: [init, review], ...session };
      dispatch({ type: 'state', activeSessionId: full.sessionId, session: full });
    },
    answer: (text: string, messageId: string | null = null) => runtime ? ingest({ kind: 'agentText', messageId, text }) : dispatch({ type: 'agentText', messageId, text }),
    thought: (text: string, messageId: string | null = null) => runtime ? ingest({ kind: 'thoughtText', messageId, text }) : dispatch({ type: 'thoughtText', messageId, text }),
    replayed: (text: string, messageId: string | null = null) => runtime ? ingest({ kind: 'promptText', messageId, text }) : dispatch({ type: 'promptText', messageId, text }),
    wholeAnswer: (text: string, messageId: string) => runtime ? ingest({ kind: 'agentMessage', messageId, text }) : dispatch({ type: 'agentMessage', messageId, text }),
    wholeThought: (text: string, messageId: string) => runtime ? ingest({ kind: 'thoughtMessage', messageId, text }) : dispatch({ type: 'thoughtMessage', messageId, text }),
    wholePrompt: (text: string, messageId: string) => runtime ? ingest({ kind: 'promptMessage', messageId, text }) : dispatch({ type: 'promptMessage', messageId, text }),
    toolCall: (toolCallId: string, report: ToolCallReport = {}) => {
      if (runtime) {
        if (report.content) { throw new Error('Use core tool content in the retained fixture'); }
        ingest({ kind: 'toolCall', toolCallId, ...(report.title !== undefined ? { title: report.title } : {}),
          ...(report.status !== undefined ? { status: report.status } : {}) });
      } else { dispatch({ type: 'toolCall', toolCallId, ...report }); }
    },
    plan: (...steps: PlanStep[]) => runtime ? ingest({ kind: 'plan', steps }) : dispatch({ type: 'plan', steps }),
    prompt: (text: string) => {
      dispatch({ type: 'promptEdited', text });
      dispatch({ type: 'promptSent' });
    },
    takePosted: () => posted.splice(0),
    takeComposerEdits: () => composerEdits.splice(0),
    sentPrompts: () => runtime?.sessions.sendPrompt.mock.calls.map(([, text]) => text) ?? [],
  };
}

export function retainedChatView() { return chatView(true); }

function partSummary(part: TurnPart): string {
  switch (part.kind) {
    case 'message':
      return part.text;
    case 'image':
      return 'image';
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
