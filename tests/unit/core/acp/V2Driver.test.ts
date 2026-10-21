import { describe, expect, it, vi } from 'vitest';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { AuthRequired, UnknownSession, type ConfigOption, type PermissionOutcome, type PromptPart, type SessionUpdate } from '@/core/acp/AcpDriver';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { connectedV2Driver, fakeV2Agent, type V2AgentScript } from '@tests/unit/core/InProcessAgents';

const go: PromptPart[] = [{ kind: 'text', text: 'go' }];

function text(value: string, audience?: V2.Role[]): V2.ContentBlock {
  return { type: 'text', text: value, ...(audience ? { annotations: { audience } } : {}) };
}

function notify(client: V2.AgentContext, update: V2.SessionUpdate, sessionId = 's1'): Promise<void> {
  return client.notify(V2.methods.client.session.update, { sessionId, update });
}

/** The session updates the driver passes up, by session, for those the agent sends, by session, while creating a session. */
async function passedUp(...sent: [string, V2.SessionUpdate][]): Promise<[string, SessionUpdate][]> {
  const { driver, updates } = await connectedV2Driver(() => fakeV2Agent()
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
  const { driver, exit } = await connectedV2Driver(() => fakeV2Agent()
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
  const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's1', configOptions: options })));
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent({
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent({ info: { name: 'fake-agent', version: '1' }, capabilities: {} }));

      expect(driver.agent.displayName).toBe('fake-agent');
      expect(driver.agent.capabilities).toEqual({ list: false, load: false, resume: false });
    });
  });

  describe('sessions', () => {
    it('creates a session in the directory given, with no modes, and no config options or commands when it has none', async () => {
      const received: V2.NewSessionRequest[] = [];
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, ({ params }) => {
        received.push(params);
        return { sessionId: 's1' };
      }));

      expect(await driver.newSession('/work')).toEqual({ sessionId: 's1', modes: null, configOptions: null, commands: null });
      expect(received).toEqual([{ cwd: '/work' }]);
    });

    it('gives a session the commands the agent starts it with, with the hint a text input has', async () => {
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.list, ({ params }) => {
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.resume, ({ params }) => {
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.setConfigOption, ({ params }) => {
        received.push(params);
        return { configOptions: [{ ...modelOption, currentValue: 'b' }] };
      }));

      const options = await driver.setConfigOption('s1', 'model', 'b');

      expect(received).toEqual([{ sessionId: 's1', configId: 'model', type: 'id', value: 'b' }]);
      expect(options).toEqual([expect.objectContaining({ id: 'model', current: 'b' })]);
    });

    it('has no modes to set', async () => {
      const { driver } = await connectedV2Driver(() => fakeV2Agent());

      await expect(driver.setMode('s1', 'code')).rejects.toThrow('ACP v2 sessions have no modes');
    });

    it('logs in with the method chosen, and cancels a session', async () => {
      const logins: V2.LoginAuthRequest[] = [];
      let cancelled: (sessionId: string) => void = () => {};
      const cancel = new Promise<string>((resolve) => { cancelled = resolve; });
      const { driver } = await connectedV2Driver(() => fakeV2Agent()
        .onRequest(V2.methods.agent.auth.login, ({ params }) => { logins.push(params); })
        .onNotification(V2.methods.agent.session.cancel, ({ params }) => cancelled(params.sessionId)));

      await driver.authenticate('token');
      await driver.cancel('s1');

      expect(logins).toEqual([{ methodId: 'token' }]);
      expect(await cancel).toBe('s1');
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.prompt, async ({ params, client }) => {
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

      agent.exit();

      expect(await outcome).toEqual(new Error('The connection to the agent closed before the turn ended'));
      expect(agent.driver.closed).toBe(true);
    });

    it('fails a prompt the agent refuses with its error, leaving nothing to fail when the connection closes', async () => {
      const { driver, exit } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.prompt, () => {
        throw V2.RequestError.internalError(undefined, 'Too many prompts');
      }));

      const refused = await outcomeOf(driver.prompt('s1', go));
      exit();
      await new Promise((resolve) => setImmediate(resolve));

      expect(refused).toHaveProperty('message', expect.stringContaining('Too many prompts'));
      expect(driver.closed).toBe(true);
    });
  });

  describe('session updates', () => {
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
      const { driver, updates } = await connectedV2Driver(() => fakeV2Agent()
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
        ['s1', { kind: 'promptText', text: ' now' }],
      ];
      expect(updates).toEqual([...replay, ['s1', { kind: 'agentText', messageId: 'a1', text: 'Done' }], ...replay]);
    });

    it('passes up the prompts a load replays after a prompt the agent refused', async () => {
      const { driver, updates } = await connectedV2Driver(() => fakeV2Agent()
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

    it("keeps each tool call's texts, which an update's content replaces and a chunk adds to, and leaves alone what an update leaves out", async () => {
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
        ['s1', { kind: 'toolCall', toolCallId: 'c1', title: 'Read a.ts', status: 'running', texts: ['first'] }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', texts: ['first', 'second'] }],
        ['s2', { kind: 'toolCall', toolCallId: 'c1', texts: ['elsewhere'] }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', status: 'completed' }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', texts: ['replaced'] }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', texts: ['replaced', 'more'] }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', texts: [] }],
        ['s1', { kind: 'toolCall', toolCallId: 'c1', texts: ['again'] }],
      ]);
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
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
        for (const request of sent) {
          received.push(await client.request(V2.methods.client.session.requestPermission, { sessionId: 's1', ...request }));
        }
        return { sessionId: 's1' };
      }), { permissions: { requestPermission } });
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
  });

  describe('elicitation', () => {
    it('answers an elicitation with method not found', async () => {
      let answered: (outcome: unknown) => void = () => {};
      const answer = new Promise<unknown>((resolve) => { answered = resolve; });
      const { driver } = await connectedV2Driver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
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
    const failing: V2AgentScript = () => fakeV2Agent()
      .onRequest(V2.methods.agent.session.new, () => {
        throw V2.RequestError.authRequired();
      })
      .onRequest(V2.methods.agent.session.resume, ({ params }) => {
        if (params.replayFrom) {
          throw new V2.RequestError(-32002, `Session not found: ${params.sessionId}`);
        }
        throw V2.RequestError.internalError(undefined, 'disk full');
      });

    it("reports the agent's refusal until the user authenticates as AuthRequired, with the agent's message", async () => {
      const { driver } = await connectedV2Driver(failing);

      const error = await driver.newSession('/work').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthRequired);
      expect(error).toHaveProperty('message', expect.stringContaining('Authentication required'));
    });

    it('reports a session the agent does not know as UnknownSession, and other failures as they are', async () => {
      const { driver } = await connectedV2Driver(failing);

      const unknown = await driver.loadSession('gone', '/work').catch((e: unknown) => e);
      const other = await driver.resumeSession('old', '/work').catch((e: unknown) => e);

      expect(unknown).toBeInstanceOf(UnknownSession);
      expect(unknown).toHaveProperty('message', expect.stringContaining('Session not found: gone'));
      expect(other).not.toBeInstanceOf(UnknownSession);
      expect(other).toHaveProperty('message', expect.stringContaining('disk full'));
    });
  });
});
