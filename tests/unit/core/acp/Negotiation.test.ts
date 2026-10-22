import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { setLogSink } from '@/core/Log';
import { V1Driver, v1InitializeRequest } from '@/core/acp/V1Driver';
import { V2Driver, v2InitializeRequest } from '@/core/acp/V2Driver';
import { connectedDriver, fakeAgent, fakeV2Agent, type AgentScript } from '@tests/unit/core/InProcessAgents';

const v2Request = {
  protocolVersion: 2,
  info: { name: 'vscode-acp-client', version: '0.0.0-test' },
  capabilities: {},
};
const v1Request = {
  protocolVersion: 1,
  clientInfo: { name: 'vscode-acp-client', version: '0.0.0-test' },
  clientCapabilities: {},
};

/** An ACP v1 agent that refuses any `initialize` but one asking for 1, with `refusal`. */
function strictV1Agent(refusal: () => Error): AgentScript {
  return () => agent({ name: 'strict-agent' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      if (params.protocolVersion !== 1) {
        throw refusal();
      }
      return { protocolVersion: 1 };
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' }));
}

const unsupported = (...supported: number[]) => () => new RequestError(-32022, 'Unsupported protocol version', { requested: 2, supported });

describe('negotiation', () => {
  let sent: unknown[];

  beforeEach(() => {
    sent = [];
    setLogSink({ log() {}, warn() {}, error() {}, traffic: (direction, data) => { if (direction === 'send') { sent.push(data); } } });
  });

  afterEach(() => setLogSink(undefined));

  /** The params of each `initialize` sent to the agent. */
  const initializes = () => sent
    .filter((message): message is { method: string; params: unknown } =>
      typeof message === 'object' && message !== null && 'method' in message && message.method === 'initialize')
    .map((message) => message.params);

  it('speaks v1 with an agent that speaks only v1, which answers the request for v2', async () => {
    const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })));

    expect(driver).toBeInstanceOf(V1Driver);
    expect(initializes()).toEqual([v2Request]);
    expect(await driver.newSession('/work')).toMatchObject({ sessionId: 's1' });
  });

  it('speaks v2 with an agent that speaks only v2', async () => {
    const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's1' })));

    expect(driver).toBeInstanceOf(V2Driver);
    expect(initializes()).toEqual([v2Request]);
    expect(await driver.newSession('/work')).toMatchObject({ sessionId: 's1' });
  });

  it('speaks v2 with an agent that speaks both', async () => {
    const { driver } = await connectedDriver(() => V2.agentProtocolRouter()
      .withV1(fakeAgent())
      .withV2(fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's2' }))));

    expect(driver).toBeInstanceOf(V2Driver);
    expect(await driver.newSession('/work')).toMatchObject({ sessionId: 's2' });
  });

  it("speaks v1 with a v1 agent behind a router, which is told the client's name and offered no file access or terminals", async () => {
    let received: unknown;
    const { driver } = await connectedDriver(() => V2.agentProtocolRouter()
      .withV1(agent({ name: 'routed-agent' }).onRequest(methods.agent.initialize, ({ params }) => {
        received = params;
        return { protocolVersion: 1 };
      })));

    expect(driver).toBeInstanceOf(V1Driver);
    expect(received).toEqual({
      protocolVersion: 1,
      clientInfo: { name: 'vscode-acp-client', version: '0.0.0-test' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // What every v2 client supports, which the router offers for it.
        session: { configOptions: { boolean: {} } },
        auth: { terminal: false },
      },
    });
  });

  it.each([
    ['an invalid request', () => RequestError.invalidParams(undefined, 'Unknown field: info')],
    ['a -32022 listing 1', unsupported(1)],
  ])('follows up with v1 on the same connection when a v1 agent refuses the request for v2 with %s', async (_, refusal) => {
    const { driver } = await connectedDriver(strictV1Agent(refusal));

    expect(driver).toBeInstanceOf(V1Driver);
    expect(initializes()).toEqual([v2Request, v1Request]);
    expect(await driver.newSession('/work')).toMatchObject({ sessionId: 's1' });
  });

  it.each([
    [[3], 'Agent "fake" speaks ACP versions 3; this extension speaks versions 1 and 2'],
    [[2, 3], 'Agent "fake" speaks ACP versions 2, 3; this extension speaks versions 1 and 2'],
  ])('fails at once, naming the versions, when the agent refuses with a -32022 listing %j', async (supported, message) => {
    await expect(connectedDriver(strictV1Agent(unsupported(...supported)))).rejects.toThrow(message);

    expect(initializes()).toEqual([v2Request]);
  });

  it('fails with the agent\'s error when it refuses both versions', async () => {
    await expect(connectedDriver(() => agent({ name: 'refusing-agent' }).onRequest(methods.agent.initialize, ({ params }) => {
      throw RequestError.internalError(undefined, `will not speak ${params.protocolVersion}`);
    }))).rejects.toThrow('will not speak 1');

    expect(initializes()).toEqual([v2Request, v1Request]);
  });

  it('fails, naming the version, when the agent answers with a version the extension does not speak', async () => {
    await expect(connectedDriver(() => fakeAgent({ protocolVersion: 3 })))
      .rejects.toThrow('Agent "fake" answered initialize with ACP version 3; this extension speaks versions 1 and 2');
  });

  it('drops what the agent sends before it answers', async () => {
    const { driver, updates } = await connectedDriver(() => agent({ name: 'early-agent' })
      .onRequest(methods.agent.initialize, async ({ client }) => {
        await client.notify(methods.client.session.update, {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'early' } },
        });
        return { protocolVersion: 1 };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })));

    await driver.newSession('/work');

    expect(updates).toEqual([]);
  });

  it("sends each version's request saying the same thing, as the replay answers one with the other's answer", () => {
    const v1 = v1InitializeRequest('1.2.3');
    const v2 = v2InitializeRequest('1.2.3');

    expect([v1.protocolVersion, v2.protocolVersion]).toEqual([1, 2]);
    expect({ identity: v1.clientInfo, capabilities: v1.clientCapabilities }).toEqual({ identity: v2.info, capabilities: v2.capabilities });
  });
});
