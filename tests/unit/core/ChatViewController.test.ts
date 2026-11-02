import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ConfigOption, Modes, SessionUpdate } from '@/core/acp/AcpDriver';
import { AgentTerminals } from '@/core/AgentTerminals';
import { ChatViewController, type ChatSessions, type ChatViewEnvironment } from '@/core/ChatViewController';
import { Cleaner } from '@/core/CommandOutput';
import { setLogSink } from '@/core/Log';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import type { FileEditor } from '@/core/ReportedFiles';
import { SessionManager, type SessionInfo } from '@/core/SessionManager';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { InProcessAgents, unusedHandlers, work } from './InProcessAgents';
import type { ExtensionToWebviewMessage, Picker } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const modelOption: ConfigOption = {
  kind: 'select',
  id: 'model',
  name: 'Model',
  description: null,
  category: 'model',
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
};

/** {@link modelOption} as the webview gets it. */
const modelPicker: Picker = {
  id: 'model',
  category: 'model',
  name: 'Model',
  description: null,
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
};

const modes: Modes = {
  current: 'ask',
  available: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code', description: null }],
};

/** {@link modes} as the webview gets it. */
const modePicker: Picker = {
  id: 'mode',
  category: 'mode',
  name: 'Mode',
  description: null,
  current: 'ask',
  groups: [{ header: null, values: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code', description: null }] }],
};

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
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
class FakeSessions implements ChatSessions {
  private readonly activity = new SessionManager(new InProcessAgents({}), new ConnectionManager(new SessionUpdateHandler(), 'test', () => unusedHandlers), {
    workspaceRoots: () => work, workspaceTarget: () => undefined, workspaceTargetKnown: async () => undefined,
    agentConfigs: () => ({}), activeFileLink: () => undefined,
  }, { chooseAuthMethod: async () => undefined });
  applyForegroundState: ChatSessions['applyForegroundState'] = (id, state) => this.activity.applyForegroundState(id, state);
  beginPrompt: ChatSessions['beginPrompt'] = (id) => this.activity.beginPrompt(id);
  endPrompt: ChatSessions['endPrompt'] = (id, submission) => this.activity.endPrompt(id, submission);
  clearActivity: ChatSessions['clearActivity'] = (id) => this.activity.clearActivity(id);
  hasForegroundWork: ChatSessions['hasForegroundWork'] = (id) => this.activity.hasForegroundWork(id);
  activeId: string | null = 's1';
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
  applyAvailableCommands = vi.fn<ChatSessions['applyAvailableCommands']>();
  applyConfigOptions = vi.fn<ChatSessions['applyConfigOptions']>((sessionId, options) => {
    if (this.session?.sessionId === sessionId) {
      this.session.configOptions = options;
    }
  });
  applyCurrentMode = vi.fn<ChatSessions['applyCurrentMode']>((sessionId, modeId) => {
    if (this.session?.sessionId === sessionId && this.session.modes) {
      this.session.modes = { ...this.session.modes, current: modeId };
    }
  });
  /** A null title clears it, a missing one leaves it unchanged. */
  applySessionInfoUpdate = vi.fn<ChatSessions['applySessionInfoUpdate']>((sessionId, update) => {
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

class FakeEnvironment implements ChatViewEnvironment {
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

function setup() {
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
  const controller = new ChatViewController(sessions, environment, editor, terminals, {
    workspaceRoots: () => ({ cwd: '/work/project', additionalDirectories: ['/other'] }),
  });
  onTestFinished(async () => {
    const disposed = controller.dispose();
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  return { sessions, environment, editor, terminals, controller };
}

function sendPrompt(controller: ChatViewController, sessions: FakeSessions, text: string): Promise<void> {
  const turn = controller.handleMessage({ type: 'sendPrompt', text });
  onTestFinished(async () => {
    for (const prompt of sessions.prompts.splice(0)) { prompt.reply.resolve(undefined); }
    await turn;
  });
  return turn;
}

const toolCall: SessionUpdate = { kind: 'toolCall', toolCallId: 't1', title: 'Read' };

describe('ChatViewController', () => {
  it('routes opaque tab requests to session commands without changing content', async () => {
    const { controller, environment } = setup();
    const requests: string[] = [];
    controller.setTabNavigation({
      selectTab: async (id) => { requests.push(`select:${id}`); },
      closeTab: async (id) => { requests.push(`close:${id}`); },
    });
    await controller.handleMessage({ type: 'selectSessionTab', tabId: 'opaque-one' });
    await controller.handleMessage({ type: 'closeSessionTab', tabId: 'opaque-two' });
    expect(requests).toEqual(['select:opaque-one', 'close:opaque-two']);
    expect(environment.take()).toEqual([]);
  });
  it('commits tabs only on successful opens and re-sends the complete navigation on readiness', async () => {
    const { controller, sessions, environment } = setup();
    controller.notifyActiveSessionChanged();
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([]);
    controller.notifySessionOpened('s1');
    const first = environment.take();
    const snapshot = first.find((message) => message.type === 'sessionTabs');
    expect(snapshot).toEqual({ type: 'sessionTabs', selectedTabId: 'tab-1', tabs: [
      { tabId: 'tab-1', title: null, agentName: 'Fake Agent', cwd: '/work/project', additionalDirectories: ['/other'], running: false },
    ] });
    if (snapshot?.type !== 'sessionTabs') { throw new Error('missing tab snapshot'); }
    expect(snapshot.selectedTabId).toBe(snapshot.tabs[0]?.tabId);

    sessions.session = sessionInfo({ sessionId: 's2', title: 'Second' });
    sessions.activeId = 's2';
    controller.notifyActiveSessionChanged();
    controller.notifyLoadSessionEnd(false);
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([]);
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([snapshot]);

    controller.notifySessionOpened('s2');
    const second = environment.take().find((message) => message.type === 'sessionTabs');
    expect(second?.type === 'sessionTabs' && second.tabs).toEqual([
      snapshot.tabs[0],
      { tabId: 'tab-2', title: 'Second', agentName: 'Fake Agent', cwd: '/work/project', additionalDirectories: ['/other'], running: false },
    ]);
    controller.notifySessionOpened('s2');
    expect(environment.take()).toEqual([second]);
  });

  it('updates tab labels and foreground indicators without creating content or prompt boundaries', async () => {
    const { controller, sessions, environment } = setup();
    controller.notifySessionOpened('s1');
    const initial = environment.take().find((message) => message.type === 'sessionTabs');
    if (initial?.type !== 'sessionTabs') { throw new Error('missing tab snapshot'); }
    const tab = initial.tabs[0];
    controller.handleSessionUpdate('s1', { kind: 'sessionInfo', title: 'Renamed' });
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([
      { ...initial, tabs: [{ ...tab, title: 'Renamed' }] },
    ]);
    controller.handleSessionUpdate('s1', { kind: 'sessionInfo', title: null });
    environment.take();
    controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'running' });
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([
      { ...initial, tabs: [{ ...tab, running: true }] },
    ]);
    const turn = sendPrompt(controller, sessions, 'steering');
    environment.take();
    sessions.fail(new Error('Rejected'));
    await turn;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.take().some((message) => message.type === 'promptEnd')).toBe(false);
    controller.notifySessionRemoved('s1');
    const removed = environment.take();
    expect(removed).toEqual([initial]);
  });

  it('keeps the next submission active when autonomous idle releases the queue synchronously', async () => {
    const { controller, sessions, environment } = setup();
    controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'running' });
    let next: Promise<void> | undefined;
    const post = environment.post.bind(environment);
    environment.post = (message) => {
      post(message);
      if (message.type === 'foregroundActivity' && !message.running) { next = sendPrompt(controller, sessions, 'next'); }
    };
    controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'idle' });
    environment.post = post;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.executeCommand).toHaveBeenLastCalledWith('setContext', 'acp.turnInProgress', true);
    sessions.answer();
    await next;
  });

  it('does not clear work submitted synchronously when an idle notification releases the queue', async () => {
    const { controller, sessions, environment } = setup();
    const first = sendPrompt(controller, sessions, 'first');
    let next: Promise<void> | undefined;
    const post = environment.post.bind(environment);
    environment.post = (message) => {
      post(message);
      if (message.type === 'promptEnd') { next = sendPrompt(controller, sessions, 'next'); }
    };
    sessions.answer();
    await first;
    environment.post = post;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.executeCommand).toHaveBeenLastCalledWith('setContext', 'acp.turnInProgress', true);
    sessions.answer();
    await next;
  });

  it.each(['resolve', 'reject'] as const)('does not end older outstanding work when a newer submission settles by %s', async (settle) => {
    const { controller, sessions, environment } = setup();
    const first = sendPrompt(controller, sessions, 'first');
    const second = sendPrompt(controller, sessions, 'steer');
    environment.take();
    const newer = sessions.prompts.pop();
    if (!newer) { throw new Error('missing steering submission'); }
    if (settle === 'resolve') { newer.reply.resolve(undefined); }
    else { newer.reply.reject(new Error('refused')); }
    await second;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.take().filter((message) => message.type === 'promptEnd')).toEqual([]);
    sessions.answer();
    await first;
    expect(controller.hasRunningTurn).toBe(false);
    expect(environment.take()).toEqual([{ type: 'promptEnd' }]);
  });

  it('rejects stale controls after reconnect and rechecks connection ownership after native reveal', async () => {
    const { controller, environment, sessions } = setup();
    environment.visible = false;
    const old = new ElicitationRequests();
    const detachOld = controller.attachElicitations('Agent', old, 'fake');
    const withdrawn = old.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'Old', requestedSchema: {} });
    const rejected = expect(withdrawn).rejects.toMatchObject({ kind: 'closed' });
    const oldId = old.snapshot()[0]?.interactionId ?? '';
    old.close(); detachOld(); await rejected;
    const replacement = new ElicitationRequests();
    const detach = controller.attachElicitations('Agent', replacement, 'replacement');
    sessions.session = sessionInfo({ agentId: 'replacement' });
    const answer = replacement.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'New', requestedSchema: {} });
    const id = replacement.snapshot()[0]?.interactionId ?? '';
    await controller.handleMessage({ type: 'questionResponse', interactionId: oldId, action: 'accept', content: {} });
    await controller.handleMessage({ type: 'questionDraft', interactionId: oldId, draft: { injected: 'stale' } });
    expect(replacement.snapshot()).toHaveLength(1);
    environment.notifications[0]?.reply.resolve('Open');
    await environment.notifications[0]?.reply.promise;
    expect(environment.reveal).not.toHaveBeenCalled();
    const revealing = deferred<undefined>();
    environment.reveal.mockImplementation(() => revealing.promise);
    environment.notifications[1]?.reply.resolve('Open');
    await environment.notifications[1]?.reply.promise;
    expect(environment.reveal).toHaveBeenCalledOnce();
    sessions.session = sessionInfo({ agentId: 'another-connection' });
    environment.take();
    revealing.resolve(undefined);
    await revealing.promise;
    expect(environment.take()).toEqual([]);
    sessions.session = sessionInfo({ agentId: 'replacement' });
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ interactionId: id, draft: null })] });
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'decline' });
    expect(await answer).toEqual({ action: 'decline' });
    detach(); replacement.close();
  });

  it('keeps questions from multiple connections in arrival order', async () => {
    const { controller, environment } = setup();
    const a = new ElicitationRequests();
    const b = new ElicitationRequests();
    const detachA = controller.attachElicitations('A', a, 'a');
    const detachB = controller.attachElicitations('B', b, 'b');
    const first = b.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth-b' }, message: 'First', requestedSchema: {} });
    const second = a.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth-a' }, message: 'Second', requestedSchema: {} });
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take().filter((message) => message.type === 'questions').at(-1)?.questions.map((question) => question.message)).toEqual(['First', 'Second']);
    a.respond(a.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    b.respond(b.snapshot()[0]?.interactionId ?? '', { action: 'decline' });
    await Promise.all([first, second]);
    detachA(); detachB(); a.close(); b.close();
  });

  it('does not expose, answer or record a foreign connection question with the active session ID', async () => {
    const { controller, environment, sessions } = setup();
    sessions.session = sessionInfo({ agentId: 'other-connection', agentName: 'other' });
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Agent', requests, 'fake');
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'Foreign?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }, { type: 'questions', questions: [] }]);
    expect(environment.notifications).toEqual([]);
    await controller.handleMessage({ type: 'questionDraft', interactionId: id, draft: { answer: 'forged' } });
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: {} });
    expect(requests.snapshot()).toHaveLength(1);
    requests.respond(id, { action: 'decline' });
    expect(await answer).toEqual({ action: 'decline' });
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    detach();
    requests.close();
  });

  it('announces a hidden question without revealing or answering, then opens only the explicitly selected request', async () => {
    const { controller, environment, sessions } = setup();
    sessions.session = sessionInfo({ title: 'Work session' });
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Agent', requests, 'fake');
    const first = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'First?', requestedSchema: {} });
    const second = requests.create({ mode: 'form', rpcId: 2, scope: { sessionId: 's1' }, message: 'Second?', requestedSchema: {} });
    const id = requests.snapshot()[1]?.interactionId ?? '';
    expect(environment.notifications.map(({ message, items }) => ({ message, items }))).toEqual([
      { message: 'Agent has a question for Work session.', items: ['Open'] },
      { message: 'Agent has a question for Work session.', items: ['Open'] },
    ]);
    expect(environment.reveal).not.toHaveBeenCalled();
    expect(requests.snapshot()).toHaveLength(2);
    environment.notifications[0]?.reply.resolve(undefined);
    environment.notifications[1]?.reply.resolve('Open');
    await environment.notifications[1]?.reply.promise;
    await controller.handleMessage({ type: 'ready' });
    expect(environment.reveal).toHaveBeenCalledOnce();
    expect(environment.take()).toContainEqual({ type: 'questionOpen', interactionId: id });
    expect(requests.snapshot()).toHaveLength(2);
    requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    requests.respond(id, { action: 'decline' });
    expect(await first).toEqual({ action: 'cancel' });
    expect(await second).toEqual({ action: 'decline' });
    detach();
    requests.close();
  });

  it('does not reveal a stale notification or navigate to a different active session', async () => {
    const { controller, environment, sessions } = setup();
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Agent', requests, 'fake');
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'Pending?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    sessions.activeId = 'other';
    environment.notifications[0]?.reply.resolve('Open');
    await environment.notifications[0]?.reply.promise;
    expect(environment.reveal).not.toHaveBeenCalled();
    requests.respond(id, { action: 'cancel' });
    await answer;
    detach();
    requests.close();
  });

  it('announces outside-session questions without inventing a session and ignores withdrawn notification actions', async () => {
    const { controller, environment, sessions } = setup();
    sessions.activeId = null;
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Setup Agent', requests, 'fake');
    const abort = new AbortController();
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth' }, message: 'Setup?', requestedSchema: {} }, abort.signal);
    const rejected = expect(answer).rejects.toMatchObject({ kind: 'cancelled' });
    expect(environment.notifications[0]?.message).toBe('Setup Agent has a question.');
    abort.abort();
    await rejected;
    environment.notifications[0]?.reply.resolve('Open');
    await environment.notifications[0]?.reply.promise;
    expect(environment.reveal).not.toHaveBeenCalled();
    expect(environment.take().filter((message) => message.type === 'questionOpen')).toEqual([]);
    detach();
    requests.close();
  });
  it.each(['accept', 'decline', 'cancel'] as const)('records only core-confirmed session form response %s, once', async (action) => {
    const { controller, environment } = setup();
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Agent', requests, 'fake');
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'Count?', requestedSchema: { title: 'Settings', properties: { count: { type: 'integer', default: 0 } }, required: ['count'] } });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    environment.take();
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: { count: 0.5 } });
    expect(environment.take()).toEqual([{ type: 'questionErrors', interactionId: id, errors: { count: 'Invalid value' } }]);
    const response = action === 'accept' ? { action, content: { count: 0 } } : { action };
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, ...response });
    expect(await answer).toEqual(response);
    const messages = environment.take();
    expect(messages).toEqual([
      { type: 'questionSettled', record: { interactionId: id, sessionId: 's1', agentName: 'Agent', message: 'Count?', title: 'Settings', description: null, fields: [expect.objectContaining({ name: 'count', kind: 'integer', default: 0 })], response } },
      { type: 'questions', questions: [] },
    ]);
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, ...response });
    expect(environment.take()).toEqual([]);
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take().filter((message) => message.type === 'questionSettled')).toEqual([]);
    detach();
    requests.close();
  });

  it('does not record outside-session responses or request withdrawal as session answers', async () => {
    const { controller, environment } = setup();
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Setup Agent', requests, 'fake');
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth' }, message: 'Setup?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    environment.take();
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: {} });
    expect(await answer).toEqual({ action: 'accept', content: {} });
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    const abort = new AbortController();
    const withdrawn = requests.create({ mode: 'form', rpcId: 2, scope: { sessionId: 's1' }, message: 'Pending?', requestedSchema: {} }, abort.signal);
    const rejected = expect(withdrawn).rejects.toMatchObject({ kind: 'cancelled' });
    environment.take();
    abort.abort();
    await rejected;
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    detach();
    requests.close();
  });
  it('keeps outside-session forms available without a session and removes aborted drafts on resynchronization', async () => {
    const { controller, environment, sessions } = setup();
    sessions.activeId = null;
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Setup Agent', requests, 'fake');
    const abort = new AbortController();
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth' }, message: 'Setup?', requestedSchema: {} }, abort.signal);
    const rejected = expect(answer).rejects.toMatchObject({ kind: 'cancelled' });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    await controller.handleMessage({ type: 'questionDraft', interactionId: id, draft: { text: 'draft' } });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ interactionId: id, sessionId: null, agentName: 'Setup Agent' })] });
    abort.abort();
    await rejected;
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: {} });
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [] });
    detach();
    requests.close();
  });

  it('resynchronizes pending forms and raw drafts without answering or exposing another session', async () => {
    const { controller, environment, sessions } = setup();
    const requests = new ElicitationRequests();
    const detach = controller.attachElicitations('Agent', requests, 'fake');
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'Count?', requestedSchema: { properties: { count: { type: 'integer', default: 0 } } } });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ interactionId: id, agentName: 'Agent', message: 'Count?', draft: null, fields: [expect.objectContaining({ kind: 'integer', default: 0 })] })] });
    await controller.handleMessage({ type: 'questionDraft', interactionId: id, draft: { count: '-' } });
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ draft: { count: '-' } })] });
    await controller.handleMessage({ type: 'questionDraft', interactionId: id, draft: {} });
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ draft: {} })] });
    sessions.activeId = 'other';
    controller.notifyActiveSessionChanged();
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [] });
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: { count: 3 } });
    expect(requests.snapshot()).toHaveLength(1);
    sessions.activeId = 's1';
    controller.notifyActiveSessionChanged();
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: { count: 1.5 } });
    expect(environment.take()).toContainEqual({ type: 'questionErrors', interactionId: id, errors: { count: 'Invalid value' } });
    await controller.handleMessage({ type: 'questionResponse', interactionId: id, action: 'accept', content: { count: 3 } });
    expect(await answer).toEqual({ action: 'accept', content: { count: 3 } });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [] });
    detach();
    requests.close();
  });

  it('stops posting and accepting updates while its command output drains on disposal', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const { controller, terminals, environment, sessions } = setup();
    let outputReleased = false;
    const dispose = Cleaner.prototype.dispose;
    const release = vi.spyOn(Cleaner.prototype, 'dispose').mockImplementation(function (this: Cleaner) {
      return dispose.call(this).then(() => { outputReleased = true; });
    });
    onTestFinished(() => { release.mockRestore(); });
    controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute', content: [{ kind: 'text', text: 'pending' }] });
    controller.handleSessionUpdate('s1', { kind: 'agentText', messageId: null, text: 'pending text' });
    terminals.handleSessionUpdate('s1', { kind: 'terminalOutput', terminalId: 't1', data: new TextEncoder().encode('pending terminal') });
    environment.take();
    const disposed = controller.dispose();
    const releasedAtDisposal = disposed.then(() => outputReleased);
    expect(controller.dispose()).toBe(disposed);
    controller.handleSessionUpdate('s1', { kind: 'agentText', messageId: null, text: 'late' });
    await controller.handleMessage({ type: 'sendPrompt', text: 'late' });
    await vi.runAllTimersAsync();
    await disposed;

    expect(await releasedAtDisposal).toBe(true);
    expect(environment.take()).toEqual([]);
    expect(sessions.sendPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('session state', () => {
    it('logs every webview ready handshake at info', async () => {
      const { controller } = setup();
      const calls: unknown[][] = [];
      setLogSink({
        trace() {},
        debug() {},
        info: (...args) => calls.push(['info', ...args]),
        warn() {},
        error() {},
      });
      onTestFinished(() => { setLogSink(undefined); });

      await controller.handleMessage({ type: 'ready' });
      await controller.handleMessage({ type: 'ready' });

      expect(calls).toEqual([
        ['info', 'Chat view ready'],
        ['info', 'Chat view ready'],
      ]);
    });

    it('describes the active session when the webview is ready', async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({
        title: 'Fix the build',
        availableCommands: [
          { name: 'init', description: 'Init', takesInput: false, hint: null },
          { name: 'review', description: 'Review', takesInput: true, hint: 'what to review' },
        ],
      });

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{
        type: 'state',
        activeSessionId: 's1',
        session: {
          sessionId: 's1',
          agentName: 'Fake Agent',
          title: 'Fix the build',
          cwd: '/work/project',
          pickers: [modelPicker],
          commands: [
            { name: 'init', description: 'Init', takesInput: false, hint: null },
            { name: 'review', description: 'Review', takesInput: true, hint: 'what to review' },
          ],
        },
      }, { type: 'sessionTabs', tabs: [], selectedTabId: null }]);
    });

    it('leaves the title out when the session has none', () => {
      const { environment, controller } = setup();

      controller.notifyActiveSessionChanged();

      const [state] = environment.take();
      expect(state).toMatchObject({ type: 'state', session: { sessionId: 's1' } });
      expect(state?.type === 'state' ? state.session : undefined).not.toHaveProperty('title');
    });

    it('reports no session when none is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{ type: 'state', activeSessionId: null, session: null }, { type: 'sessionTabs', tabs: [], selectedTabId: null }]);
    });

    it('passes on replays and changes to the pickers', () => {
      const { environment, controller } = setup();

      controller.notifyLoadSessionStart('s1');
      controller.notifyLoadSessionEnd(false);
      controller.notifyPickersChanged();

      expect(environment.take()).toEqual([
        { type: 'loadSessionStart' },
        { type: 'loadSessionEnd', ok: false },
        { type: 'pickers', pickers: [modelPicker] },
      ]);
    });

    it('says nothing about pickers when no session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      controller.notifyPickersChanged();

      expect(environment.take()).toEqual([]);
    });
  });

  describe('pickers', () => {
    function pickers(session: SessionInfo): Picker[] {
      const { sessions, environment, controller } = setup();
      sessions.session = session;
      controller.notifyPickersChanged();
      const [message] = environment.take();
      return message?.type === 'pickers' ? message.pickers : [];
    }

    it('shows the modes as a picker for a session without config options', () => {
      expect(pickers(sessionInfo({ configOptions: null, modes }))).toEqual([modePicker]);
      expect(pickers(sessionInfo({ configOptions: [], modes }))).toEqual([modePicker]);
    });

    it('shows only the config options when the session has both, as they replace modes', () => {
      expect(pickers(sessionInfo({ configOptions: [modelOption], modes }))).toEqual([modelPicker]);
    });

    it('shows no picker for modes without any, or for config options other than selects with values', () => {
      expect(pickers(sessionInfo({ configOptions: null, modes: { current: 'ask', available: [] } }))).toEqual([]);
      const unpickable: ConfigOption[] = [
        { kind: 'boolean', id: 'fast', name: 'Fast', description: null, category: 'other', current: false },
        { kind: 'select', id: 'empty', name: 'Empty', description: null, category: 'other', current: '', groups: [] },
      ];
      expect(pickers(sessionInfo({ configOptions: unpickable, modes }))).toEqual([]);
    });

    it('keeps the groups and headers of grouped values', () => {
      const grouped: ConfigOption = {
        ...modelOption,
        current: 'b',
        groups: [
          { header: 'Fast models', values: [{ id: 'a', name: 'A', description: null }] },
          { header: 'slow', values: [{ id: 'b', name: 'B', description: 'Slow' }] },
        ],
      };

      expect(pickers(sessionInfo({ configOptions: [grouped] }))).toEqual([{
        ...modelPicker,
        current: 'b',
        groups: [
          { header: 'Fast models', values: [{ id: 'a', name: 'A', description: null }] },
          { header: 'slow', values: [{ id: 'b', name: 'B', description: 'Slow' }] },
        ],
      }]);
    });
  });

  describe('session title', () => {
    function infoUpdate(fields: { title?: string | null; updatedAt?: string }): SessionUpdate {
      return { kind: 'sessionInfo', ...fields };
    }

    function titles(environment: FakeEnvironment): (string | null)[] {
      return environment.take().flatMap((m) => (m.type === 'sessionInfoUpdate' ? [m.title] : []));
    }

    it('shows the title the agent sets', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate('s1', infoUpdate({ title: 'New title' }));

      expect(titles(environment)).toEqual(['New title']);
    });

    it('keeps the title when an update carries none', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build' });

      controller.handleSessionUpdate('s1', infoUpdate({ updatedAt: '2026-10-18T12:00:00Z' }));

      expect(titles(environment)).toEqual(['Fix the build']);
    });

    it('removes the title when the agent clears it', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build' });

      controller.handleSessionUpdate('s1', infoUpdate({ title: null }));

      expect(titles(environment)).toEqual([null]);
    });
  });

  describe('turns', () => {
    it('restores foreground state and review context when a controller is recreated during autonomous work', async () => {
      const { sessions, controller, environment, editor, terminals } = setup();
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'requiresAction' });
      await controller.dispose();
      environment.take();
      environment.executeCommand.mockClear();
      const replacement = new ChatViewController(sessions, environment, editor, terminals);
      onTestFinished(() => replacement.dispose());
      await replacement.handleMessage({ type: 'ready' });
      expect(replacement.hasRunningTurn).toBe(true);
      const messages = environment.take();
      const first = messages[0];
      if (!first) { throw new Error('Missing session state'); }
      const opened = update(initialState, first, 0).state;
      const streaming = update(opened, { type: 'agentText', messageId: 'autonomous', text: 'Working' }, 1).state;
      const state = messages.reduce((state, message) => update(state, message, 2).state, streaming);
      expect(state.activeSession?.turnRunning).toBe(true);
      expect(state.transcript.currentTurn).toBe(streaming.transcript.currentTurn);
      expect(state.transcript.entries).toEqual(streaming.transcript.entries);
      expect(messages.map((message) => message.type)).toEqual(['state', 'sessionTabs', 'foregroundActivity']);
      expect(environment.executeCommand.mock.calls).toEqual([['setContext', 'acp.turnInProgress', true]]);
    });

    it.each(['answer', 'fail'] as const)('does not end newer autonomous work when an older prompt settles via %s', async (outcome) => {
      const { sessions, controller, environment } = setup();
      const turn = sendPrompt(controller, sessions, 'go');
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'running' });
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'idle' });
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'running' });
      environment.take();
      if (outcome === 'answer') { sessions.answer(); } else { sessions.fail(new Error('Rejected')); }
      await turn;
      expect(controller.hasRunningTurn).toBe(true);
      expect(environment.take()).toEqual(outcome === 'answer' ? [] : [{ type: 'error', message: 'Rejected' }]);
    });

    it('holds queued prompts until prompt acceptance settles and does not release twice for repeated idle', async () => {
      const { sessions, controller, environment } = setup();
      const turn = sendPrompt(controller, sessions, 'go');
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'running' });
      environment.take();
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'idle' });
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'idle' });
      expect(environment.take()).toEqual([]);
      expect(controller.hasRunningTurn).toBe(true);
      sessions.answer();
      await turn;
      expect(environment.take()).toEqual([{ type: 'promptEnd' }]);
    });

    it('keeps immediate submission feedback through an initial idle snapshot until foreground work starts', async () => {
      const { sessions, controller, environment } = setup();
      const turn = sendPrompt(controller, sessions, 'go');
      environment.take();
      controller.handleSessionUpdate('s1', { kind: 'foreground', state: 'idle' });
      expect(controller.hasRunningTurn).toBe(true);
      expect(environment.take()).toEqual([]);
      sessions.fail(new Error('Rejected'));
      await turn;
      expect(controller.hasRunningTurn).toBe(false);
    });

    it('refuses a prompt when no session is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await sendPrompt(controller, sessions, 'hello');

      expect(sessions.sendPrompt).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([{ type: 'error', message: 'No active session. Create a session first.' }]);
    });

    it('runs a turn and reports its end', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      expect(sessions.sendPrompt).toHaveBeenCalledExactlyOnceWith('s1', 'hello');
      expect(environment.take()).toEqual([{ type: 'promptStart' }]);
      expect(controller.hasRunningTurn).toBe(true);

      sessions.answer();
      await turn;

      expect(sessions.recordTurnEnded).toHaveBeenCalledExactlyOnceWith('s1');
      expect(environment.take()).toStrictEqual([{ type: 'promptEnd' }]);
      expect(controller.hasRunningTurn).toBe(false);
    });

    it('reports a failed prompt as an error that ends the turn', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.fail(new Error('agent crashed'));
      await turn;

      expect(controller.hasRunningTurn).toBe(false);
      expect(sessions.recordTurnEnded).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([
        { type: 'promptStart' },
        { type: 'error', message: 'agent crashed' },
        { type: 'promptEnd' },
      ]);
    });

    it('uses a generic message when the failure has none', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.fail({});
      await turn;

      expect(environment.take()).toContainEqual({ type: 'error', message: 'Prompt failed' });
    });

    it('tells the editor a turn is in progress until it ends, also when it fails', async () => {
      const { sessions, environment, controller } = setup();
      const inProgress = (value: boolean) => ['setContext', 'acp.turnInProgress', value];

      const turn = sendPrompt(controller, sessions, 'hello');
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true)]);
      sessions.answer();
      await turn;
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true), inProgress(false)]);

      const failing = sendPrompt(controller, sessions, 'again');
      sessions.fail(new Error('agent crashed'));
      await failing;
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true), inProgress(false), inProgress(true), inProgress(false)]);
    });

    it('tells its turn listeners each time it tells the editor, for the review to pause', async () => {
      const { sessions, controller } = setup();
      const heard: boolean[] = [];
      controller.addTurnListener((inProgress) => heard.push(inProgress));

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.answer();
      await turn;
      expect(heard).toEqual([true, false]);
    });

    it('tells a chat view that opens during a turn that the turn is running, so it holds the next prompt', async () => {
      const { sessions, environment, controller } = setup();
      const turn = sendPrompt(controller, sessions, 'hello');
      environment.take();

      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['state', 'sessionTabs', 'foregroundActivity']);

      sessions.answer();
      await turn;
      environment.take();
      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['state', 'sessionTabs']);
    });

    describe('in a session the chat view no longer shows', () => {
      function switchTo(sessions: FakeSessions, controller: ChatViewController, sessionId: string): void {
        sessions.activeId = sessionId;
        controller.notifyActiveSessionChanged();
      }

      it('does not tell the chat view when the turn ends or fails, so it cannot end a turn of the session shown now', async () => {
        const outcomes: [string, (sessions: FakeSessions) => void][] = [
          ['ends', (sessions) => sessions.answer()],
          ['fails', (sessions) => sessions.fail(new Error('agent crashed'))],
        ];
        for (const [name, outcome] of outcomes) {
          const { sessions, environment, controller } = setup();
          const turn = sendPrompt(controller, sessions, 'hello');
          switchTo(sessions, controller, 's2');
          environment.take();

          outcome(sessions);
          await turn;

          expect(environment.take(), name).toEqual([]);
        }
      });

      it('takes the Cancel button off the title bar while another session is shown, and puts it back on return', async () => {
        const { sessions, environment, controller } = setup();
        const turn = sendPrompt(controller, sessions, 'hello');
        environment.executeCommand.mockClear();

        switchTo(sessions, controller, 's2');
        switchTo(sessions, controller, 's1');

        expect(environment.executeCommand.mock.calls).toEqual([
          ['setContext', 'acp.turnInProgress', false],
          ['setContext', 'acp.turnInProgress', true],
        ]);
        sessions.answer();
        await turn;
      });

      it('tells the chat view the turn is still running when it shows that session again', async () => {
        const { sessions, environment, controller } = setup();
        const turn = sendPrompt(controller, sessions, 'hello');
        switchTo(sessions, controller, 's2');
        expect(environment.take().map((message) => message.type)).toEqual(['promptStart', 'state']);

        switchTo(sessions, controller, 's1');

        expect(environment.take().map((message) => message.type)).toEqual(['state', 'foregroundActivity']);
        sessions.answer();
        await turn;
      });

      it("says no turn is running while another session is active, and the left session's turn is again on return", async () => {
        const { sessions, controller } = setup();
        const turn = sendPrompt(controller, sessions, 'hello');

        switchTo(sessions, controller, 's2');
        expect(controller.hasRunningTurn).toBe(false);
        switchTo(sessions, controller, 's1');
        expect(controller.hasRunningTurn).toBe(true);
        sessions.answer();
        await turn;
      });
    });

    it('does not tell the chat view again that a turn is running when the same session is reported again', async () => {
      const { sessions, environment, controller } = setup();
      await controller.handleMessage({ type: 'ready' });
      const turn = sendPrompt(controller, sessions, 'hello');
      environment.take();

      controller.notifyActiveSessionChanged();

      expect(environment.take().map((message) => message.type)).toEqual(['state']);
      sessions.answer();
      await turn;
    });

    describe('when the agent of a session exits', () => {
      it('tells the chat view why its session ended, which ends the turn', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');
        environment.take();

        controller.notifySessionEnded('s1', 'Fake Agent exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([{ type: 'sessionEnded', message: 'Fake Agent exited unexpectedly (code 1).' }]);
        sessions.fail(new Error('ACP connection closed'));
        await turn;
      });

      it('says nothing more when the turn then fails, the session being gone', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');
        controller.notifySessionEnded('s1', 'Fake Agent exited unexpectedly (code 1).');
        sessions.activeId = null;
        controller.notifyActiveSessionChanged();
        environment.take();

        sessions.fail(new Error('ACP connection closed'));
        await turn;

        expect(environment.take()).toEqual([]);
      });

      it('forgets the turn, so the chat view is not told it is running when it opens again', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');

        controller.notifySessionEnded('s1', 'Fake Agent exited unexpectedly (code 1).');
        environment.take();
        await controller.handleMessage({ type: 'ready' });

        expect(environment.take().map((message) => message.type)).toEqual(['state', 'sessionTabs']);
        expect(controller.hasRunningTurn).toBe(false);
        sessions.fail(new Error('ACP connection closed'));
        await turn;
      });

      it('does not tell the chat view about a session it does not show', async () => {
        const { environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        environment.take();

        controller.notifySessionEnded('s2', 'Other exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([]);
      });
    });

    it('knows how many prompts the chat view holds, none once a chat view opens anew', async () => {
      const { controller } = setup();
      expect(controller.queuedPrompts).toBe(0);

      await controller.handleMessage({ type: 'queuedPrompts', count: 2 });
      expect(controller.queuedPrompts).toBe(2);

      await controller.handleMessage({ type: 'ready' });
      expect(controller.queuedPrompts).toBe(0);
    });

    it('tells the chat view to clear the transcript', () => {
      const { environment, controller } = setup();

      controller.clearTranscript();

      expect(environment.take()).toEqual([{ type: 'clearTranscript' }]);
    });
  });

  describe('session controls', () => {
    it('logs a changed picker selection at debug with its picker ID and value', async () => {
      const { sessions, controller } = setup();
      sessions.session = sessionInfo({ configOptions: null, modes });
      const calls: unknown[][] = [];
      setLogSink({
        trace() {},
        debug: (...args) => calls.push(['debug', ...args]),
        info() {},
        warn() {},
        error() {},
      });
      onTestFinished(() => { setLogSink(undefined); });

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'mode', value: 'code' });

      expect(calls).toEqual([['debug', 'Picker value selected', { pickerId: 'mode', value: 'code' }]]);
    });

    it('cancels the active turn', async () => {
      const { sessions, controller } = setup();

      await controller.handleMessage({ type: 'cancelTurn' });

      expect(sessions.cancelTurn).toHaveBeenCalledExactlyOnceWith('s1');
    });

    it('ignores cancel when no session is active and keeps quiet when cancel fails', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;
      await controller.handleMessage({ type: 'cancelTurn' });
      expect(sessions.cancelTurn).not.toHaveBeenCalled();

      sessions.activeId = 's1';
      sessions.cancelTurn.mockRejectedValueOnce(new Error('gone'));
      await controller.handleMessage({ type: 'cancelTurn' });
      expect(environment.take()).toEqual([]);
    });

    it("sets the mode when the session's picker stands for its modes, leaving the pickers to the session's report", async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ configOptions: null, modes });

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'mode', value: 'code' });

      expect(sessions.setMode).toHaveBeenCalledExactlyOnceWith('s1', 'code');
      expect(sessions.setConfigOption).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([]);
    });

    it('reports a mode that cannot be set, and rolls the picker back', async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ configOptions: null, modes });
      sessions.setMode.mockRejectedValueOnce(new Error('unknown mode'));

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'mode', value: 'nope' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set mode: unknown mode' },
        { type: 'pickers', pickers: [modePicker] },
      ]);
    });

    it('sets a config option, then re-sends the pickers from every option the agent returns', async () => {
      const { sessions, environment, controller } = setup();
      sessions.setConfigOption.mockImplementationOnce(async (sessionId, _configId, _value) => {
        const returned: ConfigOption[] = [{ ...modelOption, current: 'b' }];
        sessions.applyConfigOptions(sessionId, returned);
        return returned;
      });

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

      expect(sessions.setConfigOption).toHaveBeenCalledExactlyOnceWith('s1', 'model', 'b');
      expect(sessions.setMode).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([{ type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] }]);
    });

    it("rolls the picker back to the session's options when setting one fails", async () => {
      const { sessions, environment, controller } = setup();
      sessions.setConfigOption.mockRejectedValueOnce(new Error('rejected'));

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set model: rejected' },
        { type: 'pickers', pickers: [modelPicker] },
      ]);
    });

    it('ignores a choice when no session is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

      expect(sessions.setConfigOption).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([]);
    });
  });

  describe('session updates', () => {
    function translated(update: SessionUpdate, session: SessionInfo = sessionInfo()): ExtensionToWebviewMessage[] {
      const { sessions, environment, controller } = setup();
      sessions.session = session;
      vi.useFakeTimers();
      try {
        controller.handleSessionUpdate('s1', update);
        vi.advanceTimersByTime(16);
      } finally {
        vi.useRealTimers();
      }
      return environment.take().filter((message) => message.type !== 'sessionInfoUpdate');
    }

    it('tells the webview about updates to the active session only', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate('s1', toolCall);
      controller.handleSessionUpdate('other', toolCall);

      expect(environment.take()).toEqual([{ type: 'toolCall', toolCallId: 't1', title: 'Read' }]);
    });

    it('delivers reported usage immediately in the webview contract without changing its values', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate('s1', { kind: 'usage', used: 123456, size: 200001, cost: { amount: 0.123456789, currency: 'EUR' } });
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 15000, size: 100000, cost: null });
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } });

      expect(environment.take()).toEqual([
        { type: 'usage', usage: { used: 123456, size: 200001, cost: { amount: 0.123456789, currency: 'EUR' } } },
        { type: 'usage', usage: { used: 15000, size: 100000, cost: null } },
        { type: 'usage', usage: { used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } } },
      ]);
    });

    it('delivers compaction patches and chunks in order between buffered text messages', () => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate('s1', { kind: 'agentText', messageId: 'm1', text: 'Before' });
      controller.handleSessionUpdate('s1', {
        kind: 'compactionUpdate', compactionId: 'c1', status: '_paused',
        summary: { present: false }, error: { present: false },
      });
      controller.handleSessionUpdate('s1', {
        kind: 'compactionSummaryChunk', compactionId: 'c1',
        content: { type: 'resource_link', uri: 'file:///summary', name: 'summary', _meta: { nested: [null, true, 3] } },
      });
      controller.handleSessionUpdate('s1', {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'completed',
        summary: { present: true, value: [{ type: 'text', text: 'Summary' }] }, error: { present: true, value: '' },
      });
      controller.handleSessionUpdate('s1', {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'completed',
        summary: { present: true, value: null }, error: { present: true, value: null },
      });
      controller.handleSessionUpdate('s1', {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'completed',
        summary: { present: true, value: [] }, error: { present: false },
      });
      controller.handleSessionUpdate('s1', { kind: 'agentText', messageId: 'm2', text: 'After' });
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 10, size: 100, cost: null });

      expect(environment.take()).toEqual([
        { type: 'agentText', messageId: 'm1', text: 'Before' },
        { type: 'compactionUpdate', compactionId: 'c1', status: '_paused', summary: { present: false }, error: { present: false } },
        {
          type: 'compactionSummaryChunk', compactionId: 'c1',
          content: { type: 'resource_link', uri: 'file:///summary', name: 'summary', _meta: { nested: [null, true, 3] } },
        },
        {
          type: 'compactionUpdate', compactionId: 'c1', status: 'completed',
          summary: { present: true, value: [{ type: 'text', text: 'Summary' }] }, error: { present: true, value: '' },
        },
        {
          type: 'compactionUpdate', compactionId: 'c1', status: 'completed',
          summary: { present: true, value: null }, error: { present: true, value: null },
        },
        {
          type: 'compactionUpdate', compactionId: 'c1', status: 'completed',
          summary: { present: true, value: [] }, error: { present: false },
        },
        { type: 'agentText', messageId: 'm2', text: 'After' },
        { type: 'usage', usage: { used: 10, size: 100, cost: null } },
      ]);
    });

    it('drops both compaction variants for other sessions or without an active session', () => {
      const { sessions, environment, controller } = setup();
      const patch: SessionUpdate = {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'in_progress',
        summary: { present: false }, error: { present: false },
      };
      const chunk: SessionUpdate = { kind: 'compactionSummaryChunk', compactionId: 'c1', content: { type: 'text', text: 'Summary' } };
      controller.handleSessionUpdate('other', patch);
      controller.handleSessionUpdate('other', chunk);
      sessions.activeId = null;
      controller.handleSessionUpdate('s1', patch);
      controller.handleSessionUpdate('s1', chunk);
      expect(environment.take()).toEqual([]);
    });

    it('drops other-session usage and reports received without an active session', () => {
      const { sessions, environment, controller } = setup();

      controller.handleSessionUpdate('other', { kind: 'usage', used: 999, size: 200000, cost: null });
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 1000, size: 200000, cost: null });
      sessions.activeId = null;
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 2000, size: 200000, cost: null });

      expect(environment.take()).toEqual([{ type: 'usage', usage: { used: 1000, size: 200000, cost: null } }]);
    });

    it('delivers fresh usage during load replay without replaying a cached snapshot', () => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 90000, size: 200000, cost: { amount: 1.25, currency: 'USD' } });
      environment.take();

      controller.notifyLoadSessionStart('s1');
      controller.notifyLoadSessionEnd(true);
      expect(environment.take()).toEqual([{ type: 'loadSessionStart' }, { type: 'loadSessionEnd', ok: true }]);

      controller.notifyLoadSessionStart('s1');
      controller.handleSessionUpdate('s1', { kind: 'usage', used: 15000, size: 100000, cost: null });
      controller.notifyLoadSessionEnd(true);
      expect(environment.take()).toEqual([
        { type: 'loadSessionStart' },
        { type: 'usage', usage: { used: 15000, size: 100000, cost: null } },
        { type: 'loadSessionEnd', ok: true },
      ]);
    });

    it("passes on text, tool calls, the plan and slash commands in the webview's terms", () => {
      expect(translated({ kind: 'agentText', messageId: 'm1', text: 'Hi' })).toEqual([{ type: 'agentText', messageId: 'm1', text: 'Hi' }]);
      expect(translated({ kind: 'thoughtText', messageId: null, text: 'Hm' })).toEqual([{ type: 'thoughtText', messageId: null, text: 'Hm' }]);
      expect(translated({ kind: 'promptText', messageId: 'u1', text: 'Fix it' })).toEqual([{ type: 'promptText', messageId: 'u1', text: 'Fix it' }]);
      expect(translated({ kind: 'agentMessage', messageId: 'm1', text: 'Hi all' })).toEqual([{ type: 'agentMessage', messageId: 'm1', text: 'Hi all' }]);
      expect(translated({ kind: 'thoughtMessage', messageId: 'r1', text: 'Hmm' })).toEqual([{ type: 'thoughtMessage', messageId: 'r1', text: 'Hmm' }]);
      expect(translated({ kind: 'promptMessage', messageId: 'u1', text: 'Fix' })).toEqual([{ type: 'promptMessage', messageId: 'u1', text: 'Fix' }]);
      expect(translated({ kind: 'toolCall', toolCallId: 't1', title: 'Run tests', status: 'running', content: [
        { kind: 'text', text: 'ok' },
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a', newText: 'b' } },
        { kind: 'text', text: 'done' },
      ] })).toEqual([
        { type: 'toolCall', toolCallId: 't1', title: 'Run tests', status: 'running', content: [{ kind: 'text', text: 'ok' }, { kind: 'text', text: 'done' }] },
      ]);
      expect(translated({ kind: 'toolCall', toolCallId: 't1', content: [] })).toEqual([{ type: 'toolCall', toolCallId: 't1', content: [] }]);
      expect(translated({ kind: 'toolCall', toolCallId: 't1' })).toEqual([{ type: 'toolCall', toolCallId: 't1' }]);
      expect(translated({ kind: 'plan', steps: [{ text: 'Read', status: 'completed' }, { text: 'Edit', status: 'running' }] })).toEqual([
        { type: 'plan', steps: [{ text: 'Read', status: 'completed' }, { text: 'Edit', status: 'running' }] },
      ]);
      expect(translated({ kind: 'commands', commands: [{ name: 'review', description: 'Review', takesInput: true, hint: 'what' }] })).toEqual([
        { type: 'commands', commands: [{ name: 'review', description: 'Review', takesInput: true, hint: 'what' }] },
      ]);
    });

    it("passes on a tool call's diffs of both kinds as their files, while acp.showToolCallDiffs is on, in the order reported among its texts", () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      environment.showsDiffs = true;

      controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/project/new.ts', oldText: null, newText: 'a' } },
        { kind: 'text', text: 'moved' },
        { kind: 'diff', diff: {
          kind: 'changes',
          changes: [
            { operation: 'move', path: '/work/project/to.ts', oldPath: '/work/project/from.ts', fileType: 'text', mimeType: null },
            { operation: 'delete', path: '/work/old.bin', fileType: 'binary', mimeType: 'application/octet-stream' },
          ],
          patch: { format: 'git_patch', text: 'diff --git /work/project/from.ts /work/project/to.ts\n' },
        } },
        { kind: 'diff', diff: { kind: 'changes', changes: [{ operation: 'add', path: '/work/project/dir', fileType: 'directory', mimeType: null }], patch: null } },
      ] });

      const file = { oldPath: null, added: 0, removed: 0, hunks: [], note: null, opens: 'file' } as const;
      expect(environment.take()).toEqual([{ type: 'toolCall', toolCallId: 't1', content: [
        { kind: 'diff', files: [{
          ...file,
          operation: 'add',
          path: 'new.ts',
          added: 1,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
          opens: 'fileAndChanges',
        }] },
        { kind: 'text', text: 'moved' },
        { kind: 'diff', files: [
          { ...file, operation: 'move', path: 'to.ts', oldPath: 'from.ts', note: 'noLines' },
          { ...file, operation: 'delete', path: '/work/old.bin', note: 'binary' },
        ] },
        { kind: 'diff', files: [{ ...file, operation: 'add', path: 'dir', note: 'noPatch', opens: null }] },
      ] }]);
    });

    it('reads acp.showToolCallDiffs for each tool call update', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      const edited: SessionUpdate = { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'text', text: 'edited' },
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a', newText: 'b' } },
      ] };

      controller.handleSessionUpdate('s1', edited);
      environment.showsDiffs = true;
      controller.handleSessionUpdate('s1', edited);
      environment.showsDiffs = false;
      controller.handleSessionUpdate('s1', edited);

      expect(environment.take()).toEqual([
        { type: 'toolCall', toolCallId: 't1', content: [{ kind: 'text', text: 'edited' }] },
        { type: 'toolCall', toolCallId: 't1', content: [
          { kind: 'text', text: 'edited' },
          { kind: 'diff', files: [{
            operation: 'modify',
            path: '/work/a.ts',
            oldPath: null,
            added: 1,
            removed: 1,
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
            note: null,
            opens: 'fileAndChanges',
          }] },
        ] },
        { type: 'toolCall', toolCallId: 't1', content: [{ kind: 'text', text: 'edited' }] },
      ]);
    });

    it("passes on a tool call's terminals by ID, and tells the webview of each terminal once its changes settle, for the active session only", async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { sessions, environment, terminals, controller } = setup();
      sessions.session = sessionInfo();
      const feed = (sessionId: string, update: SessionUpdate) => {
        controller.handleSessionUpdate(sessionId, update);
        terminals.handleSessionUpdate(sessionId, update);
      };

      feed('s1', { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute', content: [{ kind: 'terminal', terminalId: 'term' }] });
      feed('s1', { kind: 'terminal', terminalId: 'term', command: 'npm test' });
      feed('s1', { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('\x1b[31mfailed\x1b[0m\n') });
      feed('other', { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('elsewhere') });
      feed('s1', { kind: 'terminal', terminalId: 'term', exitStatus: { exitCode: 1, signal: null } });
      await vi.runAllTimersAsync();

      expect(environment.take()).toEqual([
        { type: 'toolCall', toolCallId: 'c1', content: [{ kind: 'terminal', terminalId: 'term' }] },
        { type: 'terminal', terminalId: 'term', text: 'failed', truncated: false, exitStatus: { exitCode: 1, signal: null } },
      ]);
    });

    it("posts an execute tool call's title and status at once, and its text once cleaned, as command output", async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();

      controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 'c1', title: 'npm test', toolKind: 'execute', status: 'running', content: [
        { kind: 'text', text: 'Downloading 5%\rDownloading done\n' },
      ] });
      expect(environment.take()).toEqual([{ type: 'toolCall', toolCallId: 'c1', title: 'npm test', status: 'running' }]);
      await vi.runAllTimersAsync();

      expect(environment.take()).toEqual([
        { type: 'toolCall', toolCallId: 'c1', content: [{ kind: 'commandOutput', text: 'Downloading done', truncated: false }] },
      ]);
    });

    it("drops an execute tool call's cleaned text once its session is no longer shown", async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();

      controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute', content: [{ kind: 'text', text: 'ran' }] });
      sessions.activeId = null;
      await vi.runAllTimersAsync();

      expect(environment.take()).toEqual([{ type: 'toolCall', toolCallId: 'c1' }]);
    });

    describe("the output of a session that ended, which goes once the chat view clears the session's transcript", () => {
      function shown() {
        const { sessions, terminals, controller } = setup();
        for (const sessionId of ['s1', 's2']) {
          terminals.handleSessionUpdate(sessionId, { kind: 'terminalOutput', terminalId: 't1', data: new TextEncoder().encode('out') });
        }
        controller.notifyActiveSessionChanged();
        /** The session is removed, as the session manager removes it, and no session is shown. */
        const removed = (sessionId: string) => {
          terminals.endSession(sessionId);
          sessions.activeId = null;
          controller.notifyActiveSessionChanged();
        };
        return { sessions, terminals, controller, removed };
      }

      it('stays while the chat view keeps the transcript of a session whose agent exited, and goes once it shows another', () => {
        const { sessions, terminals, controller, removed } = shown();

        controller.notifySessionEnded('s1', 'Fake exited unexpectedly (code 1).');
        removed('s1');
        expect(terminals.info('s1', 't1')).toBeDefined();

        sessions.activeId = 's2';
        controller.notifyActiveSessionChanged();
        expect(terminals.info('s1', 't1')).toBeUndefined();
        expect(terminals.info('s2', 't1')).toBeDefined();
      });

      it('goes when the user disconnects, as the chat view then shows nothing', () => {
        const { terminals, removed } = shown();

        removed('s1');

        expect(terminals.info('s1', 't1')).toBeUndefined();
        expect(terminals.info('s2', 't1')).toBeDefined();
      });

      it('goes when the transcript is cleared', () => {
        const { terminals, controller, removed } = shown();
        controller.notifySessionEnded('s1', 'Fake exited unexpectedly (code 1).');
        removed('s1');

        controller.clearTranscript();

        expect(terminals.info('s1', 't1')).toBeUndefined();
      });
    });

    it("forgets a removed session's commands", () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute' });

      controller.notifySessionRemoved('s1');
      environment.take();
      controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 'c1', content: [{ kind: 'text', text: 'ran' }] });

      expect(environment.take()).toEqual([{ type: 'toolCall', toolCallId: 'c1', content: [{ kind: 'text', text: 'ran' }] }]);
    });

    it('reports pickers from the session once it has applied the change', () => {
      expect(translated({ kind: 'configOptions', options: [{ ...modelOption, current: 'b' }] })).toEqual([
        { type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] },
      ]);
      expect(translated({ kind: 'currentMode', modeId: 'code' }, sessionInfo({ configOptions: null, modes }))).toEqual([
        { type: 'pickers', pickers: [{ ...modePicker, current: 'code' }] },
      ]);
    });

    it('drops the updates the chat view has no place for', () => {
      expect(translated({ kind: 'sessionInfo', updatedAt: '2026-10-20T00:00:00Z' })).toEqual([]);
    });

    it('applies commands, config options, the mode and session info even before the session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;
      const commands = [{ name: 'init', description: 'Init', takesInput: false, hint: null }];

      controller.handleSessionUpdate('s2', { kind: 'commands', commands });
      controller.handleSessionUpdate('s2', { kind: 'configOptions', options: [modelOption] });
      controller.handleSessionUpdate('s2', { kind: 'currentMode', modeId: 'code' });
      controller.handleSessionUpdate('s2', { kind: 'sessionInfo', title: 'Title' });

      expect(sessions.applyAvailableCommands).toHaveBeenCalledExactlyOnceWith('s2', commands);
      expect(sessions.applyConfigOptions).toHaveBeenCalledExactlyOnceWith('s2', [modelOption]);
      expect(sessions.applyCurrentMode).toHaveBeenCalledExactlyOnceWith('s2', 'code');
      expect(sessions.applySessionInfoUpdate).toHaveBeenCalledExactlyOnceWith('s2', expect.objectContaining({ title: 'Title' }));
      expect(environment.take()).toEqual([]);
    });
  });

  describe('text chunks', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
    });

    const answer = (text: string, messageId: string | null = null): ExtensionToWebviewMessage => ({ type: 'agentText', messageId, text });
    const answerChunk = (text: string, messageId: string | null = null): SessionUpdate => ({ kind: 'agentText', messageId, text });

    it('joins the text of a frame into one message', () => {
      const { environment, controller } = setup();

      for (const text of ['Hel', 'lo', ' world']) {
        controller.handleSessionUpdate('s1', answerChunk(text));
      }
      vi.advanceTimersByTime(15);
      expect(environment.take()).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(environment.take()).toEqual([answer('Hello world')]);

      controller.handleSessionUpdate('s1', answerChunk('!'));
      vi.advanceTimersByTime(16);
      expect(environment.take()).toEqual([answer('!')]);
    });

    it('sends the text before anything that follows it, without waiting', async () => {
      const { sessions, environment, controller } = setup();
      const turn = sendPrompt(controller, sessions, 'hello');
      environment.take();

      controller.handleSessionUpdate('s1', answerChunk('reading'));
      controller.handleSessionUpdate('s1', toolCall);
      controller.handleSessionUpdate('s1', answerChunk('done'));
      sessions.answer();
      await turn;

      expect(environment.take()).toEqual([
        answer('reading'),
        { type: 'toolCall', toolCallId: 't1', title: 'Read' },
        answer('done'),
        { type: 'promptEnd' },
      ]);
      vi.advanceTimersByTime(16);
      expect(environment.take()).toEqual([]);
    });

    it("sends a message's whole text without waiting, after the text before it, and joins none of it", () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate('s1', answerChunk('Hel', 'm1'));
      controller.handleSessionUpdate('s1', { kind: 'agentMessage', messageId: 'm1', text: 'Hello' });
      controller.handleSessionUpdate('s1', answerChunk('!', 'm1'));

      expect(environment.take()).toEqual([answer('Hel', 'm1'), { type: 'agentMessage', messageId: 'm1', text: 'Hello' }]);
      vi.advanceTimersByTime(16);
      expect(environment.take()).toEqual([answer('!', 'm1')]);
    });

    it('keeps text of different kinds or messages apart', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate('s1', { kind: 'promptText', messageId: 'u1', text: 'q' });
      controller.handleSessionUpdate('s1', { kind: 'promptText', messageId: 'u2', text: 'r' });
      controller.handleSessionUpdate('s1', { kind: 'thoughtText', messageId: null, text: 'hm' });
      controller.handleSessionUpdate('s1', { kind: 'thoughtText', messageId: null, text: 'm' });
      controller.handleSessionUpdate('s1', answerChunk('a', 'm1'));
      controller.handleSessionUpdate('s1', answerChunk('b', 'm2'));
      vi.advanceTimersByTime(16);

      expect(environment.take()).toEqual([
        { type: 'promptText', messageId: 'u1', text: 'q' },
        { type: 'promptText', messageId: 'u2', text: 'r' },
        { type: 'thoughtText', messageId: null, text: 'hmm' },
        answer('a', 'm1'),
        answer('b', 'm2'),
      ]);
    });
  });

  describe("a tool call's files", () => {
    /** A controller shown a tool call of three files: an edit, a binary file reported without lines, and a patch. */
    function withFiles() {
      const parts = setup();
      parts.environment.showsDiffs = true;
      parts.controller.handleSessionUpdate('s1', { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a\n', newText: 'b\n' } },
        { kind: 'diff', diff: {
          kind: 'changes',
          changes: [
            { operation: 'modify', path: '/work/b.bin', fileType: 'binary', mimeType: null },
            { operation: 'modify', path: '/work/c.ts', fileType: 'text', mimeType: null },
          ],
          patch: { format: 'git_patch', text: '--- /work/c.ts\n+++ /work/c.ts\n@@ -1 +1 @@\n-a\n+c\n' },
        } },
      ] });
      parts.environment.take();
      return parts;
    }

    it("opens the file the webview names by its place across the tool call's diffs, and its changes in the diff editor", async () => {
      const { editor, controller } = withFiles();

      await controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 0 });
      await controller.handleMessage({ type: 'openChanges', toolCallId: 't1', file: 0 });

      expect(editor.open.mock.calls).toEqual([['/work/a.ts']]);
      expect(editor.showChanges.mock.calls).toEqual([['/work/a.ts', 'a\n', 'b\n']]);
    });

    it("undoes a patch's hunks as the agent sent them on the file as it is now", async () => {
      const { editor, controller } = withFiles();
      editor.readText.mockResolvedValueOnce('c\n');

      await controller.handleMessage({ type: 'openChanges', toolCallId: 't1', file: 2 });

      expect(editor.showChanges.mock.calls).toEqual([['/work/c.ts', 'a\n', 'c\n']]);
    });

    it('opens a file without lines but shows no changes of it, and opens nothing it was not shown', async () => {
      const { sessions, editor, controller } = withFiles();

      await controller.handleMessage({ type: 'openChanges', toolCallId: 't1', file: 1 });
      await controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 3 });
      await controller.handleMessage({ type: 'openFile', toolCallId: 'unknown', file: 0 });
      sessions.activeId = 's2';
      await controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 0 });
      sessions.activeId = 's1';
      await controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 1 });

      expect(editor.open.mock.calls).toEqual([['/work/b.bin']]);
      expect(editor.showChanges).not.toHaveBeenCalled();
    });

    it('opens the file chosen from the context menu itself, telling the webview nothing', async () => {
      const { environment, editor, controller } = withFiles();

      await controller.chooseDiffFile({ toolCallId: 't1', file: 0, open: 'changes' });

      expect(editor.showChanges.mock.calls).toEqual([['/work/a.ts', 'a\n', 'b\n']]);
      expect(environment.take()).toEqual([]);
    });

    it("forgets a session's files when the session goes, and when a load is about to report them again", async () => {
      const removed = withFiles();
      removed.controller.notifySessionRemoved('s1');
      await removed.controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 0 });

      const reloaded = withFiles();
      reloaded.controller.notifyLoadSessionStart('s1');
      await reloaded.controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 0 });

      expect(removed.editor.open).not.toHaveBeenCalled();
      expect(reloaded.editor.open).not.toHaveBeenCalled();
    });

    it('logs a file the editor fails to open, as nothing else is waiting on it', async () => {
      const { editor, controller } = withFiles();
      const failure = new Error('no editor');
      editor.open.mockRejectedValueOnce(failure);
      const errors: unknown[][] = [];
      setLogSink({ trace() {}, debug() {}, info() {}, warn() {}, error: (...args) => errors.push(args) });

      try {
        await expect(controller.handleMessage({ type: 'openFile', toolCallId: 't1', file: 0 })).resolves.toBeUndefined();
      } finally {
        setLogSink(undefined);
      }

      expect(errors).toEqual([['Failed to open /work/a.ts', failure]]);
    });
  });
});
