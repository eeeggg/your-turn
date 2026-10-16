import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

/**
 * Minimal ACP agent spoken to over stdio by `connection.test.ts`.
 *
 * A prompt streams "hello", requests permission, then streams
 * "perm:<optionId>". A cancel notification streams "cancel-ack".
 */

const SESSION_ID = 'fake-session';

function modelOption(currentValue: string): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' },
    ],
  };
}

agent({ name: 'fake-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
    agentInfo: { name: 'FakeAgent', version: '0.0.1' },
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: SESSION_ID,
    configOptions: [modelOption('model-a')],
  }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
    configOptions: [modelOption(String(params.value))],
  }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const say = (text: string) => client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    await say('hello');
    const permission = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Edit foo.ts', status: 'pending' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const outcome = permission.outcome.outcome === 'selected' ? permission.outcome.optionId : permission.outcome.outcome;
    await say(`perm:${outcome}`);
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, async ({ params, client }) => {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancel-ack' } },
    });
  })
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ));
