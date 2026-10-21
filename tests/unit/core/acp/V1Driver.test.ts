import { describe, expect, it, vi } from 'vitest';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type * as Acp from '@agentclientprotocol/sdk';
import { AuthRequired, UnknownSession, type ConfigOption, type SessionUpdate } from '@/core/acp/AcpDriver';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { connectedDriver, fakeAgent, type AgentScript } from '@tests/unit/core/InProcessAgents';

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
  return (await driver.newSession('/work')).configOptions;
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
        capabilities: { list: true, load: true, resume: false },
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

    it('reports a new tool call and its updates alike, with its status, title and text output', async () => {
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
        { kind: 'toolCall', toolCallId: 't1', title: 'Run tests', status: 'running', texts: ['ok'] },
        { kind: 'toolCall', toolCallId: 't1', status: 'completed' },
        { kind: 'toolCall', toolCallId: 't1', status: 'failed', texts: [] },
        { kind: 'toolCall', toolCallId: 't1' },
        { kind: 'toolCall', toolCallId: 't2', status: 'pending' },
      ]);
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

    it('drops the updates the interface has no place for', async () => {
      expect(await translated({ sessionUpdate: 'usage_update', used: 1000, size: 200000 })).toEqual([]);
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

      expect(await driver.newSession('/work')).toEqual({
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
      }), { permissions: { requestPermission } });

      await driver.prompt('s1', [{ kind: 'text', text: 'go' }]);

      const options = [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'reject', name: 'Reject', kind: 'reject_always' }];
      expect(requestPermission.mock.calls).toEqual([
        [{ sessionId: 's1', title: 'Edit a.ts', description: null, subject: null, options }],
        [{ sessionId: 's1', title: null, description: null, subject: null, options }],
      ]);
      expect(answers).toEqual([
        { outcome: { outcome: 'selected', optionId: 'allow' } },
        { outcome: { outcome: 'selected', optionId: 'allow' } },
      ]);
    });
  });

  describe('errors', () => {
    const failing: AgentScript = () => fakeAgent()
      .onRequest(methods.agent.session.new, () => {
        throw RequestError.authRequired();
      })
      .onRequest(methods.agent.session.load, ({ params }) => {
        throw RequestError.invalidParams(undefined, `Session not found: ${params.sessionId}`);
      })
      .onRequest(methods.agent.session.resume, () => {
        throw RequestError.internalError(undefined, 'disk full');
      });

    it("reports the agent's refusal until the user authenticates as AuthRequired, with the agent's message", async () => {
      const { driver } = await connectedDriver(failing);

      const error = await driver.newSession('/work').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthRequired);
      expect(error).toHaveProperty('message', expect.stringContaining('Authentication required'));
    });

    it('reports a session the agent does not know as UnknownSession, and other failures as they are', async () => {
      const { driver } = await connectedDriver(failing);

      const unknown = await driver.loadSession('gone', '/work').catch((e: unknown) => e);
      const other = await driver.resumeSession('old', '/work').catch((e: unknown) => e);

      expect(unknown).toBeInstanceOf(UnknownSession);
      expect(unknown).toHaveProperty('message', expect.stringContaining('Session not found: gone'));
      expect(other).not.toBeInstanceOf(UnknownSession);
      expect(other).toHaveProperty('message', expect.stringContaining('disk full'));
    });
  });
});
