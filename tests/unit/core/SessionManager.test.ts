import { describe, expect, it, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, AuthMethod, ResourceLink, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { ChatViewController } from '@/core/ChatViewController';
import { ConnectionManager } from '@/core/ConnectionManager';
import { SessionHistoryStore, type KeyValueStore } from '@/core/SessionHistoryStore';
import { SessionManager, type AuthPrompt, type SessionEnvironment } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { fakeAgent, InProcessAgents, type AgentScript } from './inProcessAgents';

/** Let pending callbacks, including agent exits, run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const unused = (): never => {
  throw new Error('not used by these tests');
};
const unusedHandlers: ClientHandlers = {
  files: { readTextFile: unused, writeTextFile: unused },
  terminals: { createTerminal: unused, terminalOutput: unused, waitForTerminalExit: unused, killTerminal: unused, releaseTerminal: unused, dispose() {} },
  permissions: { requestPermission: unused },
};

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

const EVENTS = [
  'session-added',
  'session-removed',
  'active-session-changed',
  'clear-chat',
  'mode-changed',
  'session-load-start',
  'session-load-end',
  'agent-closed',
] as const;

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

function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const updates = new SessionUpdateHandler();
  let fileLink: ResourceLink | undefined;
  const environment: SessionEnvironment = {
    workspaceCwd: () => '/work',
    agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
    activeFileLink: () => fileLink,
  };
  const authPrompt = { chooseAuthMethod: vi.fn<AuthPrompt['chooseAuthMethod']>(async () => undefined) };
  const manager = new SessionManager(agents, new ConnectionManager(updates, '0.0.0-test', () => unusedHandlers), environment, authPrompt);
  const sessionHistory = new SessionHistoryStore(memoryStore());
  manager.setHistoryStore(sessionHistory);

  // As in the extension, the chat view applies session updates to the sessions.
  const chatView = new ChatViewController(manager, { post() {}, midTurnPrompt: () => 'queue', executeCommand: async () => {} });
  const received: SessionNotification[] = [];
  updates.addListener((update) => {
    received.push(update);
    chatView.handleSessionUpdate(update);
  });

  const events: unknown[][] = [];
  for (const name of EVENTS) {
    manager.on(name, (...args: unknown[]) => events.push([name, ...args]));
  }

  return {
    agents,
    manager,
    sessionHistory,
    authPrompt,
    received,
    events,
    linkActiveFile(link: ResourceLink) { fileLink = link; },
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
      const { manager, sessionHistory, takeEvents } = setup({ fake: fake.script });

      const session = await manager.connectToAgent('fake');

      expect(fake.requests).toEqual([{ method: 'session/new', params: { cwd: '/work', mcpServers: [] } }]);
      expect(session).toMatchObject({
        sessionId: 's1',
        agentName: 'fake',
        agentDisplayName: 'Fake Agent',
        cwd: '/work',
        modes: null,
        configOptions: [modelOption('a')],
      });
      expect(manager.getActiveSessionId()).toBe('s1');
      expect(manager.hasSession('fake')).toBe(true);
      expect(takeEvents()).toEqual([['session-added', 's1', 'fake'], ['active-session-changed', 's1']]);
      expect(sessionHistory.get('fake', 's1')).toMatchObject({ cwd: '/work' });
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

    it('disconnects an agent launched only to list its sessions', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.ensureConnected('fake');

      await manager.disconnectAgent('fake');
      await settle();

      expect(agents.launched[0]?.killed).toBe(true);
      expect(takeEvents()).toEqual([['agent-closed', 'agent_1', null]]);
    });

    it('disconnects an agent with a session, dropping the session', async () => {
      const { agents, manager, takeEvents } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');
      takeEvents();

      await manager.disconnectAgent('fake');
      await settle();

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

    it('starts a new session on the same agent and clears the chat', async () => {
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
        'session-removed', 'active-session-changed', 'clear-chat', 'session-added', 'active-session-changed',
      ]);
    });
  });

  describe('authentication', () => {
    const methodsOffered: AuthMethod[] = [{ id: 'token', name: 'Token' }, { id: 'browser', name: 'Browser' }];

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
      authPrompt.chooseAuthMethod.mockResolvedValueOnce(methodsOffered[1]);

      const session = await manager.connectToAgent('fake');

      expect(authPrompt.chooseAuthMethod).toHaveBeenCalledExactlyOnceWith('fake', methodsOffered);
      expect(fake.authenticated).toEqual(['browser']);
      expect(session.sessionId).toBe('s1');
    });

    it('stops the agent when the user cancels', async () => {
      const { agents, manager } = setup({ fake: authAgent().script });

      await expect(manager.connectToAgent('fake')).rejects.toThrow('Authentication cancelled by user.');
      expect(agents.launched[0]?.killed).toBe(true);
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
      linkActiveFile({ type: 'resource_link', uri: 'file:///work/a.ts', name: '/work/a.ts' } as ResourceLink);

      const response = await manager.sendPrompt('s1', 'explain this');

      expect(response.stopReason).toBe('end_turn');
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
      const fake = sessionAgent('s1', (app) => app.onNotification(methods.agent.session.cancel, ({ params }) => {
        cancelled.push(params.sessionId);
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.cancelTurn('s1');
      await settle();

      expect(cancelled).toEqual(['s1']);
    });

    it('replaces the config options with the full set the agent returns', async () => {
      const fake = sessionAgent('s1', (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
        configOptions: [modelOption(String(params.value))],
      })));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption('s1', 'model', 'b');

      expect(options).toEqual([modelOption('b')]);
      expect(manager.getSession('s1')?.configOptions).toEqual([modelOption('b')]);
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
      expect(manager.getSession('s1')?.modes?.currentModeId).toBe('code');
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
      const { manager, received } = setup({ fake: script });

      const session = await manager.connectToAgent('fake');
      await settle();

      expect(received).toHaveLength(3);
      expect(session.availableCommands).toEqual([{ name: 'init', description: 'Init' }]);
      expect(session.configOptions).toEqual([modelOption('b')]);
      expect(session.title).toBe('Early title');
    });

    it('records titles in the session history and clears them on null', async () => {
      const { manager, sessionHistory } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');

      manager.applySessionInfoUpdate('s1', { title: 'Named' });
      expect(manager.getSession('s1')?.title).toBe('Named');
      expect(sessionHistory.get('fake', 's1')?.title).toBe('Named');

      manager.applySessionInfoUpdate('s1', { title: null });
      expect(manager.getSession('s1')).not.toHaveProperty('title');
      expect(sessionHistory.get('fake', 's1')).not.toHaveProperty('title');
    });

    it('records only the first prompt in the session history', async () => {
      const { manager, sessionHistory } = setup({ fake: sessionAgent().script });
      await manager.connectToAgent('fake');

      manager.recordFirstPrompt('s1', 'first');
      manager.recordFirstPrompt('s1', 'second');

      expect(sessionHistory.get('fake', 's1')?.firstPrompt).toBe('first');
    });
  });

  describe('listing sessions', () => {
    const listingCaps = { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } };

    function listingAgent(pages: Record<string, { ids: string[]; nextCursor?: string }>) {
      const requests: unknown[] = [];
      const script: AgentScript = () => fakeAgent(listingCaps).onRequest(methods.agent.session.list, ({ params }) => {
        requests.push(params);
        const page = pages[params.cursor ?? ''] ?? { ids: [] };
        return {
          sessions: page.ids.map((sessionId) => ({ sessionId, cwd: '/work', title: `Title ${sessionId}` })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
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

    it('forgets session history entries the agent no longer lists, on the first page only', async () => {
      const fake = listingAgent({ '': { ids: ['a'], nextCursor: 'page2' }, page2: { ids: [] } });
      const { manager, sessionHistory } = setup({ fake: fake.script });
      sessionHistory.upsertNew('fake', '/work', 'a');
      sessionHistory.upsertNew('fake', '/work', 'gone');

      await manager.listSessions('fake', { cursor: 'page2' });
      expect(sessionHistory.get('fake', 'gone')).toBeDefined();

      await manager.listSessions('fake');
      expect(sessionHistory.get('fake', 'a')).toBeDefined();
      expect(sessionHistory.get('fake', 'gone')).toBeUndefined();
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
            throw RequestError.invalidParams(undefined, 'Session not found');
          }
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } },
          });
          return { configOptions: [modelOption('b')] };
        })
        .onRequest(methods.agent.session.resume, ({ params }) => {
          if (params.sessionId === 'gone') {
            throw RequestError.invalidParams(undefined, 'Session not found');
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
      expect(received.map((n) => n.sessionId)).toEqual(['old']);
      expect(session.configOptions).toEqual([modelOption('b')]);
      expect(takeEvents()).toEqual([
        ['session-added', 'old', 'fake'],
        ['active-session-changed', 'old'],
        ['session-load-start', 'old', 'fake'],
        ['session-load-end', 'old', 'fake', true],
      ]);
    });

    it('drops a session the agent no longer has, from the chat view and the session history', async () => {
      const { manager, sessionHistory, takeEvents } = setup({ fake: replayingAgent() });
      sessionHistory.upsertNew('fake', '/work', 'gone');

      await expect(manager.loadSession('fake', 'gone')).rejects.toThrow('Session not found');

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.getSession('gone')).toBeUndefined();
      expect(sessionHistory.get('fake', 'gone')).toBeUndefined();
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
      expect(session.configOptions).toEqual([modelOption('a')]);
      expect(manager.getActiveSessionId()).toBe('old');
      expect(takeEvents()).toEqual([['session-added', 'old', 'fake'], ['active-session-changed', 'old']]);
    });

    it('forgets a session the agent cannot resume', async () => {
      const { manager, sessionHistory } = setup({ fake: replayingAgent() });
      sessionHistory.upsertNew('fake', '/work', 'gone');

      await expect(manager.resumeSession('fake', 'gone')).rejects.toThrow('Session not found');

      expect(sessionHistory.get('fake', 'gone')).toBeUndefined();
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
      const { manager } = setup({ fake: listingAgent(['Listed title'], 'Replayed title') });
      await manager.listSessions('fake');

      const session = await manager.loadSession('fake', 'old');
      await settle();

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
      const { manager, sessionHistory } = setup({ fake: script });
      sessionHistory.upsertNew('fake', '/work', 'old');
      sessionHistory.setTitle('fake', 'old', 'Remembered title');

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
      const { manager, sessionHistory } = setup({ fake: script });
      sessionHistory.upsertNew('fake', '/work', 'old');
      sessionHistory.setTitle('fake', 'old', 'Remembered title');

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

      agents.launched[0]?.crash(1);
      await settle();

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.hasSession('fake')).toBe(false);
      expect(takeEvents()).toEqual([
        ['session-removed', 's1', 'fake'],
        ['active-session-changed', null],
        ['agent-closed', 'agent_1', 1],
      ]);
    });

    it('drops a loaded session when its agent exits', async () => {
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.load, () => ({}));
      const { agents, manager } = setup({ fake: script });
      await manager.loadSession('fake', 'old');

      agents.launched[0]?.crash(1);
      await settle();

      expect(manager.getSession('old')).toBeUndefined();
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('launches a fresh agent after the previous one exited', async () => {
      const { agents, manager } = setup({ fake: sessionAgent().script });
      await manager.ensureConnected('fake');
      agents.launched[0]?.crash(1);
      await settle();

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
      await settle();

      expect(manager.getActiveSessionId()).toBe('s2');
      expect(manager.hasSession('fake')).toBe(true);
      await expect(manager.sendPrompt('s2', 'still there?')).resolves.toEqual({ stopReason: 'end_turn' });
    });

    it('stops every agent on dispose', async () => {
      const { agents, manager } = setup({ one: sessionAgent('s1').script, two: sessionAgent('s2').script });
      await manager.ensureConnected('one');
      await manager.connectToAgent('two');

      manager.dispose();

      expect(agents.launched.map((l) => l.killed)).toEqual([true, true]);
      expect(manager.getActiveSessionId()).toBe('s2');
    });
  });
});
