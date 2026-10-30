import { describe, expect, it, vi } from 'vitest';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type * as Acp from '@agentclientprotocol/sdk';
import { PermissionRequests, type PermissionChooser } from '@/core/PermissionRequests';
import { AuthRequired, UnknownSession, type ConfigOption, type SessionRoots, type SessionUpdate } from '@/core/acp/AcpDriver';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { connectedDriver, fakeAgent, work, type AgentScript } from '@tests/unit/core/InProcessAgents';

/** The session updates the driver passes up for those an agent sends during a prompt. */
async function translated(...updates: Acp.SessionUpdate[]): Promise<SessionUpdate[]> {
  const { driver, updates: received } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
    for (const update of updates) {
      await client.notify(methods.client.session.update, { sessionId: 's1', update });
    }
    return { stopReason: 'end_turn' };
  }));
  await driver.prompt('s1', [{ kind: 'text', text: 'go' }]);
  return received.map(([, update]) => update);
}

/** The config options of a session the agent creates with these. */
async function configOptionsOf(...options: Acp.SessionConfigOption[]): Promise<ConfigOption[] | null> {
  const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1', configOptions: options })));
  return (await driver.newSession(work)).configOptions;
}

const modelOption: Acp.SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B', description: 'The big one' }],
};

describe('V1Driver', () => {
  describe('the agent', () => {
    it('describes the agent as its initialize response does', async () => {
      const { driver } = await connectedDriver(() => fakeAgent({
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        authMethods: [{ id: 'token', name: 'Token', description: 'Paste an API token' }, { id: 'browser', name: 'Browser' }],
      }));

      expect(driver.agent).toEqual({
        displayName: 'Fake Agent',
        capabilities: { list: true, load: true, resume: false, additionalDirectories: false },
        authMethods: [
          { id: 'token', name: 'Token', description: 'Paste an API token' },
          { id: 'browser', name: 'Browser', description: null },
        ],
      });
    });

    it('names the agent by its name when it has no title, and not at all when it gives none', async () => {
      const named = await connectedDriver(() => fakeAgent({ agentInfo: { name: 'fake-agent', version: '1' } }));
      const unnamed = await connectedDriver(() => fakeAgent({ agentInfo: null }));

      expect(named.driver.agent.displayName).toBe('fake-agent');
      expect(unnamed.driver.agent.displayName).toBeNull();
    });

    it('supports additional directories when its session capabilities advertise them', async () => {
      const { driver } = await connectedDriver(() => fakeAgent({ agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } }));

      expect(driver.agent.capabilities.additionalDirectories).toBe(true);
    });
  });

  it('tags every session update it passes up with its schema, v1', async () => {
    const { driver, schemas } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
      await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } });
      await client.notify(methods.client.session.update, { sessionId: 's2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } });
      return { stopReason: 'end_turn' };
    }));
    await driver.prompt('s1', [{ kind: 'text', text: 'go' }]);
    expect(schemas).toEqual(['v1', 'v1']);
  });

  describe('session updates', () => {
    it("passes on the agent's answer, thinking and replayed prompts as text, with their message IDs", async () => {
      expect(await translated(
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hi' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hm' } },
        { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Fix it' } },
      )).toEqual([
        { kind: 'agentText', messageId: 'm1', text: 'Hi' },
        { kind: 'thoughtText', messageId: null, text: 'Hm' },
        { kind: 'promptText', messageId: 'u1', text: 'Fix it' },
      ]);
    });

    it('drops text meant for the model alone, content other than text, and empty answer text', async () => {
      const forModel: Acp.ContentBlock = { type: 'text', text: 'file contents', annotations: { audience: ['assistant'] } };
      const image: Acp.ContentBlock = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
      const chunks = (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'] as const).flatMap((sessionUpdate) => [
        { sessionUpdate, content: forModel },
        { sessionUpdate, content: image },
      ]);

      expect(await translated(
        ...chunks,
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'both', annotations: { audience: ['user', 'assistant'] } } },
      )).toEqual([{ kind: 'agentText', messageId: null, text: 'both' }]);
    });

    it('drops what an agent replays of a file read into the prompt, keeping what the user typed', async () => {
      const forModel = (text: string): Acp.SessionUpdate => (
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text, annotations: { audience: ['assistant'] } } }
      );

      expect(await translated(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' } },
        forModel('Called the Read tool with the following input: {"filePath":"/work/a.ts"}'),
        forModel('export const a = 1;'),
        { sessionUpdate: 'user_message_chunk', content: { type: 'resource_link', uri: 'file:///work/a.ts', name: 'a.ts' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer to q1' } },
      )).toEqual([
        { kind: 'promptText', messageId: null, text: 'q1' },
        { kind: 'agentText', messageId: null, text: 'answer to q1' },
      ]);
    });

    it('reports a new tool call and its updates alike, with its status, title and content', async () => {
      expect(await translated(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Run tests',
          status: 'in_progress',
          content: [
            { type: 'content', content: { type: 'text', text: 'ok' } },
            { type: 'diff', path: '/work/a.ts', oldText: 'a', newText: 'b' },
            { type: 'terminal', terminalId: 'term-1' },
            { type: 'content', content: { type: 'text', text: '' } },
          ],
        },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: null, status: 'failed', content: [] },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: '', status: null, content: null },
        { sessionUpdate: 'tool_call', toolCallId: 't2', title: '', status: 'pending' },
      )).toEqual([
        { kind: 'toolCall', toolCallId: 't1', title: 'Run tests', status: 'running', content: [
          { kind: 'text', text: 'ok' },
          { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a', newText: 'b' } },
        ] },
        { kind: 'toolCall', toolCallId: 't1', status: 'completed' },
        { kind: 'toolCall', toolCallId: 't1', status: 'failed', content: [] },
        { kind: 'toolCall', toolCallId: 't1' },
        { kind: 'toolCall', toolCallId: 't2', status: 'pending' },
      ]);
    });

    it("passes on a tool call's kind, and leaves it as it was when an update leaves it out", async () => {
      expect(await translated(
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm test', kind: 'execute' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'other' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: null },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1' },
      )).toEqual([
        { kind: 'toolCall', toolCallId: 't1', title: 'npm test', toolKind: 'execute' },
        { kind: 'toolCall', toolCallId: 't1', toolKind: 'other' },
        { kind: 'toolCall', toolCallId: 't1' },
        { kind: 'toolCall', toolCallId: 't1' },
      ]);
    });

    it("passes on a tool call's diffs as whole files, in the order reported among its texts, a new file's old text as null", async () => {
      expect(await translated({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        content: [
          { type: 'diff', path: '/work/new.ts', newText: 'created' },
          { type: 'content', content: { type: 'text', text: 'between' } },
          { type: 'diff', path: '/work/also-new.ts', oldText: null, newText: '' },
          { type: 'diff', path: '/work/emptied.ts', oldText: 'gone', newText: '' },
        ],
      })).toEqual([{ kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/new.ts', oldText: null, newText: 'created' } },
        { kind: 'text', text: 'between' },
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/also-new.ts', oldText: null, newText: '' } },
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/emptied.ts', oldText: 'gone', newText: '' } },
      ] }]);
    });

    it('reports the plan as steps', async () => {
      expect(await translated({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read', priority: 'high', status: 'completed' },
          { content: 'Edit', priority: 'medium', status: 'in_progress' },
          { content: 'Test', priority: 'low', status: 'pending' },
        ],
      })).toEqual([{
        kind: 'plan',
        steps: [{ text: 'Read', status: 'completed' }, { text: 'Edit', status: 'running' }, { text: 'Test', status: 'pending' }],
      }]);
    });

    it('reports slash commands, config options, the mode and session info', async () => {
      expect(await translated(
        { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'Init' }, { name: 'review', description: 'Review', input: { hint: 'what to review' } }] },
        { sessionUpdate: 'config_option_update', configOptions: [modelOption] },
        { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
        { sessionUpdate: 'session_info_update', title: 'Fix the build' },
        { sessionUpdate: 'session_info_update', title: null, updatedAt: '2026-10-20T00:00:00Z' },
        { sessionUpdate: 'session_info_update' },
      )).toEqual([
        { kind: 'commands', commands: [
          { name: 'init', description: 'Init', takesInput: false, hint: null },
          { name: 'review', description: 'Review', takesInput: true, hint: 'what to review' },
        ] },
        { kind: 'configOptions', options: [{
          kind: 'select',
          id: 'model',
          name: 'Model',
          description: null,
          category: 'model',
          current: 'a',
          groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
        }] },
        { kind: 'currentMode', modeId: 'code' },
        { kind: 'sessionInfo', title: 'Fix the build' },
        { kind: 'sessionInfo', title: null, updatedAt: '2026-10-20T00:00:00Z' },
        { kind: 'sessionInfo' },
      ]);
    });

    it('passes on reported context usage and cumulative cost without rounding or protocol metadata', async () => {
      expect(await translated({
        sessionUpdate: 'usage_update',
        used: 123456,
        size: 200001,
        cost: { amount: 0.123456789, currency: 'EUR', _meta: { vendor: 'cost metadata' } },
        _meta: { vendor: 'usage metadata' },
      })).toEqual([{ kind: 'usage', used: 123456, size: 200001, cost: { amount: 0.123456789, currency: 'EUR' } }]);
    });

    it('reports no cost for both absent and null cost', async () => {
      expect(await translated(
        { sessionUpdate: 'usage_update', used: 1000, size: 200000 },
        { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: null },
      )).toEqual([
        { kind: 'usage', used: 1000, size: 200000, cost: null },
        { kind: 'usage', used: 1000, size: 200000, cost: null },
      ]);
    });

    it('preserves zero context and cost values', async () => {
      expect(await translated({ sessionUpdate: 'usage_update', used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } }))
        .toEqual([{ kind: 'usage', used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } }]);
    });

    it('passes on successive snapshots unchanged when context shrinks, the limit changes and cost is no longer reported', async () => {
      expect(await translated(
        { sessionUpdate: 'usage_update', used: 90000, size: 200000, cost: { amount: 1.25, currency: 'USD' } },
        { sessionUpdate: 'usage_update', used: 15000, size: 100000, cost: { amount: 1.5, currency: 'USD' } },
        { sessionUpdate: 'usage_update', used: 16000, size: 100000 },
      )).toEqual([
        { kind: 'usage', used: 90000, size: 200000, cost: { amount: 1.25, currency: 'USD' } },
        { kind: 'usage', used: 15000, size: 100000, cost: { amount: 1.5, currency: 'USD' } },
        { kind: 'usage', used: 16000, size: 100000, cost: null },
      ]);
    });
  });

  describe('config options', () => {
    it('keeps the groups of grouped values, headed by their names', async () => {
      const [option] = await configOptionsOf({
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'b',
        options: [
          { group: 'fast', name: 'Fast models', options: [{ value: 'a', name: 'A' }] },
          { group: 'slow', name: '', options: [{ value: 'b', name: 'B' }] },
        ],
      }) ?? [];

      expect(option?.kind === 'select' ? option.groups : undefined).toEqual([
        { header: 'Fast models', values: [{ id: 'a', name: 'A', description: null }] },
        { header: 'slow', values: [{ id: 'b', name: 'B', description: null }] },
      ]);
    });

    it('sets a select option by its value alone, and a boolean one with its type', async () => {
      const received: Acp.SetSessionConfigOptionRequest[] = [];
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        received.push(params);
        return { configOptions: [] };
      }));

      await driver.setConfigOption('s1', 'model', 'b');
      await driver.setConfigOption('s1', 'fast', true);

      expect(received).toEqual([
        { sessionId: 's1', configId: 'model', value: 'b' },
        { sessionId: 's1', configId: 'fast', type: 'boolean', value: true },
      ]);
    });

    it('keeps booleans, which no picker shows but which still replace modes', async () => {
      expect(await configOptionsOf({ id: 'fast', name: 'Fast', description: 'Answers sooner', type: 'boolean', currentValue: true })).toEqual([
        { kind: 'boolean', id: 'fast', name: 'Fast', description: 'Answers sooner', category: 'other', current: true },
      ]);
    });

    it.each([
      ['mode', 'mode'],
      ['model', 'model'],
      ['thought_level', 'thought_level'],
      ['model_config', 'other'],
      [null, 'other'],
    ] as const)('gives a config option of category %s the category %s', async (category, expected) => {
      const [option] = await configOptionsOf({ ...modelOption, category }) ?? [];
      expect(option?.category).toBe(expected);
    });
  });

  describe('sessions', () => {
    it('reports the modes of a new session, no config options when it has none, and no commands, which only its updates report', async () => {
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.new, () => ({
        sessionId: 's1',
        modes: { availableModes: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
      })));

      expect(await driver.newSession(work)).toEqual({
        sessionId: 's1',
        modes: { current: 'ask', available: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code', description: null }] },
        configOptions: null,
        commands: null,
      });
    });

    it('lists sessions with their titles and times, null where the agent gives none', async () => {
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.list, () => ({
        sessions: [{ sessionId: 'a', cwd: '/work', title: 'Fix the build', updatedAt: '2026-10-20T00:00:00Z' }, { sessionId: 'b', cwd: '/work' }],
        nextCursor: 'page2',
      })));

      expect(await driver.listSessions({ cwd: '/work' })).toEqual({
        sessions: [
          { sessionId: 'a', cwd: '/work', title: 'Fix the build', updatedAt: '2026-10-20T00:00:00Z' },
          { sessionId: 'b', cwd: '/work', title: null, updatedAt: null },
        ],
        nextCursor: 'page2',
      });
    });

    describe('additional directories', () => {
      const roots = { cwd: '/work', additionalDirectories: ['/more', '/other'] };

      /** The `session/new`, `session/load` and `session/resume` requests a driver for this agent makes with `given`. */
      async function setupRequests(capabilities: Acp.SessionCapabilities, given: SessionRoots = roots): Promise<unknown[]> {
        const received: unknown[] = [];
        const { driver } = await connectedDriver(() => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, ...capabilities } } })
          .onRequest(methods.agent.session.new, ({ params }) => { received.push(params); return { sessionId: 's1' }; })
          .onRequest(methods.agent.session.load, ({ params }) => { received.push(params); return {}; })
          .onRequest(methods.agent.session.resume, ({ params }) => { received.push(params); return {}; }));
        await driver.newSession(given);
        await driver.loadSession('s1', given);
        await driver.resumeSession('s1', given);
        return received;
      }

      it('gives a session its other directories on creation, load and resume when the agent supports them', async () => {
        expect(await setupRequests({ additionalDirectories: {} })).toEqual([
          { cwd: '/work', additionalDirectories: ['/more', '/other'], mcpServers: [] },
          { sessionId: 's1', cwd: '/work', additionalDirectories: ['/more', '/other'], mcpServers: [] },
          { sessionId: 's1', cwd: '/work', additionalDirectories: ['/more', '/other'], mcpServers: [] },
        ]);
      });

      it('sends only the cwd to an agent that does not support them, and when there are none', async () => {
        const onlyCwd = [
          { cwd: '/work', mcpServers: [] },
          { sessionId: 's1', cwd: '/work', mcpServers: [] },
          { sessionId: 's1', cwd: '/work', mcpServers: [] },
        ];

        expect(await setupRequests({})).toEqual(onlyCwd);
        expect(await setupRequests({ additionalDirectories: {} }, work)).toEqual(onlyCwd);
      });
    });
  });

  describe('permission requests', () => {
    it("asks with the tool call's title and the options offered, saying nothing of what it is about or why, and answers with the choice", async () => {
      const requestPermission = vi.fn<ClientHandlers['permissions']['requestPermission']>(async () => ({ kind: 'selected', optionId: 'allow' }));
      const answers: Acp.RequestPermissionResponse[] = [];
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
        for (const title of ['Edit a.ts', undefined]) {
          answers.push(await client.request(methods.client.session.requestPermission, {
            sessionId: 's1',
            toolCall: { toolCallId: 'c1', ...(title ? { title } : {}) },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_always' }],
          }));
        }
        return { stopReason: 'end_turn' };
      }), { permissions: { requestPermission, cancelSession: vi.fn() } });

      await driver.prompt('s1', [{ kind: 'text', text: 'go' }]);

      const options = [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'reject', name: 'Reject', kind: 'reject_always' }];
      expect(requestPermission.mock.calls).toEqual([
        [{ sessionId: 's1', title: 'Edit a.ts', description: null, subject: null, options }, expect.any(AbortSignal)],
        [{ sessionId: 's1', title: null, description: null, subject: null, options }, expect.any(AbortSignal)],
      ]);
      expect(answers).toEqual([
        { outcome: { outcome: 'selected', optionId: 'allow' } },
        { outcome: { outcome: 'selected', optionId: 'allow' } },
      ]);
    });

    it('returns the SDK request-cancelled error when permission UI is dismissed without reject-once', async () => {
      const requestPermission = vi.fn<ClientHandlers['permissions']['requestPermission']>(async () => ({ kind: 'requestCancelled' }));
      const answers: unknown[] = [];
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
        answers.push(await client.request(methods.client.session.requestPermission, {
          sessionId: 's1',
          toolCall: { toolCallId: 'c1' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        }).catch((error: unknown) => error));
        return { stopReason: 'end_turn' };
      }), { permissions: { requestPermission, cancelSession: vi.fn() } });

      await driver.prompt('s1', [{ kind: 'text', text: 'go' }]);

      expect(answers).toEqual([expect.objectContaining({ code: -32800 })]);
    });

    it('notifies the agent of session cancellation before answering pending permission as cancelled', async () => {
      const events: string[] = [];
      let permissionStarted!: () => void;
      const started = new Promise<void>((resolve) => { permissionStarted = resolve; });
      const chooser: PermissionChooser = {
        autoApprove: () => 'ask',
        choose: (_prompt, _options, signal) => new Promise((resolve) => {
          permissionStarted();
          signal.addEventListener('abort', () => resolve(undefined), { once: true });
        }),
      };
      const permissions = new PermissionRequests(chooser);
      const handlers: ClientHandlers = {
        permissions: {
          requestPermission: (permission, signal) => permissions.requestPermission(permission, signal),
          cancelSession: (sessionId) => {
            events.push('cancel-pending-permissions');
            permissions.cancelSession(sessionId);
          },
        },
      };
      const { driver } = await connectedDriver(() => fakeAgent()
        .onRequest(methods.agent.session.prompt, async ({ client }) => {
          const response = await client.request(methods.client.session.requestPermission, {
            sessionId: 's1',
            toolCall: { toolCallId: 'c1' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          });
          events.push(`permission:${response.outcome.outcome}`);
          return { stopReason: 'cancelled' };
        })
        .onNotification(methods.agent.session.cancel, () => { events.push('session-cancel'); }), handlers);
      const turn = driver.prompt('s1', [{ kind: 'text', text: 'go' }]);

      await started;
      await driver.cancel('s1');
      await turn;

      expect(events).toEqual(['session-cancel', 'cancel-pending-permissions', 'permission:cancelled']);
    });

    it('passes request withdrawal to the permission handler and returns its cancelled-request error', async () => {
      let permissionStarted!: () => void;
      const started = new Promise<void>((resolve) => { permissionStarted = resolve; });
      const permissions = new PermissionRequests({
        autoApprove: () => 'ask',
        choose: (_prompt, _options, signal) => new Promise((resolve) => {
          permissionStarted();
          signal.addEventListener('abort', () => resolve(undefined), { once: true });
        }),
      });
      const cancellation = new AbortController();
      const answers: unknown[] = [];
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
        const response = client.request(methods.client.session.requestPermission, {
          sessionId: 's1', toolCall: { toolCallId: 'c1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        }, { cancellationSignal: cancellation.signal }).catch((error: unknown) => error);
        await started;
        cancellation.abort();
        answers.push(await response);
        return { stopReason: 'end_turn' };
      }), { permissions });

      await driver.prompt('s1', [{ kind: 'text', text: 'go' }]);

      expect(answers).toEqual([expect.objectContaining({ code: -32800 })]);
    });
  });

  describe('errors', () => {
    /** An agent refusing every load and resume with what `refusal` makes of the session asked for. */
    const refusing = (refusal: (sessionId: string) => RequestError): AgentScript => () => fakeAgent()
      .onRequest(methods.agent.session.load, ({ params }) => {
        throw refusal(params.sessionId);
      })
      .onRequest(methods.agent.session.resume, ({ params }) => {
        throw refusal(params.sessionId);
      });

    it("reports the agent's refusal until the user authenticates as AuthRequired, with the agent's message", async () => {
      const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.new, () => {
        throw RequestError.authRequired();
      }));

      const error = await driver.newSession(work).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthRequired);
      expect(error).toHaveProperty('message', expect.stringContaining('Authentication required'));
    });

    it("reports a load or resume of a session the agent does not know, as ACP reports it, as UnknownSession with the agent's message", async () => {
      const { driver } = await connectedDriver(refusing((sessionId) => new RequestError(-32002, 'Resource not found', { sessionId })));

      const loaded = await driver.loadSession('gone', work).catch((e: unknown) => e);
      const resumed = await driver.resumeSession('gone', work).catch((e: unknown) => e);

      expect(loaded).toBeInstanceOf(UnknownSession);
      expect(loaded).toHaveProperty('message', expect.stringContaining('Resource not found'));
      expect(resumed).toBeInstanceOf(UnknownSession);
    });

    it.each<[string, (sessionId: string) => RequestError]>([
      ['a missing resource naming another session', () => new RequestError(-32002, 'Resource not found', { sessionId: 'other' })],
      ['a missing resource naming no session', () => RequestError.resourceNotFound('file:///work/missing')],
      ['a missing resource without data', () => new RequestError(-32002, 'Resource not found')],
      ['invalid params whose message says the session was not found', (sessionId) => RequestError.invalidParams(undefined, `Session not found: ${sessionId}`)],
      ['the session being in use by another client', () => RequestError.invalidRequest(undefined, 'This session is in use by another client')],
      ['an internal error', () => RequestError.internalError(undefined, 'disk full')],
    ])('reports a refusal with %s as it is, not as UnknownSession', async (_, refusal) => {
      const { driver } = await connectedDriver(refusing(refusal));

      const loaded = await driver.loadSession('gone', work).catch((e: unknown) => e);
      const resumed = await driver.resumeSession('gone', work).catch((e: unknown) => e);

      expect(loaded).toBeInstanceOf(RequestError);
      expect(loaded).toHaveProperty('message', refusal('gone').message);
      expect(resumed).toBeInstanceOf(RequestError);
    });
  });
});
