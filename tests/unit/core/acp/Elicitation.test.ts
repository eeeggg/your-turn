import { describe, expect, it, onTestFinished } from 'vitest';
import * as V1 from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import { v1Elicitation, v2Elicitation } from '@/core/acp/Elicitation';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { Elicitations } from '@/core/ClientHandlers';
import { connectedDriver, fakeAgent, fakeV2Agent, InProcessAgents, unusedHandlers, work } from '@tests/unit/core/InProcessAgents';

describe('versioned elicitation translation', () => {
  it('v2 preserves future string formats as unconstrained text', async () => {
    const requests = new ElicitationRequests();
    const answer = v2Elicitation({ mode: 'form', sessionId: 's1', message: 'Question', requestedSchema: { properties: { text: { type: 'string', format: 'future' } } } }, 1, new AbortController().signal, requests);
    const interaction = requests.snapshot()[0];
    expect(interaction).toMatchObject({ form: { fields: [{ name: 'text', format: 'future' }] } });
    requests.respond(interaction?.interactionId ?? '', { action: 'accept', content: { text: 'anything' } });
    expect(await answer).toEqual({ action: 'accept', content: { text: 'anything' } });
  });

  it.each([1, 2])('v%i relays SDK request cancellation as -32800 through an explicit exchange', async (version) => {
    const requests = new ElicitationRequests();
    let created: () => void = () => {};
    const ready = new Promise<void>((resolve) => { created = resolve; });
    requests.subscribe((change) => { if (change.kind === 'created') { created(); } });
    const toAgent = new TransformStream<V1.AnyMessage, V1.AnyMessage>();
    const toClient = new TransformStream<V1.AnyMessage, V1.AnyMessage>();
    const clientStream = { readable: toClient.readable, writable: toAgent.writable };
    const agentStream = { readable: toAgent.readable, writable: toClient.writable };
    const client = version === 1
      ? V1.client({ name: 'test' }).onRequest(V1.methods.client.elicitation.create, ({ params, requestId, signal }) => v1Elicitation(params, requestId, signal, requests)).connect(clientStream)
      : V2.client({ name: 'test' }).onRequest(V2.methods.client.elicitation.create, ({ params, requestId, signal }) => v2Elicitation(params, requestId, signal, requests)).connect(clientStream);
    const agent = version === 1 ? fakeAgent().connect(agentStream) : fakeV2Agent().connect(agentStream);
    onTestFinished(async () => { requests.close(); client.close(); agent.close(); await Promise.all([client.closed, agent.closed]); });
    if (version === 1) {
      await (client as V1.ClientConnection).agent.request(V1.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    } else {
      await (client as V2.ClientConnection).agent.request(V2.methods.agent.initialize, { protocolVersion: 2, info: { name: 'internal-test', version: '1' }, capabilities: { elicitation: { form: {} } } });
    }
    const controller = new AbortController();
    const params = { mode: 'form' as const, sessionId: 's1', message: 'Question', requestedSchema: {} };
    const response = version === 1
      ? (agent as V1.AgentConnection).client.request(V1.methods.client.elicitation.create, params, { cancellationSignal: controller.signal })
      : (agent as V2.AgentConnection).client.request(V2.methods.client.elicitation.create, params, { cancellationSignal: controller.signal });
    const check = expect(response).rejects.toMatchObject({ code: -32800 });
    await ready;
    const id = requests.snapshot()[0]?.interactionId ?? '';
    const withdrawn = new Promise<void>((resolve) => {
      requests.subscribe((change) => { if (change.kind === 'withdrawn') { resolve(); } });
    });
    controller.abort();
    await withdrawn;
    await check;
    expect(requests.snapshot()).toEqual([]);
    expect(requests.respond(id, { action: 'cancel' })).toEqual({ kind: 'stale' });
  });

  for (const [version, translate] of [[1, v1Elicitation], [2, v2Elicitation]] as const) {
    it(`v${version} rejects malformed known variants before invoking the core handler`, async () => {
      const requests: Elicitations = {
        create: () => Promise.resolve({ action: 'accept', content: {} }),
        complete() {}, close() {},
      };
      const request = { mode: 'form' as const, sessionId: 's1', message: 'Question', requestedSchema: { properties: { count: { type: 'number' as const, minimum: 'not numeric' as unknown as number } } } };
      const answer = translate(request, 1, new AbortController().signal, requests);
      await expect(answer).rejects.toMatchObject({ code: -32602 });
    });

    it(`v${version} translates every supported field without losing constraints, labels or typed answers`, async () => {
      const requests = new ElicitationRequests();
      const request = {
        mode: 'form' as const, sessionId: 's1', message: 'Settings', requestedSchema: {
          title: 'Profile', description: 'Details', required: ['choice'], properties: {
            text: { type: 'string' as const, minLength: 1, maxLength: 8, pattern: '^a', default: 'abc' },
            choice: { type: 'string' as const, oneOf: [{ const: 'a', title: 'Alpha', description: 'First' }] },
            count: { type: 'number' as const, minimum: 0, maximum: 2, default: 0 },
            integer: { type: 'integer' as const, minimum: 0, maximum: 3, default: 1 },
            enabled: { type: 'boolean' as const, default: false, title: 'Enabled', description: 'Switch' },
            untitled: { type: 'array' as const, items: { type: 'string' as const, enum: ['a', 'b'] }, minItems: 1, maxItems: 2, default: ['b'] },
            titled: { type: 'array' as const, items: { anyOf: [{ const: 'a', title: 'Alpha', description: 'First' }] } },
            future: { type: '_future' as const },
          },
        },
      };
      const answer = translate(request, 'incoming', new AbortController().signal, requests);
      const interaction = requests.snapshot()[0];
      expect(interaction).toMatchObject({ mode: 'form', form: { title: 'Profile', description: 'Details', fields: [
        { name: 'text', minLength: 1, maxLength: 8, pattern: '^a', format: null, default: 'abc' },
        { name: 'choice', required: true, choices: [{ value: 'a', title: 'Alpha', description: 'First' }] },
        { name: 'count', minimum: 0, maximum: 2, default: 0 },
        { name: 'integer', type: 'integer', minimum: 0, maximum: 3, default: 1 },
        { name: 'enabled', title: 'Enabled', description: 'Switch', default: false },
        { name: 'untitled', minItems: 1, maxItems: 2, default: ['b'], choices: [{ value: 'a' }, { value: 'b' }] },
        { name: 'titled', choices: [{ value: 'a', title: 'Alpha', description: 'First' }] },
      ] } });
      expect(requests.respond(interaction?.interactionId ?? '', { action: 'accept', content: { choice: 'a', integer: 1.5 } })).toEqual({ kind: 'invalid', errors: { integer: 'Invalid value' } });
      const content = { text: 'abc', choice: 'a', count: 0, integer: 1, enabled: false, untitled: ['a'], titled: [] };
      requests.respond(interaction?.interactionId ?? '', { action: 'accept', content });
      expect(await answer).toEqual({ action: 'accept', content });
    });

    it(`v${version} rejects unknown modes and unknown required fields at translation or validation`, async () => {
      const requests = new ElicitationRequests();
      await expect(translate({ mode: '_future', sessionId: 's1', message: 'Question' }, 1, new AbortController().signal, requests)).rejects.toMatchObject({ code: -32602 });
      await expect(translate({ mode: 'form', sessionId: 's1', message: 'Question', requestedSchema: { required: ['future'], properties: { future: { type: '_future' } } } }, 2, new AbortController().signal, requests)).rejects.toMatchObject({ code: -32602 });
      expect(requests.snapshot()).toEqual([]);
    });

    it.each(['accept', 'decline', 'cancel'] as const)(`v${version} translates form scope and %s`, async (action) => {
      const requests = new ElicitationRequests((id) => id === 'parent');
      const signal = new AbortController().signal;
      const answer = translate({ mode: 'form', requestId: 'parent', message: 'Question', requestedSchema: { properties: { count: { type: 'integer' } } } }, 'incoming', signal, requests);
      const interaction = requests.snapshot()[0];
      expect(interaction).toMatchObject({ rpcId: 'incoming', scope: { requestId: 'parent' }, form: { fields: [{ name: 'count', type: 'integer' }] } });
      const response = action === 'accept' ? { action, content: { count: 0 } } : { action };
      requests.respond(interaction?.interactionId ?? '', response);
      expect(await answer).toEqual(response);
    });

    it(`v${version} translates URL session scope and maps individual cancellation to -32800`, async () => {
      const requests = new ElicitationRequests();
      const controller = new AbortController();
      const answer = translate({ mode: 'url', sessionId: 's1', toolCallId: 'tool', message: 'Authorize', elicitationId: 'external', url: 'https://example.org' }, 42, controller.signal, requests);
      expect(requests.snapshot()).toMatchObject([{ rpcId: 42, scope: { sessionId: 's1', toolCallId: 'tool' }, elicitationId: 'external' }]);
      const check = expect(answer).rejects.toMatchObject({ code: -32800 });
      controller.abort();
      await check;
    });

    it(`v${version} returns invalid params for unrenderable forms instead of a user refusal`, async () => {
      await expect(translate({ mode: 'form', sessionId: 's1', message: 'Question', requestedSchema: { required: ['absent'] } }, 1, new AbortController().signal, new ElicitationRequests())).rejects.toMatchObject({ code: -32602 });
    });
  }
});

describe('unadvertised elicitation wire behavior', () => {
  it.each([1, 2])('v%i validates authentication parents using actual outgoing wire IDs after negotiation replay', async (version) => {
    let requests: ElicitationRequests | undefined;
    const observed: { parent: string | number | null } = { parent: null };
    const duringAuth = async (id: string | number | null) => {
      observed.parent = id;
      if (!requests || id === null) { throw new Error('Missing connection ownership'); }
      await expect(requests.create({ mode: 'form', rpcId: 'bad', scope: { requestId: 'not-outstanding' }, message: 'Question', requestedSchema: {} })).rejects.toMatchObject({ kind: 'invalid' });
      const answer = requests.create({ mode: 'form', rpcId: 'incoming', scope: { requestId: id }, message: 'Question', requestedSchema: {} });
      expect(requests.snapshot()).toMatchObject([{ rpcId: 'incoming', scope: { requestId: id } }]);
      requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'accept', content: {} });
      expect(await answer).toEqual({ action: 'accept', content: {} });
      return {};
    };
    const agents = new InProcessAgents({ fake: version === 1
      ? () => fakeAgent().onRequest(V1.methods.agent.authenticate, ({ requestId }) => duringAuth(requestId))
      : () => fakeV2Agent().onRequest(V2.methods.agent.auth.login, ({ requestId }) => duringAuth(requestId)) });
    const updates = new SessionUpdateHandler();
    onTestFinished(async () => { updates.dispose(); await Promise.all(agents.launched.map((agent) => agent.crash())); });
    const manager = new ConnectionManager(updates, 'test', (context) => {
      expect(context.agentName).toBe('fake');
      requests = context.elicitations;
      return unusedHandlers;
    });
    const driver = await manager.connect('fake', agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit() {} }));
    await driver.authenticate('browser');
    if (!requests || observed.parent === null) { throw new Error('Authentication did not run'); }
    await expect(requests.create({ mode: 'form', rpcId: 'late', scope: { requestId: observed.parent }, message: 'Question', requestedSchema: {} })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(requests.create({ mode: 'form', rpcId: 'replay', scope: { requestId: 'acp-negotiation-v2' }, message: 'Question', requestedSchema: {} })).rejects.toMatchObject({ kind: 'invalid' });
  });

  for (const [version, agent] of [[1, fakeAgent], [2, fakeV2Agent]] as const) {
    it(`v${version} routes agent URL completion independently of consent`, async () => {
      const elicitations = new ElicitationRequests();
      const answer = elicitations.create({ mode: 'url', rpcId: 2, scope: { sessionId: 's1' }, message: 'Authorize', elicitationId: 'external', url: 'https://example.org' });
      elicitations.respond(elicitations.snapshot()[0]?.interactionId ?? '', { action: 'accept' });
      await answer;
      const script = version === 1
        ? () => fakeAgent().onRequest(V1.methods.agent.session.new, async ({ client }) => {
          await client.notify(V1.methods.client.elicitation.complete, { elicitationId: 'external' });
          return { sessionId: 's1' };
        })
        : () => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
          await client.notify(V2.methods.client.elicitation.complete, { elicitationId: 'external' });
          return { sessionId: 's1' };
        });
      const { driver } = await connectedDriver(script, { ...unusedHandlers, elicitations });
      await driver.newSession(work);
      expect(elicitations.snapshot()).toEqual([]);
    });

    it(`v${version} closes connection-owned pending and accepted URL state on disconnect`, async () => {
      const elicitations = new ElicitationRequests();
      const { exit } = await connectedDriver(agent, { ...unusedHandlers, elicitations });
      const answer = elicitations.create({ mode: 'form', rpcId: 1, scope: { sessionId: 's1' }, message: 'Question', requestedSchema: {} });
      const rejected = expect(answer).rejects.toMatchObject({ kind: 'closed' });
      const accepted = elicitations.create({ mode: 'url', rpcId: 2, scope: { sessionId: 's1' }, message: 'Authorize', elicitationId: 'external', url: 'https://example.org' });
      elicitations.respond(elicitations.snapshot()[1]?.interactionId ?? '', { action: 'accept' });
      await accepted;
      await exit();
      await rejected;
      expect(elicitations.snapshot()).toEqual([]);
    });
  }

  it.each([1, 2])('v%i session cancellation does not dismiss independent elicitations', async (version) => {
    const elicitations = new ElicitationRequests();
    const script = version === 1
      ? () => fakeAgent().onNotification(V1.methods.agent.session.cancel, () => {})
      : () => fakeV2Agent().onNotification(V2.methods.agent.session.cancel, () => {});
    const { driver } = await connectedDriver(script, { permissions: { requestPermission: () => { throw new Error('Unexpected permission'); }, cancelSession: () => {} }, elicitations });
    const answer = elicitations.create({ mode: 'form', rpcId: 'incoming', scope: { sessionId: 's1' }, message: 'Question', requestedSchema: {} });
    const before = elicitations.snapshot();
    await driver.cancel('s1');
    expect(elicitations.snapshot()).toEqual(before);
    elicitations.respond(before[0]?.interactionId ?? '', { action: 'decline' });
    expect(await answer).toEqual({ action: 'decline' });
  });

  it.each(['form', 'url'] as const)('v1 rejects unsolicited %s with invalid params', async (mode) => {
    let received: unknown;
    const { driver } = await connectedDriver(() => fakeAgent().onRequest(V1.methods.agent.session.new, async ({ client }) => {
      const request: V1.CreateElicitationRequest = mode === 'form'
        ? { mode, sessionId: 's1', message: 'Question', requestedSchema: {} }
        : { mode, sessionId: 's1', message: 'Authorize', elicitationId: 'external', url: 'https://example.org' };
      received = await client.request(V1.methods.client.elicitation.create, request).catch((error: unknown) => error);
      return { sessionId: 's1' };
    }));
    await driver.newSession(work);
    expect(received).toMatchObject({ code: -32602 });
  });

  it.each(['form', 'url'] as const)('v2 rejects unsolicited %s with method not found', async (mode) => {
    let received: unknown;
    const { driver } = await connectedDriver(() => fakeV2Agent().onRequest(V2.methods.agent.session.new, async ({ client }) => {
      const request: V2.CreateElicitationRequest = mode === 'form'
        ? { mode, sessionId: 's1', message: 'Question', requestedSchema: {} }
        : { mode, sessionId: 's1', message: 'Authorize', elicitationId: 'external', url: 'https://example.org' };
      received = await client.request(V2.methods.client.elicitation.create, request).catch((error: unknown) => error);
      return { sessionId: 's1' };
    }));
    await driver.newSession(work);
    expect(received).toMatchObject({ code: -32601 });
  });
});
