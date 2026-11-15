import { expect, onTestFinished, vi } from 'vitest';
import type { ImageNetwork } from '@/core/MarkdownImageNetwork';
import type { ConfigOption, ForegroundState, SessionUpdate } from '@/core/acp/AcpDriver';
import { AgentTerminals } from '@/core/AgentTerminals';
import {
  ChatViewController,
  type ChatSessions,
  type ChatViewEnvironment
} from '@/core/ChatViewController';
import type { FileEditor } from '@/core/ReportedFiles';
import { SessionManager, type SessionInfo } from '@/core/SessionManager';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionUpdateHandler, type SessionDelivery, type SessionLoad } from '@/core/SessionUpdateHandler';
import { InProcessAgents, unusedHandlers, work } from '@tests/unit/core/InProcessAgents';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';

export const SESSION_ID = '32350bd8-7efa-4316-a84c-e051a33e7580';
export const OTHER_SESSION_ID = 'ade937c1-4293-4a45-8fea-dcf147090866';

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
  private readonly activity = new SessionManager(new InProcessAgents({}), new ConnectionManager('test', () => unusedHandlers), {
    workspaceRoots: () => work, workspaceTarget: () => undefined, workspaceTargetKnown: async () => undefined,
    agentConfigs: () => ({}), activeFileLink: () => undefined,
  }, { chooseAuthMethod: async () => undefined }, new SessionUpdateHandler());
  applyForegroundState = (id: string, state: ForegroundState) => this.activity.applyForegroundState(id, state);
  beginPrompt: ChatSessions['beginPrompt'] = (id) => this.activity.beginPrompt(id);
  endPrompt: ChatSessions['endPrompt'] = (id, submission) => this.activity.endPrompt(id, submission);
  clearActivity: ChatSessions['clearActivity'] = (id) => this.activity.clearActivity(id);
  hasForegroundWork: ChatSessions['hasForegroundWork'] = (id) => this.activity.hasForegroundWork(id);
  activeId: string | null = SESSION_ID;
  session: SessionInfo | undefined = sessionInfo();
  readonly prompts: { text: string; reply: Deferred<undefined> }[] = [];

  getActiveSessionId = () => this.activeId;
  getSession = (sessionId: string) => (this.session?.sessionId === sessionId ? this.session : undefined);
  sendPrompt = vi.fn<ChatSessions['sendPrompt']>((_sessionId, text) => {
    const reply = deferred<undefined>();
    this.prompts.push({ text, reply });
    return reply.promise;
  });
  cancelTurn = vi.fn<ChatSessions['cancelTurn']>(async () => {});
  setMode = vi.fn<ChatSessions['setMode']>(async () => {});
  setConfigOption = vi.fn<ChatSessions['setConfigOption']>(async () => null);
  recordTurnEnded = vi.fn<ChatSessions['recordTurnEnded']>();
  applyAvailableCommands = vi.fn<SessionManager['applyAvailableCommands']>();
  applyConfigOptions = vi.fn<SessionManager['applyConfigOptions']>((sessionId, options) => {
    if (this.session?.sessionId === sessionId) {
      this.session.configOptions = options;
    }
  });
  applyCurrentMode = vi.fn<SessionManager['applyCurrentMode']>((sessionId, modeId) => {
    if (this.session?.sessionId === sessionId && this.session.modes) {
      this.session.modes = { ...this.session.modes, current: modeId };
    }
  });
  /** A null title clears it, a missing one leaves it unchanged. */
  applySessionInfoUpdate = vi.fn<SessionManager['applySessionInfoUpdate']>((sessionId, update) => {
    if (this.session?.sessionId !== sessionId) { return; }
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

export function setup(network?: ImageNetwork) {
  const sessions = new FakeSessions();
  onTestFinished(() => { expect(sessions.prompts, 'chat prompts left pending by the test').toHaveLength(0); });
  const environment = new FakeEnvironment();
  const editor = new FakeEditor();
  const terminals = new AgentTerminals({ open: () => ({ write: () => {}, show: () => {} }) });
  onTestFinished(async () => {
    const disposed = terminals.dispose();
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  class TestController extends ChatViewController {
    private testLoad: SessionLoad | undefined;
    override notifyLoadSessionStart(input: string | SessionLoad): void {
      if (typeof input !== 'string') { super.notifyLoadSessionStart(input); return; }
      const registration = sessions.getSession(input);
      if (!registration) { return; }
      this.testLoad = { registration, origin: { identity: { configuredName: registration.agentName, sessionId: input }, sourceId: registration.agentId }, attempt: Symbol() };
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
      return super.notifyLoadSessionEnd(load, input);
    }
    override handleSessionUpdate(delivery: SessionDelivery): void;
    override handleSessionUpdate(sessionId: string, update: SessionUpdate): void;
    override handleSessionUpdate(input: SessionDelivery | string, update?: SessionUpdate): void {
      if (typeof input !== 'string') { super.handleSessionUpdate(input); return; }
      if (!update) { throw new Error('Missing test update'); }
      const sessionId = input;
      const registration = sessions.getSession(sessionId);
      switch (update.kind) {
        case 'foreground': sessions.applyForegroundState(sessionId, update.state); break;
        case 'commands': sessions.applyAvailableCommands(sessionId, update.commands); break;
        case 'configOptions': sessions.applyConfigOptions(sessionId, update.options); break;
        case 'currentMode': sessions.applyCurrentMode(sessionId, update.modeId); break;
        case 'sessionInfo': sessions.applySessionInfoUpdate(sessionId, update); break;
        default: break;
      }
      super.handleSessionUpdate({ input: {
        origin: { identity: { configuredName: registration?.agentName ?? 'fake', sessionId }, sourceId: registration?.agentId ?? 'fake' },
        update, schema: 'v1',
      }, registration });
    }
  }
  const controller = new TestController(sessions, environment, editor, terminals, {
    workspaceRoots: () => ({ cwd: '/work/project', additionalDirectories: ['/other'] }),
  }, network);
  onTestFinished(async () => {
    const disposed = controller.dispose();
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  return { sessions, environment, editor, terminals, controller };
}

export function sendPrompt(controller: ChatViewController, sessions: FakeSessions, text: string): Promise<void> {
  const turn = controller.handleMessage({ type: 'sendPrompt', text });
  onTestFinished(async () => {
    for (const prompt of sessions.prompts.splice(0)) { prompt.reply.resolve(undefined); }
    await turn;
  });
  return turn;
}
