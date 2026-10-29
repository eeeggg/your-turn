import { describe, expect, it, vi } from 'vitest';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { AuthRequired, UnknownSession, type ConfigOption, type PermissionOutcome, type PromptPart, type SessionUpdate, type ToolCallContent } from '@/core/acp/AcpDriver';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { PermissionRequests } from '@/core/PermissionRequests';
import { setLogSink } from '@/core/Log';
import { connectedDriver, fakeV2Agent, type AgentScript } from '@tests/unit/core/InProcessAgents';

const go: PromptPart[] = [{ kind: 'text', text: 'go' }];

function text(value: string, audience?: V2.Role[]): V2.ContentBlock {
  return { type: 'text', text: value, ...(audience ? { annotations: { audience } } : {}) };
}

function notify(client: V2.AgentContext, update: V2.SessionUpdate, sessionId = 's1'): Promise<void> {
  return client.notify(V2.methods.client.session.update, { sessionId, update });
}

/** The session updates the driver passes up, by session, for those the agent sends, by session, while creating a session. */
async function passedUp(...sent: [string, V2.SessionUpdate][]): Promise<[string, SessionUpdate][]> {
  const { driver, updates } = await connectedDriver(() => fakeV2Agent()
    .onRequest(V2.methods.agent.session.new, async ({ client }) => {
      for (const [sessionId, update] of sent) {
        await notify(client, update, sessionId);
      }
      return { sessionId: 's1' };
    })
    .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] })));
  await driver.newSession('/work');
  // A round trip after the answer, by which time the driver has taken in the updates sent before it.
  await driver.listSessions({});
  return updates;
}

/** The session updates the driver passes up for those the agent sends for one session. */
async function updatesFor(...sent: V2.SessionUpdate[]): Promise<SessionUpdate[]> {
  return (await passedUp(...sent.map((update): [string, V2.SessionUpdate] => ['s1', update]))).map(([, update]) => update);
}

const running: V2.StateUpdate = { state: 'running' };
const blocked: V2.StateUpdate = { state: 'requires_action' };
const idle: V2.StateUpdate = { state: 'idle', stopReason: 'end_turn' };

function reportState(client: V2.AgentContext, update: V2.StateUpdate): Promise<void> {
  return client.notify(V2.methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'state_update', ...update } });
}

/** Resolves with 'ended' or the error once `prompt` settles, so a test can tell a turn still running from one that ended. */
function outcomeOf(prompt: Promise<void>): Promise<unknown> {
  return prompt.then(() => 'ended', (e: unknown) => e);
}

async function soFar(outcome: Promise<unknown>): Promise<unknown> {
  return Promise.race([outcome, Promise.resolve('running')]);
}

/**
 * A driver whose agent reports `beforeAnswer` and then accepts the prompt; `report` sends more of the session's state,
 * returning once the driver has taken it in.
 */
async function turnAgent(...beforeAnswer: V2.StateUpdate[]) {
  let promptedBy: (client: V2.AgentContext) => void = () => {};
  const prompted = new Promise<V2.AgentContext>((resolve) => { promptedBy = resolve; });
  const { driver, exit } = await connectedDriver(() => fakeV2Agent()
    .onRequest(V2.methods.agent.session.prompt, async ({ client }) => {
      for (const update of beforeAnswer) {
        await reportState(client, update);
      }
      promptedBy(client);
      return { messageId: 'u1' };
    })
    .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] })));
  return {
    driver,
    exit,
    async report(...updates: V2.StateUpdate[]): Promise<void> {
      const client = await prompted;
      for (const update of updates) {
        await reportState(client, update);
      }
      // The agent answers after the updates it sent before, and the driver takes them in in order.
      await driver.listSessions({});
    },
  };
}

/** The config options of a session the agent creates with these. */
async function configOptionsOf(...options: V2.SessionConfigOption[]): Promise<ConfigOption[] | null> {
  const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's1', configOptions: options })));
  return (await driver.newSession('/work')).configOptions;
}

const modelOption: V2.SessionConfigOption = {
  configId: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B', description: 'The big one' }],
};

describe('V2Driver', () => {
  describe('the agent', () => {
    it('describes the agent as its initialize response does, offering only the auth methods it handles itself', async () => {
      const { driver } = await connectedDriver(() => fakeV2Agent({
        authMethods: [
          { type: 'agent', methodId: 'token', name: 'Token', description: 'Paste an API token' },
          { type: 'agent', methodId: 'browser', name: 'Browser' },
          { type: 'terminal', methodId: 'tui', name: 'Log in from the terminal' },
          { type: '_vendor', methodId: 'sso', name: 'SSO' },
        ],
      }));

      expect(driver.agent).toEqual({
        displayName: 'Fake Agent',
        capabilities: { list: true, load: true, resume: true },
        authMethods: [
          { id: 'token', name: 'Token', description: 'Paste an API token' },
          { id: 'browser', name: 'Browser', description: null },
        ],
      });
    });

    it('names the agent by its name when it has no title, and offers no past sessions when it has no sessions capability', async () => {
      const { driver } = await connectedDriver(() => fakeV2Agent({ info: { name: 'fake-agent', version: '1' }, capabilities: {} }));

      expect(driver.agent.displayName).toBe('fake-agent');
      expect(driver.agent.capabilities).toEqual({ list: false, load: false, resume: false });
    });
  });

  describe('sessions', () => {
    it('creates a session in the directory given, with no modes, and no config options or commands when it has none', async () => {
      const received: V2.NewSessionRequest[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, ({ params }) => {
        received.push(params);
        return { sessionId: 's1' };
      }));

      expect(await driver.newSession('/work')).toEqual({ sessionId: 's1', modes: null, configOptions: null, commands: null });
      expect(received).toEqual([{ cwd: '/work' }]);
    });

    it('gives a session the commands the agent starts it with, with the hint a text input has', async () => {
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({
        sessionId: 's1',
        availableCommands: [
          { name: 'web', description: 'Search the web', input: { type: 'text', hint: 'query' } },
          { name: 'pick', description: 'Pick a file', input: { type: '_vendor_file' } },
          { name: 'plan', description: 'Make a plan' },
        ],
      })));

      expect((await driver.newSession('/work')).commands).toEqual([
        { name: 'web', description: 'Search the web', takesInput: true, hint: 'query' },
        { name: 'pick', description: 'Pick a file', takesInput: true, hint: null },
        { name: 'plan', description: 'Make a plan', takesInput: false, hint: null },
      ]);
    });

    it('lists sessions with their titles and times, null where the agent gives none, asking only for what is given', async () => {
      const received: V2.ListSessionsRequest[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.list, ({ params }) => {
        received.push(params);
        return {
          sessions: [{ sessionId: 'a', cwd: '/work', title: 'Fix the build', updatedAt: '2026-10-20T00:00:00Z' }, { sessionId: 'b', cwd: '/work' }],
          ...(params.cursor ? {} : { nextCursor: 'page2' }),
        };
      }));

      expect(await driver.listSessions({ cwd: '/work' })).toEqual({
        sessions: [
          { sessionId: 'a', cwd: '/work', title: 'Fix the build', updatedAt: '2026-10-20T00:00:00Z' },
          { sessionId: 'b', cwd: '/work', title: null, updatedAt: null },
        ],
        nextCursor: 'page2',
      });
      expect(await driver.listSessions({ cursor: 'page2' })).not.toHaveProperty('nextCursor');
      expect(received).toEqual([{ cwd: '/work' }, { cursor: 'page2' }]);
    });

    it('loads a session by resuming it with a replay from the start, and resumes one without a replay', async () => {
      const received: V2.ResumeSessionRequest[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.resume, ({ params }) => {
        received.push(params);
        return { configOptions: [modelOption] };
      }));

      const loaded = await driver.loadSession('old', '/work');
      const resumed = await driver.resumeSession('old', '/work');

      expect(received).toEqual([
        { sessionId: 'old', cwd: '/work', replayFrom: { type: 'start' } },
        { sessionId: 'old', cwd: '/work' },
      ]);
      expect(loaded).toEqual(resumed);
      expect(loaded.modes).toBeNull();
      expect(loaded.configOptions?.map((option) => option.id)).toEqual(['model']);
    });

    it('sets a config option to a value by its ID, and reports the options the agent returns', async () => {
      const received: V2.SetSessionConfigOptionRequest[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.setConfigOption, ({ params }) => {
        received.push(params);
        return { configOptions: [{ ...modelOption, currentValue: 'b' }] };
      }));

      const options = await driver.setConfigOption('s1', 'model', 'b');

      expect(received).toEqual([{ sessionId: 's1', configId: 'model', type: 'id', value: 'b' }]);
      expect(options).toEqual([expect.objectContaining({ id: 'model', current: 'b' })]);
    });

    it('has no modes to set', async () => {
      const { driver } = await connectedDriver(() => fakeV2Agent());

      await expect(driver.setMode('s1', 'code')).rejects.toThrow('ACP v2 sessions have no modes');
    });

    it('logs in with the method chosen, and cancels a session', async () => {
      const logins: V2.LoginAuthRequest[] = [];
      let cancelled: (sessionId: string) => void = () => {};
      const cancel = new Promise<string>((resolve) => { cancelled = resolve; });
      const cancelSession = vi.fn<ClientHandlers['permissions']['cancelSession']>();
      const { driver } = await connectedDriver(() => fakeV2Agent()
        .onRequest(V2.methods.agent.auth.login, ({ params }) => { logins.push(params); })
        .onNotification(V2.methods.agent.session.cancel, ({ params }) => cancelled(params.sessionId)), {
        permissions: { requestPermission: vi.fn(), cancelSession },
      });

      await driver.authenticate('token');
      await driver.cancel('s1');

      expect(logins).toEqual([{ methodId: 'token' }]);
      expect(await cancel).toBe('s1');
      expect(cancelSession).toHaveBeenCalledExactlyOnceWith('s1');
    });
  });

  describe('config options', () => {
    it('groups the values the agent grouped, under their names', async () => {
      expect(await configOptionsOf({
        ...modelOption,
        options: [
          { groupId: 'fast', name: 'Fast', options: [{ value: 'a', name: 'Model A' }] },
          { groupId: 'smart', name: '', options: [{ value: 'b', name: 'Model B' }] },
        ],
      })).toEqual([{
        kind: 'select',
        id: 'model',
        name: 'Model',
        description: null,
        category: 'model',
        current: 'a',
        groups: [
          { header: 'Fast', values: [{ id: 'a', name: 'Model A', description: null }] },
          { header: 'smart', values: [{ id: 'b', name: 'Model B', description: null }] },
        ],
      }]);
    });

    it('puts values the agent left ungrouped into one group without a header', async () => {
      const [option] = await configOptionsOf(modelOption) ?? [];

      expect(option).toEqual({
        kind: 'select',
        id: 'model',
        name: 'Model',
        description: null,
        category: 'model',
        current: 'a',
        groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
      });
    });

    it('keeps booleans, and drops options of a type the interface has no place for', async () => {
      expect(await configOptionsOf(
        { configId: 'fast', name: 'Fast', description: 'Answers sooner', type: 'boolean', currentValue: true },
        { configId: 'budget', name: 'Budget', type: '_vendor_slider', currentValue: 3 },
      )).toEqual([
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

  describe('prompts', () => {
    it('sends the text and the file link as content blocks', async () => {
      const received: V2.PromptRequest[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.prompt, async ({ params, client }) => {
        received.push(params);
        await reportState(client, running);
        await reportState(client, idle);
        return { messageId: 'u1' };
      }));

      await driver.prompt('s1', [
        { kind: 'fileLink', uri: 'file:///work/a.ts', name: 'a.ts', mimeType: 'text/typescript' },
        { kind: 'fileLink', uri: 'file:///work/b', name: 'b' },
        { kind: 'text', text: 'Fix it' },
      ]);

      expect(received).toEqual([{
        sessionId: 's1',
        prompt: [
          { type: 'resource_link', uri: 'file:///work/a.ts', name: 'a.ts', mimeType: 'text/typescript' },
          { type: 'resource_link', uri: 'file:///work/b', name: 'b' },
          { type: 'text', text: 'Fix it' },
        ],
      }]);
    });

    it.each([
      ['working', running],
      ['waiting on the user', blocked],
    ])('ends the turn when the session goes idle after %s, not when the agent accepts the prompt', async (_, state) => {
      const agent = await turnAgent();
      const outcome = outcomeOf(agent.driver.prompt('s1', go));

      await agent.report(state);
      expect(await soFar(outcome)).toBe('running');

      await agent.report(idle);
      expect(await outcome).toBe('ended');
    });

    it('ends nothing with an idle report while the session is already idle', async () => {
      const agent = await turnAgent();
      const outcome = outcomeOf(agent.driver.prompt('s1', go));

      await agent.report(idle);
      expect(await soFar(outcome)).toBe('running');

      await agent.report(running, idle);
      expect(await outcome).toBe('ended');
    });

    it('ends the turn the agent reported in full before accepting the prompt', async () => {
      const agent = await turnAgent(running, idle);

      expect(await outcomeOf(agent.driver.prompt('s1', go))).toBe('ended');
    });

    it('waits on when the session is working again by the time the agent accepts the prompt', async () => {
      const agent = await turnAgent(running, idle, running);
      const outcome = outcomeOf(agent.driver.prompt('s1', go));

      await agent.report();
      expect(await soFar(outcome)).toBe('running');

      await agent.report(idle);
      expect(await outcome).toBe('ended');
    });

    it("fails with the error the agent's idle report carries, and asks for authentication on -32000", async () => {
      const agent = await turnAgent();

      const failed = outcomeOf(agent.driver.prompt('s1', go));
      await agent.report(running, { state: 'idle', stopReason: 'error', error: { code: -32603, message: 'The model crashed' } });
      const refused = outcomeOf(agent.driver.prompt('s1', go));
      await agent.report(running, { state: 'idle', stopReason: 'error', error: { code: -32000, message: 'Log in again' } });

      expect(await failed).toEqual(new Error('The model crashed'));
      expect(await refused).toBeInstanceOf(AuthRequired);
      expect(await refused).toHaveProperty('message', 'Log in again');
    });

    it('fails a turn still running when the connection closes', async () => {
      const agent = await turnAgent();
      const outcome = outcomeOf(agent.driver.prompt('s1', go));
      await agent.report(running);

      await agent.exit();

      expect(await outcome).toEqual(new Error('The connection to the agent closed before the turn ended'));
      expect(agent.driver.closed).toBe(true);
    });

    it('fails a prompt the agent refuses with its error, leaving nothing to fail when the connection closes', async () => {
      const { driver, exit } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.prompt, () => {
        throw V2.RequestError.internalError(undefined, 'Too many prompts');
      }));

      const refused = await outcomeOf(driver.prompt('s1', go));
      await exit();

      expect(refused).toHaveProperty('message', expect.stringContaining('Too many prompts'));
      expect(driver.closed).toBe(true);
    });
  });

  describe('session updates', () => {
    it('tags every session update it passes up with its schema, v2', async () => {
      const { driver, schemas } = await connectedDriver(() => fakeV2Agent()
        .onRequest(V2.methods.agent.session.new, async ({ client }) => {
          await notify(client, { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('hi') });
          await notify(client, { sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: text('hi') }, 's2');
          return { sessionId: 's1' };
        })
        .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] })));
      await driver.newSession('/work');
      await driver.listSessions({});
      expect(schemas).toEqual(['v2', 'v2']);
    });

    it("passes up the agent's answer and thinking, streamed and whole, leaving out what is not for the user", async () => {
      expect(await updatesFor(
        { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: text('') },
        { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('Hello') },
        { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('') },
        { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('Internal note', ['assistant']) },
        { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
        { sessionUpdate: 'agent_message', messageId: 'a1', content: [text('Hello, '), text('note', ['assistant']), text('world', ['user'])] },
        { sessionUpdate: 'agent_thought', messageId: 't1', content: [text('Pondering')] },
      )).toEqual([
        { kind: 'thoughtText', messageId: 't1', text: '' },
        { kind: 'agentText', messageId: 'a1', text: 'Hello' },
        { kind: 'agentMessage', messageId: 'a1', text: 'Hello, world' },
        { kind: 'thoughtMessage', messageId: 't1', text: 'Pondering' },
      ]);
    });

    it('clears a whole message the agent gives no content, and leaves one alone the agent gives none at all', async () => {
      expect(await updatesFor(
        { sessionUpdate: 'agent_message', messageId: 'a1', content: null },
        { sessionUpdate: 'agent_thought', messageId: 't1', content: [] },
        { sessionUpdate: 'agent_message', messageId: 'a1' },
        { sessionUpdate: 'agent_thought', messageId: 't1' },
      )).toEqual([
        { kind: 'agentMessage', messageId: 'a1', text: '' },
        { kind: 'thoughtMessage', messageId: 't1', text: '' },
      ]);
    });

    it("passes up the prompts a load replays, before a turn and after it, but not the agent's report of the prompt it is answering", async () => {
      const { driver, updates } = await connectedDriver(() => fakeV2Agent()
        .onRequest(V2.methods.agent.session.resume, async ({ client }) => {
          await notify(client, { sessionUpdate: 'user_message', messageId: 'u0', content: [text('Fix the build')] });
          await notify(client, { sessionUpdate: 'user_message_chunk', messageId: 'u0', content: text(' now') });
          await notify(client, { sessionUpdate: 'user_message', messageId: 'u0' });
          return {};
        })
        .onRequest(V2.methods.agent.session.prompt, async ({ client }) => {
          await notify(client, { sessionUpdate: 'user_message', messageId: 'u1', content: [text('go')] });
          await reportState(client, running);
          await notify(client, { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: text('!') });
          await notify(client, { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('Done') });
          await reportState(client, idle);
          return { messageId: 'u1' };
        })
        .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] })));

      await driver.loadSession('s1', '/work');
      // As the user's prompt does, this one comes after the driver has taken in the replay.
      await driver.listSessions({});
      await driver.prompt('s1', go);
      await driver.loadSession('s1', '/work');
      await driver.listSessions({});

      const replay: [string, SessionUpdate][] = [
        ['s1', { kind: 'promptMessage', messageId: 'u0', text: 'Fix the build' }],
        ['s1', { kind: 'promptText', messageId: 'u0', text: ' now' }],
      ];
      expect(updates).toEqual([...replay, ['s1', { kind: 'agentText', messageId: 'a1', text: 'Done' }], ...replay]);
    });

    it('passes up the prompts a load replays after a prompt the agent refused', async () => {
      const { driver, updates } = await connectedDriver(() => fakeV2Agent()
        .onRequest(V2.methods.agent.session.prompt, () => {
          throw V2.RequestError.internalError(undefined, 'Too many prompts');
        })
        .onRequest(V2.methods.agent.session.resume, async ({ client }) => {
          await notify(client, { sessionUpdate: 'user_message', messageId: 'u0', content: [text('Fix the build')] });
          return {};
        })
        .onRequest(V2.methods.agent.session.list, () => ({ sessions: [] })));

      await driver.prompt('s1', go).catch(() => {});
      await driver.loadSession('s1', '/work');
      await driver.listSessions({});

      expect(updates).toEqual([['s1', { kind: 'promptMessage', messageId: 'u0', text: 'Fix the build' }]]);
    });

    it("keeps each tool call's content, which an update's content replaces and a chunk adds to, and leaves alone what an update leaves out", async () => {
      const texts = (...items: string[]): ToolCallContent[] => items.map((item) => ({ kind: 'text', text: item }));
      expect(await passedUp(
        ['s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Read a.ts', status: 'in_progress', content: [
          { type: 'content', content: text('first') },
          { type: 'diff', changes: [] },
          { type: 'content', content: text('') },
        ] }],
        ['s1', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c1', content: { type: 'content', content: text('second') } }],
        ['s1', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c1', content: { type: 'terminal', terminalId: 'term' } }],
        ['s2', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c1', content: { type: 'content', content: text('elsewhere') } }],
        ['s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: null, status: 'completed' }],
        ['s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [{ type: 'content', content: text('replaced') }] }],
        ['s1', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c1', content: { type: 'content', content: text('more') } }],
        ['s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: null }],
        ['s1', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c1', content: { type: 'content', content: text('again') } }],
      )).toEqual([
        ['s1', { kind: 'toolCall', toolCallId: 'c1', title: 'Read a.ts', status: 'running', content: texts('first') }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: texts('first', 'second') }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: [...texts('first', 'second'), { kind: 'terminal', terminalId: 'term' }] }],
        ['s2', { kind: 'toolCall', toolCallId: 'c1', content: texts('elsewhere') }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', status: 'completed' }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: texts('replaced') }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: texts('replaced', 'more') }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: [] }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: texts('again') }],
      ]);
    });

    it("passes on a tool call's diffs as their changes and patch, in the order reported among its texts and chunks", async () => {
      const patch = { format: 'git_patch', text: 'diff --git /work/a.ts /work/a.ts\n--- /work/a.ts\n+++ /work/a.ts\n@@ -1 +1 @@\n-a\n+b\n' };
      const reported: ToolCallContent[] = [
        { kind: 'diff', diff: { kind: 'changes', changes: [
          { operation: 'modify', path: '/work/a.ts', fileType: 'text', mimeType: 'text/typescript' },
        ], patch: { format: 'git_patch', text: patch.text } } },
        { kind: 'text', text: 'between' },
        { kind: 'diff', diff: { kind: 'changes', changes: [
          { operation: 'add', path: '/work/new.ts', fileType: null, mimeType: null },
          { operation: 'delete', path: '/work/old.ts', fileType: null, mimeType: null },
          { operation: 'move', oldPath: '/work/from.png', path: '/work/to.png', fileType: 'binary', mimeType: 'image/png' },
          { operation: 'copy', oldPath: '/work/src', path: '/work/dst', fileType: 'directory', mimeType: null },
          { operation: 'modify', path: '/work/link', fileType: 'symlink', mimeType: null },
        ], patch: null } },
      ];
      expect(await passedUp(
        ['s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [
          { type: 'diff', changes: [{ operation: 'modify', path: '/work/a.ts', fileType: 'text', mimeType: 'text/typescript' }], patch },
          { type: 'content', content: text('between') },
          { type: 'diff', changes: [
            { operation: 'add', path: '/work/new.ts' },
            { operation: 'delete', path: '/work/old.ts', fileType: null },
            { operation: 'move', oldPath: '/work/from.png', path: '/work/to.png', fileType: 'binary', mimeType: 'image/png' },
            { operation: 'copy', oldPath: '/work/src', path: '/work/dst', fileType: 'directory' },
            { operation: 'modify', path: '/work/link', fileType: 'symlink' },
          ] },
        ] }],
        ['s1', { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c1', content: {
          type: 'diff', changes: [{ operation: 'modify', path: '/work/b.ts' }], patch: { format: 'unified', text: '@@ -1 +1 @@' },
        } }],
      )).toEqual([
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: reported }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: [
          ...reported,
          { kind: 'diff', diff: { kind: 'changes', changes: [
            { operation: 'modify', path: '/work/b.ts', fileType: null, mimeType: null },
          ], patch: { format: 'other', text: '@@ -1 +1 @@' } } },
        ] }],
      ]);
    });

    it("keeps a tool call's terminals among its content, by ID, in the order reported", async () => {
      expect(await updatesFor({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [
        { type: 'terminal', terminalId: 'build' },
        { type: 'content', content: text('between') },
        { type: 'terminal', terminalId: 'test' },
      ] })).toEqual([{ kind: 'toolCall', toolCallId: 'c1', content: [
        { kind: 'terminal', terminalId: 'build' },
        { kind: 'text', text: 'between' },
        { kind: 'terminal', terminalId: 'test' },
      ] }]);
    });

    it("passes on a terminal's updates as reported, a field left out, cleared or given, its output decoded from base64", async () => {
      const output = Buffer.from('café\r\n');
      expect(await updatesFor(
        { sessionUpdate: 'terminal_update', terminalId: 't1', command: 'npm test', cwd: '/work', output: { data: output.toString('base64') } },
        { sessionUpdate: 'terminal_update', terminalId: 't1', exitStatus: { exitCode: 1 } },
        { sessionUpdate: 'terminal_update', terminalId: 't2' },
        { sessionUpdate: 'terminal_update', terminalId: 't2', command: null, cwd: null, output: null, exitStatus: null },
        { sessionUpdate: 'terminal_update', terminalId: 't2', exitStatus: { signal: 'SIGTERM' } },
        { sessionUpdate: 'terminal_update', terminalId: 't2', exitStatus: {} },
      )).toEqual([
        { kind: 'terminal', terminalId: 't1', command: 'npm test', cwd: '/work', output: new Uint8Array(output) },
        { kind: 'terminal', terminalId: 't1', exitStatus: { exitCode: 1, signal: null } },
        { kind: 'terminal', terminalId: 't2' },
        { kind: 'terminal', terminalId: 't2', command: null, cwd: null, output: null, exitStatus: null },
        { kind: 'terminal', terminalId: 't2', exitStatus: { exitCode: null, signal: 'SIGTERM' } },
        { kind: 'terminal', terminalId: 't2', exitStatus: { exitCode: null, signal: null } },
      ]);
    });

    it("passes on a terminal's output chunks as their bytes, each decoded alone, even with a character split between them", async () => {
      const [first, second] = [Buffer.from('caf\xc3', 'latin1'), Buffer.from('\xa9\n', 'latin1')];
      expect(await passedUp(
        ['s1', { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: first.toString('base64') }],
        ['s2', { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: second.toString('base64') }],
      )).toEqual([
        ['s1', { kind: 'terminalOutput', terminalId: 't1', data: new Uint8Array(first) }],
        ['s2', { kind: 'terminalOutput', terminalId: 't1', data: new Uint8Array(second) }],
      ]);
    });

    it('drops the changes ACP defines no fields for, a diff left with none, and calls a file type it does not know other', async () => {
      const custom = { operation: '_chmod', path: '/work/run.sh' } as V2.DiffChange;
      const future = { operation: 'truncate', path: '/work/log' } as V2.DiffChange;
      expect(await passedUp(
        ['s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [
          { type: 'diff', changes: [custom, { operation: 'modify', path: '/work/sock', fileType: 'socket' }] },
          { type: 'diff', changes: [future], patch: { format: 'git_patch', text: '' } },
        ] }],
      )).toEqual([
        ['s1', { kind: 'toolCall', toolCallId: 'c1', content: [
          { kind: 'diff', diff: { kind: 'changes', changes: [{ operation: 'modify', path: '/work/sock', fileType: 'other', mimeType: null }], patch: null } },
        ] }],
      ]);
    });

    describe("a git_patch naming files with Git's a/ and b/ prefixes, which ACP forbids (ACP-DEV-001)", () => {
      /** What the driver passes up as the patch of each diff sent, and the warnings it logs meanwhile. */
      async function repaired(...patches: string[]): Promise<{ patches: unknown[]; warnings: string[] }> {
        const warnings: string[] = [];
        setLogSink({ trace() {}, debug() {}, info() {}, warn: (message) => warnings.push(message), error() {} });
        try {
          const updates = await updatesFor(...patches.map((patchText, index): V2.SessionUpdate => ({
            sessionUpdate: 'tool_call_update',
            toolCallId: `c${index + 1}`,
            content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/work/a.ts' }], patch: { format: 'git_patch', text: patchText } }],
          })));
          const passed = updates.map((update) => (update.kind === 'toolCall' && update.content?.[0]?.kind === 'diff' && update.content[0].diff.kind === 'changes' ? update.content[0].diff.patch?.text : undefined));
          return { patches: passed, warnings };
        } finally {
          setLogSink(undefined);
        }
      }

      it("takes the prefixes off the names, leaving the hunks' lines that read like names, and warns each time", async () => {
        // Codex's preview, from the live check of 0.3.10-dev.0, trimmed; the second hunk, whose counts Git leaves out as
        // each is 1, holds lines that read like names.
        const sent = [
          'diff --git a/home/me/tmp/scratch2.py b/home/me/tmp/scratch2.py',
          '--- a/home/me/tmp/scratch2.py',
          '+++ b/home/me/tmp/scratch2.py',
          '@@ -1 +1,3 @@',
          '+import argparse',
          '+',
          ' def _validate_n(n: int) -> int:',
          '@@ -29 +31 @@',
          '--- a/notes.md',
          '+++ b/notes.md',
          '',
        ].join('\n');

        expect(await repaired(sent, sent)).toEqual({
          patches: Array(2).fill([
            'diff --git /home/me/tmp/scratch2.py /home/me/tmp/scratch2.py',
            '--- /home/me/tmp/scratch2.py',
            '+++ /home/me/tmp/scratch2.py',
            '@@ -1 +1,3 @@',
            '+import argparse',
            '+',
            ' def _validate_n(n: int) -> int:',
            '@@ -29 +31 @@',
            '--- a/notes.md',
            '+++ b/notes.md',
            '',
          ].join('\n')),
          warnings: ['c1', 'c2'].map(
            (id) => `ACP-DEV-001, deviating from the ACP standard in tool call ${id}'s patch: a v2 git_patch names files with Git's a/ and b/ prefixes, which ACP forbids, as its paths must be absolute; the prefixes are removed, leaving the absolute paths`,
          ),
        });
      });

      it('takes them off quoted names, a deleted file, a rename, and a name holding " b/" itself', async () => {
        const sent = [
          'diff --git "a/work/tab\\there.ts" "b/work/tab\\there.ts"',
          '--- "a/work/tab\\there.ts"',
          '+++ "b/work/tab\\there.ts"',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          'diff --git a/work/gone.ts b/work/gone.ts',
          'deleted file mode 100644',
          '--- a/work/gone.ts',
          '+++ /dev/null',
          '@@ -1 +0,0 @@',
          '-bye',
          'diff --git a/work/old.ts b/work/new.ts',
          'similarity index 100%',
          'rename from /work/old.ts',
          'rename to /work/new.ts',
          'diff --git a/work/my b/x.ts b/work/my b/x.ts',
          '--- a/work/my b/x.ts',
          '+++ b/work/my b/x.ts',
          '@@ -1 +1 @@',
          '-c',
          '+d',
          '',
        ].join('\n');

        const { patches } = await repaired(sent);

        expect(patches).toEqual([[
          'diff --git "/work/tab\\there.ts" "/work/tab\\there.ts"',
          '--- "/work/tab\\there.ts"',
          '+++ "/work/tab\\there.ts"',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          'diff --git /work/gone.ts /work/gone.ts',
          'deleted file mode 100644',
          '--- /work/gone.ts',
          '+++ /dev/null',
          '@@ -1 +0,0 @@',
          '-bye',
          'diff --git /work/old.ts /work/new.ts',
          'similarity index 100%',
          'rename from /work/old.ts',
          'rename to /work/new.ts',
          'diff --git /work/my b/x.ts /work/my b/x.ts',
          '--- /work/my b/x.ts',
          '+++ /work/my b/x.ts',
          '@@ -1 +1 @@',
          '-c',
          '+d',
          '',
        ].join('\n')]);
      });

      it('passes a patch with absolute names on as sent, warning nothing, even where a name holds " b/"', async () => {
        const sent = [
          'diff --git /work/my b/x.ts /work/my b/x.ts',
          '--- /work/my b/x.ts',
          '+++ /work/my b/x.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          'diff --git /work/my b/y.ts /work/z.ts',
          'similarity index 100%',
          'rename from /work/my b/y.ts',
          'rename to /work/z.ts',
          '',
        ].join('\n');

        expect(await repaired(sent)).toEqual({ patches: [sent], warnings: [] });
      });
    });

    it.each([
      ['pending', 'pending'],
      ['in_progress', 'running'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
      ['_vendor_paused', undefined],
    ] as const)('shows a tool call reported %s as %s', async (status, expected) => {
      const [update] = await updatesFor({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status });
      expect(update).toEqual({ kind: 'toolCall', toolCallId: 'c1', ...(expected ? { status: expected } : {}) });
    });

    it.each([
      ['execute', 'execute'],
      ['read', 'read'],
      ['switch_mode', 'switch_mode'],
      ['other', 'other'],
      ['_vendor_deploy', 'other'],
      [null, 'other'],
      [undefined, undefined],
    ] as const)("passes on a tool call's kind %s as %s", async (kind, expected) => {
      const [update] = await updatesFor({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', ...(kind !== undefined ? { kind } : {}) });
      expect(update).toEqual({ kind: 'toolCall', toolCallId: 'c1', ...(expected ? { toolKind: expected } : {}) });
    });

    it('passes up a plan of items, showing a cancelled or unknown step as not done, and drops plans of another type', async () => {
      const entry = (content: string, status: V2.PlanEntryStatus): V2.PlanEntry => ({ content, priority: 'medium', status });
      expect(await updatesFor(
        { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: [
          entry('Read', 'completed'), entry('Fix', 'in_progress'), entry('Test', 'pending'), entry('Ship', 'cancelled'), entry('Party', '_vendor_later'),
        ] } },
        { sessionUpdate: 'plan_update', plan: { type: '_vendor_graph', planId: 'p2' } },
      )).toEqual([
        { kind: 'plan', steps: [
          { text: 'Read', status: 'completed' },
          { text: 'Fix', status: 'running' },
          { text: 'Test', status: 'pending' },
          { text: 'Ship', status: 'pending' },
          { text: 'Party', status: 'pending' },
        ] },
      ]);
    });

    it("passes up the session's commands, config options and info, and drops the updates the interface has no place for", async () => {
      expect(await updatesFor(
        { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'web', description: 'Search the web', input: { type: 'text', hint: '' } }] },
        { sessionUpdate: 'config_option_update', configOptions: [modelOption] },
        { sessionUpdate: 'session_info_update', title: 'Fix the build', updatedAt: null },
        { sessionUpdate: 'session_info_update' },
        { sessionUpdate: '_vendor_usage', tokens: 3 },
      )).toEqual([
        { kind: 'commands', commands: [{ name: 'web', description: 'Search the web', takesInput: true, hint: null }] },
        { kind: 'configOptions', options: [expect.objectContaining({ id: 'model', current: 'a' })] },
        { kind: 'sessionInfo', title: 'Fix the build', updatedAt: null },
        { kind: 'sessionInfo' },
      ]);
    });
  });

  describe('permission requests', () => {
    const allow: V2.PermissionOption = { optionId: 'allow', name: 'Allow', kind: 'allow_once' };
    const reject: V2.PermissionOption = { optionId: 'reject', name: 'Reject', kind: 'reject_always' };

    /** The requests the driver asks the user, and the agent's answers, for those the agent sends while creating a session. */
    async function asked(answers: PermissionOutcome[], ...sent: Omit<V2.RequestPermissionRequest, 'sessionId'>[]) {
      const requestPermission = vi.fn<ClientHandlers['permissions']['requestPermission']>();
      for (const answer of answers) {
        requestPermission.mockResolvedValueOnce(answer);
      }
      const received: V2.RequestPermissionResponse[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
        for (const request of sent) {
          received.push(await client.request(V2.methods.client.session.requestPermission, { sessionId: 's1', ...request }));
        }
        return { sessionId: 's1' };
      }), { permissions: { requestPermission, cancelSession: vi.fn() } });
      await driver.newSession('/work');
      return { requests: requestPermission.mock.calls.map(([request]) => request), received };
    }

    it('asks with the title, what the request is about, why and the options offered, and answers with the choice', async () => {
      const { requests, received } = await asked(
        [{ kind: 'selected', optionId: 'allow' }, { kind: 'cancelled' }],
        {
          title: 'Make edits?',
          description: 'To fix the build',
          subject: { type: 'tool_call', toolCall: { toolCallId: 'c1', title: 'Edit a.ts' } },
          options: [allow, reject],
        },
        { title: 'Continue with elevated permissions?', options: [allow] },
      );

      expect(requests).toEqual([
        {
          sessionId: 's1',
          title: 'Make edits?',
          description: 'To fix the build',
          subject: 'Edit a.ts',
          options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'reject', name: 'Reject', kind: 'reject_always' }],
        },
        { sessionId: 's1', title: 'Continue with elevated permissions?', description: null, subject: null, options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }] },
      ]);
      expect(received).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow' } }, { outcome: { outcome: 'cancelled' } }]);
    });

    it.each([
      ['a tool call', 'Run npm test', { type: 'tool_call', toolCall: { toolCallId: 'c1', title: 'Run npm test' } }],
      ['a tool call without a title', null, { type: 'tool_call', toolCall: { toolCallId: 'c1' } }],
      ['a command', 'npm test in /work/project', { type: 'command', command: 'npm test', cwd: '/work/project', toolCallId: 'c1' }],
      ['a subject of a type it added', null, { type: '_vendor_network', host: 'example.com' }],
    ] as const)('names %s as %s', async (_, expected, subject) => {
      const { requests } = await asked([{ kind: 'cancelled' }], { title: 'Run command?', subject, options: [allow] });
      expect(requests[0]?.subject).toBe(expected);
    });

    it('offers an option of a kind the agent added as neither allowing nor rejecting', async () => {
      const { requests } = await asked([{ kind: 'cancelled' }], {
        title: 'Run command?',
        options: [allow, { optionId: 'sandbox', name: 'Run in the sandbox', kind: '_vendor_sandboxed' }],
      });
      expect(requests[0]?.options).toEqual([{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'sandbox', name: 'Run in the sandbox', kind: 'other' }]);
    });

    it('returns the SDK request-cancelled error when permission UI is dismissed without reject-once', async () => {
      let permissionStarted!: () => void;
      const started = new Promise<void>((resolve) => { permissionStarted = resolve; });
      const cancellation = new AbortController();
      const permissions = new PermissionRequests({
        autoApprove: () => 'ask',
        choose: (_prompt, _options, signal) => new Promise((resolve) => {
          permissionStarted();
          signal.addEventListener('abort', () => resolve(undefined), { once: true });
        }),
      });
      const received: unknown[] = [];
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
        const response = client.request(V2.methods.client.session.requestPermission, {
          sessionId: 's1',
          title: 'Run command?',
          options: [allow],
        }, { cancellationSignal: cancellation.signal }).catch((error: unknown) => error);
        await started;
        cancellation.abort();
        received.push(await response);
        return { sessionId: 's1' };
      }), { permissions });

      await driver.newSession('/work');

      expect(received).toEqual([expect.objectContaining({ code: -32800 })]);
    });

    it('notifies the agent before resolving its pending permission request as cancelled', async () => {
      const events: string[] = [];
      let resolvePermission!: (outcome: PermissionOutcome) => void;
      let permissionStarted!: () => void;
      const started = new Promise<void>((resolve) => { permissionStarted = resolve; });
      const requestPermission = vi.fn<ClientHandlers['permissions']['requestPermission']>(() => new Promise((resolve) => {
        resolvePermission = resolve;
        permissionStarted();
      }));
      const cancelSession = vi.fn<ClientHandlers['permissions']['cancelSession']>(() => {
        events.push('cancel-pending-permissions');
        resolvePermission({ kind: 'cancelled' });
      });
      const { driver } = await connectedDriver(() => fakeV2Agent()
        .onRequest(V2.methods.agent.session.new, async ({ client }) => {
          const response = await client.request(V2.methods.client.session.requestPermission, {
            sessionId: 's1', title: 'Run command?', options: [allow],
          });
          events.push(`permission:${response.outcome.outcome}`);
          return { sessionId: 's1' };
        })
        .onNotification(V2.methods.agent.session.cancel, () => { events.push('session-cancel'); }), {
        permissions: { requestPermission, cancelSession },
      });
      const session = driver.newSession('/work');

      await started;
      await driver.cancel('s1');
      await session;

      expect(events).toEqual(['session-cancel', 'cancel-pending-permissions', 'permission:cancelled']);
      expect(cancelSession).toHaveBeenCalledExactlyOnceWith('s1');
    });
  });

  describe('elicitation', () => {
    it('answers an elicitation with method not found', async () => {
      let answered: (outcome: unknown) => void = () => {};
      const answer = new Promise<unknown>((resolve) => { answered = resolve; });
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
        answered(await client.request(V2.methods.client.elicitation.create, {
          mode: 'url', sessionId: 's1', elicitationId: 'e1', url: 'https://example.com/login', message: 'Sign in',
        }).catch((e: unknown) => e));
        return { sessionId: 's1' };
      }));

      await driver.newSession('/work');

      expect(await answer).toHaveProperty('code', -32601);
    });
  });

  describe('errors', () => {
    /** An agent refusing every resume, replaying or not, with what `refusal` makes of the session asked for. */
    const refusing = (refusal: (sessionId: string) => V2.RequestError): AgentScript => () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.resume, ({ params }) => {
        throw refusal(params.sessionId);
      });

    it("reports the agent's refusal until the user authenticates as AuthRequired, with the agent's message", async () => {
      const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => {
        throw V2.RequestError.authRequired();
      }));

      const error = await driver.newSession('/work').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthRequired);
      expect(error).toHaveProperty('message', expect.stringContaining('Authentication required'));
    });

    it("reports a load or resume of a session the agent does not know, as ACP reports it, as UnknownSession with the agent's message", async () => {
      const { driver } = await connectedDriver(refusing((sessionId) => new V2.RequestError(-32002, 'Resource not found', { sessionId })));

      const loaded = await driver.loadSession('gone', '/work').catch((e: unknown) => e);
      const resumed = await driver.resumeSession('gone', '/work').catch((e: unknown) => e);

      expect(loaded).toBeInstanceOf(UnknownSession);
      expect(loaded).toHaveProperty('message', expect.stringContaining('Resource not found'));
      expect(resumed).toBeInstanceOf(UnknownSession);
    });

    it.each<[string, (sessionId: string) => V2.RequestError]>([
      ['a missing resource naming another session', () => new V2.RequestError(-32002, 'Resource not found', { sessionId: 'other' })],
      ['a missing resource naming no session', () => V2.RequestError.resourceNotFound('file:///work/missing')],
      ['a missing resource without data', () => new V2.RequestError(-32002, 'Resource not found')],
      ['invalid params whose message says the session was not found', (sessionId) => V2.RequestError.invalidParams(undefined, `Session not found: ${sessionId}`)],
      ['the session being in use by another client', () => V2.RequestError.invalidRequest(undefined, 'This session is in use by another client')],
      ['an internal error', () => V2.RequestError.internalError(undefined, 'disk full')],
    ])('reports a refusal with %s as it is, not as UnknownSession', async (_, refusal) => {
      const { driver } = await connectedDriver(refusing(refusal));

      const loaded = await driver.loadSession('gone', '/work').catch((e: unknown) => e);
      const resumed = await driver.resumeSession('gone', '/work').catch((e: unknown) => e);

      expect(loaded).toBeInstanceOf(V2.RequestError);
      expect(loaded).toHaveProperty('message', refusal('gone').message);
      expect(resumed).toBeInstanceOf(V2.RequestError);
    });
  });
});
