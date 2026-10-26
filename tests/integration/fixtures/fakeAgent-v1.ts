import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentContext, SessionConfigOption } from '@agentclientprotocol/sdk';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

/**
 * Minimal ACP v1 agent spoken to over stdio by `connection.test.ts` and `toolcalldiffs.test.ts`; `fakeAgent-v2.ts` is
 * its v2 twin.
 *
 * A prompt streams "hello", requests permission, then streams
 * "perm:<optionId>". A cancel notification streams "cancel-ack".
 * A prompt of "edit <dir>" instead edits `a.ts` in that directory, creates `new.ts` there and reports both as one
 * tool call's whole-file diffs. A prompt of "run" reports a command it ran, as an `execute` tool call with its output
 * as text, as a v1 agent does: `commandoutput.test.ts` expects the same output as `fakeAgent-v2.ts`'s terminal.
 * A prompt of "review <dir>" changes files there for `review.test.ts`, one of them other than it reports; "again <dir>"
 * then changes `a.ts` once more, "review-open <dir>" changes two existing files for the UI journey, and "three <dir>"
 * changes `m.ts` there in three places.
 */

const SESSION_ID = process.env['ACP_TEST_SESSION_ID'] ?? 'fake-session';

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

/**
 * Modifies `a.ts` and deletes `gone.ts`, which the test made, creates `new.ts`, and writes `mismatch.ts` other than it
 * reports, all as one tool call's whole-file diffs.
 */
async function changeForReview(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const modified = join(dir, 'a.ts');
  const created = join(dir, 'new.ts');
  const deleted = join(dir, 'gone.ts');
  const mismatched = join(dir, 'mismatch.ts');
  const oldText = readFileSync(modified, 'utf8');
  const newText = oldText.replace('two', 'TWO');
  const deletedText = readFileSync(deleted, 'utf8');
  writeFileSync(modified, newText);
  writeFileSync(created, 'new\n');
  unlinkSync(deleted);
  writeFileSync(mismatched, 'on disk\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'review-1',
      title: 'Change files',
      kind: 'edit',
      status: 'completed',
      content: [
        { type: 'diff', path: modified, oldText, newText },
        { type: 'diff', path: created, oldText: null, newText: 'new\n' },
        { type: 'diff', path: deleted, oldText: deletedText, newText: '' },
        { type: 'diff', path: mismatched, oldText: null, newText: 'reported\n' },
      ],
    },
  });
}

/** Changes `a.ts`'s first line, for a round of `review.test.ts`'s after its first. */
async function changeAgain(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const modified = join(dir, 'a.ts');
  const oldText = readFileSync(modified, 'utf8');
  const newText = oldText.replace('one', 'ONE');
  writeFileSync(modified, newText);
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'review-2',
      title: 'Change a.ts again',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: modified, oldText, newText }],
    },
  });
}

/** Changes two existing, openable files in order for the UI review-presentation journey. */
async function changeOpenFiles(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const paths = [join(dir, 'a.ts'), join(dir, 'b.ts')];
  const changes = paths.map((path) => {
    const oldText = readFileSync(path, 'utf8');
    const newText = oldText.replace('before', 'after');
    writeFileSync(path, newText);
    return { type: 'diff' as const, path, oldText, newText };
  });
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'review-open-1',
      title: 'Change open files',
      kind: 'edit',
      status: 'completed',
      content: changes,
    },
  });
}

/** Changes lines 2, 15 and 28 of `m.ts`'s thirty, `l1` to `l30`, for three changes far apart in quick diff's view. */
async function changeThree(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const modified = join(dir, 'm.ts');
  const oldText = readFileSync(modified, 'utf8');
  const newText = oldText.split('\n').map((line) => (['l2', 'l15', 'l28'].includes(line) ? line.toUpperCase() : line)).join('\n');
  writeFileSync(modified, newText);
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'review-3',
      title: 'Change m.ts in three places',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: modified, oldText, newText }],
    },
  });
}

function run(client: AgentContext, sessionId: string): Promise<void> {
  return client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'run-1',
      title: 'npm test',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '\x1b[32mPASS\x1b[0m a.test.ts\nDownloading 5%\rDownloading done\ncafé\n' } }],
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
    if (text.startsWith('review ')) {
      await changeForReview(client, params.sessionId, text.slice('review '.length));
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('review-open ')) {
      await changeOpenFiles(client, params.sessionId, text.slice('review-open '.length));
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('again ')) {
      await changeAgain(client, params.sessionId, text.slice('again '.length));
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('three ')) {
      await changeThree(client, params.sessionId, text.slice('three '.length));
      return { stopReason: 'end_turn' };
    }
    if (text === 'run') {
      await run(client, params.sessionId);
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
