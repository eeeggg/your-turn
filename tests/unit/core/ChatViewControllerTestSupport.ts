import { expect, onTestFinished, vi } from 'vitest';
import type { ImageNetwork } from '@/core/MarkdownImageNetwork';
import type { ConfigOption, ForegroundState, SessionUpdate } from '@/core/acp/AcpDriver';
import { SessionStates } from '@/core/sessions/States';
import { SessionInteractions } from '@/core/sessions/Interactions';
import {
  ChatViewController,
  type ChatSessions,
  type ChatViewEnvironment
} from '@/core/ChatViewController';
import type { FileEditor } from '@/core/ReportedFiles';
import type { SessionManager, SessionInfo } from '@/core/sessions/Manager';
import type { SessionDelivery, SessionLoad } from '@/core/sessions/UpdateHandler';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';

export const SESSION_ID = '32350bd8-7efa-4316-a84c-e051a33e7580';
export const OTHER_SESSION_ID = 'ade937c1-4293-4a45-8fea-dcf147090866';

export function contentSnapshots(messages: readonly ExtensionToWebviewMessage[]) {
  return messages.flatMap((message) => message.type === 'viewSnapshot' ? message.content ? [message.content] : [] : message.type === 'contentSnapshot' ? [message] : []);
}

export function questionSnapshots(messages: readonly ExtensionToWebviewMessage[]) {
  return messages.flatMap((message) => message.type === 'viewSnapshot' || message.type === 'questions' ? [{ questions: message.questions }] : []);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const modelOption: Extract<ConfigOption, { kind: 'select' }> = {
  kind: 'select',
  id: 'model',
  name: 'Model',
  description: null,
  category: 'model',
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
};

export function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: SESSION_ID,
    agentId: 'fake',
    agentName: 'fake',
    agentDisplayName: 'Fake Agent',
    cwd: '/work/project',
    createdAt: '2026-10-18T00:00:00Z',
    modes: null,
    configOptions: [modelOption],
    availableCommands: [],
    ...overrides,
  };
}

/** Sessions whose prompts stay in flight until the test answers them. */
export class FakeSessions implements ChatSessions {
  loading: SessionLoad | undefined;
  sessionLoad: ChatSessions['sessionLoad'] = () => this.loading;
  readonly interactions = new SessionInteractions((identity, agentId) => this.getSession(identity)?.agentId === agentId
    ? this.retained.view(identity)?.generation ?? 0 : undefined, (identity, agentId, question) => {
      const session = this.getSession(identity);
      if (session?.agentId === agentId) { this.retained.questionSettled(session, question); }
    });
  readonly retained = new SessionStates(() => { for (const listener of this.activityListeners) { listener(); } }, { open: () => ({ write() {}, show() {} }) });
  private readonly activityListeners = new Set<(retiredSource?: string, promptOwner?: SessionInfo) => void>();
  onChanged(listener: (retiredSource?: string, promptOwner?: SessionInfo) => void): () => void {
    this.activityListeners.add(listener);
    return () => { this.activityListeners.delete(listener); };
  }
  private readonly activity = new Map<string, { foreground?: ForegroundState; submissions: Set<symbol> }>();
  applyForegroundState = (id: string, state: ForegroundState) => {
    const activity = this.activity.get(id) ?? { submissions: new Set<symbol>() };
    this.activity.set(id, { ...activity, foreground: state });
    if (state === 'idle') { this.releaseQueue(); }
  };
  retireSession(id: string): void { this.activity.delete(id); }
  hasForegroundWork: ChatSessions['hasForegroundWork'] = (identity) => {
    const activity = this.getSession(identity) && this.activity.get(identity.sessionId);
    return activity !== undefined && (activity.submissions.size > 0 || activity.foreground === 'running' || activity.foreground === 'requiresAction');
  };
  activeId: string | null = SESSION_ID;
  session: SessionInfo | undefined = sessionInfo();
  readonly prompts: { text: string; reply: Deferred<undefined> }[] = [];

  getActiveSessionId = () => this.activeId;
  getActiveSession = () => this.session?.sessionId === this.activeId ? this.session : undefined;
  sessionState: ChatSessions['sessionState'] = (identity) => this.retained.view(identity);
  editComposer: ChatSessions['editComposer'] = (...args) => this.retained.editComposer(...args);
  submitPrompt: ChatSessions['submitPrompt'] = (identity, generation, text) => {
    if (!this.getSession(identity) || this.retained.view(identity)?.generation !== generation) { return; }
    if (this.hasForegroundWork(identity) || (this.retained.view(identity)?.queue.length ?? 0) > 0) {
      this.retained.enqueue(identity, generation, text);
      return;
    } else { return this.sendPrompt(identity, text); }
  };
  changeQueuedPrompt: ChatSessions['changeQueuedPrompt'] = (identity, generation, change) => {
    if (this.retained.view(identity)?.generation !== generation) { return; }
    if (change.kind === 'steer' || change.kind === 'stop') {
      const head = this.retained.view(identity)?.queue[0];
      if (head?.id !== change.id || !this.hasForegroundWork(identity)) { return; }
      if (change.kind === 'stop') { void this.cancelTurn(identity); }
      else if (head.draft === null) {
        this.retained.takeQueued(identity, generation);
        if (this.session) { this.retained.turnEnded(this.session, Date.now()); }
        void this.sendPrompt(identity, head.text).catch(() => {});
        for (const listener of this.activityListeners) { listener(); }
      }
      return;
    }
    this.retained.changeQueue(identity, generation, change);
    this.releaseQueue();
  };
  private releaseQueue(): void {
    const session = this.getActiveSession();
    if (!session) { return; }
    const identity = { configuredName: session.agentName, sessionId: session.sessionId };
    const state = this.retained.view(identity);
    if (!state || this.hasForegroundWork(identity)) { return; }
    const head = this.retained.takeQueued(identity, state.generation);
    if (head) { void this.sendPrompt(identity, head.text).catch(() => {}); }
  }

  /** Synchronous boundary for pure projection scenarios; protocol settlement is tested with the real manager. */
  finishProjectedTurn(now: number): void {
    const session = this.getActiveSession();
    if (!session) { return; }
    this.retained.turnEnded(session, now);
    this.activity.delete(session.sessionId);
    for (const prompt of this.prompts.splice(0)) { prompt.reply.resolve(undefined); }
    this.releaseQueue();
    for (const listener of this.activityListeners) { listener(); }
  }
  sessionToolCallDiffs: ChatSessions['sessionToolCallDiffs'] = (...args) => this.retained.toolCallDiffs(...args);
  openCommandOutput: ChatSessions['openCommandOutput'] = (...args) => this.retained.openCommandOutput(...args);
  getSession: ChatSessions['getSession'] = ({ configuredName, sessionId }) => (this.session?.sessionId === sessionId && this.session.agentName === configuredName ? this.session : undefined);
  sendPrompt = vi.fn<SessionManager['sendPrompt']>((identity, text) => {
    const { sessionId } = identity;
    const registration = this.getSession(identity);
    const activity = this.activity.get(sessionId) ?? { submissions: new Set<symbol>() };
    const submission = Symbol();
    activity.submissions.add(submission);
    this.activity.set(sessionId, activity);
    if (this.session) { this.retained.submitted(this.session, text); }
    const reply = deferred<undefined>();
    this.prompts.push({ text, reply });
    for (const listener of this.activityListeners) { listener(undefined, registration); }
    return reply.promise.then(() => {
        if (registration && this.getSession({ configuredName: registration.agentName, sessionId }) === registration) {
          this.recordTurnEnded({ configuredName: registration.agentName, sessionId });
        }
      }).catch((error: unknown) => {
      if (this.session) { this.retained.promptFailed(this.session, error instanceof Error ? error.message : 'Prompt failed'); }
      throw error;
    }).finally(() => {
      activity.submissions.delete(submission);
      if (this.session && !this.hasForegroundWork(identity)) { this.retained.turnEnded(this.session, Date.now()); }
      for (const listener of this.activityListeners) { listener(undefined, registration); }
    });
  });
  cancelTurn = vi.fn<ChatSessions['cancelTurn']>(async () => {});
  setMode = vi.fn<ChatSessions['setMode']>(async () => {});
  setConfigOption = vi.fn<ChatSessions['setConfigOption']>(async () => null);
  recordTurnEnded = vi.fn<SessionManager['recordTurnEnded']>();
  applyAvailableCommands = vi.fn<SessionManager['applyAvailableCommands']>();
  applyConfigOptions = vi.fn<SessionManager['applyConfigOptions']>((identity, options) => {
    if (this.session && this.getSession(identity) === this.session) {
      this.session.configOptions = options;
    }
  });
  applyCurrentMode = vi.fn<SessionManager['applyCurrentMode']>((identity, modeId) => {
    if (this.session && this.getSession(identity) === this.session && this.session.modes) {
      this.session.modes = { ...this.session.modes, current: modeId };
    }
  });
  /** A null title clears it, a missing one leaves it unchanged. */
  applySessionInfoUpdate = vi.fn<SessionManager['applySessionInfoUpdate']>((identity, update) => {
    if (!this.session || this.getSession(identity) !== this.session) { return; }
    if (update.title === null) {
      delete this.session.title;
    } else if (update.title !== undefined) {
      this.session.title = update.title;
    }
  });

  /** End the turn of the oldest prompt still in flight. */
  answer(): void {
    const prompt = this.prompts.shift();
    if (!prompt) {
      throw new Error('no prompt in flight');
    }
    prompt.reply.resolve(undefined);
  }

  fail(error: unknown): void {
    const prompt = this.prompts.shift();
    if (!prompt) {
      throw new Error('no prompt in flight');
    }
    prompt.reply.reject(error);
  }
}

export class FakeEnvironment implements ChatViewEnvironment {
  private view = initialState;
  transcript() { return this.view.transcript; }
  parts() { return this.view.transcript.entries.flatMap((entry) => entry.kind === 'turn' ? entry.parts : []); }
  visible = true;
  notifications: { message: string; items: string[]; reply: Deferred<string | undefined> }[] = [];
  showInformationMessage: ChatViewEnvironment['showInformationMessage'] = <T extends string>(message: string, ...items: T[]) => {
    const reply = deferred<T | undefined>();
    this.notifications.push({ message, items, reply: { ...reply, resolve: (value) => reply.resolve(value as T | undefined) } });
    return reply.promise;
  };
  reveal = vi.fn<ChatViewEnvironment['reveal']>(async () => { this.visible = true; });
  posted: ExtensionToWebviewMessage[] = [];

  post(message: ExtensionToWebviewMessage): void {
    this.posted.push(message);
    this.view = update(this.view, structuredClone(message), Date.now()).state;
  }
  executeCommand = vi.fn<ChatViewEnvironment['executeCommand']>(async () => {});
  showsDiffs = false;

  showsToolCallDiffs(): boolean {
    return this.showsDiffs;
  }

  /** Messages posted since the last call. */
  take(): ExtensionToWebviewMessage[] {
    const taken = this.posted;
    this.posted = [];
    return taken;
  }
}

/** A workspace with nothing in it. */
class FakeEditor implements FileEditor {
  exists = vi.fn<FileEditor['exists']>(async () => false);
  readText = vi.fn<FileEditor['readText']>(async () => null);
  open = vi.fn<FileEditor['open']>(async () => {});
  showChanges = vi.fn<FileEditor['showChanges']>(async () => {});
  showInformationMessage = vi.fn<FileEditor['showInformationMessage']>(async () => undefined);
}

const environments = new WeakMap<ChatViewController, FakeEnvironment>();

export function setup(network?: ImageNetwork, finish?: (sessions: FakeSessions) => void) {
  const sessions = new FakeSessions();
  onTestFinished(() => sessions.retained.dispose());
  onTestFinished(() => { finish?.(sessions); expect(sessions.prompts, 'chat prompts left pending by the test').toHaveLength(0); });
  const environment = new FakeEnvironment();
  const editor = new FakeEditor();
  class TestController extends ChatViewController {
    private testLoad: SessionLoad | undefined;
    override notifyLoadSessionStart(input: string | SessionLoad): void {
      if (typeof input !== 'string') { super.notifyLoadSessionStart(input); return; }
      const registration = sessions.session?.sessionId === input ? sessions.session : undefined;
      if (!registration) { return; }
      this.testLoad = { registration, origin: { identity: { configuredName: registration.agentName, sessionId: input }, sourceId: registration.agentId }, attempt: Symbol() };
      sessions.loading = this.testLoad;
      sessions.retained.beginLoad(this.testLoad);
      super.notifyLoadSessionStart(this.testLoad);
    }
    override notifyLoadSessionEnd(load: SessionLoad, ok: boolean): boolean;
    override notifyLoadSessionEnd(ok: boolean): boolean;
    override notifyLoadSessionEnd(input: SessionLoad | boolean, ok?: boolean): boolean {
      if (typeof input !== 'boolean') { return super.notifyLoadSessionEnd(input, ok ?? false); }
      if (!this.testLoad) { this.notifyLoadSessionStart(sessions.activeId ?? ''); }
      if (!this.testLoad) { return false; }
      const load = this.testLoad;
      this.testLoad = undefined;
      sessions.loading = undefined;
      sessions.retained.endLoad(load, input);
      return super.notifyLoadSessionEnd(load, input);
    }
    override handleSessionUpdate(delivery: SessionDelivery): void;
    override handleSessionUpdate(sessionId: string, update: SessionUpdate): void;
    override handleSessionUpdate(input: SessionDelivery | string, update?: SessionUpdate): void {
      if (typeof input !== 'string') { super.handleSessionUpdate(input); return; }
      if (!update) { throw new Error('Missing test update'); }
      const sessionId = input;
      const registration = sessions.session?.sessionId === sessionId ? sessions.session : undefined;
      const identity = { configuredName: registration?.agentName ?? 'fake', sessionId };
      if (registration) { sessions.retained.accept(registration, update, Date.now()); }
      switch (update.kind) {
        case 'foreground': sessions.applyForegroundState(sessionId, update.state); break;
        case 'commands': sessions.applyAvailableCommands(identity, update.commands); break;
        case 'configOptions': sessions.applyConfigOptions(identity, update.options); break;
        case 'currentMode': sessions.applyCurrentMode(identity, update.modeId); break;
        case 'sessionInfo': sessions.applySessionInfoUpdate(identity, update); break;
        default: break;
      }
      super.handleSessionUpdate({ input: {
        origin: { identity: { configuredName: registration?.agentName ?? 'fake', sessionId }, sourceId: registration?.agentId ?? 'fake' },
        update, schema: 'v1',
      }, registration });
    }
  }
  const controller = new TestController(sessions, environment, editor, {
    workspaceRoots: () => ({ cwd: '/work/project', additionalDirectories: ['/other'] }),
  }, network);
  environments.set(controller, environment);
  onTestFinished(async () => {
    const disposed = controller.dispose();
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  return { sessions, environment, editor, controller };
}

export function sendPrompt(controller: ChatViewController, sessions: FakeSessions, text: string): Promise<void> {
  const environment = environments.get(controller);
  if (!environment) { throw new Error('Missing test environment'); }
  if (sessions.session) { sessions.retained.attach(sessions.session); }
  if (!environment.transcript().projection) {
    void controller.handleMessage({ type: 'ready' });
    environment.take();
  }
  const target = environment.transcript().projection?.target
    ?? { configuredName: 'fake', sessionId: SESSION_ID, generation: 0, projection: 0 };
  const turn = controller.handleMessage({ type: 'sendPrompt', target, text });
  onTestFinished(async () => {
    for (const prompt of sessions.prompts.splice(0)) { prompt.reply.resolve(undefined); }
    await turn;
  });
  return turn;
}

export async function issuedTarget(parts: ReturnType<typeof setup>) {
  if (parts.sessions.session) { parts.sessions.retained.attach(parts.sessions.session); }
  await parts.controller.handleMessage({ type: 'ready' });
  const snapshot = contentSnapshots(parts.environment.take()).at(-1);
  if (!snapshot) { throw new Error('Missing issued projection'); }
  return snapshot.target;
}
