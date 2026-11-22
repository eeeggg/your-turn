import { describe, expect, it, vi } from 'vitest';
import { agent, methods } from '@agentclientprotocol/sdk';
import type { AgentContext } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { PermissionRequests } from '@/core/PermissionRequests';
import { connectedDriver, fakeAgent, InProcessAgents } from '@tests/unit/core/InProcessAgents';

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

describe('ConnectionManager', () => {
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
