import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentContext, SessionConfigOption } from '@agentclientprotocol/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

/**
 * Minimal ACP v1 agent spoken to over stdio by `connection.test.ts` and `toolcalldiffs.test.ts`; `fakeAgent-v2.ts` is
 * its v2 twin.
 *
 * A prompt streams "hello", requests permission, then streams
 * "perm:<optionId>". A cancel notification streams "cancel-ack".
 * A prompt of "edit <dir>" instead edits `a.ts` in that directory, creates `new.ts` there and reports both as one
 * tool call's whole-file diffs.
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

async function edit(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const edited = join(dir, 'a.ts');
  const created = join(dir, 'new.ts');
  const oldText = readFileSync(edited, 'utf8');
  const newText = oldText.replace('two', 'TWO');
  writeFileSync(edited, newText);
  writeFileSync(created, 'new\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit a.ts',
      kind: 'edit',
      status: 'completed',
      content: [
        { type: 'diff', path: edited, oldText, newText },
        { type: 'diff', path: created, oldText: null, newText: 'new\n' },
      ],
    },
  });
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
    const text = params.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    if (text.startsWith('edit ')) {
      await edit(client, params.sessionId, text.slice('edit '.length));
      return { stopReason: 'end_turn' };
    }
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
