import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, AuthMethod as AcpAuthMethod, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { UnknownSession, type AuthMethod, type ConfigOption, type FileLink, type SessionUpdate } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
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
import { fakeAgent, fakeV2Agent, InProcessAgents, unusedEditor, unusedHandlers, type AgentScript, type ExitOrder } from './InProcessAgents';

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
  const environment: SessionEnvironment = {
    workspaceCwd: () => '/work',
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
  onTestFinished(async () => { await terminals.dispose(); });
  const chatView = new ChatViewController(
    manager,
    { post() {}, executeCommand: async () => {}, showsToolCallDiffs: () => false },
    unusedEditor,
    terminals,
  );
  onTestFinished(async () => { updates.dispose(); await chatView.dispose(); });
  const received: [string, SessionUpdate][] = [];
  const receivedWaiters: { count: number; resolve: () => void }[] = [];
  updates.addListener((sessionId, update) => {
    received.push([sessionId, update]);
    chatView.handleSessionUpdate(sessionId, update);
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
    chatView,
    references,
    workspace,
    /** The reference to session `sessionId` of agent `fake` on the test workspace's host. */
    reference: (sessionId: string) => references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId }),
    authPrompt,
    received,
    events,
    linkActiveFile(link: FileLink) { fileLink = link; },
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
  describe('connecting', () => {
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

      expect(await manager.ensureConnected('fake')).toEqual({ list: false, load: true, resume: false });
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

    it('keeps no config options when the agent responds with null ones', async () => {
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, () => (
        { configOptions: null } as unknown as { configOptions: SessionConfigOption[] }
      )));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption('s1', 'model', 'b');

      expect(options).toBeNull();
      expect(manager.getSession('s1')?.configOptions).toBeNull();
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
      const availableCommands = [{ name: 'init', description: 'Init' }];
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
      expect(manager.getCachedCapabilities('fake')).toEqual({ list: true, load: true, resume: true });
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
          { workspaceCwd: () => process.cwd(), workspaceTarget: () => undefined, workspaceTargetKnown: () => Promise.resolve(undefined), agentConfigs: () => ({ broken: config }), activeFileLink: () => undefined },
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
