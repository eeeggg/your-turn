import { describe, expect, it, vi } from 'vitest';
import { agent, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentContext, InitializeRequest } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { connectedDriver, fakeAgent, InProcessAgents } from '@tests/unit/core/InProcessAgents';

function handlers() {
  return {
    permissions: {
      requestPermission: vi.fn<ClientHandlers['permissions']['requestPermission']>(async () => ({ kind: 'cancelled' as const })),
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
  const prompt = () => driver.prompt('s1', [{ kind: 'text', text: 'go' }]);
  return { handlers: set, updates, prompt };
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
    const { handlers: set, prompt } = await connectWith(async (client) => {
      answers.push(await client.request(methods.client.session.requestPermission, {
        sessionId: 's1',
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
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      });
    });

    await prompt();

    expect(updates).toEqual([['s1', { kind: 'agentText', messageId: null, text: 'hello' }]]);
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
