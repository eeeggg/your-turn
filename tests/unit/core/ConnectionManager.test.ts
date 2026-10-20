import { describe, expect, it, vi } from 'vitest';
import { agent, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentContext, InitializeRequest, SessionNotification } from '@agentclientprotocol/sdk';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { ConnectionManager } from '@/core/ConnectionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { fakeAgent, InProcessAgents } from './InProcessAgents';

function handlers() {
  return {
    permissions: {
      requestPermission: vi.fn<ClientHandlers['permissions']['requestPermission']>(async () => ({ outcome: { outcome: 'cancelled' as const } })),
    },
  } satisfies ClientHandlers;
}

/** Connect to an agent whose `session/prompt` runs `work` against the client, then ends the turn. */
async function connectWith(work: (client: AgentContext) => Promise<void>) {
  const agents = new InProcessAgents({
    fake: () => fakeAgent().onRequest(methods.agent.session.prompt, async ({ client }) => {
      await work(client);
      return { stopReason: 'end_turn' };
    }),
  });
  const updates = new SessionUpdateHandler();
  const received: SessionNotification[] = [];
  updates.addListener((n) => received.push(n));
  const handlerSets: ReturnType<typeof handlers>[] = [];
  const manager = new ConnectionManager(updates, '0.0.0-test', () => {
    const set = handlers();
    handlerSets.push(set);
    return set;
  });
  const agentProcess = agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit() {} });
  const { connection, initResponse } = await manager.connect('fake', agentProcess);
  const prompt = () => connection.agent.request(methods.agent.session.prompt, {
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'go' }],
  });
  return { agents, connection, initResponse, handlerSets, received, prompt };
}

describe('ConnectionManager', () => {
  it('initializes with the client version, offering the agent no file access or terminals', async () => {
    const initialize = vi.fn<(params: InitializeRequest) => void>();
    const agents = new InProcessAgents({
      fake: () => agent({ name: 'bare-agent' }).onRequest(methods.agent.initialize, ({ params }) => {
        initialize(params);
        return { protocolVersion: params.protocolVersion };
      }),
    });
    const manager = new ConnectionManager(new SessionUpdateHandler(), '1.2.3', handlers);

    await manager.connect('fake', agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit() {} }));

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0]?.[0]).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'vscode-acp-client', version: '1.2.3' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
    });
  });

  it('answers file and terminal requests as unknown methods', async () => {
    const answers: unknown[] = [];
    const { prompt } = await connectWith(async (client) => {
      answers.push(await client.request(methods.client.fs.readTextFile, { sessionId: 's1', path: '/work/a.ts' }).catch((e: unknown) => e));
      answers.push(await client.request(methods.client.terminal.create, { sessionId: 's1', command: 'ls' }).catch((e: unknown) => e));
    });

    await prompt();

    expect(answers).toEqual([
      expect.objectContaining({ code: -32601 }),
      expect.objectContaining({ code: -32601 }),
    ]);
  });

  it("routes the agent's permission requests to the connection's handlers", async () => {
    const answers: unknown[] = [];
    const { handlerSets, prompt } = await connectWith(async (client) => {
      answers.push(await client.request(methods.client.session.requestPermission, {
        sessionId: 's1',
        toolCall: { toolCallId: 'c1' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      }));
    });

    await prompt();

    expect(handlerSets[0]?.permissions.requestPermission).toHaveBeenCalledOnce();
    expect(answers).toEqual([{ outcome: { outcome: 'cancelled' } }]);
  });

  it('passes session updates to the session update handler', async () => {
    const { received, prompt } = await connectWith(async (client) => {
      await client.notify(methods.client.session.update, {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      });
    });

    await prompt();

    expect(received).toEqual([{
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    }]);
  });

  it('gives each connection its own handlers', async () => {
    const agents = new InProcessAgents({ one: () => fakeAgent(), two: () => fakeAgent() });
    const createHandlers = vi.fn(handlers);
    const manager = new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', createHandlers);

    for (const name of ['one', 'two']) {
      await manager.connect(name, agents.launch(name, { command: name }, '/work', { error() {}, exit() {} }));
    }

    expect(createHandlers).toHaveBeenCalledTimes(2);
  });
});
