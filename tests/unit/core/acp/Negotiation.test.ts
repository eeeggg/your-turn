import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { clearTraffic, getTrafficJsonl, setTrafficCaptureEnabled } from '@/core/Traffic';
import { setLogSink } from '@/core/Log';
import { V1Driver, v1InitializeRequest } from '@/core/acp/V1Driver';
import { V2Driver, v2InitializeRequest } from '@/core/acp/V2Driver';
import { connectedDriver, fakeAgent, fakeV2Agent, work, type AgentScript } from '@tests/unit/core/InProcessAgents';

const v2Request = {
  protocolVersion: 2,
  info: { name: 'vscode-acp-client', version: '0.0.0-test' },
  capabilities: {},
};
const v1Request = {
  protocolVersion: 1,
  clientInfo: { name: 'vscode-acp-client', version: '0.0.0-test' },
  clientCapabilities: { session: { compaction: {}, configOptions: { boolean: {} } } },
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
  beforeEach(() => {
    clearTraffic();
    setTrafficCaptureEnabled(true);
  });

  afterEach(() => {
    setLogSink(undefined);
    setTrafficCaptureEnabled(true);
    clearTraffic();
  });

  /** The params of each `initialize` sent to the agent. */
  const initializes = () => getTrafficJsonl().trimEnd().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; message: { method?: string; params?: unknown } })
    .filter((record) => record.direction === 'send' && record.message.method === 'initialize')
    .map((record) => record.message.params);

  it('speaks v1 with an agent that speaks only v1, which answers the request for v2', async () => {
    const { driver } = await connectedDriver(() => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })));

    expect(driver).toBeInstanceOf(V1Driver);
    expect(initializes()).toEqual([v2Request, v1Request]);
    expect(await driver.newSession(work)).toMatchObject({ sessionId: 's1' });
  });

  it('uses the second initialize response and delivers v1 capabilities before creating a session on the same connection', async () => {
    let launches = 0;
    let initialized = 0;
    let capabilities: unknown;
    const { driver } = await connectedDriver(() => {
      launches++;
      return agent({ name: 'downgrading-agent' })
        .onRequest(methods.agent.initialize, ({ params }) => {
          initialized++;
          capabilities = params.clientCapabilities;
          return {
            protocolVersion: 1,
            agentInfo: { name: initialized === 1 ? 'initial' : 'final', version: '1.0.0' },
            agentCapabilities: { loadSession: initialized === 2 },
          };
        })
        .onRequest(methods.agent.session.new, () => {
          return { sessionId: 's1' };
        });
    });

    expect(driver.agent.displayName).toBe('final');
    expect(driver.agent.capabilities.load).toBe(true);
    expect(initialized).toBe(2);
    expect(capabilities).toMatchObject({ session: { compaction: {}, configOptions: { boolean: {} } } });
    expect(await driver.newSession(work)).toMatchObject({ sessionId: 's1' });
    expect(initializes()).toEqual([v2Request, v1Request]);
    expect(launches).toBe(1);
  });

  it('reports rejection of repeated v1 initialization rather than claiming the capabilities were accepted', async () => {
    await expect(connectedDriver(() => agent({ name: 'legacy-agent' })
      .onRequest(methods.agent.initialize, ({ params }) => {
        if (params.protocolVersion === 1) {
          throw RequestError.invalidRequest(undefined, 'Repeated initialization is not supported');
        }
        return { protocolVersion: 1 };
      }))).rejects.toThrow('Repeated initialization is not supported');

    expect(initializes()).toEqual([v2Request, v1Request]);
  });

  it('speaks v2 with an agent that speaks only v2', async () => {
    const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's1' })));

    expect(driver).toBeInstanceOf(V2Driver);
    expect(initializes()).toEqual([v2Request]);
    expect(await driver.newSession(work)).toMatchObject({ sessionId: 's1' });
  });

  it('uses the v2 answer without sending another initialize to the agent', async () => {
    const { driver } = await connectedDriver(() => V2.agent({ name: 'v2-agent' })
      .onRequest(V2.methods.agent.initialize, () => ({
        protocolVersion: 2,
        info: { name: 'v2-agent', version: '0.0.1' },
        capabilities: { session: {} },
      }))
      .onRequest(V2.methods.agent.session.new, () => ({ sessionId: 's2' })));

    expect(driver).toBeInstanceOf(V2Driver);
    expect(await driver.newSession(work)).toMatchObject({ sessionId: 's2' });
    expect(initializes()).toEqual([v2Request]);
  });

  it('sends v1 capabilities on fallback and replays the answer without another initialize', async () => {
    const { driver } = await connectedDriver(() => agent({ name: 'v1-agent' })
      .onRequest(methods.agent.initialize, ({ params }) => {
        if (params.protocolVersion !== 1) {
          throw RequestError.invalidParams(undefined, 'Expected ACP v1');
        }
        return { protocolVersion: 1 };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })));

    expect(driver).toBeInstanceOf(V1Driver);
    expect(await driver.newSession(work)).toMatchObject({ sessionId: 's1' });
    expect(initializes()).toEqual([v2Request, v1Request]);
  });

  it.each([
    ['an invalid request', () => RequestError.invalidParams(undefined, 'Unknown field: info')],
    ['a -32022 listing 1', unsupported(1)],
  ])('follows up with v1 on the same connection when a v1 agent refuses the request for v2 with %s', async (_, refusal) => {
    const { driver } = await connectedDriver(strictV1Agent(refusal));

    expect(driver).toBeInstanceOf(V1Driver);
    expect(initializes()).toEqual([v2Request, v1Request]);
    expect(await driver.newSession(work)).toMatchObject({ sessionId: 's1' });
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

    await driver.newSession(work);

    expect(updates).toEqual([]);
  });

  // V2 clients support boolean config options without saying so; v1 clients advertise them.
  it("sends each version's request saying the same thing in its own terms, as the replay answers one with the other's answer", () => {
    const v1 = v1InitializeRequest('1.2.3');
    const v2 = v2InitializeRequest('1.2.3');

    expect([v1.protocolVersion, v2.protocolVersion]).toEqual([1, 2]);
    expect(v1.clientInfo).toEqual(v2.info);
    expect([v1.clientCapabilities, v2.capabilities]).toEqual([{ session: { compaction: {}, configOptions: { boolean: {} } } }, {}]);
  });
});
