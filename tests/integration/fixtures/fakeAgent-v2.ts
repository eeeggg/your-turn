import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2';
import type { AgentContext, ContentBlock, SessionConfigOption, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

/**
 * Minimal ACP v2 agent spoken to over stdio by `connection.test.ts` and `toolcalldiffs.test.ts`; `fakeAgent-v1.ts` is
 * its v1 twin.
 *
 * A prompt is accepted at once; the turn then streams "hello", requests
 * permission, streams "perm:<optionId>" and goes idle. A cancel notification
 * streams "cancel-ack".
 * A prompt of "edit <dir>" instead edits `a.ts` in that directory and deletes `gone.ts`, reporting both as one tool
 * call's diff: its `changes` and a `git_patch` in ACP's form, with absolute paths and no `a/` or `b/`.
 */

const SESSION_ID = 'fake-session';

function modelOption(currentValue: string): SessionConfigOption {
  return {
    configId: 'model',
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

function say(client: AgentContext, sessionId: string, text: string): Promise<void> {
  return client.notify(methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', messageId: `${text}-message`, content: { type: 'text', text } },
  });
}

function reportState(client: AgentContext, sessionId: string, update: StateUpdate): Promise<void> {
  return client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: 'state_update', ...update } });
}

async function turn(client: AgentContext, sessionId: string): Promise<void> {
  await reportState(client, sessionId, { state: 'running' });
  await say(client, sessionId, 'hello');
  const permission = await client.request(methods.client.session.requestPermission, {
    sessionId,
    title: 'Edit foo.ts?',
    subject: { type: 'tool_call', toolCall: { toolCallId: 'tool-1', title: 'Edit foo.ts', status: 'pending' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  const outcome = permission.outcome.outcome === 'selected' ? permission.outcome.optionId : permission.outcome.outcome;
  await say(client, sessionId, `perm:${String(outcome)}`);
  await reportState(client, sessionId, { state: 'idle', stopReason: 'end_turn' });
}

/** The patch is written for the files as `toolcalldiffs.test.ts` lays them out. */
async function edit(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const edited = join(dir, 'a.ts');
  const deleted = join(dir, 'gone.ts');
  if (readFileSync(edited, 'utf8') !== 'one\ntwo\n' || readFileSync(deleted, 'utf8') !== 'bye\n') {
    throw new Error(`${dir} is not laid out as the edit expects`);
  }
  writeFileSync(edited, 'one\nTWO\n');
  unlinkSync(deleted);
  const patch = [
    `diff --git ${edited} ${edited}`,
    `--- ${edited}`,
    `+++ ${edited}`,
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '+TWO',
    `diff --git ${deleted} ${deleted}`,
    'deleted file mode 100644',
    `--- ${deleted}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    '',
  ].join('\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      title: 'Edit a.ts',
      kind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          changes: [
            { operation: 'modify', path: edited, fileType: 'text' },
            { operation: 'delete', path: deleted, fileType: 'text' },
          ],
          patch: { format: 'git_patch', text: patch },
        },
      ],
    },
  });
}

function promptText(prompt: ContentBlock[]): string {
  return prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

agent({ name: 'fake-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    info: { name: 'FakeAgent', version: '0.0.1' },
    capabilities: { session: {} },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: SESSION_ID,
    configOptions: [modelOption('model-a')],
  }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
    configOptions: [modelOption(String(params.value))],
  }))
  .onRequest(methods.agent.session.prompt, ({ params, client }) => {
    const text = promptText(params.prompt);
    if (text.startsWith('edit ')) {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await edit(client, params.sessionId, text.slice('edit '.length));
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else {
      void turn(client, params.sessionId);
    }
    return { messageId: 'prompt-message' };
  })
  .onNotification(methods.agent.session.cancel, async ({ params, client }) => {
    await say(client, params.sessionId, 'cancel-ack');
  })
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ));
