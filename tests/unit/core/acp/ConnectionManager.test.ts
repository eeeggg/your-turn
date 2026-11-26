import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods } from '@agentclientprotocol/sdk';
import type { AgentContext } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { PermissionRequests } from '@/core/PermissionRequests';
import { connectedDriver, fakeAgent, InProcessAgents } from '@tests/unit/core/InProcessAgents';
import type { AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';

const SESSION_ID = '8b22e365-3d6d-4aa5-ad43-162c3f3b6299';

function handlers() {
  return {
    permissions: {
      requestPermission: vi.fn<ClientHandlers['permissions']['requestPermission']>(async () => ({ kind: 'cancelled' as const })),
      cancelSession: vi.fn<ClientHandlers['permissions']['cancelSession']>(),
    },
  } satisfies ClientHandlers;
}

/** Connect to an agent whose `session/prompt` runs `work` against the client, then ends the turn. */
async function connectWith(work: (client: AgentContext) => Promise<void>) {
  const set = handlers();
  const { driver, updates } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
    await work(client);
    return { stopReason: 'end_turn' };
  }), set);
  const prompt = () => driver.prompt(SESSION_ID, [{ kind: 'text', text: 'go' }]);
  return { handlers: set, updates, prompt };
}

async function connectWire(version: 1 | 2, ending?: 'EOF' | 'read failure') {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let failOnRead = false;
  let pending = '';
  let acceptPrompt: (() => void) | undefined;
  let promptReceived!: () => void;
  const prompting = new Promise<void>((resolve) => { promptReceived = resolve; });
  const notifications = Array.from({ length: 20 }, (_, index) => ({
    jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update: {
      sessionUpdate: 'agent_message_chunk', ...(version === 2 ? { messageId: 'answer' } : {}),
      content: { type: 'text', text: `chunk ${index}` },
    } },
  }));
  const send = (...messages: unknown[]) => { output.enqueue(encoder.encode(messages.map((message) => JSON.stringify(message)).join('\n') + '\n')); };
  const close = () => { if (!ended) { ended = true; output.close(); } };
  const seen: (string | [AcpSchema, string, string])[] = [];
  const foreground: SessionUpdate[] = [];
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const streams = {
    output: new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      pull(controller) {
        if (failOnRead) { ended = true; controller.error(new Error('Agent output read failed')); }
      },
      cancel() { ended = true; },
    }),
    input: new WritableStream<Uint8Array>({
      write(bytes) {
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const { id, method } = JSON.parse(line) as { id: unknown; method: unknown };
          switch (method) {
            case 'initialize':
              send({ jsonrpc: '2.0', id, result: version === 1 ? { protocolVersion: 1 }
                : { protocolVersion: 2, info: { name: 'wire-agent', version: 'test' }, capabilities: { session: {} } } });
              break;
            case 'session/load':
            case 'session/resume':
              expect(method).toBe(version === 1 ? 'session/load' : 'session/resume');
              send(...notifications, { jsonrpc: '2.0', id, result: {} });
              break;
            case 'session/prompt':
              expect(version).toBe(2);
              acceptPrompt = () => send({ jsonrpc: '2.0', id, result: { messageId: 'prompt' } });
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID,
                update: { sessionUpdate: 'state_update', state: 'running' } } });
              promptReceived();
              break;
            case 'session/cancel':
              if (!acceptPrompt) { throw new Error('No prompt to cancel'); }
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID,
                update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' } } });
              acceptPrompt();
              acceptPrompt = undefined;
              break;
            default: throw new Error(`Unexpected wire message: ${line}`);
          }
        }
      },
    }),
  };
  const manager = new ConnectionManager('0.0.0-test', handlers);
  const connecting = manager.connect('fake', streams, 'wire', {
    handleUpdate(sessionId, update, schema) {
      if (update.kind === 'agentText') { seen.push([schema, sessionId, update.text]); }
      if (update.kind === 'foreground') { foreground.push(update); }
    },
  }, () => { seen.push('closed'); markClosed(); });
  onTestFinished(async () => { close(); await closed; });
  const driver = await connecting;
  const expected = notifications.map(({ params }) => [version === 1 ? 'v1' : 'v2', SESSION_ID, params.update.content.text]);
  return { driver, seen, closed, expected, foreground, prompting, finish() {
    failOnRead = ending === 'read failure';
    send(...notifications);
    if (ending === 'EOF') { close(); }
  } };
}

describe('ConnectionManager', () => {
  describe.each([1, 2] as const)('ACP v%s over NDJSON', (version) => {
    it.each(['EOF', 'read failure'] as const)('delivers queued notifications before cleanup on %s', async (ending) => {
      const wire = await connectWire(version, ending);
      wire.finish();
      await wire.closed;
      expect(wire.seen).toEqual([...wire.expected, 'closed']);
    });

    it('delivers replay output before Load consumes its response', async () => {
      const wire = await connectWire(version);
      await wire.driver.loadSession(SESSION_ID, { cwd: '/work', additionalDirectories: [] });
      expect(wire.seen).toEqual(wire.expected);
    });
  });

  it('settles a v2 prompt when Stop produces idle before the prompt response over NDJSON', async () => {
    const wire = await connectWire(2);
    const result = expect(wire.driver.prompt(SESSION_ID, [{ kind: 'text', text: 'go' }])).resolves.toEqual({ stopReason: 'cancelled' });
    await wire.prompting;
    await wire.driver.cancel(SESSION_ID);
    await result;
    expect(wire.foreground).toEqual([
      { kind: 'foreground', state: 'running' },
      { kind: 'foreground', state: 'idle', outcome: 'cancelled' },
    ]);
  });

  it.each([false, true])('attaches observation before initialization and releases it on closure (initialization fails: %s)', async (fails) => {
    const seen: string[] = [];
    let detached = 0;
    const permissions = new PermissionRequests({ autoApprove: () => 'allowAll', choose: async () => undefined });
    let released!: () => void;
    const closed = new Promise<void>((resolve) => { released = resolve; });
    const agents = new InProcessAgents({ fake: () => agent({ name: 'fake' }).onRequest(methods.agent.initialize, () => {
      seen.push('initialize');
      if (fails) { throw new Error('Initialization refused'); }
      return { protocolVersion: 1, agentInfo: { name: 'fake', version: 'test' } };
    }).onRequest(methods.agent.session.new, async ({ client }) => {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId: SESSION_ID, toolCall: { toolCallId: 'opening' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      return { sessionId: SESSION_ID };
    }) });
    const manager = new ConnectionManager('0.0.0-test', () => ({ permissions, permissionInteractions: permissions }));
    const process = agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit() {} });
    const connecting = manager.connect('fake', process, process.id, { handleUpdate() {} }, undefined, {
      observeRequests: ({ agentName, agentId, permissions, elicitations }) => {
        expect([agentName, agentId]).toEqual(['fake', process.id]);
        expect(elicitations.snapshot()).toEqual([]);
        seen.push('attached');
        const stop = permissions?.subscribe(() => { seen.push(`permissions:${permissions.snapshot().length}`); });
        return () => { stop?.(); detached++; released(); };
      },
    });
    if (fails) { await expect(connecting).rejects.toThrow(); }
    else {
      const driver = await connecting;
      await driver.newSession({ cwd: '/work', additionalDirectories: [] });
      await agents.launched[0]?.crash();
    }
    expect(seen[0]).toBe('attached');
    await closed;
    expect(seen).toEqual(['attached', 'initialize', 'initialize', ...(fails ? [] : ['permissions:1', 'permissions:0'])]);
    expect(detached).toBe(1);
  });

  it('answers file and terminal requests as unknown methods', async () => {
    const answers: unknown[] = [];
    const { prompt } = await connectWith(async (client) => {
      answers.push(await client.request(methods.client.fs.readTextFile, { sessionId: SESSION_ID, path: '/work/a.ts' }).catch((e: unknown) => e));
      answers.push(await client.request(methods.client.terminal.create, { sessionId: SESSION_ID, command: 'ls' }).catch((e: unknown) => e));
    });

    await prompt();

    expect(answers).toEqual([
      expect.objectContaining({ code: -32601 }),
      expect.objectContaining({ code: -32601 }),
    ]);
  });

  it("routes the agent's permission requests to the connection's handlers", async () => {
    const answers: unknown[] = [];
    const { handlers: set, prompt } = await connectWith(async (client) => {
      answers.push(await client.request(methods.client.session.requestPermission, {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: 'c1' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      }));
    });

    await prompt();

    expect(set.permissions.requestPermission).toHaveBeenCalledOnce();
    expect(answers).toEqual([{ outcome: { outcome: 'cancelled' } }]);
  });

  it('passes session updates to the session update handler', async () => {
    const { updates, prompt } = await connectWith(async (client) => {
      await client.notify(methods.client.session.update, {
        sessionId: SESSION_ID,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      });
    });

    await prompt();

    expect(updates).toEqual([[SESSION_ID, { kind: 'agentText', messageId: null, text: 'hello' }]]);
  });

  it('gives each connection its own handlers', async () => {
    const agents = new InProcessAgents({ one: () => fakeAgent(), two: () => fakeAgent() });
    const createHandlers = vi.fn(handlers);
    const manager = new ConnectionManager('0.0.0-test', createHandlers);

    for (const name of ['one', 'two']) {
      const process = agents.launch(name, { command: name }, '/work', { error() {}, exit() {} });
      await manager.connect(name, process, process.id, { handleUpdate() {} });
    }

    expect(createHandlers).toHaveBeenCalledTimes(2);
  });
});
