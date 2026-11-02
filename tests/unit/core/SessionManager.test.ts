import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, AuthMethod as AcpAuthMethod, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { UnknownSession, type AuthMethod, type ConfigOption, type FileLink, type SessionRoots, type SessionUpdate } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { setLogSink } from '@/core/Log';
import { AgentManager, commandNotFound, type AgentConfigEntry } from '@/core/AgentManager';
import { AgentTerminals } from '@/core/AgentTerminals';
import { ChatViewController } from '@/core/ChatViewController';
import { SessionReferences, WorkspaceState, type KeyValueStore, type SessionAddress, type WorkspaceTarget } from '@/core/PersistedState';
import {
  AuthenticationCancelled,
  SessionManager,
  type AuthPrompt,
  type SessionEnvironment,
  type SessionManagerEvents,
} from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { fakeAgent, fakeV2Agent, InProcessAgents, unusedEditor, unusedHandlers, work, type AgentScript, type ExitOrder } from './InProcessAgents';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

/** A remote window's workspace file saved on the client, so its URI and host differ. */
const WORKSPACE: WorkspaceTarget = { uri: 'file:///Users/me/work.code-workspace', host: 'vscode-remote://ssh-remote+devenv' };

/** Where session `sessionId` of agent `fake` lives in the test workspace. */
const address = (sessionId: string): SessionAddress =>
  ({ configuredName: 'fake', sessionId, cwd: '/work', host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });

const EVENTS = [
  'session-added',
  'session-removed',
  'active-session-changed',
  'clear-transcript',
  'mode-changed',
  'session-load-start',
  'session-load-end',
  'session-ended',
  'agent-closed',
] as const satisfies readonly (keyof SessionManagerEvents)[];

function modelOption(currentValue: string): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
  };
}

/** {@link modelOption} as the session holds it. */
function modelConfig(current: string): ConfigOption {
  return {
    kind: 'select',
    id: 'model',
    name: 'Model',
    description: null,
    category: 'model',
    current,
    groups: [{ header: null, values: [{ id: 'a', name: 'A', description: null }, { id: 'b', name: 'B', description: null }] }],
  };
}

function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const updates = new SessionUpdateHandler();
  let fileLink: FileLink | undefined;
  let target: WorkspaceTarget | undefined = WORKSPACE;
  let known: Promise<WorkspaceTarget | undefined> | undefined;
  let roots: SessionRoots = work;
  const environment: SessionEnvironment = {
    workspaceRoots: () => roots,
    workspaceTarget: () => target,
    workspaceTargetKnown: () => known ?? Promise.resolve(target),
    agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
    activeFileLink: () => fileLink,
  };
  const authPrompt = { chooseAuthMethod: vi.fn<AuthPrompt['chooseAuthMethod']>(async () => undefined) };
  const manager = new SessionManager(agents, new ConnectionManager(updates, '0.0.0-test', () => ({
    ...unusedHandlers,
    permissions: { ...unusedHandlers.permissions, cancelSession: () => {} },
  })), environment, authPrompt);
  onTestFinished(async () => { await manager.dispose(); });
  const references = new SessionReferences(memoryStore(), () => Date.now());
  const workspace = new WorkspaceState(memoryStore());
  manager.setPersistedState(references, workspace);

  // As in the extension, the chat view applies session updates to the sessions.
  const terminals = new AgentTerminals({ open: () => ({ write: () => {}, show: () => {} }) });
  const executeCommand = vi.fn(async () => {});
  const posted: ExtensionToWebviewMessage[] = [];
  onTestFinished(async () => { await terminals.dispose(); });
  const chatView = new ChatViewController(
    manager,
    { post: (message) => posted.push(message), executeCommand, showsToolCallDiffs: () => false, visible: true, reveal: async () => {}, showInformationMessage: async () => undefined },
    unusedEditor,
    terminals,
    environment,
  );
  manager.on('session-opened', (sessionId) => chatView.notifySessionOpened(sessionId));
  onTestFinished(async () => { updates.dispose(); await chatView.dispose(); });
  const received: [string, SessionUpdate][] = [];
  const receivedWaiters: { count: number; resolve: () => void }[] = [];
  updates.addListener((sessionId, update, _schema, agentId) => {
    received.push([sessionId, update]);
    chatView.handleSessionUpdate(sessionId, update, agentId);
    for (const waiter of receivedWaiters.splice(0)) {
      if (received.length >= waiter.count) {
        waiter.resolve();
      } else {
        receivedWaiters.push(waiter);
      }
    }
  });

  const events: unknown[][] = [];
  for (const name of EVENTS) {
    manager.on(name, (...args: unknown[]) => events.push([name, ...args]));
  }

  return {
    agents,
    manager,
    posted,
    chatView,
    executeCommand,
    references,
    workspace,
    /** The reference to session `sessionId` of agent `fake` on the test workspace's host. */
    reference: (sessionId: string) => references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId }),
    authPrompt,
    received,
    events,
    linkActiveFile(link: FileLink) { fileLink = link; },
    /** As in a multi-root workspace whose other folders are these. */
    withOtherFolders(...additionalDirectories: string[]) { roots = { ...work, additionalDirectories }; },
    /** As in a window with no folder, or an untitled multi-root workspace. */
    withoutWorkspaceTarget() { target = undefined; },
    /** As in a remote window that has yet to learn its workspace URI; the function returned makes it known. */
    withPendingWorkspaceTarget(): () => void {
      target = undefined;
      let learn: () => void = () => {};
      known = new Promise((resolve) => {
        learn = () => {
          target = WORKSPACE;
          known = undefined;
          resolve(WORKSPACE);
        };
      });
      return learn;
    },
    receivedAtLeast(count: number): Promise<void> {
      if (received.length >= count) { return Promise.resolve(); }
      return new Promise((resolve) => receivedWaiters.push({ count, resolve }));
    },
    /** Events emitted since the last call. */
    takeEvents(): unknown[][] { return events.splice(0); },
  };
}

/** An agent that creates session `id` and records the requests it receives. */
function sessionAgent(id = 's1', extend: (app: AgentApp) => AgentApp = (app) => app, init = {}) {
  const requests: { method: string; params: unknown }[] = [];
  const script: AgentScript = () => extend(fakeAgent(init)
    .onRequest(methods.agent.session.new, ({ params }) => {
      requests.push({ method: 'session/new', params });
      return { sessionId: id, configOptions: [modelOption('a')] };
    }));
  return { script, requests };
}

describe('SessionManager', () => {
  it('opens navigation references for create, load and resume, but not a failed replay', async () => {
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'created' }))
      .onRequest(methods.agent.session.load, ({ params }) => {
        if (params.sessionId === 'failed') { throw RequestError.invalidParams(undefined, 'Cannot load'); }
        return {};
      })
      .onRequest(methods.agent.session.resume, () => ({}));
    const { manager, chatView, posted } = setup({ fake: script });
    await manager.connectToAgent('fake');
    await manager.loadSession('fake', 'loaded');
    await manager.resumeSession('fake', 'resumed');
    await expect(manager.loadSession('fake', 'failed')).rejects.toThrow('Cannot load');
    await chatView.handleMessage({ type: 'ready' });
    const snapshots = posted.filter((message) => message.type === 'sessionTabs');
    expect(snapshots.at(-1)).toEqual({ type: 'sessionTabs', selectedTabId: 'tab-3', tabs: [
      { tabId: 'tab-1', title: null, agentName: 'Fake Agent', cwd: '/work', additionalDirectories: [], running: false },
      { tabId: 'tab-2', title: null, agentName: 'Fake Agent', cwd: '/work', additionalDirectories: [], running: false },
      { tabId: 'tab-3', title: null, agentName: 'Fake Agent', cwd: '/work', additionalDirectories: [], running: false },
    ] });
  });

  it.each([false, true])('retains every outstanding submission when the newer one ends (reported idle: %s)', async (reportedIdle) => {
    const { manager } = setup({ fake: sessionAgent().script });
    await manager.connectToAgent('fake');
    const first = manager.beginPrompt('s1');
    const second = manager.beginPrompt('s1');
    if (reportedIdle) { manager.applyForegroundState('s1', 'idle'); }
    manager.endPrompt('s1', second);
    expect(manager.hasForegroundWork('s1')).toBe(true);
    manager.endPrompt('s1', first);
    expect(manager.hasForegroundWork('s1')).toBe(false);
  });

  it.each(['disconnect', 'exit'] as const)('resets Stop and review context through the extension lifecycle on %s', async (ending) => {
    const { manager, chatView, agents, executeCommand } = setup({ fake: sessionAgent().script });
    manager.on('active-session-changed', () => chatView.notifyActiveSessionChanged());
    manager.on('session-removed', (id) => chatView.notifySessionRemoved(id));
    manager.on('session-ended', (id, reason) => chatView.notifySessionEnded(id, reason));
    await manager.connectToAgent('fake');
    chatView.handleSessionUpdate('s1', { kind: 'foreground', state: 'running' });
    expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'acp.turnInProgress', true);
    if (ending === 'disconnect') { await manager.disconnectAgent('fake'); }
    else { await agents.running('fake')[0]?.crash(); }
    expect(chatView.hasRunningTurn).toBe(false);
    expect(executeCommand).toHaveBeenLastCalledWith('setContext', 'acp.turnInProgress', false);
  });

  it('keeps another agent opening snapshot when an unrelated connection exits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, agents, receivedAtLeast, chatView } = setup({
      other: () => fakeV2Agent(),
      fake: () => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
        await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } });
        await gate;
        return { sessionId: 's1' };
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

  it('does not reuse foreground snapshots from a failed opening after its connection exits', async () => {
    let first = true;
    const { manager, chatView } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, async ({ client }) => {
        if (first) {
          first = false;
          await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } });
          throw V2.RequestError.internalError(undefined, 'Cannot open');
        }
        return { sessionId: 's1' };
      }) });
    await expect(manager.connectToAgent('fake')).rejects.toThrow('Cannot open');
    await manager.connectToAgent('fake');
    expect(chatView.hasRunningTurn).toBe(false);
  });

  it('restores Stop for autonomous foreground work and keeps it until cancellation reaches idle', async () => {
    let client!: V2.AgentContext;
    let cancel!: (sessionId: string) => void;
    const cancelled = new Promise<string>((resolve) => { cancel = resolve; });
    const { manager, chatView } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, ({ client: connected }) => { client = connected; return { sessionId: 's1' }; })
      .onRequest(V2.methods.agent.session.prompt, async () => {
        await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } });
        await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle' } });
        return { messageId: 'u1' };
      })
      .onNotification(V2.methods.agent.session.cancel, ({ params }) => cancel(params.sessionId)) });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'sendPrompt', text: 'go' });
    expect(chatView.hasRunningTurn).toBe(false);
    await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } });
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(true);
    await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'requires_action' } });
    await manager.listSessions('fake');
    await chatView.handleMessage({ type: 'cancelTurn' });
    expect(await cancelled).toBe('s1');
    expect(chatView.hasRunningTurn).toBe(true);
    await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' } });
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(false);
    await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'background', content: { type: 'text', text: 'Detached output' } } });
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(false);
  });

  it('retains running snapshots received before session creation or resume registration', async () => {
    const { manager, chatView } = setup({ fake: () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(V2.methods.agent.session.new, async ({ client }) => {
        await client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } });
        return { sessionId: 's1' };
      })
      .onRequest(V2.methods.agent.session.resume, async ({ client, params }) => {
        await client.notify(V2.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'state_update', state: 'requires_action' } });
        return {};
      }) });
    await manager.connectToAgent('fake');
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(true);
    await manager.resumeSession('fake', 's2');
    await manager.listSessions('fake');
    expect(chatView.hasRunningTurn).toBe(true);
    await manager.disconnectAgent('fake');
    expect(chatView.hasRunningTurn).toBe(false);
  });

  describe('connecting', () => {
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
      const fake = sessionAgent();
      const { manager, reference, workspace, takeEvents } = setup({ fake: fake.script });

      const session = await manager.connectToAgent('fake');

      expect(fake.requests).toEqual([{ method: 'session/new', params: { cwd: '/work', mcpServers: [] } }]);
      expect(session).toMatchObject({
        sessionId: 's1',
        agentName: 'fake',
        agentDisplayName: 'Fake Agent',
        cwd: '/work',
        modes: null,
        configOptions: [modelConfig('a')],
      });
      expect(manager.getActiveSessionId()).toBe('s1');
      expect(manager.hasSession('fake')).toBe(true);
      expect(takeEvents()).toEqual([['session-added', 's1', 'fake'], ['active-session-changed', 's1']]);
      expect(reference('s1')).toMatchObject(address('s1'));
      expect(workspace.lastActiveSession()).toEqual(address('s1'));
    });

    it("launches the agent in the workspace's first folder, and gives the sessions it creates, loads and resumes the others", async () => {
      const init = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, additionalDirectories: {} } } };
      const fake = sessionAgent('s1', (app) => app
        .onRequest(methods.agent.session.load, ({ params }) => { fake.requests.push({ method: 'session/load', params }); return {}; })
        .onRequest(methods.agent.session.resume, ({ params }) => { fake.requests.push({ method: 'session/resume', params }); return {}; }), init);
      const { manager, agents, withOtherFolders } = setup({ fake: fake.script });
      withOtherFolders('/more', '/other');

      await manager.connectToAgent('fake');
      await manager.loadSession('fake', 'old');
      await manager.resumeSession('fake', 'older');

      expect(agents.launched.map((launched) => launched.cwd)).toEqual(['/work']);
      const additionalDirectories = ['/more', '/other'];
      expect(fake.requests).toEqual([
        { method: 'session/new', params: { cwd: '/work', additionalDirectories, mcpServers: [] } },
        { method: 'session/load', params: { sessionId: 'old', cwd: '/work', additionalDirectories, mcpServers: [] } },
        { method: 'session/resume', params: { sessionId: 'older', cwd: '/work', additionalDirectories, mcpServers: [] } },
      ]);
    });

    it('records nothing about a session in a window with no workspace target', async () => {
      const { manager, references, workspace, withoutWorkspaceTarget } = setup({ fake: sessionAgent().script });
      withoutWorkspaceTarget();

      await manager.connectToAgent('fake');
      manager.applySessionInfoUpdate('s1', { title: 'Named' });
      manager.recordTurnEnded('s1');

      expect(manager.getSession('s1')?.title).toBe('Named');
      expect(references.list(WORKSPACE.host, 'fake', '/work')).toEqual([]);
      expect(workspace.lastActiveSession()).toBeUndefined();
    });

    it('records nothing while the workspace target is pending, and records the session once it is known', async () => {
      const { manager, references, reference, workspace, withPendingWorkspaceTarget } = setup({ fake: sessionAgent().script });
      const learn = withPendingWorkspaceTarget();

      await manager.connectToAgent('fake');
      manager.applySessionInfoUpdate('s1', { title: 'Named' });
      manager.recordTurnEnded('s1');
      expect(references.list(WORKSPACE.host, 'fake', '/work')).toEqual([]);
      expect(workspace.lastActiveSession()).toBeUndefined();

      learn();
      await manager.recordsSettled();
      expect(reference('s1')).toMatchObject({ ...address('s1'), title: 'Named' });
      expect(workspace.lastActiveSession()).toEqual(address('s1'));
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
      const { agents, manager, takeEvents } = setup({ one: sessionAgent('s1').script, two: sessionAgent('s2').script });
      await manager.connectToAgent('one');
      takeEvents();

      await manager.connectToAgent('two');

      expect(agents.running('one')).toEqual([]);
      expect(manager.getSession('s1')).toBeUndefined();
      expect(manager.getAgentNamesWithSessions()).toEqual(['two']);
      expect(takeEvents().slice(0, 2)).toEqual([['session-removed', 's1', 'one'], ['active-session-changed', null]]);
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
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      takeEvents();
      const closed = new Promise<void>((resolve) => manager.once('agent-closed', () => resolve()));

      await manager.disconnectAgent('fake');
      await closed;

      expect(agents.launched[0]?.killed).toBe(true);
      expect(manager.hasSession('fake')).toBe(false);
      expect(manager.getActiveSessionId()).toBeNull();
      expect(takeEvents()).toEqual([
        ['session-removed', 's1', 'fake'],
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

      await expect(manager.connectToAgent('fake')).rejects.toThrow('boom');
      expect(agents.launched[0]?.killed).toBe(true);
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
      let next = 0;
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: `s${++next}` }));
      const { manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      takeEvents();

      const session = await manager.newSession();

      expect(session?.sessionId).toBe('s2');
      expect(manager.getActiveSessionId()).toBe('s2');
      expect(takeEvents().map(([name]) => name)).toEqual([
        'session-removed', 'active-session-changed', 'clear-transcript', 'session-added', 'active-session-changed',
      ]);
    });
  });

  describe('authentication', () => {
    const methodsOffered: AcpAuthMethod[] = [{ id: 'token', name: 'Token' }, { id: 'browser', name: 'Browser' }];
    /** {@link methodsOffered} as the user is offered them. */
    const choices: AuthMethod[] = [{ id: 'token', name: 'Token', description: null }, { id: 'browser', name: 'Browser', description: null }];

    function authAgent() {
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
          return { sessionId: 's1' };
        });
      return { script, authenticated };
    }

    it('authenticates with the method the user picks, then creates the session', async () => {
      const fake = authAgent();
      const { manager, authPrompt } = setup({ fake: fake.script });
      authPrompt.chooseAuthMethod.mockResolvedValueOnce(choices[1]);

      const session = await manager.connectToAgent('fake');

      expect(authPrompt.chooseAuthMethod).toHaveBeenCalledExactlyOnceWith('fake', choices);
      expect(fake.authenticated).toEqual(['browser']);
      expect(session.sessionId).toBe('s1');
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
            return { sessions: [{ sessionId: 'old', cwd: '/work' }] };
          });
        return { script, authenticated };
      }

      it('authenticates with the method the user picks, then lists again, keeping the agent', async () => {
        const fake = listingAgent();
        const { agents, manager, authPrompt } = setup({ fake: fake.script });
        authPrompt.chooseAuthMethod.mockResolvedValueOnce(choices[1]);

        const listed = await manager.listSessions('fake');

        expect(fake.authenticated).toEqual(['browser']);
        expect(listed.sessions.map((s) => s.sessionId)).toEqual(['old']);
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
    it('sends the prompt with the active file linked first', async () => {
      const prompts: unknown[] = [];
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.prompt, ({ params }) => {
        prompts.push(params.prompt);
        return { stopReason: 'end_turn' };
      }));
      const { manager, linkActiveFile } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      linkActiveFile({ uri: 'file:///work/a.ts', name: '/work/a.ts' });

      await manager.sendPrompt('s1', 'explain this');

      expect(prompts).toEqual([[
        { type: 'resource_link', uri: 'file:///work/a.ts', name: '/work/a.ts' },
        { type: 'text', text: 'explain this' },
      ]]);
    });

    it('refuses a prompt for a session it does not have', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      await expect(manager.sendPrompt('nope', 'hi')).rejects.toThrow('Session not found: nope');
    });

    it('sends cancel as a notification', async () => {
      const cancelled: string[] = [];
      let cancellationReceived: () => void = () => {};
      const received = new Promise<void>((resolve) => { cancellationReceived = resolve; });
      const fake = sessionAgent('s1', (app) => app.onNotification(methods.agent.session.cancel, ({ params }) => {
        cancelled.push(params.sessionId);
        cancellationReceived();
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.cancelTurn('s1');
      await received;

      expect(cancelled).toEqual(['s1']);
    });

    it('replaces the config options with the full set the agent returns', async () => {
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
        configOptions: [modelOption(String(params.value))],
      })));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption('s1', 'model', 'b');

      expect(options).toEqual([modelConfig('b')]);
      expect(manager.getSession('s1')?.configOptions).toEqual([modelConfig('b')]);
    });

    it('keeps the config options, with the value asked for, when the agent answers without them', async () => {
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, () => (
        { configOptions: null } as unknown as { configOptions: SessionConfigOption[] }
      )));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption('s1', 'model', 'b');

      expect(options).toBeNull();
      expect(manager.getSession('s1')?.configOptions).toEqual([modelConfig('b')]);
      expect(reference('s1')?.selections).toEqual({ options: { model: 'b' } });
    });

    it('sets a boolean option, keeping the value asked for when the agent answers without the options', async () => {
      const fast: SessionConfigOption = { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false };
      const set: unknown[] = [];
      const fake: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: 's1', configOptions: [modelOption('a'), fast] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          set.push(params);
          return { configOptions: null } as unknown as { configOptions: SessionConfigOption[] };
        });
      const { manager, reference } = setup({ fake });
      await manager.connectToAgent('fake');

      await manager.setConfigOption('s1', 'fast', true);

      expect(set).toEqual([{ sessionId: 's1', configId: 'fast', type: 'boolean', value: true }]);
      expect(manager.getSession('s1')?.configOptions?.find((option) => option.id === 'fast')?.current).toBe(true);
      expect(reference('s1')?.selections).toEqual({ options: { model: 'a', fast: true } });
    });

    it('sets the model through the model config option', async () => {
      const set: unknown[] = [];
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        set.push(params);
        return { configOptions: [modelOption(String(params.value))] };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.setModel('s1', 'b');

      expect(set).toEqual([{ sessionId: 's1', configId: 'model', value: 'b' }]);
    });

    it('cannot set the model when the agent has no model option', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1' }));
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      await expect(manager.setModel('s1', 'b')).rejects.toThrow('Fake Agent does not expose a model config option');
    });

    it('sets a mode through session/set_mode when the agent has no mode config option', async () => {
      const setModes: string[] = [];
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({
          sessionId: 's1',
          modes: { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
        }))
        .onRequest(methods.agent.session.setMode, ({ params }) => {
          setModes.push(params.modeId);
          return {};
        });
      const { manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      takeEvents();

      await manager.setMode('s1', 'code');

      expect(setModes).toEqual(['code']);
      expect(manager.getSession('s1')?.modes?.current).toBe('code');
      expect(takeEvents()).toEqual([['mode-changed', 's1', 'code']]);
    });

    it('sets the mode through a mode config option when the agent has one', async () => {
      const set: unknown[] = [];
      const modeOption: SessionConfigOption = {
        id: 'agent-mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask',
        options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code' }],
      };
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: 's1', configOptions: [modeOption] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          set.push(params);
          return { configOptions: [{ ...modeOption, currentValue: String(params.value) }] };
        });
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      await manager.setMode('s1', 'code');

      expect(set).toEqual([{ sessionId: 's1', configId: 'agent-mode', value: 'code' }]);
    });
  });

  describe('session updates', () => {
    it('keeps slash commands, config options and a title that arrive while the session is being created', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
        const notify = (update: SessionNotification['update']) =>
          client.notify(methods.client.session.update, { sessionId: 's1', update });
        await notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'Init' }] });
        await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] });
        await notify({ sessionUpdate: 'session_info_update', title: 'Early title' });
        return { sessionId: 's1', configOptions: [modelOption('a')] };
      });
      const { manager, received, receivedAtLeast } = setup({ fake: script });
      const updatesReceived = receivedAtLeast(3);

      const session = await manager.connectToAgent('fake');
      await updatesReceived;

      expect(received).toHaveLength(3);
      expect(session.availableCommands).toEqual([{ name: 'init', description: 'Init', takesInput: false, hint: null }]);
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(session.title).toBe('Early title');
    });

    it.each([
      ['creating', (manager: SessionManager) => manager.connectToAgent('fake')],
      ['resuming', (manager: SessionManager) => manager.resumeSession('fake', 's1')],
      ['loading', (manager: SessionManager) => manager.loadSession('fake', 's1')],
    ])('takes the slash commands a v2 session state carries, on %s the session', async (_, open) => {
      const availableCommands: V2.AvailableCommand[] = [{ type: 'command', name: 'init', description: 'Init' }];
      const script: AgentScript = () => fakeV2Agent()
        .onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's1', availableCommands }))
        .onRequest(V2.methods.agent.session.resume, () => ({ availableCommands }));
      const { manager } = setup({ fake: script });

      const session = await open(manager);

      expect(session.availableCommands).toEqual([{ name: 'init', description: 'Init', takesInput: false, hint: null }]);
    });

    it('treats null config options in an update as none', async () => {
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.prompt, async ({ client }) => {
        const update = { sessionUpdate: 'config_option_update', configOptions: null } as unknown as SessionNotification['update'];
        await client.notify(methods.client.session.update, { sessionId: 's1', update });
        return { stopReason: 'end_turn' };
      }));
      const { manager, received, receivedAtLeast } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const updated = receivedAtLeast(received.length + 1);

      await manager.sendPrompt('s1', 'hello');
      await updated;

      expect(manager.getSession('s1')?.configOptions).toEqual([]);
    });

    it("caches titles in the session's reference and clears them on null", async () => {
      const { manager, reference } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');

      manager.applySessionInfoUpdate('s1', { title: 'Named' });
      expect(manager.getSession('s1')?.title).toBe('Named');
      expect(reference('s1')?.title).toBe('Named');

      manager.applySessionInfoUpdate('s1', { updatedAt: '2026-10-18T10:00:00Z' });
      expect(reference('s1')?.title).toBe('Named');

      manager.applySessionInfoUpdate('s1', { title: null });
      expect(manager.getSession('s1')).not.toHaveProperty('title');
      expect(reference('s1')).not.toHaveProperty('title');
    });

    it('records the mode the agent switches to itself', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({
        sessionId: 's1',
        modes: { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
      }));
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      manager.applyCurrentMode('s1', 'code');

      expect(manager.getSession('s1')?.modes?.current).toBe('code');
    });

    it('moves the session to the top of the session history when a turn ends', async () => {
      vi.useFakeTimers({ now: Date.parse('2026-10-18T10:00:00Z'), toFake: ['Date'] });
      try {
        const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })));
        const { manager, chatView, references } = setup({ fake: fake.script });
        await manager.connectToAgent('fake');
        vi.setSystemTime(Date.parse('2026-10-18T11:00:00Z'));
        await references.used(address('newer'));
        vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z'));

        await chatView.handleMessage({ type: 'sendPrompt', text: 'hello' });

        expect(references.list(WORKSPACE.host, 'fake', '/work').map((r) => r.sessionId)).toEqual(['s1', 'newer']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('selections', () => {
    const effortOption = (currentValue: string): SessionConfigOption => ({
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue,
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
    });
    const fastOption = (currentValue: boolean): SessionConfigOption => ({ id: 'fast', name: 'Fast', type: 'boolean', currentValue });
    const modes = (currentModeId: string) => ({ availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId });
    const caps = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };

    /**
     * An agent whose sessions, `s1` first, start with model `a`, effort `low` and a boolean option off. Setting the model
     * to `b` resets the effort to `medium`. A prompt makes it change the effort and the boolean option itself. A load
     * replays two model changes, then answers with model `b`; a resume answers with model `b`.
     */
    function selectingAgent() {
      let created = 0;
      const defaults = { model: 'a', effort: 'low', fast: false };
      const options = { ...defaults };
      const all = () => [modelOption(options.model), effortOption(options.effort), fastOption(options.fast)];
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => {
          Object.assign(options, defaults);
          return { sessionId: `s${++created}`, configOptions: all() };
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          if (params.configId === 'model') {
            options.model = String(params.value);
            if (options.model === 'b') { options.effort = 'medium'; }
          }
          return { configOptions: all() };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions: [modelOption(options.model), effortOption('medium'), fastOption(true)] },
          });
          return { stopReason: 'end_turn' };
        })
        .onRequest(methods.agent.session.load, async ({ params, client }) => {
          const notify = (update: SessionNotification['update']) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
          await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('a')] });
          await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] });
          return { configOptions: [modelOption('b')] };
        })
        .onRequest(methods.agent.session.resume, () => ({ configOptions: [modelOption('b')] }));
      return script;
    }

    /**
     * An agent using the separate modes API and no config options, whose session `s1` starts in mode `ask`. A prompt
     * makes it switch to `ask` itself; a load replays a switch to `code`, then answers in mode `code`.
     */
    function modesAgent() {
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => ({ sessionId: 's1', modes: modes('ask') }))
        .onRequest(methods.agent.session.setMode, () => ({}))
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' },
          });
          return { stopReason: 'end_turn' };
        })
        .onRequest(methods.agent.session.load, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
          });
          return { modes: modes('code') };
        });
      return script;
    }

    it('saves every option as the agent answers the user, with the changes it brings about', async () => {
      const { manager, reference } = setup({ fake: selectingAgent() });
      await manager.connectToAgent('fake');

      await manager.setConfigOption('s1', 'model', 'b');

      expect(reference('s1')?.selections).toEqual({ options: { model: 'b', effort: 'medium', fast: false } });
    });

    it('saves what the agent answers, not the value asked for', async () => {
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [modelOption('a')] })));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.setConfigOption('s1', 'model', 'b');

      expect(reference('s1')?.selections).toEqual({ options: { model: 'a' } });
    });

    it('saves nothing for a change still pending, nor for one the agent rejects', async () => {
      let received: () => void = () => {};
      const requested = new Promise<void>((resolve) => { received = resolve; });
      let answer: () => void = () => {};
      const answered = new Promise<void>((resolve) => { answer = resolve; });
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, async () => {
        received();
        await answered;
        throw RequestError.invalidParams(undefined, 'unknown value');
      }));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const setting = manager.setConfigOption('s1', 'model', 'b');
      await requested;
      expect(reference('s1')?.selections).toEqual({ options: {} });
      answer();

      await expect(setting).rejects.toThrow('unknown value');
      expect(reference('s1')?.selections).toEqual({ options: {} });
    });

    it('saves every option when the agent changes them itself', async () => {
      const { manager, reference, received, receivedAtLeast } = setup({ fake: selectingAgent() });
      await manager.connectToAgent('fake');
      const reported = receivedAtLeast(received.length + 1);

      await manager.sendPrompt('s1', 'hello');
      await reported;

      expect(reference('s1')?.selections).toEqual({ options: { model: 'a', effort: 'medium', fast: true } });
    });

    it('saves the mode of an agent using the modes API as the user sets it, then as the agent switches it', async () => {
      const { manager, reference, received, receivedAtLeast } = setup({ fake: modesAgent() });
      await manager.connectToAgent('fake');

      await manager.setMode('s1', 'code');
      expect(reference('s1')?.selections).toEqual({ modeId: 'code', options: {} });

      const reported = receivedAtLeast(received.length + 1);
      await manager.sendPrompt('s1', 'hello');
      await reported;
      expect(reference('s1')?.selections).toEqual({ modeId: 'ask', options: {} });
    });

    it('saves nothing from the state a session is created with, nor from updates while it is created', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
        const update = (configOptions: SessionConfigOption[]) => client.notify(methods.client.session.update, {
          sessionId: 's1', update: { sessionUpdate: 'config_option_update', configOptions },
        });
        await update([modelOption('a')]);
        await update([modelOption('b')]);
        return { sessionId: 's1', configOptions: [modelOption('b')], modes: modes('ask') };
      });
      const { manager, reference, receivedAtLeast } = setup({ fake: script });
      const updated = receivedAtLeast(2);

      await manager.connectToAgent('fake');
      await updated;

      expect(reference('s1')?.selections).toEqual({ options: {} });
    });

    it('starts a new session with the selections its agent supplies, not those saved for another', async () => {
      const { manager, reference } = setup({ fake: selectingAgent() });
      await manager.connectToAgent('fake');
      await manager.setConfigOption('s1', 'model', 'b');

      const created = await manager.newSession();

      expect(created?.sessionId).toBe('s2');
      expect(reference('s2')?.selections).toEqual({ options: {} });
      expect(created?.configOptions?.find((option) => option.id === 'model')?.current).toBe('a');
    });

    it('saves no mode for a session with config options, as they replace its modes', async () => {
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: 's1', configOptions: [modelOption('a')], modes: modes('ask') }));
      const { manager, reference } = setup({ fake: script });
      await manager.connectToAgent('fake');

      manager.applyCurrentMode('s1', 'code');

      expect(reference('s1')?.selections).toEqual({ options: { model: 'a' } });
    });

    it('keeps what was saved for a session when it is loaded or resumed, saving nothing it opens with or replays', async () => {
      const { manager, reference, references } = setup({ fake: selectingAgent() });
      const saved = { options: { model: 'a', effort: 'low' } };
      for (const sessionId of ['loaded', 'resumed']) {
        await references.saveSelections(address(sessionId), saved);
      }

      await manager.loadSession('fake', 'loaded');
      await manager.resumeSession('fake', 'resumed');

      expect(reference('loaded')?.selections).toEqual(saved);
      expect(reference('resumed')?.selections).toEqual(saved);
    });

    it('keeps the mode saved for a session of an agent using the modes API when it is loaded', async () => {
      const { manager, reference, references } = setup({ fake: modesAgent() });
      await references.saveSelections(address('loaded'), { modeId: 'ask', options: {} });

      await manager.loadSession('fake', 'loaded');

      expect(reference('loaded')?.selections).toEqual({ modeId: 'ask', options: {} });
    });

    it('saves the changes the agent makes once a loaded session has opened', async () => {
      const { manager, reference } = setup({ fake: selectingAgent() });
      await manager.loadSession('fake', 'loaded');

      manager.applyConfigOptions('loaded', [modelConfig('a')]);

      expect(reference('loaded')?.selections).toEqual({ options: { model: 'a' } });
    });

    describe('reapplied after a load or resume', () => {
      const select = (id: string, category: 'mode' | 'model' | 'thought_level', currentValue: string, values: string[]): SessionConfigOption => ({
        id, name: id, category, type: 'select', currentValue, options: values.map((value) => ({ value, name: value })),
      });

      /**
       * An agent whose sessions load with, in this order, effort `low`, a boolean option `fast` off, model `a` and mode
       * `ask`. Setting the model to `b` resets the effort to `medium` and offers effort `high` as well. `answer` makes it
       * reject the first request for an option, or answer it without changing anything; it sets the option when asked
       * again, so requesting an option twice shows instead of repeating forever.
       */
      function reapplyingAgent(answer: (configId: string) => 'reject' | 'ignore' | undefined = () => undefined) {
        const requests: [string, string | boolean][] = [];
        const script: AgentScript = () => {
          const state: Record<string, string | boolean> = { effort: 'low', fast: false, model: 'a', mode: 'ask' };
          const all = (): SessionConfigOption[] => [
            select('effort', 'thought_level', String(state['effort']), state['model'] === 'b' ? ['low', 'medium', 'high'] : ['low', 'medium']),
            { id: 'fast', name: 'Fast', type: 'boolean', currentValue: state['fast'] === true },
            select('model', 'model', String(state['model']), ['a', 'b']),
            select('mode', 'mode', String(state['mode']), ['ask', 'code']),
          ];
          return fakeAgent(caps)
            .onRequest(methods.agent.session.load, () => ({ configOptions: all() }))
            .onRequest(methods.agent.session.resume, () => ({ configOptions: all() }))
            .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
              const again = requests.some(([configId]) => configId === params.configId);
              requests.push([params.configId, params.value]);
              const how = again ? undefined : answer(params.configId);
              if (how === 'reject') { throw RequestError.invalidParams(undefined, 'unknown value'); }
              if (how !== 'ignore') {
                state[params.configId] = params.value;
                if (params.configId === 'model' && params.value === 'b') { state['effort'] = 'medium'; }
              }
              return { configOptions: all() };
            });
        };
        return { script, requests };
      }

      /** The session's options as displayed, by ID. */
      const shown = (manager: SessionManager, sessionId: string) =>
        Object.fromEntries((manager.getSession(sessionId)?.configOptions ?? []).map((option) => [option.id, option.current]));

      /** The ID and reason of each saved value logged as not reapplied. */
      function notReapplied(): unknown[][] {
        const logged: unknown[][] = [];
        setLogSink({
          trace() {}, debug() {}, info() {}, error() {},
          warn: (message, context) => {
            if (message === 'Saved option not reapplied') { logged.push([context?.['configId'] ?? context?.['modeId'], context?.['reason']]); }
          },
        });
        onTestFinished(() => { setLogSink(undefined); });
        return logged;
      }

      it('requests the saved values that differ before the load ends: the mode, then the model, then the rest in the agent\'s order', async () => {
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address('s1'), { options: { effort: 'high', fast: true, model: 'b', mode: 'code' } });
        let requestedByEnd = 0;
        manager.on('session-load-end', () => { requestedByEnd = fake.requests.length; });

        await manager.loadSession('fake', 's1');

        expect(fake.requests).toEqual([['mode', 'code'], ['model', 'b'], ['effort', 'high'], ['fast', true]]);
        expect(requestedByEnd).toBe(4);
        expect(shown(manager, 's1')).toEqual({ effort: 'high', fast: true, model: 'b', mode: 'code' });
      });

      it('compares again after each answer, requesting nothing a change of model already brought about', async () => {
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address('s1'), { options: { effort: 'medium', model: 'b' } });

        await manager.loadSession('fake', 's1');

        expect(fake.requests).toEqual([['model', 'b']]);
        expect(shown(manager, 's1')).toMatchObject({ effort: 'medium', model: 'b' });
      });

      it('skips and logs saved values the agent does not offer, and options it no longer has', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address('s1'), { options: { effort: 'high', fast: 'yes', gone: 'x', model: 'z', mode: 'ask' } });

        await manager.loadSession('fake', 's1');

        expect(fake.requests).toEqual([]);
        expect(logged).toEqual([['effort', 'not offered'], ['fast', 'not offered'], ['gone', 'not offered'], ['model', 'not offered']]);
        expect(shown(manager, 's1')).toEqual({ effort: 'low', fast: false, model: 'a', mode: 'ask' });
      });

      it('skips and logs a value the agent rejects, reapplies the rest, and saves none of what it answers', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent((configId) => (configId === 'model' ? 'reject' : undefined));
        const { manager, references, reference } = setup({ fake: fake.script });
        const saved = { options: { fast: true, model: 'b' } };
        await references.saveSelections(address('s1'), saved);

        await manager.loadSession('fake', 's1');

        expect(fake.requests).toEqual([['model', 'b'], ['fast', true]]);
        expect(logged).toEqual([['model', expect.stringContaining('unknown value')]]);
        expect(shown(manager, 's1')).toEqual({ effort: 'low', fast: true, model: 'a', mode: 'ask' });
        expect(reference('s1')?.selections).toEqual(saved);
      });

      it('requests each option once, showing what the agent answers', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent(() => 'ignore');
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address('s1'), { options: { model: 'b' } });

        await manager.loadSession('fake', 's1');

        expect(fake.requests).toEqual([['model', 'b']]);
        expect(logged).toEqual([['model', 'the agent answered with another value']]);
        expect(shown(manager, 's1')).toMatchObject({ model: 'a' });
      });

      it('reapplies them after a resume too, before the session becomes active, saving none of what the agent answers', async () => {
        const fake = reapplyingAgent((configId) => (configId === 'fast' ? 'reject' : undefined));
        const { manager, references, reference } = setup({ fake: fake.script });
        const saved = { options: { fast: true, model: 'b' } };
        await references.saveSelections(address('s1'), saved);
        let requestedWhenActive = 0;
        manager.on('active-session-changed', () => { requestedWhenActive = fake.requests.length; });

        await manager.resumeSession('fake', 's1');

        expect(fake.requests).toEqual([['model', 'b'], ['fast', true]]);
        expect(requestedWhenActive).toBe(2);
        expect(shown(manager, 's1')).toEqual({ effort: 'medium', fast: false, model: 'b', mode: 'ask' });
        expect(reference('s1')?.selections).toEqual(saved);
      });

      it('reapplies those saved where the session was used, on its host, before the window knows its workspace target', async () => {
        const fake = reapplyingAgent();
        const { manager, references, withPendingWorkspaceTarget } = setup({ fake: fake.script });
        await references.saveSelections(address('s1'), { options: { model: 'b' } });
        withPendingWorkspaceTarget();

        await manager.loadSession('fake', 's1', address('s1'));

        expect(fake.requests).toEqual([['model', 'b']]);
      });

      it("reapplies those saved through another configuration, whose reference moves to the one it loads through", async () => {
        const fake = reapplyingAgent();
        const other = reapplyingAgent();
        const { manager, references, reference, workspace } = setup({ fake: fake.script, other: other.script });
        await references.setTitle(address('s1'), 'Kept title');
        await references.saveSelections(address('s1'), { options: { model: 'b' } });
        const before = reference('s1');

        await manager.loadSession('other', 's1', address('s1'));

        expect([fake.requests, other.requests]).toEqual([[], [['model', 'b']]]);
        expect(manager.getSession('s1')?.title).toBe('Kept title');
        expect(reference('s1')).toBeUndefined();
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: 's1' }))
          .toEqual({ ...before, configuredName: 'other', lastActiveAt: expect.any(String) as unknown });
        expect(workspace.lastActiveSession()).toEqual({ ...address('s1'), configuredName: 'other' });
      });

      it('leaves the reference where it was when the load through another configuration fails', async () => {
        const refusing: AgentScript = () => fakeAgent(caps).onRequest(methods.agent.session.load, () => {
          throw new RequestError(-32000, 'Session is in use by another client');
        });
        const { manager, references, reference, workspace } = setup({ fake: reapplyingAgent().script, other: refusing });
        await references.setTitle(address('s1'), 'Kept title');
        await workspace.setLastActiveSession(address('s1'));
        const before = reference('s1');

        await expect(manager.loadSession('other', 's1', address('s1'))).rejects.toThrow('in use by another client');

        expect(reference('s1')).toEqual(before);
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: 's1' })).toBeUndefined();
        expect(workspace.lastActiveSession()).toEqual(address('s1'));
      });

      it("moves the reference of a session resumed through another configuration, on this window's host when none is given", async () => {
        const fake = reapplyingAgent();
        const other = reapplyingAgent();
        const { manager, references, reference } = setup({ fake: fake.script, other: other.script });
        await references.setTitle(address('s1'), 'Kept title');
        await references.saveSelections(address('s1'), { options: { model: 'b' } });

        await manager.resumeSession('other', 's1', { configuredName: 'fake' });

        expect([fake.requests, other.requests]).toEqual([[], [['model', 'b']]]);
        expect(manager.getSession('s1')?.title).toBe('Kept title');
        expect(reference('s1')).toBeUndefined();
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: 's1' })).toMatchObject({ title: 'Kept title' });
      });

      it('reapplies the mode saved for an agent using the modes API when it offers it', async () => {
        const logged = notReapplied();
        const requested: string[] = [];
        const script: AgentScript = () => fakeAgent(caps)
          .onRequest(methods.agent.session.load, () => ({ modes: modes('code') }))
          .onRequest(methods.agent.session.setMode, ({ params }) => { requested.push(params.modeId); return {}; });
        const { manager, references } = setup({ fake: script });
        await references.saveSelections(address('offered'), { modeId: 'ask', options: {} });
        await references.saveSelections(address('withdrawn'), { modeId: 'plan', options: {} });

        await manager.loadSession('fake', 'offered');
        expect(manager.getSession('offered')?.modes?.current).toBe('ask');
        await manager.loadSession('fake', 'withdrawn');

        expect(requested).toEqual(['ask']);
        expect(logged).toEqual([['plan', 'not offered']]);
        expect(manager.getSession('withdrawn')?.modes?.current).toBe('code');
      });
    });
  });

  describe('renamed configurations', () => {
    const fakeConfig = { command: 'fake' };

    it("rebinds this host's references and this workspace's last active session to the new name", async () => {
      const { manager, references, workspace, reference } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      await manager.recordsSettled();

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      await references.settled();
      await workspace.settled();

      expect(reference('s1')).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: 's1' })).toBeDefined();
      expect(workspace.lastActiveSession()?.configuredName).toBe('renamed');
    });

    it('records a session still running under the old name under the new one', async () => {
      const { manager, references, reference } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.applySessionInfoUpdate('s1', { title: 'After the rename' });
      await manager.recordsSettled();
      await references.settled();

      expect(reference('s1')).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: 's1' })?.title).toBe('After the rename');
    });

    it('records a session still running under its first name under the last, after two renames', async () => {
      const { manager, references } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
      manager.applySessionInfoUpdate('s1', { title: 'After both' });
      await manager.recordsSettled();
      await references.settled();

      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: 's1' })?.title).toBe('After both');
    });

    it('records under the old name again once a configuration has it again', async () => {
      const { manager, references, reference } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });

      manager.agentsChanged({ renamed: fakeConfig }, { renamed: fakeConfig, fake: { command: 'other' } });
      manager.applySessionInfoUpdate('s1', { title: 'Under the old name' });
      await manager.recordsSettled();
      await references.settled();

      expect(reference('s1')?.title).toBe('Under the old name');
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
      const fake = listingAgent({ '': { ids: ['a', 'b'], nextCursor: 'page2' } });
      const { manager } = setup({ fake: fake.script });

      const result = await manager.listSessions('fake', { cwd: '/work' });

      expect(fake.requests).toEqual([{ cwd: '/work' }]);
      expect(result.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
      expect(result.nextCursor).toBe('page2');
      expect(manager.getCachedCapabilities('fake')).toEqual({ list: true, load: true, resume: true, additionalDirectories: false });
    });

    it('leaves the cursor out on the last page', async () => {
      const fake = listingAgent({ page2: { ids: ['c'] } });
      const { manager } = setup({ fake: fake.script });

      const result = await manager.listSessions('fake', { cursor: 'page2' });

      expect(fake.requests).toEqual([{ cursor: 'page2' }]);
      expect(result).not.toHaveProperty('nextCursor');
    });

    it("refreshes the titles of listed sessions' references, without referencing the others", async () => {
      const fake = listingAgent({ '': { ids: ['a', 'b'] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address('a'));

      await manager.listSessions('fake');

      expect(reference('a')?.title).toBe('Title a');
      expect(reference('b')).toBeUndefined();
    });

    it('removes the references of sessions the agent no longer lists, once it lists all of the cwd', async () => {
      const fake = listingAgent({ '': { ids: ['a'] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address('a'));
      await references.used(address('gone'));

      await manager.listSessions('fake', { cwd: '/work' });

      expect(reference('a')).toBeDefined();
      expect(reference('gone')).toBeUndefined();
    });

    it('keeps references while the agent has more pages to list', async () => {
      const fake = listingAgent({ '': { ids: ['a'], nextCursor: 'page2' }, page2: { ids: ['b'] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address('later'));

      await manager.listSessions('fake', { cwd: '/work' });
      await manager.listSessions('fake', { cwd: '/work', cursor: 'page2' });

      expect(reference('later')).toBeDefined();
    });

    it('keeps references when the agent lists sessions of every cwd', async () => {
      const fake = listingAgent({ '': { ids: [] } });
      const { manager, references, reference } = setup({ fake: fake.script });
      await references.used(address('elsewhere'));

      await manager.listSessions('fake');

      expect(reference('elsewhere')).toBeDefined();
    });

    it('refreshes the titles of listed sessions once a pending workspace target is known', async () => {
      const fake = listingAgent({ '': { ids: ['a'] } });
      const { manager, references, reference, withPendingWorkspaceTarget } = setup({ fake: fake.script });
      await references.used(address('a'));
      const learn = withPendingWorkspaceTarget();

      await manager.listSessions('fake');
      expect(reference('a')?.title).toBeUndefined();

      learn();
      await manager.recordsSettled();
      expect(reference('a')?.title).toBe('Title a');
    });

    it('keeps the reference of a session open in this window that the agent does not list', async () => {
      const fake = listingAgent({ '': { ids: [] } });
      const { manager, reference } = setup({ fake: fake.script });
      await manager.loadSession('fake', 'open');

      await manager.listSessions('fake', { cwd: '/work' });

      expect(reference('open')).toBeDefined();
    });

    it('refuses to list when the agent does not support it', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      await expect(manager.listSessions('fake')).rejects.toThrow('does not support session/list');
    });
  });

  describe('loading and resuming', () => {
    const caps = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };

    function replayingAgent(onLoad: (sessionId: string) => void = () => {}) {
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'fresh' }))
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

    it('loads a session, active while the agent replays it', async () => {
      let activeDuringLoad: string | null = null;
      const { manager, received, takeEvents } = setup({ fake: replayingAgent(() => { activeDuringLoad = manager.getActiveSessionId(); }) });

      const session = await manager.loadSession('fake', 'old');

      expect(activeDuringLoad).toBe('old');
      expect(received.map(([sessionId]) => sessionId)).toEqual(['old']);
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(takeEvents()).toEqual([
        ['session-added', 'old', 'fake'],
        ['active-session-changed', 'old'],
        ['session-load-start', 'old', 'fake'],
        ['session-load-end', 'old', 'fake', true],
      ]);
    });

    it('tells how each session was opened once it has been, and nothing of one that failed to open', async () => {
      const { manager } = setup({ fake: replayingAgent() });
      const opened: unknown[] = [];
      manager.on('session-opened', (...args) => opened.push(args));

      await manager.connectToAgent('fake');
      await manager.loadSession('fake', 'loaded');
      await manager.resumeSession('fake', 'resumed');
      await expect(manager.loadSession('fake', 'gone')).rejects.toThrow('Resource not found');
      await expect(manager.resumeSession('fake', 'gone')).rejects.toThrow('Resource not found');

      expect(opened).toEqual([['fresh', 'fake', 'created'], ['loaded', 'fake', 'loaded'], ['resumed', 'fake', 'resumed']]);
    });

    it('records a loaded or resumed session as used and as the last active session in the workspace', async () => {
      const { manager, reference, workspace } = setup({ fake: replayingAgent() });

      await manager.loadSession('fake', 'loaded');
      expect(reference('loaded')).toMatchObject(address('loaded'));
      expect(workspace.lastActiveSession()).toEqual(address('loaded'));

      await manager.resumeSession('fake', 'resumed');
      expect(reference('resumed')).toMatchObject(address('resumed'));
      expect(workspace.lastActiveSession()).toEqual(address('resumed'));
    });

    it('drops a session the agent no longer has from the chat view, keeping its reference', async () => {
      const { manager, references, reference, workspace, takeEvents } = setup({ fake: replayingAgent() });
      await references.used(address('gone'));

      await expect(manager.loadSession('fake', 'gone')).rejects.toThrow(UnknownSession);

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.getSession('gone')).toBeUndefined();
      expect(reference('gone')).toBeDefined();
      expect(workspace.lastActiveSession()).toBeUndefined();
      expect(takeEvents()).toEqual([
        ['session-added', 'gone', 'fake'],
        ['active-session-changed', 'gone'],
        ['session-load-start', 'gone', 'fake'],
        ['session-removed', 'gone', 'fake'],
        ['session-load-end', 'gone', 'fake', false],
        ['active-session-changed', null],
      ]);
    });

    it("replaces the same agent's active session when loading another", async () => {
      const { agents, manager, takeEvents } = setup({ fake: replayingAgent() });
      await manager.connectToAgent('fake');
      takeEvents();

      await manager.loadSession('fake', 'old');

      expect(agents.launched).toHaveLength(1);
      expect(manager.getSession('fresh')).toBeUndefined();
      expect(manager.getActiveSessionId()).toBe('old');
      expect(takeEvents()[0]).toEqual(['session-removed', 'fresh', 'fake']);
    });

    it("disconnects another agent's session before loading", async () => {
      const { agents, manager } = setup({ fake: replayingAgent(), other: sessionAgent('o1').script });
      await manager.connectToAgent('other');

      await manager.loadSession('fake', 'old');

      expect(agents.running('other')).toEqual([]);
      expect(manager.getAgentNamesWithSessions()).toEqual(['fake']);
    });

    it('refuses to load when the agent does not support it', async () => {
      const { manager } = setup({ fake: sessionAgent().script });

      await expect(manager.loadSession('fake', 'old')).rejects.toThrow('does not support session/load');
    });

    it('resumes a session without replay and makes it active', async () => {
      const { manager, received, takeEvents } = setup({ fake: replayingAgent() });

      const session = await manager.resumeSession('fake', 'old');

      expect(received).toEqual([]);
      expect(session.configOptions).toEqual([modelConfig('a')]);
      expect(manager.getActiveSessionId()).toBe('old');
      expect(takeEvents()).toEqual([['session-added', 'old', 'fake'], ['active-session-changed', 'old']]);
    });

    it('keeps the reference of a session the agent cannot resume', async () => {
      const { manager, references, reference } = setup({ fake: replayingAgent() });
      await references.used(address('gone'));

      await expect(manager.resumeSession('fake', 'gone')).rejects.toThrow(UnknownSession);

      expect(reference('gone')).toBeDefined();
    });

    it('removes a session from the session history on request', async () => {
      const { manager, references, reference } = setup({ fake: replayingAgent() });
      await references.used(address('a'));
      await references.used(address('b'));

      await manager.removeFromHistory('fake', 'a');

      expect(reference('a')).toBeUndefined();
      expect(reference('b')).toBeDefined();
    });

    it('removes a session from the session history once a pending workspace target is known', async () => {
      const { manager, references, reference, withPendingWorkspaceTarget } = setup({ fake: replayingAgent() });
      await references.used(address('a'));
      const learn = withPendingWorkspaceTarget();

      const removing = manager.removeFromHistory('fake', 'a');
      expect(reference('a')).toBeDefined();

      learn();
      await removing;
      expect(reference('a')).toBeUndefined();
    });
  });

  describe('titles of reopened sessions', () => {
    /** An agent that lists `old` with the titles given in turn, and loads it, replaying `replayedTitle` if set. */
    function listingAgent(listedTitles: (string | undefined)[], replayedTitle?: string) {
      let page = 0;
      return () => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } })
        .onRequest(methods.agent.session.list, () => {
          const title = listedTitles[page++];
          return { sessions: [{ sessionId: 'old', cwd: '/work', ...(title !== undefined ? { title } : {}) }] };
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

      const session = await manager.loadSession('fake', 'old');

      expect(session.title).toBe('Listed title');
    });

    it('lets a title the agent replays during the load replace the listed one', async () => {
      const { manager, received, receivedAtLeast } = setup({ fake: listingAgent(['Listed title'], 'Replayed title') });
      await manager.listSessions('fake');
      const replayed = receivedAtLeast(received.length + 1);

      const session = await manager.loadSession('fake', 'old');
      await replayed;

      expect(session.title).toBe('Replayed title');
    });

    it('forgets a listed title once the agent lists the session without one', async () => {
      const { manager } = setup({ fake: listingAgent(['Listed title', undefined]) });
      await manager.listSessions('fake');
      await manager.listSessions('fake');

      const session = await manager.loadSession('fake', 'old');

      expect(session).not.toHaveProperty('title');
    });

    it('titles a resumed session from the session history when the agent does not list sessions', async () => {
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { sessionCapabilities: { resume: {} } } })
        .onRequest(methods.agent.session.resume, () => ({}));
      const { manager, references } = setup({ fake: script });
      await references.setTitle(address('old'), 'Remembered title');

      const session = await manager.resumeSession('fake', 'old');

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
      await references.setTitle(address('old'), 'Remembered title');

      const session = await manager.resumeSession('fake', 'old');

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
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      takeEvents();

      await agents.launched[0]?.crash(1);

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.hasSession('fake')).toBe(false);
      expect(takeEvents()).toEqual([
        ['session-ended', 's1', 'Fake Agent exited unexpectedly (code 1).'],
        ['session-removed', 's1', 'fake'],
        ['active-session-changed', null],
        ['agent-closed', 'agent_1', 1],
      ]);
    });

    it('names no exit code when a signal killed the agent', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      takeEvents();

      await agents.launched[0]?.crash(null);

      expect(takeEvents()).toContainEqual(['session-ended', 's1', 'Fake Agent exited unexpectedly.']);
    });

    it('announces no end for a session whose agent it stopped itself', async () => {
      const stops: [string, (manager: SessionManager) => Promise<unknown>][] = [
        ['disconnect', (manager) => manager.disconnectAgent('fake')],
        ['new session', (manager) => manager.newSession()],
        // The session outlives the stop until the exit drops it.
        ['authentication cancelled while listing', (manager) => manager.listSessions('fake').catch(() => {})],
      ];
      for (const [name, stop] of stops) {
        const init = { agentCapabilities: { sessionCapabilities: { list: {} } }, authMethods: [{ id: 'login', name: 'Log in' }] };
        const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.list, () => {
          throw RequestError.authRequired();
        }), init);
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

    it('fails a prompt in flight only once the exit has ended its session, whichever the agent reports first', async () => {
      for (const order of ['output-then-exit', 'exit-then-output'] as ExitOrder[]) {
        let promptStarted: () => void = () => {};
        const started = new Promise<void>((resolve) => { promptStarted = resolve; });
        const script: AgentScript = () => fakeAgent()
          .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' }))
          .onRequest(methods.agent.session.prompt, () => {
            promptStarted();
            return new Promise(() => {});
          });
        const { agents, manager, events } = setup({ fake: script });
        await manager.connectToAgent('fake');
        const prompt = manager.sendPrompt('s1', 'hello');
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
      await manager.loadSession('fake', 'old');

      await agents.launched[0]?.crash(1);

      expect(manager.getSession('old')).toBeUndefined();
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
      let next = 0;
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: `s${++next}` }))
        .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }));
      const { agents, manager } = setup({ fake: script });
      await manager.connectToAgent('fake');
      const replaced = agents.launched[0];

      await manager.newSession();
      expect(replaced?.killed).toBe(true);
      await replaced?.exitReported;

      expect(manager.getActiveSessionId()).toBe('s2');
      expect(manager.hasSession('fake')).toBe(true);
      await expect(manager.sendPrompt('s2', 'still there?')).resolves.toBeUndefined();
    });

    describe('when the command cannot start, as real processes', () => {
      function realAgent(config: AgentConfigEntry): SessionManager {
        const manager = new SessionManager(
          new AgentManager(),
          new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', () => unusedHandlers),
          { workspaceRoots: () => ({ cwd: process.cwd(), additionalDirectories: [] }), workspaceTarget: () => undefined, workspaceTargetKnown: () => Promise.resolve(undefined), agentConfigs: () => ({ broken: config }), activeFileLink: () => undefined },
          { chooseAuthMethod: vi.fn() },
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

        await expect(manager.connectToAgent('broken')).rejects.toThrow('Agent "broken" exited with code 2 before connecting; its output is in the ACP log (ACP: Show Log).');
      });
    });

    it('stops every agent on dispose', async () => {
      const { agents, manager, takeEvents } = setup({ one: sessionAgent('s1').script, two: sessionAgent('s2').script });
      await manager.ensureConnected('one');
      await manager.connectToAgent('two');
      takeEvents();

      const disposed = manager.dispose();

      expect(agents.launched.map((l) => l.killed)).toEqual([true, true]);
      expect(manager.getActiveSessionId()).toBe('s2');
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
      let next = 0;
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: `s${++next}` }));
      const { agents, manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      await manager.newSession();
      takeEvents();

      await manager.dispose();

      expect(agents.launched).toHaveLength(2);
      expect(agents.launched.every((launched) => launched.killed)).toBe(true);
      expect(takeEvents()).not.toContainEqual(['session-ended', 's2', 'Fake Agent exited unexpectedly.']);
      expect(manager.getSession('s2')).toBeUndefined();
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
        return { sessionId: 'late' };
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
        expect(manager.getSession('late')).toBeUndefined();

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
          return { sessions: [{ sessionId: 'a', cwd: '/work', title: 'Listed during shutdown' }] };
        });
      const { agents, manager, references, workspace, reference } = setup({ fake: script });
      await references.used(address('a'));
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

        expect(reference('a')?.title).toBe('Listed during shutdown');
        await references.used(address('after'));
        await workspace.setLastActiveSession(address('after'));
        expect(reference('after')).toBeUndefined();
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
      await references.used(address('kept'));
      const learn = withPendingWorkspaceTarget();
      await manager.connectToAgent('fake');
      const removing = manager.removeFromHistory('fake', 'kept');

      await manager.dispose();
      await manager.recordsSettled();
      await removing;
      learn();
      await references.settled();
      await workspace.settled();

      expect(reference('s1')).toBeUndefined();
      expect(reference('kept')).toBeDefined();
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
        () => manager.loadSession('fake', 'old'),
        () => manager.resumeSession('fake', 'old'),
      ]) {
        await expect(connect()).rejects.toThrow('Session manager is disposed.');
      }
      expect(agents.launched).toEqual([]);
    });
  });
});
