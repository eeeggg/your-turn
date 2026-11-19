import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type {
  AgentApp,
  AuthMethod as AcpAuthMethod,
} from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import {
  UnknownSession,
  type AcpDriver,
  type AuthMethod,
} from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionUpdateHandler } from '@/core/sessions/UpdateHandler';
import { Reviews } from '@/core/review/Reviews';
import { AgentManager, commandNotFound, type AgentConfigEntry } from '@/core/AgentManager';
import {
  AuthenticationCancelled,
  SessionManager,
} from '@/core/sessions/Manager';
import {
  fakeAgent,
  fakeV2Agent,
  unusedHandlers,
  type AgentScript,
  type ExitOrder
} from '@tests/unit/core/InProcessAgents';
import {
  WORKSPACE,
  FIRST_SESSION,
  SECOND_SESSION,
  OLD_SESSION,
  OLDER_SESSION,
  LOADED_SESSION,
  RESUMED_SESSION,
  address,
  modelOption,
  modelConfig,
  setup,
  sessionAgent,
  promptTarget,
} from '@tests/unit/core/sessions/SessionManagerTestSupport';

const LISTED_SESSION = '5c0d51df-76e9-4ea6-b54c-c75c6afae821';
const SECOND_LISTED_SESSION = '40972ed1-a6f0-4221-a351-1cdaf335d338';
const LAST_PAGE_SESSION = '59e34b91-76f2-4b5b-9a78-73382d3fe8b1';
const KEPT_SESSION = '1468854e-6b9b-4e7a-89e0-9f7b8771bdd7';

describe('SessionManager', () => {
  it('retains a background completion until its tab is selected', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION, (app) =>
      app.onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))).script });
    const first = await manager.connectToAgent('fake');
    const second = { ...first, sessionId: SECOND_SESSION, title: 'Other session' };
    const snapshot = () => posted.filter((message) => message.type === 'sessionTabs').at(-1);
    // Control tab selection without changing the production connection policy.
    chatView.sessionTabs.open(second);
    chatView.notifyTabsChanged();
    await manager.sendPrompt(address(FIRST_SESSION), 'Continue');
    expect(snapshot()).toMatchObject({ selectedTabId: 'tab-2', tabs: [{ status: 'completed' }, { status: 'quiet' }] });
    expect(posted.filter(({ type }) => type === 'sessionTabAnnouncement')).toHaveLength(1);

    posted.length = 0;
    await chatView.handleMessage({ type: 'ready' });
    expect(posted.map(({ type }) => type)).not.toContain('sessionTabAnnouncement');
    chatView.sessionTabs.open(first);
    chatView.notifyTabsChanged();
    expect(snapshot()).toMatchObject({ selectedTabId: 'tab-1', tabs: [{ status: 'quiet' }, { status: 'quiet' }] });
    chatView.sessionTabs.open(second);
    chatView.notifyTabsChanged();
    expect(snapshot()).toMatchObject({ tabs: [{ status: 'quiet' }, { status: 'quiet' }] });
  });

  it('retains prompt failure on selection and clears it when new work begins', async () => {
    let fail = true;
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION, (app) =>
      app.onRequest(methods.agent.session.prompt, () => {
        if (fail) { throw RequestError.invalidParams(undefined, 'Prompt rejected'); }
        return { stopReason: 'cancelled' };
      })).script });
    const registration = await manager.connectToAgent('fake');
    const tabs = () => posted.flatMap((message) => message.type === 'sessionTabs' ? message.tabs : []);
    await expect(manager.sendPrompt(address(FIRST_SESSION), 'Continue')).rejects.toThrow('Prompt rejected');
    expect(tabs().at(-1)).toMatchObject({ status: 'failed' });
    chatView.notifySessionOpened(registration);
    expect(tabs().at(-1)).toMatchObject({ status: 'failed' });

    posted.length = 0;
    fail = false;
    await manager.sendPrompt(address(FIRST_SESSION), 'Try again');
    expect(tabs()).toContainEqual(expect.objectContaining({ status: 'working' }));
    expect(tabs().at(-1)).toMatchObject({ status: 'quiet' });
  });

  it('opens navigation references for create, load and resume, but not a failed replay', async () => {
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: randomUUID() }))
      .onRequest(methods.agent.session.load, ({ params }) => {
        if (params.sessionId === 'failed') { throw RequestError.invalidParams(undefined, 'Cannot load'); }
        return {};
      })
      .onRequest(methods.agent.session.resume, () => ({}));
    const { manager, chatView, posted } = setup({ fake: script });
    await manager.connectToAgent('fake');
    await manager.loadSession('fake', LOADED_SESSION);
    await manager.resumeSession('fake', RESUMED_SESSION);
    await expect(manager.loadSession('fake', 'failed')).rejects.toThrow('Cannot load');
    await chatView.handleMessage({ type: 'ready' });
    const snapshots = posted.filter((message) => message.type === 'sessionTabs');
    const review = { modified: false, created: false, deleted: false };
    expect(snapshots.at(-1)).toEqual({ type: 'sessionTabs', selectedTabId: 'tab-3', tabs: [
      { tabId: 'tab-1', title: null, agentName: 'Fake Agent', cwd: '/work', additionalDirectories: [], status: 'quiet', review },
      { tabId: 'tab-2', title: null, agentName: 'Fake Agent', cwd: '/work', additionalDirectories: [], status: 'quiet', review },
      { tabId: 'tab-3', title: null, agentName: 'Fake Agent', cwd: '/work', additionalDirectories: [], status: 'quiet', review },
    ] });
  });

  it('records prompt completion in core after its presentation is disposed', async () => {
    let finish!: () => void;
    const response = new Promise<void>((resolve) => { finish = resolve; });
    const { manager, chatView } = setup({ fake: sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
      await response;
      return { stopReason: 'end_turn' };
    })).script });
    const registration = await manager.connectToAgent('fake');
    const completed: unknown[] = [];
    manager.on('turn-ended', (session) => { completed.push(session); });
    const turn = manager.sendPrompt(address(FIRST_SESSION), 'Continue');
    await chatView.dispose();
    finish();
    await turn;

    expect(completed).toEqual([registration]);
  });

  it('does not record an intentional cancellation as successful completion', async () => {
    const { manager } = setup({ fake: sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, () => ({ stopReason: 'cancelled' }))).script });
    await manager.connectToAgent('fake');
    const completed: unknown[] = [];
    manager.on('turn-ended', (session) => { completed.push(session); });

    await manager.sendPrompt(address(FIRST_SESSION), 'Continue');

    expect(completed).toEqual([]);
    expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(false);
  });

  it.each([false, true])('retains every outstanding submission when the newer one ends (reported idle: %s)', async (reportedIdle) => {
    const replies: (() => void)[] = [];
    let receive!: () => void;
    const received = new Promise<void>((resolve) => { receive = resolve; });
    const { manager } = setup({ fake: sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
      await new Promise<void>((resolve) => {
        replies.push(resolve);
        if (replies.length === 2) { receive(); }
      });
      return { stopReason: 'end_turn' };
    })).script });
    await manager.connectToAgent('fake');
    const first = manager.sendPrompt(address(FIRST_SESSION), 'first');
    const second = manager.sendPrompt(address(FIRST_SESSION), 'second');
    await received;
    try {
      if (reportedIdle) { manager.applyForegroundState(address(FIRST_SESSION), 'idle'); }
      replies[1]?.();
      await second;
      expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(true);
    } finally { replies[0]?.(); await first; }
    expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(false);
  });

  it.each(['disconnect', 'exit'] as const)('resets Stop and review context through the extension lifecycle on %s', async (ending) => {
    const { manager, chatView, agents, executeCommand, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    manager.on('active-session-changed', () => chatView.notifyActiveSessionChanged());
    manager.on('session-removed', (registration) => chatView.notifySessionRemoved(registration));
    manager.on('session-ended', (registration, reason) => chatView.notifySessionEnded(registration, reason));
    const registration = await manager.connectToAgent('fake');
    manager.applyForegroundState(address(FIRST_SESSION), 'running');
    chatView.handleSessionUpdate({ input: {
      origin: { identity: { configuredName: registration.agentName, sessionId: FIRST_SESSION }, sourceId: registration.agentId },
      update: { kind: 'foreground', state: 'running' }, schema: 'v2',
    }, registration });
    expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', true);
    if (ending === 'disconnect') { await manager.disconnectAgent('fake'); }
    else { await agents.running('fake')[0]?.crash(); }
    expect(chatView.hasRunningTurn).toBe(false);
    expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', false);
    expect(posted.filter((message) => message.type === 'sessionTabs').at(-1))
      .toMatchObject({ tabs: [{ status: ending === 'exit' ? 'failed' : 'quiet' }] });
  });

  it.each(['disconnect', 'exit'] as const)('removes every registration on one connection on %s', async (ending) => {
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested = 0;
    const { manager, agents, takeEvents } = setup({ fake: () => fakeAgent().onRequest(methods.agent.session.new, async () => {
      if (++requested === 1) {
        entered();
        await gate;
        return { sessionId: FIRST_SESSION };
      }
      return { sessionId: SECOND_SESSION };
    }) });
    const first = manager.connectToAgent('fake');
    await firstEntered;
    try { await manager.connectToAgent('fake'); }
    finally { release(); await first; }
    expect(agents.launched).toHaveLength(1);
    expect(manager.getSession(address(FIRST_SESSION))).toBeDefined();
    expect(manager.getSession(address(SECOND_SESSION))).toBeDefined();
    takeEvents();

    if (ending === 'disconnect') { await manager.disconnectAgent('fake'); }
    else { await agents.running('fake')[0]?.crash(); }

    expect(manager.getSession(address(FIRST_SESSION))).toBeUndefined();
    expect(manager.getSession(address(SECOND_SESSION))).toBeUndefined();
    expect(manager.getActiveSession()).toBeUndefined();
    expect(takeEvents().filter(([event]) => event === 'active-session-changed')).toEqual([['active-session-changed', null]]);
  });

  it.each(['request failure', 'cancelled authentication', 'authentication failure', 'failed retry'] as const)(
    'preserves a sibling when a new session encounters %s', async (failure) => {
      let entered!: () => void;
      let release!: () => void;
      const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let requested = 0;
      const { manager, agents, authPrompt } = setup({ fake: () => fakeAgent({ authMethods: [{ id: 'test', name: 'Test' }] })
        .onRequest(methods.agent.authenticate, () => {
          if (failure === 'authentication failure') { throw RequestError.internalError(undefined, 'Cannot authenticate'); }
          return {};
        })
        .onRequest(methods.agent.session.new, async () => {
          if (++requested === 2) { return { sessionId: SECOND_SESSION }; }
          if (requested === 1) { entered(); await gate; }
          if (failure === 'request failure' || requested > 2) { throw RequestError.internalError(undefined, 'Cannot create session'); }
          throw RequestError.authRequired();
        })
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })) });
      if (failure !== 'cancelled authentication') { authPrompt.chooseAuthMethod.mockResolvedValue({ id: 'test', name: 'Test', description: null }); }
      const first = manager.connectToAgent('fake');
      const rejected = expect(first).rejects.toThrow(failure === 'cancelled authentication' ? AuthenticationCancelled
        : failure === 'authentication failure' ? 'Cannot authenticate' : 'Cannot create session');
      await firstEntered;
      try { await manager.connectToAgent('fake'); }
      finally { release(); await rejected; }

      expect(agents.launched).toHaveLength(1);
      expect(manager.getActiveSession()?.sessionId).toBe(SECOND_SESSION);
      await expect(manager.sendPrompt(address(SECOND_SESSION), 'Keep working')).resolves.toBeUndefined();
    },
  );

  it.each(['load', 'resume'] as const)('keeps an unselected sibling usable after a rejected %s', async (how) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    const reject = () => { throw RequestError.internalError(undefined, 'Cannot open session'); };
    const { manager, agents } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } })
      .onRequest(methods.agent.session.new, async () => {
        if (++requests === 1) { enter(); await gate; return { sessionId: FIRST_SESSION }; }
        return { sessionId: SECOND_SESSION };
      })
      .onRequest(methods.agent.session.load, reject)
      .onRequest(methods.agent.session.resume, reject)
      .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })) });
    const opening = manager.connectToAgent('fake');
    await entered;
    let sibling;
    try { sibling = await manager.connectToAgent('fake'); }
    finally { release(); await opening; }

    const attempt = how === 'load' ? manager.loadSession('fake', OLD_SESSION) : manager.resumeSession('fake', OLD_SESSION);
    await expect(attempt).rejects.toThrow('Cannot open session');

    expect(manager.getSession(address(OLD_SESSION))).toBeUndefined();
    expect(manager.getSession(address(SECOND_SESSION))).toBe(sibling);
    expect(agents.launched).toHaveLength(1);
    await expect(manager.sendPrompt(address(SECOND_SESSION), 'Keep working')).resolves.toBeUndefined();
  });

  it('keeps another agent opening snapshot when an unrelated connection exits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, agents, receivedAtLeast, chatView } = setup({
      other: () => fakeV2Agent(),
      fake: () => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
        await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'running' } });
        await gate;
        return { sessionId: FIRST_SESSION };
      }),
    });
    await manager.ensureConnected('other');
    const opening = manager.connectToAgent('fake');
    try {
      await receivedAtLeast(1);
      await agents.running('other')[0]?.crash();
    } finally { release(); }
    await opening;
    expect(chatView.hasRunningTurn).toBe(true);
  });

  it.each([
    ['disconnect', FIRST_SESSION], ['exit', FIRST_SESSION],
    ['disconnect', SECOND_SESSION], ['exit', SECOND_SESSION],
  ] as const)('keeps the selected chat and review on unrelated %s (other session ID: %s)', async (ending, otherId) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, agents, chatView, posted, takeEvents } = setup({
      fake: sessionAgent(FIRST_SESSION).script,
      other: () => fakeAgent().onRequest(methods.agent.session.new, async () => {
        enter();
        await gate;
        return { sessionId: otherId };
      }),
    });
    const reviews = new Reviews({ read: async () => 'B', restore: async () => {}, watch: () => ({ dispose() {} }), snapshot: () => undefined,
      applyEdit: async () => { throw new Error('Unexpected edit'); }, save: async () => { throw new Error('Unexpected save'); },
    }, manager);
    onTestFinished(() => reviews.dispose());
    manager.on('active-session-changed', (registration) => {
      reviews.activeSessionChanged(registration);
      chatView.notifyActiveSessionChanged();
    });
    manager.on('session-removed', (registration) => {
      reviews.sessionRemoved(registration);
      chatView.notifySessionRemoved(registration);
    });
    manager.on('session-ended', (registration, reason) => chatView.notifySessionEnded(registration, reason));

    // Overlap the initial opens so both registrations exist without a new navigation policy.
    const opening = manager.connectToAgent('other');
    await entered;
    try { await manager.connectToAgent('fake'); }
    finally { release(); await opening; }
    const selected = await manager.connectToAgent('fake');
    await reviews.handleSessionUpdate({ origin: { identity: address(FIRST_SESSION), sourceId: selected.agentId }, schema: 'v1',
      update: { kind: 'toolCall', toolCallId: 'edit', status: 'completed',
        content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: '/w/b.ts', oldText: 'b', newText: 'B' } }],
      },
    });
    const shown = reviews.shown();
    expect(shown?.files().map(({ path }) => path)).toEqual(['/w/b.ts']);
    takeEvents();
    posted.length = 0;

    if (ending === 'disconnect') { await manager.disconnectAgent('other'); }
    else { await agents.running('other')[0]?.crash(); }

    expect(manager.getSession({ configuredName: 'other', sessionId: otherId })).toBeUndefined();
    expect(manager.getActiveSession()).toBe(selected);
    expect(reviews.shown()).toBe(shown);
    expect(takeEvents().map(([name]) => name)).not.toContain('active-session-changed');
    expect(posted.map(({ type }) => type)).not.toContain('viewSnapshot');
    expect(posted.map(({ type }) => type)).not.toContain('sessionEnded');
  });

  it('updates the unselected tab without publishing selected title, foreground or buffered text', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, connections, chatView, posted, executeCommand } = setup({
      fake: sessionAgent(FIRST_SESSION).script,
      other: () => fakeAgent().onRequest(methods.agent.session.new, async () => {
        enter();
        await gate;
        return { sessionId: FIRST_SESSION };
      }),
    });
    const sinks = new Map<string, import('@/core/acp/AcpDriver').SessionUpdateSink>();
    const connect = connections.connect.bind(connections);
    vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, sink, closed) => {
      sinks.set(name, sink);
      return connect(name, streams, id, sink, closed);
    });
    const opening = manager.connectToAgent('other');
    await entered;
    try { await manager.connectToAgent('fake'); }
    finally { release(); await opening; }
    const selected = await manager.connectToAgent('fake');
    chatView.notifySessionOpened(selected);
    await chatView.handleMessage({ type: 'ready' });
    const foreground = vi.fn();
    chatView.addTurnListener(foreground);
    const selectedSink = sinks.get('fake');
    const otherSink = sinks.get('other');
    if (!selectedSink || !otherSink) { throw new Error('Missing session update sinks'); }
    posted.length = 0;
    executeCommand.mockClear();

    selectedSink.handleUpdate(FIRST_SESSION, { kind: 'agentText', text: 'Buffered selected text', messageId: null }, 'v1');
    otherSink.handleUpdate(FIRST_SESSION, { kind: 'sessionInfo', title: 'Other title' }, 'v1');
    otherSink.handleUpdate(FIRST_SESSION, { kind: 'foreground', state: 'running' }, 'v2');

    expect(posted.filter(({ type }) => type === 'sessionTabs').at(-1)).toMatchObject({
      selectedTabId: 'tab-1', tabs: [{ title: null, status: 'quiet' }, { title: 'Other title', status: 'working' }],
    });
    expect(posted.filter(({ type }) => type === 'sessionInfoUpdate' || type === 'foregroundActivity' || type === 'contentPatch')).toEqual([]);
    expect(chatView.hasRunningTurn).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(foreground).not.toHaveBeenCalled();
    expect(manager.resolutionBlocked()).toBe(true);

    selectedSink.handleUpdate(FIRST_SESSION, { kind: 'sessionInfo', title: 'Selected title' }, 'v1');
    selectedSink.handleUpdate(FIRST_SESSION, { kind: 'foreground', state: 'running' }, 'v2');
    expect(posted).toContainEqual({ type: 'sessionInfoUpdate', title: 'Selected title' });
    expect(posted).toContainEqual({ type: 'foregroundActivity', running: true });
    expect(posted.some(({ type }) => type === 'contentPatch')).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'your-turn.turnInProgress', true);
    expect(foreground).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not reuse foreground snapshots from a failed opening after its connection exits', async () => {
    let first = true;
    const { manager, chatView } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, async ({ client }) => {
        if (first) {
          first = false;
          await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'running' } });
          throw V2.RequestError.internalError(undefined, 'Cannot open');
        }
        return { sessionId: FIRST_SESSION };
      }) });
    await expect(manager.connectToAgent('fake')).rejects.toThrow('Cannot open');
    await manager.connectToAgent('fake');
    expect(chatView.hasRunningTurn).toBe(false);
  });

  it('restores Stop for autonomous foreground work and keeps it until cancellation reaches idle', async () => {
    let client!: V2.AgentContext;
    let cancel!: (sessionId: string) => void;
    const cancelled = new Promise<string>((resolve) => { cancel = resolve; });
    const { manager, chatView, posted } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, ({ client: connected }) => { client = connected; return { sessionId: FIRST_SESSION }; })
      .onRequest(V2.methods.agent.session.prompt, async () => {
        await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'running' } });
        await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'idle' } });
        return { messageId: 'u1' };
      })
      .onNotification(V2.methods.agent.session.cancel, ({ params }) => cancel(params.sessionId)) });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    await chatView.handleMessage({ type: 'sendPrompt', target: promptTarget(posted), text: 'go' });
    expect(chatView.hasRunningTurn).toBe(false);
    await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'running' } });
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(true);
    await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'requires_action' } });
    await manager.listSessions('fake');
    await chatView.handleMessage({ type: 'ready' });
    const snapshot = [...posted].reverse().flatMap((message) => message.type === 'viewSnapshot' ? message.content ? [message.content] : [] : message.type === 'contentSnapshot' ? [message] : [])[0];
    if (!snapshot) { throw new Error('Missing projection'); }
    await chatView.handleMessage({ type: 'cancelTurn', target: snapshot.target });
    expect(await cancelled).toBe(FIRST_SESSION);
    expect(chatView.hasRunningTurn).toBe(true);
    await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' } });
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(false);
    await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'agent_message_chunk', messageId: 'background', content: { type: 'text', text: 'Detached output' } } });
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(false);
    expect(posted.filter((message) => message.type === 'sessionTabs').at(-1)).toMatchObject({ tabs: [{ status: 'quiet' }] });
  });

  it('shows autonomous completion on an unselected tab, but not on a repeated idle report', async () => {
    let client!: V2.AgentContext;
    const { manager, chatView, posted } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, ({ client: connected }) => { client = connected; return { sessionId: FIRST_SESSION }; }) });
    const session = await manager.connectToAgent('fake');
    chatView.sessionTabs.open({ ...session, sessionId: SECOND_SESSION });
    chatView.notifyTabsChanged();
    await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'running' } });
    for (let i = 0; i < 2; i++) {
      await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });
      await manager.listSessions('fake');
    }
    expect(posted.filter((message) => message.type === 'sessionTabs').at(-1)).toMatchObject({ tabs: [{ status: 'completed' }, { status: 'quiet' }] });
    expect(posted.filter((message) => message.type === 'sessionTabAnnouncement')).toHaveLength(1);
  });

  it('retains running snapshots received before session creation or resume registration', async () => {
    const { manager, chatView } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, async ({ client }) => {
        await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'state_update', state: 'running' } });
        return { sessionId: FIRST_SESSION };
      })
      .onRequest(V2.methods.agent.session.resume, async ({ client, params }) => {
        await client.notify(V2.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'state_update', state: 'requires_action' } });
        return {};
      }) });
    await manager.connectToAgent('fake');
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(true);
    await manager.resumeSession('fake', SECOND_SESSION);
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(true);
    await manager.disconnectAgent('fake');
    expect(chatView.hasRunningTurn).toBe(false);
  });

  describe('connecting', () => {
    it('routes prompts to default creations from separate fixtures and replacement processes', async () => {
      const prompted: string[] = [];
      const recordPrompts = (app: AgentApp) => app.onRequest(methods.agent.session.prompt, ({ params }) => {
        prompted.push(params.sessionId);
        return { stopReason: 'end_turn' };
      });
      const one = sessionAgent(undefined, recordPrompts);
      const two = sessionAgent(undefined, recordPrompts);
      const { manager } = setup({ one: one.script, two: two.script });

      const first = await manager.connectToAgent('one');
      await manager.sendPrompt({ configuredName: first.agentName, sessionId: first.sessionId }, 'first');
      await manager.disconnectAgent('one');
      const second = await manager.connectToAgent('two');
      expect(second.sessionId).not.toBe(first.sessionId);
      await manager.sendPrompt({ configuredName: second.agentName, sessionId: second.sessionId }, 'second');
      const third = await manager.newSession();
      if (!third) { throw new Error('New session did not open'); }
      expect(third.sessionId).not.toBe(first.sessionId);
      expect(third.sessionId).not.toBe(second.sessionId);
      await manager.sendPrompt({ configuredName: third.agentName, sessionId: third.sessionId }, 'third');

      expect(prompted).toEqual([first.sessionId, second.sessionId, third.sessionId]);
      expect(manager.getActiveSessionId()).toBe(third.sessionId);
    });

    it('routes prompts to distinct sessions created before and after replacing a connection', async () => {
      const prompted: string[] = [];
      const firstId = '906a3a77-17a9-4e9d-a3af-3e27da496aa8';
      const secondId = '30aed0e8-9bf4-48d7-baae-6ac5bd324d90';
      const thirdId = '68a2c441-35fc-4a52-aac2-f82ff3d6bf38';
      const fake = sessionAgent([firstId, secondId, thirdId], (app) => app.onRequest(methods.agent.session.prompt, ({ params }) => {
        prompted.push(params.sessionId);
        return { stopReason: 'end_turn' };
      }));
      const { manager, agents } = setup({ fake: fake.script });
      const first = await manager.connectToAgent('fake');
      await manager.sendPrompt(address(first.sessionId), 'first');
      const second = await manager.newSession();
      expect(second).toBeDefined();
      if (!second) { throw new Error('New session did not open'); }
      expect(second.sessionId).not.toBe(first.sessionId);
      await manager.sendPrompt(address(second.sessionId), 'second');
      await manager.disconnectAgent('fake');
      const third = await manager.connectToAgent('fake');
      expect(third.sessionId).not.toBe(first.sessionId);
      expect(third.sessionId).not.toBe(second.sessionId);
      await manager.sendPrompt(address(third.sessionId), 'third');

      expect(prompted).toEqual([firstId, secondId, thirdId]);
      expect(manager.getActiveSessionId()).toBe(thirdId);
      expect(agents.launched).toHaveLength(3);
    });

    it('tells whether an agent is running, without starting it', async () => {
      const { manager, agents } = setup({ fake: sessionAgent().script });
      expect(manager.isRunning('fake')).toBe(false);
      expect(agents.launched).toHaveLength(0);

      await manager.ensureConnected('fake');
      expect(manager.isRunning('fake')).toBe(true);

      await manager.disconnectAgent('fake');
      expect(manager.isRunning('fake')).toBe(false);
    });

    it('creates a session in the workspace and makes it active', async () => {
      const fake = sessionAgent(FIRST_SESSION);
      const { manager, reference, workspace, takeEvents } = setup({ fake: fake.script });

      const session = await manager.connectToAgent('fake');

      expect(fake.requests).toEqual([{ method: 'session/new', params: { cwd: '/work', mcpServers: [] } }]);
      expect(session).toMatchObject({
        sessionId: FIRST_SESSION,
        agentName: 'fake',
        agentDisplayName: 'Fake Agent',
        cwd: '/work',
        modes: null,
        configOptions: [modelConfig('a')],
      });
      expect(manager.getActiveSessionId()).toBe(FIRST_SESSION);
      expect(manager.hasSession('fake')).toBe(true);
      expect(takeEvents()).toEqual([['session-added', session], ['active-session-changed', session]]);
      expect(reference(FIRST_SESSION)).toMatchObject(address(FIRST_SESSION));
      expect(workspace.lastActiveSession()).toEqual(address(FIRST_SESSION));
    });

    it("launches the agent in the workspace's first folder, and gives the sessions it creates, loads and resumes the others", async () => {
      const init = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, additionalDirectories: {} } } };
      const fake = sessionAgent(undefined, (app) => app
        .onRequest(methods.agent.session.load, ({ params }) => { fake.requests.push({ method: 'session/load', params }); return {}; })
        .onRequest(methods.agent.session.resume, ({ params }) => { fake.requests.push({ method: 'session/resume', params }); return {}; }), init);
      const { manager, agents, withOtherFolders } = setup({ fake: fake.script });
      withOtherFolders('/more', '/other');

      await manager.connectToAgent('fake');
      await manager.loadSession('fake', OLD_SESSION);
      await manager.resumeSession('fake', OLDER_SESSION);

      expect(agents.launched.map((launched) => launched.cwd)).toEqual(['/work']);
      const additionalDirectories = ['/more', '/other'];
      expect(fake.requests).toEqual([
        { method: 'session/new', params: { cwd: '/work', additionalDirectories, mcpServers: [] } },
        { method: 'session/load', params: { sessionId: OLD_SESSION, cwd: '/work', additionalDirectories, mcpServers: [] } },
        { method: 'session/resume', params: { sessionId: OLDER_SESSION, cwd: '/work', additionalDirectories, mcpServers: [] } },
      ]);
    });

    it('records nothing about a session in a window with no workspace target', async () => {
      const { manager, references, workspace, withoutWorkspaceTarget } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      withoutWorkspaceTarget();

      await manager.connectToAgent('fake');
      manager.applySessionInfoUpdate(address(FIRST_SESSION), { title: 'Named' });
      manager.recordTurnEnded(address(FIRST_SESSION));

      expect(manager.getSession(address(FIRST_SESSION))?.title).toBe('Named');
      expect(references.list(WORKSPACE.host, 'fake', '/work')).toEqual([]);
      expect(workspace.lastActiveSession()).toBeUndefined();
    });

    it('records nothing while the workspace target is pending, and records the session once it is known', async () => {
      const { manager, references, reference, workspace, withPendingWorkspaceTarget } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const learn = withPendingWorkspaceTarget();

      await manager.connectToAgent('fake');
      manager.applySessionInfoUpdate(address(FIRST_SESSION), { title: 'Named' });
      manager.recordTurnEnded(address(FIRST_SESSION));
      expect(references.list(WORKSPACE.host, 'fake', '/work')).toEqual([]);
      expect(workspace.lastActiveSession()).toBeUndefined();

      learn();
      await manager.recordsSettled();
      expect(reference(FIRST_SESSION)).toMatchObject({ ...address(FIRST_SESSION), title: 'Named' });
      expect(workspace.lastActiveSession()).toEqual(address(FIRST_SESSION));
    });

    it('reuses the live session when connecting to the same agent again', async () => {
      const fake = sessionAgent();
      const { agents, manager } = setup({ fake: fake.script });

      const first = await manager.connectToAgent('fake');
      const second = await manager.connectToAgent('fake');

      expect(second).toBe(first);
      expect(agents.launched).toHaveLength(1);
      expect(fake.requests).toHaveLength(1);
    });

    it('disconnects the previous agent when connecting to another', async () => {
      const { agents, manager, takeEvents } = setup({ one: sessionAgent(FIRST_SESSION).script, two: sessionAgent(SECOND_SESSION).script });
      const previous = await manager.connectToAgent('one');
      takeEvents();

      await manager.connectToAgent('two');

      expect(agents.running('one')).toEqual([]);
      expect(manager.getSession({ configuredName: 'one', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(manager.getAgentNamesWithSessions()).toEqual(['two']);
      expect(takeEvents().slice(0, 2)).toEqual([['session-removed', previous], ['active-session-changed', null]]);
    });

    it('reuses an agent already launched to list its sessions', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });

      await manager.ensureConnected('fake');
      expect(manager.hasSession('fake')).toBe(false);
      await manager.connectToAgent('fake');

      expect(agents.launched).toHaveLength(1);
      expect(manager.hasSession('fake')).toBe(true);
    });

    it('reports the capabilities of an agent launched without a session', async () => {
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } });
      const { manager } = setup({ fake: script });

      expect(await manager.ensureConnected('fake')).toEqual({ list: false, load: true, resume: false, additionalDirectories: false });
    });

    it.each(['output-then-exit', 'exit-then-output'] as const)('reports a sessionless connection ending in %s order', async (order) => {
      const { manager, agents } = setup({ fake: () => fakeAgent() });
      const states: boolean[] = [];
      manager.on('connection-changed', () => states.push(manager.isConnected('fake')));
      await manager.ensureConnected('fake');
      expect(states).toEqual([true]);
      const launched = agents.launched[0];
      if (!launched) { throw new Error('Agent did not launch'); }
      await launched.crash(1, order);
      expect(states.at(-1)).toBe(false);
      expect(manager.hasSession('fake')).toBe(false);
    });

    it('does not report a connection until initialization completes', async () => {
      let finish!: () => void;
      let entered!: () => void;
      const initialized = new Promise<void>((resolve) => { finish = resolve; });
      const initializing = new Promise<void>((resolve) => { entered = resolve; });
      const { manager } = setup({ fake: () => agent().onRequest(methods.agent.initialize, async () => {
        entered();
        await initialized;
        return { protocolVersion: 1 };
      }) });
      const connecting = manager.ensureConnected('fake');
      try {
        await initializing;
        expect(manager.isConnected('fake')).toBe(false);
      } finally { finish(); }
      await connecting;
      expect(manager.isConnected('fake')).toBe(true);
    });

    it.each(['connection', 'session'] as const)('retires a disconnected initialization before it can publish a %s', async (kind) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const { manager, agents } = setup({ fake: () => agent()
        .onRequest(methods.agent.initialize, async () => {
          enter();
          await released;
          return { protocolVersion: 1 };
        })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION })) });
      const states: boolean[] = [];
      manager.on('connection-changed', () => states.push(manager.isConnected('fake')));
      const opening = kind === 'connection' ? manager.ensureConnected('fake') : manager.connectToAgent('fake');
      const result = opening.then(() => 'opened', () => 'rejected');
      try {
        await entered;
        await manager.disconnectAgent('fake');
      } finally {
        release();
      }

      expect(await result).toBe('rejected');
      expect(agents.launched[0]?.killed).toBe(true);
      expect(manager.isConnected('fake')).toBe(false);
      expect(manager.getActiveSession()).toBeUndefined();
      expect(states).not.toContain(true);
    });

    it('ignores an old connection closure delivered after its replacement is ready', async () => {
      const { manager, agents, connections } = setup({ fake: () => fakeAgent() });
      const connect = connections.connect.bind(connections);
      const pending: (() => void)[] = [];
      const spy = vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, sink, onClosed) =>
        connect(name, streams, id, sink, () => { if (onClosed) { pending.push(onClosed); } }));
      onTestFinished(() => spy.mockRestore());
      await manager.ensureConnected('fake');
      const old = agents.launched[0];
      if (!old) { throw new Error('Agent did not launch'); }
      await manager.disconnectAgent('fake');
      await old.exitReported;
      expect(pending).toHaveLength(1);
      await manager.ensureConnected('fake');
      const changes: string[] = [];
      manager.on('connection-changed', (name) => changes.push(name));
      pending.shift()?.();
      expect(changes).toEqual([]);
      expect(manager.isConnected('fake')).toBe(true);
    });

    it('notifies retirement once per source without retiring another connection', async () => {
      const { agents, manager } = setup({ fake: () => fakeAgent(), other: () => fakeAgent() });
      const retired: string[] = [];
      manager.on('source-retired', (sourceId) => retired.push(sourceId));
      await manager.ensureConnected('fake');
      await manager.ensureConnected('other');
      const first = agents.launched[0];
      const other = agents.launched[1];
      if (!first || !other) { throw new Error('Agents did not launch'); }

      await manager.disconnectAgent('fake');
      expect(retired).toEqual(['agent_1']);
      expect(manager.isConnected('other')).toBe(true);
      await first.exitReported;
      expect(retired).toEqual(['agent_1']);

      await manager.ensureConnected('fake');
      expect(retired).toEqual(['agent_1']);
      await other.crash(1, 'exit-then-output');
      expect(retired).toEqual(['agent_1', 'agent_2']);
      expect(manager.isConnected('fake')).toBe(true);

      await manager.dispose();
      expect(retired).toEqual(['agent_1', 'agent_2', 'agent_3']);
    });

    it('disconnects an agent launched only to list its sessions', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.ensureConnected('fake');
      const closed = new Promise<void>((resolve) => manager.once('agent-closed', () => resolve()));

      await manager.disconnectAgent('fake');
      await closed;

      expect(agents.launched[0]?.killed).toBe(true);
      expect(takeEvents()).toEqual([['agent-closed', 'agent_1', null]]);
    });

    it('disconnects an agent with a session, dropping the session', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const session = await manager.connectToAgent('fake');
      takeEvents();
      const closed = new Promise<void>((resolve) => manager.once('agent-closed', () => resolve()));

      await manager.disconnectAgent('fake');
      await closed;

      expect(agents.launched[0]?.killed).toBe(true);
      expect(manager.hasSession('fake')).toBe(false);
      expect(manager.getActiveSessionId()).toBeNull();
      expect(takeEvents()).toEqual([
        ['session-removed', session],
        ['active-session-changed', null],
        ['agent-closed', 'agent_1', null],
      ]);
    });

    it('launches one process for concurrent callers', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });

      await Promise.all([manager.ensureConnected('fake'), manager.ensureConnected('fake'), manager.connectToAgent('fake')]);

      expect(agents.launched).toHaveLength(1);
    });

    it('rejects a name with no agent configuration', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });

      await expect(manager.connectToAgent('missing')).rejects.toThrow('No agent configuration named "missing". Configured: fake');
      expect(agents.launched).toEqual([]);
    });

    it('stops the agent when initialize fails', async () => {
      const failing: AgentScript = () => agent().onRequest(methods.agent.initialize, () => {
        throw RequestError.internalError(undefined, 'boom');
      });
      const { agents, manager } = setup({ fake: failing });
      const states: boolean[] = [];
      manager.on('connection-changed', () => states.push(manager.isConnected('fake')));

      await expect(manager.connectToAgent('fake')).rejects.toThrow('boom');
      expect(agents.launched[0]?.killed).toBe(true);
      expect(manager.isConnected('fake')).toBe(false);
      expect(states).toEqual([]);
    });

    it('stops the agent when the session cannot be created', async () => {
      const failing: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => {
        throw RequestError.internalError(undefined, 'no sessions today');
      });
      const { agents, manager } = setup({ fake: failing });

      await expect(manager.connectToAgent('fake')).rejects.toThrow();
      expect(agents.launched[0]?.killed).toBe(true);
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('starts a new session on the same agent and clears the transcript', async () => {
      const script = sessionAgent([FIRST_SESSION, SECOND_SESSION]).script;
      const { manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      takeEvents();

      const session = await manager.newSession();

      expect(session?.sessionId).toBe(SECOND_SESSION);
      expect(manager.getActiveSessionId()).toBe(SECOND_SESSION);
      expect(takeEvents().map(([name]) => name)).toEqual([
        'session-removed', 'active-session-changed', 'clear-transcript', 'session-added', 'active-session-changed',
      ]);
    });
  });

  describe('authentication', () => {
    const methodsOffered: AcpAuthMethod[] = [{ id: 'token', name: 'Token' }, { id: 'browser', name: 'Browser' }];
    /** {@link methodsOffered} as the user is offered them. */
    const choices: AuthMethod[] = [{ id: 'token', name: 'Token', description: null }, { id: 'browser', name: 'Browser', description: null }];

    function authAgent(sessionId?: string) {
      const authenticated: string[] = [];
      const script: AgentScript = () => fakeAgent({ authMethods: methodsOffered })
        .onRequest(methods.agent.authenticate, ({ params }) => {
          authenticated.push(params.methodId);
          return {};
        })
        .onRequest(methods.agent.session.new, () => {
          if (authenticated.length === 0) {
            throw RequestError.authRequired();
          }
          return { sessionId: sessionId ?? randomUUID() };
        });
      return { script, authenticated };
    }

    it('creates distinct sessions after authentication across process replacement', async () => {
      const fake = authAgent();
      const { manager, authPrompt } = setup({ fake: fake.script });
      authPrompt.chooseAuthMethod.mockResolvedValue(choices[1]);
      const first = await manager.connectToAgent('fake');
      const second = await manager.newSession();
      expect(second).toBeDefined();
      expect(second?.sessionId).not.toBe(first.sessionId);
    });

    it('authenticates with the method the user picks, then creates the session', async () => {
      const fake = authAgent(FIRST_SESSION);
      const { manager, authPrompt } = setup({ fake: fake.script });
      authPrompt.chooseAuthMethod.mockResolvedValueOnce(choices[1]);

      const session = await manager.connectToAgent('fake');

      expect(authPrompt.chooseAuthMethod).toHaveBeenCalledExactlyOnceWith('fake', choices);
      expect(fake.authenticated).toEqual(['browser']);
      expect(session.sessionId).toBe(FIRST_SESSION);
    });

    it('stops the agent when the user cancels', async () => {
      const { agents, manager } = setup({ fake: authAgent().script });

      await expect(manager.connectToAgent('fake')).rejects.toThrow(AuthenticationCancelled);
      expect(agents.launched[0]?.killed).toBe(true);
    });

    it('stops the agent and says why when authentication fails', async () => {
      const script: AgentScript = () => fakeAgent({ authMethods: methodsOffered })
        .onRequest(methods.agent.authenticate, () => {
          throw RequestError.internalError(undefined, 'token expired');
        })
        .onRequest(methods.agent.session.new, () => {
          throw RequestError.authRequired();
        });
      const { agents, manager, authPrompt } = setup({ fake: script });
      authPrompt.chooseAuthMethod.mockResolvedValueOnce(choices[0]);

      await expect(manager.connectToAgent('fake')).rejects.toThrow(/^Authentication failed: .*token expired/);
      expect(agents.launched[0]?.killed).toBe(true);
    });

    it('stops the agent when the session still cannot be created after authenticating', async () => {
      const script: AgentScript = () => fakeAgent({ authMethods: methodsOffered })
        .onRequest(methods.agent.authenticate, () => ({}))
        .onRequest(methods.agent.session.new, () => {
          throw RequestError.authRequired();
        });
      const { agents, manager, authPrompt } = setup({ fake: script });
      authPrompt.chooseAuthMethod.mockResolvedValueOnce(choices[0]);

      await expect(manager.connectToAgent('fake')).rejects.toThrow('Authentication required');
      expect(authPrompt.chooseAuthMethod).toHaveBeenCalledOnce();
      expect(agents.launched[0]?.killed).toBe(true);
    });

    describe('when listing sessions', () => {
      /** An agent that lists its sessions only once authenticated. */
      function listingAgent() {
        const authenticated: string[] = [];
        const script: AgentScript = () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } }, authMethods: methodsOffered })
          .onRequest(methods.agent.authenticate, ({ params }) => {
            authenticated.push(params.methodId);
            return {};
          })
          .onRequest(methods.agent.session.list, () => {
            if (authenticated.length === 0) {
              throw RequestError.authRequired();
            }
            return { sessions: [{ sessionId: OLD_SESSION, cwd: '/work' }] };
          });
        return { script, authenticated };
      }

      it('authenticates with the method the user picks, then lists again, keeping the agent', async () => {
        const fake = listingAgent();
        const { agents, manager, authPrompt } = setup({ fake: fake.script });
        authPrompt.chooseAuthMethod.mockResolvedValueOnce(choices[1]);

        const listed = await manager.listSessions('fake');

        expect(fake.authenticated).toEqual(['browser']);
        expect(listed.sessions.map((s) => s.sessionId)).toEqual([OLD_SESSION]);
        expect(agents.running('fake')).toHaveLength(1);
      });

      it('stops the agent when the user cancels', async () => {
        const { agents, manager } = setup({ fake: listingAgent().script });

        await expect(manager.listSessions('fake')).rejects.toThrow(AuthenticationCancelled);
        expect(agents.launched[0]?.killed).toBe(true);
      });
    });

    it('fails clearly when the agent requires authentication but offers no method', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => {
        throw RequestError.authRequired();
      });
      const { agents, manager } = setup({ fake: script });

      await expect(manager.connectToAgent('fake')).rejects.toThrow('requires authentication but did not advertise any auth methods');
      expect(agents.launched[0]?.killed).toBe(true);
    });
  });

  describe('prompts and session controls', () => {
    it.each(['running', 'requiresAction'] as const)('blocks review authority decisions while an unregistered sibling reports %s', async (state) => {
      const { manager } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const selected = await manager.connectToAgent('fake');
      const subject = new Reviews({ read: async () => 'A', restore: async () => {}, watch: () => ({ dispose() {} }), snapshot: () => undefined,
        applyEdit: async () => { throw new Error('Unexpected edit'); }, save: async () => { throw new Error('Unexpected save'); },
      }, manager);
      onTestFinished(() => subject.dispose());
      subject.activeSessionChanged(selected);
      await subject.handleSessionUpdate({ origin: {
        identity: { configuredName: selected.agentName, sessionId: selected.sessionId }, sourceId: selected.agentId,
      }, schema: 'v1', update: { kind: 'toolCall', toolCallId: 'edit', status: 'completed',
        content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: '/w/a.ts', oldText: 'a', newText: 'A' } }],
      } });
      const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
      if (!captured) { throw new Error('Missing decision'); }
      manager.applyForegroundState(address(SECOND_SESSION), state, 'sibling-source');
      expect(await subject.decide(captured)).toMatchObject({ kind: 'blocked' });
      expect(subject.shown()?.files()).toEqual([{ path: '/w/a.ts', baseline: 'a', current: 'A' }]);
      manager.applyForegroundState(address(SECOND_SESSION), 'idle', 'sibling-source');
      expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
    });

    it('clears selected Stop on source retirement while a local prompt continuation remains unfinished', async () => {
      let release!: () => void;
      let start!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { start = resolve; });
    const { manager, connections, chatView, executeCommand, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation(async (...args) => {
        const driver = await connect(...args);
        vi.spyOn(driver, 'prompt').mockImplementationOnce(async () => { start(); await gate; return { stopReason: 'end_turn' }; });
        return driver;
      });
      await manager.connectToAgent('fake');
      await chatView.handleMessage({ type: 'ready' });
    const turn = chatView.handleMessage({ type: 'sendPrompt', target: promptTarget(posted), text: 'go' });
      await entered;
      try {
        await manager.disconnectAgent('fake');
        expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', false);
      } finally { release(); await turn; }
    });

    it('keeps a replacement source submission busy when a retired source continuation settles late', async () => {
      let release!: () => void;
      let start!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { start = resolve; });
      const fake = sessionAgent([FIRST_SESSION, FIRST_SESSION], (app) => app.onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })));
    const { manager, connections, chatView, executeCommand, posted } = setup({ fake: fake.script });
      const drivers: AcpDriver[] = [];
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation(async (...args) => {
        const driver = await connect(...args);
        drivers.push(driver);
        return driver;
      });
      await manager.connectToAgent('fake');
      await chatView.handleMessage({ type: 'ready' });
      const oldDriver = drivers[0];
      if (!oldDriver) { throw new Error('Missing old driver'); }
      vi.spyOn(oldDriver, 'prompt').mockImplementationOnce(async () => { start(); await gate; return { stopReason: 'end_turn' }; });
    const oldTurn = chatView.handleMessage({ type: 'sendPrompt', target: promptTarget(posted), text: 'old' });
      await entered;
      await manager.disconnectAgent('fake');
      await manager.connectToAgent('fake');
      const driver = drivers[1];
      if (!driver) { throw new Error('Missing replacement driver'); }
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      vi.spyOn(driver, 'prompt').mockImplementationOnce(async () => { await pending; return { stopReason: 'end_turn' }; });
      const newTurn = manager.sendPrompt(address(FIRST_SESSION), 'new');
      try {
        expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', true);
        release();
        await oldTurn;
        expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(true);
        expect(manager.resolutionBlocked()).toBe(true);
        expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', true);
      } finally { release(); finish(); await Promise.all([oldTurn, newTurn]); }
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('updates selected Stop for direct runtime prompts and clears it when dispatch settles', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
        await gate;
        return { stopReason: 'end_turn' };
      }));
      const { manager, chatView, executeCommand } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      await chatView.handleMessage({ type: 'ready' });
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try {
        expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', true);
      } finally { release(); await turn; }
      expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', false);
    });

    it('blocks an idle-queued decision when a prompt is submitted before it executes', async () => {
      let release!: () => void;
      let start!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { start = resolve; });
      const effects: string[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, () => {
        effects.push('prompt');
        return { stopReason: 'end_turn' };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const first = manager.runDecision(async () => { start(); await gate; });
      await entered;
      const second = manager.runDecision(async () => { effects.push('second'); });
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      release();
      await first;
      expect(await second).toEqual({ kind: 'blocked' });
      await turn;
      expect(effects).toEqual(['prompt']);
    });

    it('publishes activity changes before dispatch and after settlement, and removes listeners', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
        await gate;
        return { stopReason: 'end_turn' };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const heard: boolean[] = [];
      const unsubscribe = manager.onChanged(() => heard.push(manager.resolutionBlocked()));
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try {
        expect(heard).toEqual([true]);
        release();
        await turn;
        expect(heard).toEqual([true, false]);
      } finally { release(); await turn; unsubscribe(); }
      manager.applyForegroundState(address(FIRST_SESSION), 'running');
      expect(heard).toEqual([true, false]);
    });

    it('serializes idle decisions and releases admission when the earlier decision fails', async () => {
      let release!: () => void;
      let start!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { start = resolve; });
      const { manager } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');
      const effects: string[] = [];
      const first = manager.runDecision(async () => {
        effects.push('first');
        start();
        await gate;
        throw new Error('Restore failed');
      });
      const failed = expect(first).rejects.toThrow('Restore failed');
      await entered;
      const second = manager.runDecision(async () => { effects.push('second'); return 'done'; });
      try { expect(effects).toEqual(['first']); }
      finally { release(); await failed; }
      expect(await second).toEqual({ kind: 'completed', value: 'done' });
      expect(effects).toEqual(['first', 'second']);
    });

    it('does not dispatch a waiting prompt after its captured registration is replaced', async () => {
      let release!: () => void;
      let start!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { start = resolve; });
      const prompts: string[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app
        .onRequest(methods.agent.session.load, () => ({}))
        .onRequest(methods.agent.session.prompt, ({ params }) => {
          prompts.push(params.sessionId);
          return { stopReason: 'end_turn' };
        }), { agentCapabilities: { loadSession: true } });
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const decision = manager.runDecision(async () => { start(); await gate; });
      await entered;
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      const failed = expect(turn).rejects.toThrow('Prompt session is no longer current');
      try { await manager.loadSession('fake', FIRST_SESSION); }
      finally { release(); await decision; await failed; }
      expect(prompts).toEqual([]);
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('does not let a controller removal notification release an unfinished runtime submission', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
        await gate;
        return { stopReason: 'end_turn' };
      }));
      const { manager, chatView } = setup({ fake: fake.script });
      const registration = await manager.connectToAgent('fake');
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try {
        chatView.notifySessionRemoved(registration);
        expect(manager.resolutionBlocked()).toBe(true);
      } finally { release(); await turn; }
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it.each(['running', 'requires_action'] as const)('blocks decisions for an unregistered source reporting %s, until only that source retires', async (state) => {
      let client!: V2.AgentContext;
      const { manager, receivedAtLeast } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeV2Agent().onRequest(V2.methods.agent.session.list, ({ client: connected }) => {
          client = connected;
          return { sessions: [] };
        }),
      });
      await manager.connectToAgent('fake');
      await manager.listSessions('other');
      const received = receivedAtLeast(1);
      const update: V2.UpdateSessionNotification['update'] = state === 'running'
        ? { sessionUpdate: 'state_update', state: 'running' }
        : { sessionUpdate: 'state_update', state: 'requires_action' };
      await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update });
      await received;
      expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(false);
      let executed = false;
      expect(await manager.runDecision(async () => { executed = true; })).toEqual({ kind: 'blocked' });
      expect(executed).toBe(false);
      await manager.disconnectAgent('fake');
      expect(manager.resolutionBlocked()).toBe(true);
      await manager.disconnectAgent('other');
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('keeps a removed registration submission busy until it settles on the accepting source', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app
        .onRequest(methods.agent.session.load, () => ({}))
        .onRequest(methods.agent.session.prompt, async () => {
          await gate;
          return { stopReason: 'end_turn' };
        }), { agentCapabilities: { loadSession: true } });
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try {
        await manager.loadSession('fake', SECOND_SESSION);
        expect(manager.hasForegroundWork(address(SECOND_SESSION))).toBe(false);
        expect(manager.resolutionBlocked()).toBe(true);
      } finally { release(); await turn; }
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it.each(['running', 'requiresAction'] as const)('invalidates an admitted decision after reported %s even if idle follows before its next stage', async (state) => {
      let release!: () => void;
      let start!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { start = resolve; });
      const { manager } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');
      const decision = manager.runDecision(async (stillAdmitted) => {
        start();
        await gate;
        return stillAdmitted();
      });
      await entered;
      try {
        manager.applyForegroundState(address(FIRST_SESSION), state);
        manager.applyForegroundState(address(FIRST_SESSION), 'idle');
      } finally { release(); }
      expect(await decision).toEqual({ kind: 'completed', value: false });
    });

    it('retains an outstanding submission through configuration rename and releases its captured activity', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
        await gate;
        return { stopReason: 'end_turn' };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try {
        manager.agentsChanged({ fake: { command: 'fake' } }, { renamed: { command: 'fake' } });
        expect(manager.getSession({ configuredName: 'renamed', sessionId: FIRST_SESSION })?.agentName).toBe('renamed');
        expect(manager.hasForegroundWork({ configuredName: 'renamed', sessionId: FIRST_SESSION })).toBe(true);
        expect(await manager.runDecision(async () => 'unexpected')).toEqual({ kind: 'blocked' });
      } finally { release(); await turn; }
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('releases a waiting prompt after an admitted decision fails', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const prompts: string[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, ({ params }) => {
        prompts.push(params.sessionId);
        return { stopReason: 'end_turn' };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const decision = manager.runDecision(async () => { await gate; throw new Error('Restore failed'); });
      const failed = expect(decision).rejects.toThrow('Restore failed');
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try { expect(prompts).toEqual([]); }
      finally { release(); await failed; await turn; }
      expect(prompts).toEqual([FIRST_SESSION]);
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('does not dispatch a waiting prompt after its accepting source retires', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const { manager, connections } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      const dispatched: string[] = [];
      vi.spyOn(connections, 'connect').mockImplementation(async (...args) => {
        const driver = await connect(...args);
        vi.spyOn(driver, 'prompt').mockImplementation(async (sessionId) => { dispatched.push(sessionId); return { stopReason: 'end_turn' }; });
        return driver;
      });
      await manager.connectToAgent('fake');
      const decision = manager.runDecision(async () => { await gate; });
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      const failed = expect(turn).rejects.toThrow('Prompt session is no longer current');
      try { await manager.disconnectAgent('fake'); }
      finally { release(); await decision; await failed; }
      expect(dispatched).toEqual([]);
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it.each(['resolve', 'reject'] as const)('releases direct prompt activity when dispatch settles by %s', async (outcome) => {
      let release!: () => void;
      const reply = new Promise<void>((resolve) => { release = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
        await reply;
        if (outcome === 'reject') { throw RequestError.internalError(undefined, 'Prompt refused'); }
        return { stopReason: 'end_turn' };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      const settled = outcome === 'reject'
        ? expect(turn).rejects.toThrow('Prompt refused')
        : expect(turn).resolves.toBeUndefined();
      try {
        expect(manager.resolutionBlocked()).toBe(true);
      } finally { release(); await settled; }
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('accounts a prompt immediately but dispatches it only after an admitted decision settles', async () => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const prompts: string[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, ({ params }) => {
        prompts.push(params.sessionId);
        return { stopReason: 'end_turn' };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      let valid: (() => boolean) | undefined;
      const decision = manager.runDecision(async (stillAdmitted) => {
        valid = stillAdmitted;
        started();
        await gate;
        return stillAdmitted();
      });
      await entered;
      const turn = manager.sendPrompt(address(FIRST_SESSION), 'go');
      try {
        expect(manager.resolutionBlocked()).toBe(true);
        expect(prompts).toEqual([]);
        expect(valid?.()).toBe(true);
        let executed = false;
        expect(await manager.runDecision(async () => { executed = true; })).toEqual({ kind: 'blocked' });
        expect(executed).toBe(false);
      } finally { release(); }
      expect(await decision).toEqual({ kind: 'completed', value: true });
      await turn;
      expect(prompts).toEqual([FIRST_SESSION]);
      expect(manager.resolutionBlocked()).toBe(false);
    });

    it('accounts a direct prompt before dispatch settles and releases it on completion', async () => {
      let release!: () => void;
      let receive!: () => void;
      const reply = new Promise<void>((resolve) => { release = resolve; });
      const received = new Promise<void>((resolve) => { receive = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async () => {
        receive();
        await reply;
        return { stopReason: 'end_turn' };
      }));
      const { manager, chatView } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      await chatView.dispose();

      const turn = manager.sendPrompt(address(FIRST_SESSION), 'explain this');
      try {
        expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(true);
        await received;
        expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(true);
      } finally {
        release();
        await turn;
      }
      expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(false);
    });

    it('sends the prompt with the active file linked first', async () => {
      const prompts: unknown[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, ({ params }) => {
        prompts.push(params.prompt);
        return { stopReason: 'end_turn' };
      }));
      const { manager, linkActiveFile } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      linkActiveFile({ uri: 'file:///work/a.ts', name: '/work/a.ts' });

      await manager.sendPrompt(address(FIRST_SESSION), 'explain this');

      expect(prompts).toEqual([[
        { type: 'resource_link', uri: 'file:///work/a.ts', name: '/work/a.ts' },
        { type: 'text', text: 'explain this' },
      ]]);
    });

    it('refuses a prompt for a session it does not have', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      await expect(manager.sendPrompt(address('nope'), 'hi')).rejects.toThrow('Session not found: nope');
    });

    it('sends cancel as a notification', async () => {
      const cancelled: string[] = [];
      let cancellationReceived: () => void = () => {};
      const received = new Promise<void>((resolve) => { cancellationReceived = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onNotification(methods.agent.session.cancel, ({ params }) => {
        cancelled.push(params.sessionId);
        cancellationReceived();
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.cancelTurn(address(FIRST_SESSION));
      await received;

      expect(cancelled).toEqual([FIRST_SESSION]);
    });

  });

  describe('listing sessions', () => {
    const listingCaps = { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } };

    function listingAgent(pages: Record<string, { ids: string[]; nextCursor?: string }>) {
      const requests: unknown[] = [];
      const script: AgentScript = () => fakeAgent(listingCaps)
        .onRequest(methods.agent.session.list, ({ params }) => {
          requests.push(params);
          const page = pages[params.cursor ?? ''] ?? { ids: [] };
          return {
            sessions: page.ids.map((sessionId) => ({ sessionId, cwd: '/work', title: `Title ${sessionId}` })),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          };
        })
        .onRequest(methods.agent.session.load, () => ({}));
      return { script, requests };
    }

    it('lists the sessions the agent knows, with its capabilities cached', async () => {
      const fake = listingAgent({ '': { ids: [LISTED_SESSION, SECOND_LISTED_SESSION], nextCursor: 'page2' } });
      const { manager } = setup({ fake: fake.script });

      const result = await manager.listSessions('fake', { cwd: '/work' });

      expect(fake.requests).toEqual([{ cwd: '/work' }]);
      expect(result.sessions.map((s) => s.sessionId)).toEqual([LISTED_SESSION, SECOND_LISTED_SESSION]);
      expect(result.nextCursor).toBe('page2');
      expect(manager.getCachedCapabilities('fake')).toEqual({ list: true, load: true, resume: true, additionalDirectories: false });
    });

    it('leaves the cursor out on the last page', async () => {
      const fake = listingAgent({ page2: { ids: [LAST_PAGE_SESSION] } });
      const { manager } = setup({ fake: fake.script });

      const result = await manager.listSessions('fake', { cursor: 'page2' });

      expect(fake.requests).toEqual([{ cursor: 'page2' }]);
      expect(result).not.toHaveProperty('nextCursor');
    });

    it("refreshes the titles of listed sessions' references, without referencing the others", async () => {
      const fake = listingAgent({ '': { ids: [LISTED_SESSION, SECOND_LISTED_SESSION] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address(LISTED_SESSION));

      await manager.listSessions('fake');

      expect(reference(LISTED_SESSION)?.title).toBe(`Title ${LISTED_SESSION}`);
      expect(reference(SECOND_LISTED_SESSION)).toBeUndefined();
    });

    it('removes the references of sessions the agent no longer lists, once it lists all of the cwd', async () => {
      const fake = listingAgent({ '': { ids: [LISTED_SESSION] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address(LISTED_SESSION));
      await references.used(address('gone'));

      await manager.listSessions('fake', { cwd: '/work' });

      expect(reference(LISTED_SESSION)).toBeDefined();
      expect(reference('gone')).toBeUndefined();
    });

    it('keeps references while the agent has more pages to list', async () => {
      const fake = listingAgent({ '': { ids: [LISTED_SESSION], nextCursor: 'page2' }, page2: { ids: [SECOND_LISTED_SESSION] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address(KEPT_SESSION));

      await manager.listSessions('fake', { cwd: '/work' });
      await manager.listSessions('fake', { cwd: '/work', cursor: 'page2' });

      expect(reference(KEPT_SESSION)).toBeDefined();
    });

    it('keeps references when the agent lists sessions of every cwd', async () => {
      const fake = listingAgent({ '': { ids: [] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address(KEPT_SESSION));

      await manager.listSessions('fake');

      expect(reference(KEPT_SESSION)).toBeDefined();
    });

    it('refreshes the titles of listed sessions once a pending workspace target is known', async () => {
      const fake = listingAgent({ '': { ids: [LISTED_SESSION] } });
      const { manager, references, reference, withPendingWorkspaceTarget } = setup({ fake: fake.script });
      await references.used(address(LISTED_SESSION));
      const learn = withPendingWorkspaceTarget();

      await manager.listSessions('fake');
      expect(reference(LISTED_SESSION)?.title).toBeUndefined();

      learn();
      await manager.recordsSettled();
      expect(reference(LISTED_SESSION)?.title).toBe(`Title ${LISTED_SESSION}`);
    });

    it('keeps the reference of a session open in this window that the agent does not list', async () => {
      const fake = listingAgent({ '': { ids: [] } });
      const { manager, reference } = setup({ fake: fake.script });
      await manager.loadSession('fake', KEPT_SESSION);

      await manager.listSessions('fake', { cwd: '/work' });

      expect(reference(KEPT_SESSION)).toBeDefined();
    });

    it('refuses to list when the agent does not support it', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      await expect(manager.listSessions('fake')).rejects.toThrow('does not support session/list');
    });
  });

  describe('loading and resuming', () => {
    const caps = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };

    function replayingAgent(onLoad: (sessionId: string) => void = () => {}, createdId?: string) {
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => ({ sessionId: createdId ?? randomUUID() }))
        .onRequest(methods.agent.session.load, async ({ params, client }) => {
          onLoad(params.sessionId);
          if (params.sessionId === 'gone') {
            throw new RequestError(-32002, 'Resource not found', { sessionId: params.sessionId });
          }
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } },
          });
          return { configOptions: [modelOption('b')] };
        })
        .onRequest(methods.agent.session.resume, ({ params }) => {
          if (params.sessionId === 'gone') {
            throw new RequestError(-32002, 'Resource not found', { sessionId: params.sessionId });
          }
          return { configOptions: [modelOption('a')] };
        });
      return script;
    }

    it('creates distinct sessions before loading a prior session on the replacement process', async () => {
      const { manager } = setup({ fake: replayingAgent() });
      const first = await manager.connectToAgent('fake');
      const second = await manager.newSession();
      expect(second).toBeDefined();
      expect(second?.sessionId).not.toBe(first.sessionId);
      const loaded = await manager.loadSession('fake', OLD_SESSION);
      expect(loaded.sessionId).toBe(OLD_SESSION);
    });

    it('loads a session, active while the agent replays it', async () => {
      let activeDuringLoad: string | null = null;
      const { manager, received, takeEvents } = setup({ fake: replayingAgent(() => { activeDuringLoad = manager.getActiveSessionId(); }) });

      let load: unknown;
      manager.once('session-load-start', (started) => { load = started; });
      const session = await manager.loadSession('fake', OLD_SESSION);

      expect(activeDuringLoad).toBe(OLD_SESSION);
      expect(received.map(([sessionId]) => sessionId)).toEqual([OLD_SESSION]);
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(takeEvents()).toEqual([
        ['session-added', session],
        ['active-session-changed', session],
        ['session-load-start', load],
        ['session-load-end', load, true],
      ]);
    });

    it('tells how each session was opened once it has been, and nothing of one that failed to open', async () => {
      const { manager } = setup({ fake: replayingAgent(undefined, FIRST_SESSION) });
      const opened: unknown[] = [];
      manager.on('session-opened', (...args) => opened.push(args));

      const created = await manager.connectToAgent('fake');
      const loaded = await manager.loadSession('fake', LOADED_SESSION);
      const resumed = await manager.resumeSession('fake', RESUMED_SESSION);
      await expect(manager.loadSession('fake', 'gone')).rejects.toThrow('Resource not found');
      await expect(manager.resumeSession('fake', 'gone')).rejects.toThrow('Resource not found');

      expect(opened).toEqual([[created, 'created'], [loaded, 'loaded'], [resumed, 'resumed']]);
    });

    it('records a loaded or resumed session as used and as the last active session in the workspace', async () => {
      const { manager, reference, workspace } = setup({ fake: replayingAgent() });

      await manager.loadSession('fake', LOADED_SESSION);
      expect(reference(LOADED_SESSION)).toMatchObject(address(LOADED_SESSION));
      expect(workspace.lastActiveSession()).toEqual(address(LOADED_SESSION));

      await manager.resumeSession('fake', RESUMED_SESSION);
      expect(reference(RESUMED_SESSION)).toMatchObject(address(RESUMED_SESSION));
      expect(workspace.lastActiveSession()).toEqual(address(RESUMED_SESSION));
    });

    it('drops a session the agent no longer has from the chat view, keeping its reference', async () => {
      const { manager, references, reference, workspace, takeEvents } = setup({ fake: replayingAgent() });
      await references.used(address('gone'));
      let load: import('@/core/sessions/UpdateHandler').SessionLoad | undefined;
      manager.once('session-load-start', (started) => { load = started; });

      await expect(manager.loadSession('fake', 'gone')).rejects.toThrow(UnknownSession);

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.getSession(address('gone'))).toBeUndefined();
      expect(reference('gone')).toBeDefined();
      expect(workspace.lastActiveSession()).toBeUndefined();
      expect(takeEvents()).toEqual([
        ['session-added', load?.registration],
        ['active-session-changed', load?.registration],
        ['session-load-start', load],
        ['session-removed', load?.registration],
        ['session-load-end', load, false],
        ['active-session-changed', null],
      ]);
    });

    it("replaces the same agent's active session when loading another", async () => {
      const { agents, manager, takeEvents } = setup({ fake: replayingAgent(undefined, FIRST_SESSION) });
      const previous = await manager.connectToAgent('fake');
      takeEvents();

      await manager.loadSession('fake', OLD_SESSION);

      expect(agents.launched).toHaveLength(1);
      expect(manager.getSession(address(FIRST_SESSION))).toBeUndefined();
      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(takeEvents()[0]).toEqual(['session-removed', previous]);
    });

    it("disconnects another agent's session before loading", async () => {
      const { agents, manager } = setup({ fake: replayingAgent(), other: sessionAgent().script });
      await manager.connectToAgent('other');

      await manager.loadSession('fake', OLD_SESSION);

      expect(agents.running('other')).toEqual([]);
      expect(manager.getAgentNamesWithSessions()).toEqual(['fake']);
    });

    it('refuses to load when the agent does not support it', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      await expect(manager.loadSession('fake', OLD_SESSION)).rejects.toThrow('does not support session/load');
    });

    it('resumes a session without replay and makes it active', async () => {
      const { manager, received, takeEvents } = setup({ fake: replayingAgent() });

      const session = await manager.resumeSession('fake', OLD_SESSION);

      expect(received).toEqual([]);
      expect(session.configOptions).toEqual([modelConfig('a')]);
      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(takeEvents()).toEqual([['session-added', session], ['active-session-changed', session]]);
    });

    it('keeps the reference of a session the agent cannot resume', async () => {
      const { manager, references, reference } = setup({ fake: replayingAgent() });
      await references.used(address('gone'));

      await expect(manager.resumeSession('fake', 'gone')).rejects.toThrow(UnknownSession);

      expect(reference('gone')).toBeDefined();
    });

    it('removes a session from the session history on request', async () => {
      const { manager, references, reference } = setup({ fake: replayingAgent() });
      await references.used(address(LISTED_SESSION));
      await references.used(address(SECOND_LISTED_SESSION));

      await manager.removeFromHistory('fake', LISTED_SESSION);

      expect(reference(LISTED_SESSION)).toBeUndefined();
      expect(reference(SECOND_LISTED_SESSION)).toBeDefined();
    });

    it('removes a session from the session history once a pending workspace target is known', async () => {
      const { manager, references, reference, withPendingWorkspaceTarget } = setup({ fake: replayingAgent() });
      await references.used(address(LISTED_SESSION));
      const learn = withPendingWorkspaceTarget();

      const removing = manager.removeFromHistory('fake', LISTED_SESSION);
      expect(reference(LISTED_SESSION)).toBeDefined();

      learn();
      await removing;
      expect(reference(LISTED_SESSION)).toBeUndefined();
    });
  });

  describe('titles of reopened sessions', () => {
    /** An agent that lists `old` with the titles given in turn, and loads it, replaying `replayedTitle` if set. */
    function listingAgent(listedTitles: (string | undefined)[], replayedTitle?: string) {
      let page = 0;
      return () => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } })
        .onRequest(methods.agent.session.list, () => {
          const title = listedTitles[page++];
          return { sessions: [{ sessionId: OLD_SESSION, cwd: '/work', ...(title !== undefined ? { title } : {}) }] };
        })
        .onRequest(methods.agent.session.load, async ({ params, client }) => {
          if (replayedTitle !== undefined) {
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: { sessionUpdate: 'session_info_update', title: replayedTitle },
            });
          }
          return {};
        });
    }

    it('titles a loaded session with the title its agent listed', async () => {
      const { manager } = setup({ fake: listingAgent(['Listed title']) });
      await manager.listSessions('fake');

      const session = await manager.loadSession('fake', OLD_SESSION);

      expect(session.title).toBe('Listed title');
    });

    it('lets a title the agent replays during the load replace the listed one', async () => {
      const { manager, received, receivedAtLeast } = setup({ fake: listingAgent(['Listed title'], 'Replayed title') });
      await manager.listSessions('fake');
      const replayed = receivedAtLeast(received.length + 1);

      const session = await manager.loadSession('fake', OLD_SESSION);
      await replayed;

      expect(session.title).toBe('Replayed title');
    });

    it('forgets a listed title once the agent lists the session without one', async () => {
      const { manager } = setup({ fake: listingAgent(['Listed title', undefined]) });
      await manager.listSessions('fake');
      await manager.listSessions('fake');

      const session = await manager.loadSession('fake', OLD_SESSION);

      expect(session).not.toHaveProperty('title');
    });

    it('titles a resumed session from the session history when the agent does not list sessions', async () => {
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { sessionCapabilities: { resume: {} } } })
        .onRequest(methods.agent.session.resume, () => ({}));
      const { manager, references } = setup({ fake: script });
      await references.setTitle(address(OLD_SESSION), 'Remembered title');

      const session = await manager.resumeSession('fake', OLD_SESSION);

      expect(session.title).toBe('Remembered title');
    });

    it('lets a title the agent sends while resuming replace the remembered one', async () => {
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { sessionCapabilities: { resume: {} } } })
        .onRequest(methods.agent.session.resume, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'session_info_update', title: 'Current title' },
          });
          return {};
        });
      const { manager, references } = setup({ fake: script });
      await references.setTitle(address(OLD_SESSION), 'Remembered title');

      const session = await manager.resumeSession('fake', OLD_SESSION);

      expect(session.title).toBe('Current title');
    });

    it('starts a new session untitled', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      const session = await manager.connectToAgent('fake');

      expect(session).not.toHaveProperty('title');
    });
  });

  describe('agent exit', () => {
    it('drops the session when its agent exits', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const session = await manager.connectToAgent('fake');
      takeEvents();

      await agents.launched[0]?.crash(1);

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.hasSession('fake')).toBe(false);
      expect(takeEvents()).toEqual([
        ['session-ended', session, 'Fake Agent exited unexpectedly (code 1).'],
        ['session-removed', session],
        ['active-session-changed', null],
        ['agent-closed', 'agent_1', 1],
      ]);
    });

    it('names no exit code when a signal killed the agent', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const session = await manager.connectToAgent('fake');
      takeEvents();

      await agents.launched[0]?.crash(null);

      expect(takeEvents()).toContainEqual(['session-ended', session, 'Fake Agent exited unexpectedly.']);
    });

    it('announces no end for a session whose agent it stopped itself', async () => {
      const stops: [string, (manager: SessionManager) => Promise<unknown>][] = [
        ['disconnect', (manager) => manager.disconnectAgent('fake')],
        ['new session', (manager) => manager.newSession()],
      ];
      for (const [name, stop] of stops) {
        const fake = sessionAgent();
        const { manager, takeEvents } = setup({ fake: fake.script });
        await manager.connectToAgent('fake');
        const closed = new Promise<void>((resolve) => manager.once('agent-closed', () => resolve()));

        await stop(manager);
        await closed;

        const events = takeEvents().map(([event]) => event);
        expect(events, name).toContain('session-removed');
        expect(events, name).not.toContain('session-ended');
      }
    });

    it('does not retire a live connection when authentication for listing is cancelled', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app
        .onRequest(methods.agent.session.list, () => { throw RequestError.authRequired(); })
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })), {
        agentCapabilities: { sessionCapabilities: { list: {} } }, authMethods: [{ id: 'login', name: 'Log in' }],
      });
      const { manager, takeEvents } = setup({ fake: fake.script });
      const session = await manager.connectToAgent('fake');
      takeEvents();

      await expect(manager.listSessions('fake')).rejects.toThrow(AuthenticationCancelled);

      expect(manager.getActiveSession()).toBe(session);
      await expect(manager.sendPrompt(address(FIRST_SESSION), 'Keep working')).resolves.toBeUndefined();
      expect(takeEvents().map(([event]) => event)).not.toContain('session-removed');
    });

    it('fails a prompt in flight only once the exit has ended its session, whichever the agent reports first', async () => {
      for (const order of ['output-then-exit', 'exit-then-output'] as ExitOrder[]) {
        let promptStarted: () => void = () => {};
        const started = new Promise<void>((resolve) => { promptStarted = resolve; });
        const script: AgentScript = () => fakeAgent()
          .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
          .onRequest(methods.agent.session.prompt, () => {
            promptStarted();
            return new Promise(() => {});
          });
        const { agents, manager, events } = setup({ fake: script });
        await manager.connectToAgent('fake');
        const prompt = manager.sendPrompt(address(FIRST_SESSION), 'hello');
        await started;

        await agents.launched[0]?.crash(1, order);
        const failure = await prompt.then(() => 'answered', () => events.map(([event]) => event));

        expect(failure, order).toContain('session-ended');
        expect(manager.getActiveSessionId(), order).toBeNull();
      }
    });

    it('drops a loaded session when its agent exits', async () => {
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.load, () => ({}));
      const { agents, manager } = setup({ fake: script });
      await manager.loadSession('fake', OLD_SESSION);

      await agents.launched[0]?.crash(1);

      expect(manager.getSession(address(OLD_SESSION))).toBeUndefined();
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('launches a fresh agent after the previous one exited', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });
      await manager.ensureConnected('fake');
      await agents.launched[0]?.crash(1);

      await manager.connectToAgent('fake');

      expect(agents.launched).toHaveLength(2);
    });

    it('keeps the new session working when the replaced agent exits late', async () => {
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: randomUUID() }))
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }));
      const { agents, manager } = setup({ fake: script });
      await manager.connectToAgent('fake');
      const replaced = agents.launched[0];

      const replacement = await manager.newSession();
      expect(replaced?.killed).toBe(true);
      await replaced?.exitReported;

      if (!replacement) { throw new Error('Replacement session did not open'); }
      expect(manager.getActiveSessionId()).toBe(replacement.sessionId);
      expect(manager.hasSession('fake')).toBe(true);
      await expect(manager.sendPrompt(address(replacement.sessionId), 'still there?')).resolves.toBeUndefined();
    });

    describe('when the command cannot start, as real processes', () => {
      function realAgent(config: AgentConfigEntry): SessionManager {
        const manager = new SessionManager(
          new AgentManager(),
          new ConnectionManager('0.0.0-test', () => unusedHandlers),
          { workspaceRoots: () => ({ cwd: process.cwd(), additionalDirectories: [] }), workspaceTarget: () => undefined, workspaceTargetKnown: () => Promise.resolve(undefined), agentConfigs: () => ({ broken: config }), activeFileLink: () => undefined },
          { chooseAuthMethod: vi.fn() },
          new SessionUpdateHandler(),
        );
        onTestFinished(async () => { await manager.dispose(); });
        return manager;
      }

      it('awaits Execa completion when shutting down an initialized real process', async () => {
        const manager = realAgent({ command: process.execPath, args: ['-e', `
          require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
            const request = JSON.parse(line);
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\\n');
          });
        `] });
        await manager.ensureConnected('broken');
        const closed: (number | null)[] = [];
        manager.on('agent-closed', (_id, code) => closed.push(code));

        await manager.dispose();

        expect(closed).toEqual([null]);
      });

      it('fails to connect through a command missing from the PATH with the explanation checking a package runner gives', async () => {
        const manager = realAgent({ command: 'acp-test-no-such-command', args: ['acp'] });

        await expect(manager.connectToAgent('broken')).rejects.toThrow(commandNotFound('acp-test-no-such-command'));
        expect(manager.getActiveSessionId()).toBeNull();
      });

      it('fails to connect with the exit code of a command that exits before answering', async () => {
        const manager = realAgent({ command: process.execPath, args: ['-e', 'process.exitCode = 2'] });

        await expect(manager.connectToAgent('broken')).rejects.toThrow('Agent "broken" exited with code 2 before connecting; its output is in the Your Turn log (Your Turn: Show Log).');
      });
    });

    it('stops every agent on dispose', async () => {
      const { agents, manager, takeEvents } = setup({ one: sessionAgent(FIRST_SESSION).script, two: sessionAgent(SECOND_SESSION).script });
      await manager.ensureConnected('one');
      await manager.connectToAgent('two');
      takeEvents();

      const disposed = manager.dispose();

      expect(agents.launched.map((l) => l.killed)).toEqual([true, true]);
      expect(manager.getActiveSessionId()).toBe(SECOND_SESSION);
      await disposed;
      expect(takeEvents().filter(([event]) => event === 'agent-closed')).toEqual([
        ['agent-closed', 'agent_1', null],
        ['agent-closed', 'agent_2', null],
      ]);
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('awaits an already-disconnected agent during disposal', async () => {
      const { manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.ensureConnected('fake');
      await manager.disconnectAgent('fake');

      await manager.dispose();

      expect(takeEvents()).toEqual([['agent-closed', 'agent_1', null]]);
    });

    it('shares disposal completion between repeated calls', async () => {
      const { manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.ensureConnected('fake');

      const disposed = manager.dispose();

      expect(manager.dispose()).toBe(disposed);
      await disposed;
      expect(takeEvents()).toEqual([['agent-closed', 'agent_1', null]]);
      expect(manager.dispose()).toBe(disposed);
    });

    it('does not reuse a session while disposal is still waiting for its agent to exit', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      const disposed = manager.dispose();

      await expect(manager.connectToAgent('fake')).rejects.toThrow('Session manager is disposed.');
      await disposed;

      expect(manager.getActiveSessionId()).toBeNull();
      expect(agents.launched).toHaveLength(1);
    });

    it('awaits both a replaced agent and its replacement without reporting an unexpected session end', async () => {
      const script = sessionAgent([FIRST_SESSION, SECOND_SESSION]).script;
      const { agents, manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      await manager.newSession();
      takeEvents();

      await manager.dispose();

      expect(agents.launched).toHaveLength(2);
      expect(agents.launched.every((launched) => launched.killed)).toBe(true);
      expect(takeEvents()).not.toContainEqual(['session-ended', SECOND_SESSION, 'Fake Agent exited unexpectedly.']);
      expect(manager.getSession(address(SECOND_SESSION))).toBeUndefined();
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('does not register a session whose reply arrives after shutdown begins', async () => {
      let requested: () => void = () => {};
      const started = new Promise<void>((resolve) => { requested = resolve; });
      let answer: () => void = () => {};
      const reply = new Promise<void>((resolve) => { answer = resolve; });
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async () => {
        requested();
        await reply;
        return { sessionId: FIRST_SESSION };
      });
      const { agents, manager } = setup({ fake: script });
      const connecting = manager.connectToAgent('fake').then(() => 'connected', () => 'closed');
      await started;
      const process = agents.launched[0]?.process;
      if (!process) { throw new Error('Agent was not launched.'); }
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {});
      try {
        const disposed = manager.dispose();
        answer();

        expect(await connecting).toBe('closed');
        expect(manager.getSession(address(FIRST_SESSION))).toBeUndefined();

        await agents.launched[0]?.crash();
        await disposed;
      } finally {
        kill.mockRestore();
        answer();
        await agents.launched[0]?.crash();
        await connecting;
      }
    });

    it('keeps what a request in flight as shutdown begins records, then records nothing more', async () => {
      let requested: () => void = () => {};
      const started = new Promise<void>((resolve) => { requested = resolve; });
      let answer: () => void = () => {};
      const reply = new Promise<void>((resolve) => { answer = resolve; });
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } })
        .onRequest(methods.agent.session.list, async () => {
          requested();
          await reply;
          return { sessions: [{ sessionId: LISTED_SESSION, cwd: '/work', title: 'Listed during shutdown' }] };
        });
      const { agents, manager, references, workspace, reference } = setup({ fake: script });
      await references.used(address(LISTED_SESSION));
      const listing = manager.listSessions('fake', { cwd: '/work' });
      await started;
      const process = agents.launched[0]?.process;
      if (!process) { throw new Error('Agent was not launched.'); }
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {});
      try {
        const disposed = manager.dispose();
        answer();
        await listing;
        await agents.launched[0]?.crash();
        await disposed;

        expect(reference(LISTED_SESSION)?.title).toBe('Listed during shutdown');
        await references.used(address(KEPT_SESSION));
        await workspace.setLastActiveSession(address(KEPT_SESSION));
        expect(reference(KEPT_SESSION)).toBeUndefined();
        expect(workspace.lastActiveSession()).toBeUndefined();
      } finally {
        kill.mockRestore();
        answer();
        await agents.launched[0]?.crash();
        await listing.catch(() => {});
      }
    });

    it('ends what waits for a pending workspace target on disposal, recording and removing nothing once it is known', async () => {
      const { manager, references, reference, workspace, withPendingWorkspaceTarget } = setup({ fake: sessionAgent().script });
      await references.used(address(KEPT_SESSION));
      const learn = withPendingWorkspaceTarget();
      const session = await manager.connectToAgent('fake');
      const removing = manager.removeFromHistory('fake', KEPT_SESSION);

      await manager.dispose();
      await manager.recordsSettled();
      await removing;
      learn();
      await references.settled();
      await workspace.settled();

      expect(reference(session.sessionId)).toBeUndefined();
      expect(reference(KEPT_SESSION)).toBeDefined();
      expect(workspace.lastActiveSession()).toBeUndefined();
    });

    it('stops and awaits a process whose initialize request is still pending', async () => {
      let initializing: () => void = () => {};
      const started = new Promise<void>((resolve) => { initializing = resolve; });
      let finishInitialize: () => void = () => {};
      const initialize = new Promise<void>((resolve) => { finishInitialize = resolve; });
      const script: AgentScript = () => agent().onRequest(methods.agent.initialize, async () => {
        initializing();
        await initialize;
        return { protocolVersion: 1 };
      });
      const { agents, manager, takeEvents } = setup({ fake: script });
      const connecting = manager.ensureConnected('fake').then(() => 'connected', () => 'closed');
      try {
        await started;

        await manager.dispose();

        expect(agents.launched[0]?.killed).toBe(true);
        expect(takeEvents()).toEqual([['agent-closed', 'agent_1', null]]);
        expect(await connecting).toBe('closed');
        expect(manager.getCachedCapabilities('fake')).toBeUndefined();
      } finally {
        finishInitialize();
        await agents.launched[0]?.crash();
        await connecting;
      }
    });

    it('refuses new connections and sessions after disposal without launching another process', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });
      await manager.dispose();

      for (const connect of [
        () => manager.ensureConnected('fake'),
        () => manager.connectToAgent('fake'),
        () => manager.listSessions('fake'),
        () => manager.loadSession('fake', OLD_SESSION),
        () => manager.resumeSession('fake', OLD_SESSION),
      ]) {
        await expect(connect()).rejects.toThrow('Session manager is disposed.');
      }
      expect(agents.launched).toEqual([]);
    });
  });
});
