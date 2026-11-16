import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type { AgentContext, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { setLogSink } from '@/core/Log';
import { SessionManager } from '@/core/SessionManager';
import type { SessionLoad } from '@/core/SessionUpdateHandler';
import { Reviews } from '@/core/review/Reviews';
import { fakeAgent, fakeV2Agent, type AgentScript } from '@tests/unit/core/InProcessAgents';
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
} from '@tests/unit/core/SessionManagerTestSupport';

describe('SessionManager', () => {
  describe('session settings', () => {
    it.each(['config', 'mode'] as const)('does not apply a delayed %s setter to a replacement registration with the same ID', async (kind) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const modes = { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' };
      const state = kind === 'config' ? { configOptions: [modelOption('a')] } : { modes };
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, ...state }))
        .onRequest(methods.agent.session.load, () => state)
        .onRequest(methods.agent.session.setConfigOption, async () => {
          enter();
          await released;
          return { configOptions: [modelOption('b')] };
        })
        .onRequest(methods.agent.session.setMode, async () => {
          enter();
          await released;
          return {};
        });
      const { manager, reference, takeEvents, agents } = setup({ fake: script });
      const original = await manager.connectToAgent('fake');
      const setting = kind === 'config'
        ? manager.setConfigOption(FIRST_SESSION, 'model', 'b')
        : manager.setMode(FIRST_SESSION, 'code');
      let replacement;
      try {
        await entered;
        replacement = await manager.loadSession('fake', FIRST_SESSION);
        expect(replacement).not.toBe(original);
        takeEvents();
      } finally {
        release();
        await setting;
      }

      expect(agents.launched).toHaveLength(1);
      expect(manager.getSession(FIRST_SESSION)).toBe(replacement);
      expect(replacement.configOptions).toEqual(kind === 'config' ? [modelConfig('a')] : null);
      expect(replacement.modes?.current).toBe(kind === 'mode' ? 'ask' : undefined);
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
      expect(takeEvents()).toEqual([]);
    });

    it('replaces the config options with the full set the agent returns', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
        configOptions: [modelOption(String(params.value))],
      })));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption(FIRST_SESSION, 'model', 'b');

      expect(options).toEqual([modelConfig('b')]);
      expect(manager.getSession(FIRST_SESSION)?.configOptions).toEqual([modelConfig('b')]);
    });

    it('keeps the config options, with the value asked for, when the agent answers without them', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, () => (
        { configOptions: null } as unknown as { configOptions: SessionConfigOption[] }
      )));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption(FIRST_SESSION, 'model', 'b');

      expect(options).toBeNull();
      expect(manager.getSession(FIRST_SESSION)?.configOptions).toEqual([modelConfig('b')]);
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'b' } });
    });

    it('sets a boolean option, keeping the value asked for when the agent answers without the options', async () => {
      const fast: SessionConfigOption = { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false };
      const set: unknown[] = [];
      const fake: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modelOption('a'), fast] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          set.push(params);
          return { configOptions: null } as unknown as { configOptions: SessionConfigOption[] };
        });
      const { manager, reference } = setup({ fake });
      await manager.connectToAgent('fake');

      await manager.setConfigOption(FIRST_SESSION, 'fast', true);

      expect(set).toEqual([{ sessionId: FIRST_SESSION, configId: 'fast', type: 'boolean', value: true }]);
      expect(manager.getSession(FIRST_SESSION)?.configOptions?.find((option) => option.id === 'fast')?.current).toBe(true);
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a', fast: true } });
    });

    it('sets the model through the model config option', async () => {
      const set: unknown[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        set.push(params);
        return { configOptions: [modelOption(String(params.value))] };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.setModel(FIRST_SESSION, 'b');

      expect(set).toEqual([{ sessionId: FIRST_SESSION, configId: 'model', value: 'b' }]);
    });

    it('cannot set the model when the agent has no model option', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }));
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      await expect(manager.setModel(FIRST_SESSION, 'b')).rejects.toThrow('Fake Agent does not expose a model config option');
    });

    it('sets a mode through session/set_mode when the agent has no mode config option', async () => {
      const setModes: string[] = [];
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({
          sessionId: FIRST_SESSION,
          modes: { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
        }))
        .onRequest(methods.agent.session.setMode, ({ params }) => {
          setModes.push(params.modeId);
          return {};
        });
      const { manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      takeEvents();

      await manager.setMode(FIRST_SESSION, 'code');

      expect(setModes).toEqual(['code']);
      expect(manager.getSession(FIRST_SESSION)?.modes?.current).toBe('code');
      expect(takeEvents()).toEqual([['mode-changed', manager.getSession(FIRST_SESSION), 'code']]);
    });

    it('sets the mode through a mode config option when the agent has one', async () => {
      const set: unknown[] = [];
      const modeOption: SessionConfigOption = {
        id: 'agent-mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask',
        options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code' }],
      };
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modeOption] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          set.push(params);
          return { configOptions: [{ ...modeOption, currentValue: String(params.value) }] };
        });
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      await manager.setMode(FIRST_SESSION, 'code');

      expect(set).toEqual([{ sessionId: FIRST_SESSION, configId: 'agent-mode', value: 'code' }]);
    });
  });

  describe('session updates', () => {
    it('rejects normalized input captured from a retired connection before global fan-out', async () => {
      const { manager, connections, updates, received } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      const registration = await manager.connectToAgent('fake');
      const projected: unknown[] = [];
      updates.addListener((delivery) => projected.push(delivery));
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: null, text: 'accepted' }, 'v1');
      expect(projected).toHaveLength(1);
      expect(received).toEqual([[FIRST_SESSION, { kind: 'agentText', messageId: null, text: 'accepted' }]]);
      await manager.disconnectAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'configOptions', options: [modelConfig('b')] }, 'v1');
      expect(projected).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(registration.configOptions).toEqual([modelConfig('a')]);
    });

    it('qualifies equal-ID V1/V2 review evidence through actual connections and runtime before fan-out', async () => {
      const { manager, updates, receivedAtLeast } = setup({
        fake: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } })
          .onRequest(methods.agent.session.list, async ({ client }) => {
            await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update: {
              sessionUpdate: 'tool_call', toolCallId: 'same', title: 'Edit', status: 'completed',
              content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'A' }],
            } });
            return { sessions: [] };
          }),
        other: () => fakeV2Agent().onRequest(V2.methods.agent.session.list, async ({ client }) => {
          const update: V2.UpdateSessionNotification['update'] = {
            sessionUpdate: 'tool_call_update', toolCallId: 'same', title: 'Edit', status: 'completed',
            content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/w/b.ts', fileType: 'text' }],
              patch: { format: 'git_patch', text: 'diff --git /w/b.ts /w/b.ts\n--- /w/b.ts\n+++ /w/b.ts\n@@ -1 +1 @@\n-b\n+B\n' } }],
          };
          await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update });
          return { sessions: [] };
        }),
      });
      const reviews = new Reviews({ read: async (path) => path === '/w/a.ts' ? 'A' : 'B\n', restore: async () => {}, watch: () => ({ dispose() {} }), snapshot: () => undefined,
        applyEdit: async () => { throw new Error('Unexpected edit'); }, save: async () => { throw new Error('Unexpected save'); },
      }, manager);
      onTestFinished(() => reviews.dispose());
      const taking: Promise<void>[] = [];
      const origins: { configuredName: string; sourceId: string; schema: string }[] = [];
      updates.addListener(({ input, registration }) => {
        expect(registration).toBeUndefined();
        origins.push({ configuredName: input.origin.identity.configuredName, sourceId: input.origin.sourceId, schema: input.schema });
        taking.push(reviews.handleSessionUpdate(input));
      });
      const received = receivedAtLeast(2);
      await manager.listSessions('fake');
      await manager.listSessions('other');
      await received;
      await Promise.all(taking);
      expect(origins.map(({ configuredName, schema }) => [configuredName, schema])).toEqual([['fake', 'v1'], ['other', 'v2']]);
      expect(origins[0]?.sourceId).not.toBe(origins[1]?.sourceId);
      reviews.activeSessionChanged({ sessionId: FIRST_SESSION, agentName: 'fake', agentId: origins[0]?.sourceId ?? '' });
      expect(reviews.shown()?.files().map(({ path }) => path)).toEqual(['/w/a.ts']);
      reviews.activeSessionChanged({ sessionId: FIRST_SESSION, agentName: 'other', agentId: origins[1]?.sourceId ?? '' });
      expect(reviews.shown()?.files().map(({ path }) => path)).toEqual(['/w/b.ts']);
    });

    it('keeps an early mode and explicit title clearing until its source registers', async () => {
      const { manager, receivedAtLeast, references } = setup({ fake: () => fakeAgent()
        .onRequest(methods.agent.session.new, async ({ client }) => {
          await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } });
          await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'session_info_update', title: null } });
          return { sessionId: FIRST_SESSION, modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } };
        }) });
      await references.used(address(FIRST_SESSION));
      await references.setTitle(address(FIRST_SESSION), 'Remembered title');
      const received = receivedAtLeast(2);
      const session = await manager.connectToAgent('fake');
      await received;
      expect(session.modes?.current).toBe('code');
      expect(session.title).toBeUndefined();
    });

    it('does not publish obsolete load completion into a replacement registration', async () => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let loads = 0;
      const { manager, posted, chatView } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.load, async () => {
          if (++loads === 1) { enter(); await gate; }
          return {};
        }) });
      manager.on('session-load-start', (load) => chatView.notifyLoadSessionStart(load));
      manager.on('session-load-end', (load, ok) => chatView.notifyLoadSessionEnd(load, ok));
      const opening = manager.loadSession('fake', FIRST_SESSION).catch(() => undefined);
      try {
        await entered;
        await manager.loadSession('fake', FIRST_SESSION);
        posted.splice(0);
      } finally { release(); }
      await opening;
      expect(posted).toEqual([]);
    });

    it.each(['before', 'after'] as const)('keeps early metadata and activity source-local when the other source registers %s delivery', async (order) => {
      let earlyClient!: V2.AgentContext;
      const option = (currentValue: string): V2.SessionConfigOption => ({
        configId: 'model', name: 'Model', category: 'model', type: 'select', currentValue,
        options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
      });
      const { manager, receivedAtLeast } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeV2Agent()
          .onRequest(V2.methods.agent.session.list, ({ client }) => { earlyClient = client; return { sessions: [] }; })
          .onRequest(V2.methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [option('a')] })),
      });
      await manager.listSessions('other');
      const selected = order === 'before' ? await manager.connectToAgent('fake') : undefined;
      const received = receivedAtLeast(4);
      for (const update of [
        { sessionUpdate: 'config_option_update', configOptions: [option('b')] },
        { sessionUpdate: 'available_commands_update', availableCommands: [{ type: 'command', name: 'other', description: 'Other' }] },
        { sessionUpdate: 'session_info_update', title: 'Other title' },
        { sessionUpdate: 'state_update', state: 'running' },
      ] satisfies V2.UpdateSessionNotification['update'][]) {
        await earlyClient.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update });
      }
      await received;
      const first = selected ?? await manager.connectToAgent('fake');
      expect(first.configOptions).toEqual([modelConfig('a')]);
      expect(first.availableCommands).toEqual([]);
      expect(first.title).toBeUndefined();
      expect(manager.hasForegroundWork(FIRST_SESSION)).toBe(false);

      await manager.disconnectAgent('fake');
      const other = await manager.connectToAgent('other');
      expect(other.configOptions).toEqual([modelConfig('b')]);
      expect(other.availableCommands).toEqual([{ name: 'other', description: 'Other', takesInput: false, hint: null }]);
      expect(other.title).toBe('Other title');
      expect(manager.hasForegroundWork(FIRST_SESSION)).toBe(true);
    });

    it('does not apply another accepting source metadata to the selected session with the same ID', async () => {
      let client!: AgentContext;
      const { manager, receivedAtLeast } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } }).onRequest(methods.agent.session.list, ({ client: connected }) => {
          client = connected;
          return { sessions: [] };
        }),
      });
      const session = await manager.connectToAgent('fake');
      await manager.ensureConnected('other');
      await manager.listSessions('other');
      const received = receivedAtLeast(1);
      await client.notify(methods.client.session.update, {
        sessionId: FIRST_SESSION, update: { sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] },
      });
      await received;
      expect(session.configOptions).toEqual([modelConfig('a')]);
    });

    it('applies metadata once before dispatch even when no controller receives the update', async () => {
      let client!: AgentContext;
      const { manager, receivedAtLeast, updates } = setup({
        fake: () => fakeAgent().onRequest(methods.agent.session.new, ({ client: connected }) => {
          client = connected;
          return { sessionId: FIRST_SESSION };
        }),
      });
      const session = await manager.connectToAgent('fake');
      const seen: unknown[] = [];
      const applying = vi.spyOn(manager, 'applyConfigOptions');
      updates.addListener(({ registration }) => {
        expect(registration).toBe(session);
        seen.push(session.configOptions);
      });
      const received = receivedAtLeast(1);
      await client.notify(methods.client.session.update, {
        sessionId: FIRST_SESSION, update: { sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] },
      });
      await received;
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(seen).toEqual([[modelConfig('b')]]);
      expect(applying).not.toHaveBeenCalled();
    });

    it('reports an unregistered source title with its captured owner rather than the current raw-ID occupant', async () => {
      let client!: AgentContext;
      const { manager, receivedAtLeast, agents } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } })
          .onRequest(methods.agent.session.list, ({ client: connected }) => { client = connected; return { sessions: [] }; }),
      });
      const selected = await manager.connectToAgent('fake');
      await manager.listSessions('other');
      const reports: unknown[][] = [];
      manager.on('session-info-changed', (...args) => reports.push(args));
      const received = receivedAtLeast(1);
      await client.notify(methods.client.session.update, {
        sessionId: FIRST_SESSION, update: { sessionUpdate: 'session_info_update', title: 'Other title' },
      });
      await received;
      expect(selected.title).toBeUndefined();
      expect(reports).toEqual([[{
        identity: { configuredName: 'other', sessionId: FIRST_SESSION },
        sourceId: agents.running('other')[0]?.process.id,
      }, { kind: 'sessionInfo', title: 'Other title' }]]);
      expect(reports[0]?.[0]).not.toHaveProperty('sourceId', selected.agentId);
    });

    it('keeps slash commands, config options and a title that arrive while the session is being created', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
        const notify = (update: SessionNotification['update']) =>
          client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update });
        await notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'Init' }] });
        await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] });
        await notify({ sessionUpdate: 'session_info_update', title: 'Early title' });
        return { sessionId: FIRST_SESSION, configOptions: [modelOption('a')] };
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
      ['resuming', (manager: SessionManager) => manager.resumeSession('fake', FIRST_SESSION)],
      ['loading', (manager: SessionManager) => manager.loadSession('fake', FIRST_SESSION)],
    ])('takes the slash commands a v2 session state carries, on %s the session', async (_, open) => {
      const availableCommands: V2.AvailableCommand[] = [{ type: 'command', name: 'init', description: 'Init' }];
      const script: AgentScript = () => fakeV2Agent()
        .onRequest(V2.methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, availableCommands }))
        .onRequest(V2.methods.agent.session.resume, () => ({ availableCommands }));
      const { manager } = setup({ fake: script });

      const session = await open(manager);

      expect(session.availableCommands).toEqual([{ name: 'init', description: 'Init', takesInput: false, hint: null }]);
    });

    it('treats null config options in an update as none', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async ({ client }) => {
        const update = { sessionUpdate: 'config_option_update', configOptions: null } as unknown as SessionNotification['update'];
        await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update });
        return { stopReason: 'end_turn' };
      }));
      const { manager, received, receivedAtLeast } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const updated = receivedAtLeast(received.length + 1);

      await manager.sendPrompt(FIRST_SESSION, 'hello');
      await updated;

      expect(manager.getSession(FIRST_SESSION)?.configOptions).toEqual([]);
    });

    it("caches titles in the session's reference and clears them on null", async () => {
      const { manager, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');

      manager.applySessionInfoUpdate(FIRST_SESSION, { title: 'Named' });
      expect(manager.getSession(FIRST_SESSION)?.title).toBe('Named');
      expect(reference(FIRST_SESSION)?.title).toBe('Named');

      manager.applySessionInfoUpdate(FIRST_SESSION, { updatedAt: '2026-10-18T10:00:00Z' });
      expect(reference(FIRST_SESSION)?.title).toBe('Named');

      manager.applySessionInfoUpdate(FIRST_SESSION, { title: null });
      expect(manager.getSession(FIRST_SESSION)).not.toHaveProperty('title');
      expect(reference(FIRST_SESSION)).not.toHaveProperty('title');
    });

    it('records the mode the agent switches to itself', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({
        sessionId: FIRST_SESSION,
        modes: { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
      }));
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      manager.applyCurrentMode(FIRST_SESSION, 'code');

      expect(manager.getSession(FIRST_SESSION)?.modes?.current).toBe('code');
    });

    it('moves the session to the top of the session history when a turn ends', async () => {
      vi.useFakeTimers({ now: Date.parse('2026-10-18T10:00:00Z'), toFake: ['Date'] });
      try {
        const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })));
        const { manager, chatView, references } = setup({ fake: fake.script });
        await manager.connectToAgent('fake');
        vi.setSystemTime(Date.parse('2026-10-18T11:00:00Z'));
        await references.used(address(OLDER_SESSION));
        vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z'));

        await chatView.handleMessage({ type: 'sendPrompt', text: 'hello' });

        expect(references.list(WORKSPACE.host, 'fake', '/work').map((r) => r.sessionId)).toEqual([FIRST_SESSION, OLDER_SESSION]);
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
     * An agent whose sessions start with model `a`, effort `low` and a boolean option off. Setting the model
     * to `b` resets the effort to `medium`. A prompt makes it change the effort and the boolean option itself. A load
     * replays two model changes, then answers with model `b`; a resume answers with model `b`.
     */
    function selectingAgent(sessionIds: readonly string[] = []) {
      let created = 0;
      const defaults = { model: 'a', effort: 'low', fast: false };
      const options = { ...defaults };
      const all = () => [modelOption(options.model), effortOption(options.effort), fastOption(options.fast)];
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => {
          Object.assign(options, defaults);
          return { sessionId: sessionIds[created++] ?? randomUUID(), configOptions: all() };
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
     * An agent using the separate modes API and no config options, whose sessions start in mode `ask`. A prompt
     * makes it switch to `ask` itself; a load replays a switch to `code`, then answers in mode `code`.
     */
    function modesAgent(sessionId?: string) {
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => ({ sessionId: sessionId ?? randomUUID(), modes: modes('ask') }))
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

    it('starts distinct mode sessions across process replacement', async () => {
      const { manager } = setup({ fake: modesAgent() });
      const first = await manager.connectToAgent('fake');
      const second = await manager.newSession();
      expect(second).toBeDefined();
      expect(second?.sessionId).not.toBe(first.sessionId);
      expect(second?.modes?.current).toBe('ask');
    });

    it('saves every option as the agent answers the user, with the changes it brings about', async () => {
      const { manager, reference } = setup({ fake: selectingAgent([FIRST_SESSION]) });
      await manager.connectToAgent('fake');

      await manager.setConfigOption(FIRST_SESSION, 'model', 'b');

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'b', effort: 'medium', fast: false } });
    });

    it('saves what the agent answers, not the value asked for', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [modelOption('a')] })));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.setConfigOption(FIRST_SESSION, 'model', 'b');

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a' } });
    });

    it('saves nothing for a change still pending, nor for one the agent rejects', async () => {
      let received: () => void = () => {};
      const requested = new Promise<void>((resolve) => { received = resolve; });
      let answer: () => void = () => {};
      const answered = new Promise<void>((resolve) => { answer = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, async () => {
        received();
        await answered;
        throw RequestError.invalidParams(undefined, 'unknown value');
      }));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const setting = manager.setConfigOption(FIRST_SESSION, 'model', 'b');
      await requested;
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
      answer();

      await expect(setting).rejects.toThrow('unknown value');
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
    });

    it('saves every option when the agent changes them itself', async () => {
      const { manager, reference, received, receivedAtLeast } = setup({ fake: selectingAgent([FIRST_SESSION]) });
      await manager.connectToAgent('fake');
      const reported = receivedAtLeast(received.length + 1);

      await manager.sendPrompt(FIRST_SESSION, 'hello');
      await reported;

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a', effort: 'medium', fast: true } });
    });

    it('saves the mode of an agent using the modes API as the user sets it, then as the agent switches it', async () => {
      const { manager, reference, received, receivedAtLeast } = setup({ fake: modesAgent(FIRST_SESSION) });
      await manager.connectToAgent('fake');

      await manager.setMode(FIRST_SESSION, 'code');
      expect(reference(FIRST_SESSION)?.selections).toEqual({ modeId: 'code', options: {} });

      const reported = receivedAtLeast(received.length + 1);
      await manager.sendPrompt(FIRST_SESSION, 'hello');
      await reported;
      expect(reference(FIRST_SESSION)?.selections).toEqual({ modeId: 'ask', options: {} });
    });

    it('saves nothing from the state a session is created with, nor from updates while it is created', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
        const update = (configOptions: SessionConfigOption[]) => client.notify(methods.client.session.update, {
          sessionId: FIRST_SESSION, update: { sessionUpdate: 'config_option_update', configOptions },
        });
        await update([modelOption('a')]);
        await update([modelOption('b')]);
        return { sessionId: FIRST_SESSION, configOptions: [modelOption('b')], modes: modes('ask') };
      });
      const { manager, reference, receivedAtLeast } = setup({ fake: script });
      const updated = receivedAtLeast(2);

      await manager.connectToAgent('fake');
      await updated;

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
    });

    it('starts a new session with the selections its agent supplies, not those saved for another', async () => {
      const { manager, reference } = setup({ fake: selectingAgent([FIRST_SESSION, SECOND_SESSION]) });
      await manager.connectToAgent('fake');
      await manager.setConfigOption(FIRST_SESSION, 'model', 'b');

      const created = await manager.newSession();

      expect(created?.sessionId).toBe(SECOND_SESSION);
      expect(reference(SECOND_SESSION)?.selections).toEqual({ options: {} });
      expect(created?.configOptions?.find((option) => option.id === 'model')?.current).toBe('a');
    });

    it('saves no mode for a session with config options, as they replace its modes', async () => {
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modelOption('a')], modes: modes('ask') }));
      const { manager, reference } = setup({ fake: script });
      await manager.connectToAgent('fake');

      manager.applyCurrentMode(FIRST_SESSION, 'code');

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a' } });
    });

    it('keeps what was saved for a session when it is loaded or resumed, saving nothing it opens with or replays', async () => {
      const { manager, reference, references } = setup({ fake: selectingAgent() });
      const saved = { options: { model: 'a', effort: 'low' } };
      for (const sessionId of [LOADED_SESSION, RESUMED_SESSION]) {
        await references.saveSelections(address(sessionId), saved);
      }

      await manager.loadSession('fake', LOADED_SESSION);
      await manager.resumeSession('fake', RESUMED_SESSION);

      expect(reference(LOADED_SESSION)?.selections).toEqual(saved);
      expect(reference(RESUMED_SESSION)?.selections).toEqual(saved);
    });

    it('keeps the mode saved for a session of an agent using the modes API when it is loaded', async () => {
      const { manager, reference, references } = setup({ fake: modesAgent() });
      await references.saveSelections(address(LOADED_SESSION), { modeId: 'ask', options: {} });

      await manager.loadSession('fake', LOADED_SESSION);

      expect(reference(LOADED_SESSION)?.selections).toEqual({ modeId: 'ask', options: {} });
    });

    it('saves the changes the agent makes once a loaded session has opened', async () => {
      const { manager, reference } = setup({ fake: selectingAgent() });
      await manager.loadSession('fake', LOADED_SESSION);

      manager.applyConfigOptions(LOADED_SESSION, [modelConfig('a')]);

      expect(reference(LOADED_SESSION)?.selections).toEqual({ options: { model: 'a' } });
    });

    describe('reapplied after a load or resume', () => {
      it.each(['load', 'resume'] as const)('stops an obsolete %s after a saved-option reply without retargeting the replacement', async (how) => {
        let enter: () => void = () => {};
        let release: () => void = () => {};
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        const requests: string[] = [];
        let openings = 0;
        const initial = [modelOption('a'), fastOption(false)];
        const restored = [modelOption('b'), fastOption(true)];
        const open = () => ({ configOptions: ++openings === 1 ? initial : restored });
        const script: AgentScript = () => fakeAgent(caps)
          .onRequest(methods.agent.session.load, open)
          .onRequest(methods.agent.session.resume, open)
          .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
            requests.push(params.configId);
            if (params.configId === 'model') {
              enter();
              await released;
            }
            return { configOptions: [modelOption('b'), fastOption(false)] };
          });
        const { manager, references, reference, takeEvents } = setup({ fake: script });
        const saved = { options: { model: 'b', fast: true } };
        await references.saveSelections(address(FIRST_SESSION), saved);
        let load: SessionLoad | undefined;
        manager.once('session-load-start', (started) => { load = started; });
        const opening = how === 'load'
          ? manager.loadSession('fake', FIRST_SESSION)
          : manager.resumeSession('fake', FIRST_SESSION);
        const result = opening.then(() => 'opened', () => 'rejected');
        let replacement;
        try {
          await entered;
          replacement = await manager.resumeSession('fake', FIRST_SESSION);
          takeEvents();
        } finally {
          release();
        }

        expect(await result).toBe('rejected');
        expect(requests).toEqual(['model']);
        expect(manager.getActiveSession()).toBe(replacement);
        expect(manager.openSessionOf('fake')).toBe(replacement);
        expect(replacement.configOptions?.map((option) => option.current)).toEqual(['b', true]);
        expect(reference(FIRST_SESSION)?.selections).toEqual(saved);
        expect(takeEvents()).toEqual(how === 'load' ? [['session-load-end', load, false]] : []);
      });

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
        await references.saveSelections(address(FIRST_SESSION), { options: { effort: 'high', fast: true, model: 'b', mode: 'code' } });
        let requestedByEnd = 0;
        manager.on('session-load-end', () => { requestedByEnd = fake.requests.length; });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['mode', 'code'], ['model', 'b'], ['effort', 'high'], ['fast', true]]);
        expect(requestedByEnd).toBe(4);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'high', fast: true, model: 'b', mode: 'code' });
      });

      it('compares again after each answer, requesting nothing a change of model already brought about', async () => {
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { effort: 'medium', model: 'b' } });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b']]);
        expect(shown(manager, FIRST_SESSION)).toMatchObject({ effort: 'medium', model: 'b' });
      });

      it('skips and logs saved values the agent does not offer, and options it no longer has', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { effort: 'high', fast: 'yes', gone: 'x', model: 'z', mode: 'ask' } });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([]);
        expect(logged).toEqual([['effort', 'not offered'], ['fast', 'not offered'], ['gone', 'not offered'], ['model', 'not offered']]);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'low', fast: false, model: 'a', mode: 'ask' });
      });

      it('skips and logs a value the agent rejects, reapplies the rest, and saves none of what it answers', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent((configId) => (configId === 'model' ? 'reject' : undefined));
        const { manager, references, reference } = setup({ fake: fake.script });
        const saved = { options: { fast: true, model: 'b' } };
        await references.saveSelections(address(FIRST_SESSION), saved);

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b'], ['fast', true]]);
        expect(logged).toEqual([['model', expect.stringContaining('unknown value')]]);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'low', fast: true, model: 'a', mode: 'ask' });
        expect(reference(FIRST_SESSION)?.selections).toEqual(saved);
      });

      it('requests each option once, showing what the agent answers', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent(() => 'ignore');
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b']]);
        expect(logged).toEqual([['model', 'the agent answered with another value']]);
        expect(shown(manager, FIRST_SESSION)).toMatchObject({ model: 'a' });
      });

      it('reapplies them after a resume too, before the session becomes active, saving none of what the agent answers', async () => {
        const fake = reapplyingAgent((configId) => (configId === 'fast' ? 'reject' : undefined));
        const { manager, references, reference } = setup({ fake: fake.script });
        const saved = { options: { fast: true, model: 'b' } };
        await references.saveSelections(address(FIRST_SESSION), saved);
        let requestedWhenActive = 0;
        manager.on('active-session-changed', () => { requestedWhenActive = fake.requests.length; });

        await manager.resumeSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b'], ['fast', true]]);
        expect(requestedWhenActive).toBe(2);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'medium', fast: false, model: 'b', mode: 'ask' });
        expect(reference(FIRST_SESSION)?.selections).toEqual(saved);
      });

      it('reapplies those saved where the session was used, on its host, before the window knows its workspace target', async () => {
        const fake = reapplyingAgent();
        const { manager, references, withPendingWorkspaceTarget } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
        withPendingWorkspaceTarget();

        await manager.loadSession('fake', FIRST_SESSION, address(FIRST_SESSION));

        expect(fake.requests).toEqual([['model', 'b']]);
      });

      it("reapplies those saved through another configuration, whose reference moves to the one it loads through", async () => {
        const fake = reapplyingAgent();
        const other = reapplyingAgent();
        const { manager, references, reference, workspace } = setup({ fake: fake.script, other: other.script });
        await references.setTitle(address(FIRST_SESSION), 'Kept title');
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
        const before = reference(FIRST_SESSION);

        await manager.loadSession('other', FIRST_SESSION, address(FIRST_SESSION));

        expect([fake.requests, other.requests]).toEqual([[], [['model', 'b']]]);
        expect(manager.getSession(FIRST_SESSION)?.title).toBe('Kept title');
        expect(reference(FIRST_SESSION)).toBeUndefined();
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION }))
          .toEqual({ ...before, configuredName: 'other', lastActiveAt: expect.any(String) as unknown });
        expect(workspace.lastActiveSession()).toEqual({ ...address(FIRST_SESSION), configuredName: 'other' });
      });

      it('leaves the reference where it was when the load through another configuration fails', async () => {
        const refusing: AgentScript = () => fakeAgent(caps).onRequest(methods.agent.session.load, () => {
          throw new RequestError(-32000, 'Session is in use by another client');
        });
        const { manager, references, reference, workspace } = setup({ fake: reapplyingAgent().script, other: refusing });
        await references.setTitle(address(FIRST_SESSION), 'Kept title');
        await workspace.setLastActiveSession(address(FIRST_SESSION));
        const before = reference(FIRST_SESSION);

        await expect(manager.loadSession('other', FIRST_SESSION, address(FIRST_SESSION))).rejects.toThrow('in use by another client');

        expect(reference(FIRST_SESSION)).toEqual(before);
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION })).toBeUndefined();
        expect(workspace.lastActiveSession()).toEqual(address(FIRST_SESSION));
      });

      it("moves the reference of a session resumed through another configuration, on this window's host when none is given", async () => {
        const fake = reapplyingAgent();
        const other = reapplyingAgent();
        const { manager, references, reference } = setup({ fake: fake.script, other: other.script });
        await references.setTitle(address(FIRST_SESSION), 'Kept title');
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });

        await manager.resumeSession('other', FIRST_SESSION, { configuredName: 'fake' });

        expect([fake.requests, other.requests]).toEqual([[], [['model', 'b']]]);
        expect(manager.getSession(FIRST_SESSION)?.title).toBe('Kept title');
        expect(reference(FIRST_SESSION)).toBeUndefined();
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION })).toMatchObject({ title: 'Kept title' });
      });

      it.each([
        ['load', 'rename'], ['resume', 'rename'],
        ['load', 'remove'], ['resume', 'remove'],
      ] as const)('keeps deferred %s persistence bound to its registration after %s', async (how, change) => {
        const other = reapplyingAgent();
        const { manager, references, reference, workspace, withPendingWorkspaceTarget } = setup({ other: other.script });
        await references.setTitle(address(FIRST_SESSION), 'Original reference');
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
        const before = reference(FIRST_SESSION);
        const learn = withPendingWorkspaceTarget();
        const usedThrough = { configuredName: 'fake' };
        if (how === 'load') { await manager.loadSession('other', FIRST_SESSION, usedThrough); }
        else { await manager.resumeSession('other', FIRST_SESSION, usedThrough); }
        manager.applySessionInfoUpdate(FIRST_SESSION, { title: 'Deferred title' });
        if (change === 'rename') {
          manager.agentsChanged({ other: { command: 'other' } }, { renamed: { command: 'other' } });
        } else {
          await manager.disconnectAgent('other');
        }

        learn();
        await manager.recordsSettled();
        await references.settled();
        await workspace.settled();

        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION })).toBeUndefined();
        if (change === 'rename') {
          expect(reference(FIRST_SESSION)).toBeUndefined();
          expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION }))
            .toMatchObject({ title: 'Deferred title', selections: { options: { model: 'b' } } });
          expect(workspace.lastActiveSession()?.configuredName).toBe('renamed');
        } else {
          expect(reference(FIRST_SESSION)).toEqual(before);
          expect(workspace.lastActiveSession()).toBeUndefined();
        }
      });

      it('reapplies the mode saved for an agent using the modes API when it offers it', async () => {
        const logged = notReapplied();
        const requested: string[] = [];
        const script: AgentScript = () => fakeAgent(caps)
          .onRequest(methods.agent.session.load, () => ({ modes: modes('code') }))
          .onRequest(methods.agent.session.setMode, ({ params }) => { requested.push(params.modeId); return {}; });
        const { manager, references } = setup({ fake: script });
        await references.saveSelections(address(OLD_SESSION), { modeId: 'ask', options: {} });
        await references.saveSelections(address(OLDER_SESSION), { modeId: 'plan', options: {} });

        await manager.loadSession('fake', OLD_SESSION);
        expect(manager.getSession(OLD_SESSION)?.modes?.current).toBe('ask');
        await manager.loadSession('fake', OLDER_SESSION);

        expect(requested).toEqual(['ask']);
        expect(logged).toEqual([['plan', 'not offered']]);
        expect(manager.getSession(OLDER_SESSION)?.modes?.current).toBe('code');
      });
    });
  });

  describe('renamed configurations', () => {
    const fakeConfig = { command: 'fake' };

    it('notifies configuration renames after moving live ownership, but not unrelated changes', async () => {
      const { manager, agents } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const session = await manager.connectToAgent('fake');
      const renames: unknown[][] = [];
      manager.on('configuration-renamed', (from, to) => {
        renames.push([from, to, session.agentName, manager.openSessionOf(to) === session,
          manager.isConnected(to), manager.hasSession(from), manager.isConnected(from)]);
      });

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
      manager.agentsChanged({ again: fakeConfig }, { again: fakeConfig, fake: { command: 'other' } });
      manager.agentsChanged({ again: fakeConfig, fake: { command: 'other' } }, { again: fakeConfig, fake: { command: 'changed' } });

      expect(renames).toEqual([
        ['fake', 'renamed', 'renamed', true, true, false, false],
        ['renamed', 'again', 'again', true, true, false, false],
      ]);
      expect(manager.getActiveSession()).toBe(session);
      expect(agents.launched).toHaveLength(1);
    });

    it.each([
      ['load', 'initialization'], ['load', 'opening'],
      ['resume', 'initialization'], ['resume', 'opening'],
    ] as const)('keeps %s bound to the current configuration after renames during %s', async (how, stage) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const pause = async () => { enter(); await released; };
      const open = async () => {
        if (stage === 'opening') { await pause(); }
        return { configOptions: [modelOption('a')] };
      };
      const requested: unknown[] = [];
      const script: AgentScript = () => agent()
        .onRequest(methods.agent.initialize, async () => {
          if (stage === 'initialization') { await pause(); }
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };
        })
        .onRequest(methods.agent.session.load, open)
        .onRequest(methods.agent.session.resume, open)
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          requested.push(params);
          return { configOptions: [modelOption(String(params.value))] };
        });
      const { manager, agents, references, workspace } = setup({ fake: script });
      await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
      const events: unknown[][] = [];
      let load: SessionLoad | undefined;
      manager.once('session-load-start', (started) => { load = started; });
      manager.on('session-opened', (...args) => events.push(['opened', ...args]));
      manager.on('session-load-end', (...args) => events.push(['load-end', ...args]));
      manager.on('session-added', (...args) => events.push(['added', ...args]));
      const opening = how === 'load' ? manager.loadSession('fake', FIRST_SESSION) : manager.resumeSession('fake', FIRST_SESSION);
      const result = opening.then((session) => ({ session }), (error: unknown) => ({ error }));
      try {
        await entered;
        manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
        manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
        manager.agentsChanged({ again: fakeConfig }, { again: fakeConfig, fake: { command: 'other' } });
      } finally {
        release();
      }
      const outcome = await result;
      expect(outcome).not.toHaveProperty('error');
      if (!('session' in outcome)) { throw outcome.error; }
      const { session } = outcome;
      expect(manager.openSessionOf('again')).toBe(session);
      expect(manager.hasSession('fake')).toBe(false);
      expect(session.agentName).toBe('again');
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(requested).toEqual([{ sessionId: FIRST_SESSION, configId: 'model', value: 'b' }]);
      expect(events).toEqual(how === 'load'
        ? [['added', session], ['load-end', load, true], ['opened', session, 'loaded']]
        : [['added', session], ['opened', session, 'resumed']]);
      if (how === 'load') {
        expect(load?.origin.identity.configuredName).toBe(stage === 'opening' ? 'fake' : 'again');
        expect(load?.registration).toBe(session);
      }
      await references.settled();
      await workspace.settled();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: FIRST_SESSION })?.selections).toEqual({ options: { model: 'b' } });
      expect(workspace.lastActiveSession()?.configuredName).toBe('again');
      await manager.ensureConnected('again');
      expect(agents.launched).toHaveLength(1);
      await manager.disconnectAgent('again');
      expect(manager.getActiveSession()).toBeUndefined();
    });

    it.each(['initialization', 'creation'] as const)('keeps the captured configuration through two renames and old-name reuse during %s', async (stage) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const pause = async () => { enter(); await released; };
      const script: AgentScript = () => agent()
        .onRequest(methods.agent.initialize, async () => {
          if (stage === 'initialization') { await pause(); }
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } };
        })
        .onRequest(methods.agent.session.new, async () => {
          if (stage === 'creation') { await pause(); }
          return { sessionId: FIRST_SESSION };
        });
      const { manager, agents, references, workspace } = setup({ fake: script });
      const opening = manager.connectToAgent('fake');
      try {
        await entered;
        manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
        manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
        manager.agentsChanged({ again: fakeConfig }, { again: fakeConfig, fake: { command: 'other' } });
      } finally {
        release();
      }
      const session = await opening;
      await manager.recordsSettled();
      await references.settled();
      await workspace.settled();

      expect(session.agentName).toBe('again');
      expect(manager.openSessionOf('again')).toBe(session);
      expect(manager.hasSession('fake')).toBe(false);
      expect(manager.isConnected('again')).toBe(true);
      expect(manager.isConnected('fake')).toBe(false);
      expect(manager.getCachedCapabilities('again')?.load).toBe(true);
      expect(workspace.lastActiveSession()?.configuredName).toBe('again');
      expect(references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: FIRST_SESSION })).toBeDefined();

      await manager.ensureConnected('again');
      expect(agents.launched).toHaveLength(1);
      await manager.disconnectAgent('again');
      expect(manager.getActiveSession()).toBeUndefined();
      expect(manager.isConnected('again')).toBe(false);
    });

    it('keeps the renamed live registration on its original connection', async () => {
      const prompted: string[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app
        .onRequest(methods.agent.session.prompt, ({ params }) => {
          prompted.push(params.sessionId);
          return { stopReason: 'end_turn' };
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
          configOptions: [modelOption(String(params.value))],
        })));
      const { manager } = setup({ fake: fake.script });
      const session = await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });

      expect(manager.getActiveSession()).toBe(session);
      expect(session.agentName).toBe('renamed');
      expect(manager.openSessionOf('renamed')).toBe(session);
      expect(manager.hasSession('fake')).toBe(false);
      expect(manager.isConnected('renamed')).toBe(true);
      expect(manager.isConnected('fake')).toBe(false);
      await manager.sendPrompt(FIRST_SESSION, 'Continue after rename');
      await manager.setConfigOption(FIRST_SESSION, 'model', 'b');
      expect(prompted).toEqual([FIRST_SESSION]);
      expect(session.configOptions).toEqual([modelConfig('b')]);

      await manager.disconnectAgent('renamed');

      expect(manager.getActiveSession()).toBeUndefined();
      expect(manager.isConnected('renamed')).toBe(false);
    });

    it("rebinds this host's references and this workspace's last active session to the new name", async () => {
      const { manager, references, workspace, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');
      await manager.recordsSettled();

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      await references.settled();
      await workspace.settled();

      expect(reference(FIRST_SESSION)).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION })).toBeDefined();
      expect(workspace.lastActiveSession()?.configuredName).toBe('renamed');
    });

    it('records a session still running under the old name under the new one', async () => {
      const { manager, references, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.applySessionInfoUpdate(FIRST_SESSION, { title: 'After the rename' });
      await manager.recordsSettled();
      await references.settled();

      expect(reference(FIRST_SESSION)).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION })?.title).toBe('After the rename');
    });

    it('records a session still running under its first name under the last, after two renames', async () => {
      const { manager, references } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
      manager.applySessionInfoUpdate(FIRST_SESSION, { title: 'After both' });
      await manager.recordsSettled();
      await references.settled();

      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: FIRST_SESSION })?.title).toBe('After both');
    });

    it('keeps recording the original session under its renamed configuration when the old name is reused', async () => {
      const { manager, references, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');
      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });

      manager.agentsChanged({ renamed: fakeConfig }, { renamed: fakeConfig, fake: { command: 'other' } });
      manager.applySessionInfoUpdate(FIRST_SESSION, { title: 'Still the original session' });
      await manager.recordsSettled();
      await references.settled();

      expect(reference(FIRST_SESSION)).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION })?.title)
        .toBe('Still the original session');
    });
  });
});
