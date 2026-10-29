import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2';
import type { AgentContext, ContentBlock, SessionConfigOption, SessionUpdate, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2';
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
 * call's diff: its `changes` and a `git_patch` in ACP's form, with absolute paths and no `a/` or `b/`. A prompt of "run"
 * reports a command it runs in a terminal of its own, as `run` describes. A prompt of "review <dir>" changes files
 * there for `review.test.ts`, as `changeForReview` describes; "again <dir>" then changes `a.ts` once more, and "three <dir>" changes `m.ts` there in three places.
 * A prompt of "switch <model>" makes it switch its model option to that value itself.
 * It lists sessions, as its session capability says: one, new each time it is asked, titled "Listed <n>".
 */

const SESSION_ID = process.env['ACP_TEST_SESSION_ID'] ?? 'fake-session';
let listings = 0;

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

/**
 * Modifies `a.ts` and deletes `gone.ts`, which the test made, creates `new.ts`, and writes `mismatch.ts` other than
 * its patch says, as `fakeAgent-v1.ts`'s twin does; then changes `nopatch.ts`, reported with no patch, and creates
 * `image.png`, reported as binary. All are one tool call's two diffs, as ACP allows: the first's `git_patch` covering
 * its changes, the binary one as Git writes it, with no lines.
 */
async function changeForReview(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const modified = join(dir, 'a.ts');
  const created = join(dir, 'new.ts');
  const deleted = join(dir, 'gone.ts');
  const mismatched = join(dir, 'mismatch.ts');
  const unpatched = join(dir, 'nopatch.ts');
  const binary = join(dir, 'image.png');
  if (readFileSync(modified, 'utf8') !== 'one\ntwo\n' || readFileSync(deleted, 'utf8') !== 'gone\n') {
    throw new Error(`${dir} is not laid out as the review expects`);
  }
  writeFileSync(modified, 'one\nTWO\n');
  writeFileSync(created, 'new\n');
  unlinkSync(deleted);
  writeFileSync(mismatched, 'on disk\n');
  writeFileSync(unpatched, 'changed\n');
  writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
  const patch = [
    `diff --git ${modified} ${modified}`,
    `--- ${modified}`,
    `+++ ${modified}`,
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '+TWO',
    `diff --git ${created} ${created}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${created}`,
    '@@ -0,0 +1 @@',
    '+new',
    `diff --git ${deleted} ${deleted}`,
    'deleted file mode 100644',
    `--- ${deleted}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    `diff --git ${mismatched} ${mismatched}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${mismatched}`,
    '@@ -0,0 +1 @@',
    '+reported',
    `diff --git ${binary} ${binary}`,
    'new file mode 100644',
    'index 0000000..d1b8a6c',
    `Binary files /dev/null and ${binary} differ`,
    '',
  ].join('\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'review-1',
      title: 'Change files',
      kind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          changes: [
            { operation: 'modify', path: modified, fileType: 'text' },
            { operation: 'add', path: created, fileType: 'text' },
            { operation: 'delete', path: deleted, fileType: 'text' },
            { operation: 'add', path: mismatched, fileType: 'text' },
            { operation: 'add', path: binary, fileType: 'binary', mimeType: 'image/png' },
          ],
          patch: { format: 'git_patch', text: patch },
        },
        { type: 'diff', changes: [{ operation: 'modify', path: unpatched, fileType: 'text' }] },
      ],
    },
  });
}

/** Changes `a.ts`'s first line once its first change is kept, for a round of `review.test.ts`'s after its first. */
async function changeAgain(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const modified = join(dir, 'a.ts');
  if (readFileSync(modified, 'utf8') !== 'one\nTWO\n') {
    throw new Error(`${dir} is not laid out as the second round expects`);
  }
  writeFileSync(modified, 'ONE\nTWO\n');
  const patch = [
    `diff --git ${modified} ${modified}`,
    `--- ${modified}`,
    `+++ ${modified}`,
    '@@ -1,2 +1,2 @@',
    '-one',
    '+ONE',
    ' TWO',
    '',
  ].join('\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'review-2',
      title: 'Change a.ts again',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', changes: [{ operation: 'modify', path: modified, fileType: 'text' }], patch: { format: 'git_patch', text: patch } }],
    },
  });
}

/** Changes lines 2, 15 and 28 of `m.ts`'s thirty, `l1` to `l30`, for three changes far apart in quick diff's view. */
async function changeThree(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const modified = join(dir, 'm.ts');
  const lines = Array.from({ length: 30 }, (_, index) => `l${index + 1}`);
  if (readFileSync(modified, 'utf8') !== `${lines.join('\n')}\n`) {
    throw new Error(`${dir} is not laid out as three changes expect`);
  }
  writeFileSync(modified, `${lines.map((line) => (['l2', 'l15', 'l28'].includes(line) ? line.toUpperCase() : line)).join('\n')}\n`);
  const hunk = (at: number) => [`@@ -${at},3 +${at},3 @@`, ` l${at}`, `-l${at + 1}`, `+L${at + 1}`, ` l${at + 2}`];
  const patch = [`diff --git ${modified} ${modified}`, `--- ${modified}`, `+++ ${modified}`, ...hunk(1), ...hunk(14), ...hunk(27), ''].join('\n');
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'review-3',
      title: 'Change m.ts in three places',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', changes: [{ operation: 'modify', path: modified, fileType: 'text' }], patch: { format: 'git_patch', text: patch } }],
    },
  });
}

/**
 * A command's terminal, reported as ACP allows: a chunk before any tool call names the terminal, a snapshot replacing
 * it, a character split between two chunks, and the exit status last, after its tool call was marked completed, as
 * Codex does. Its output ends up as `fakeAgent-v1.ts` reports its command's.
 */
async function run(client: AgentContext, sessionId: string): Promise<void> {
  const update = (sessionUpdate: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update: sessionUpdate });
  const base64 = (data: string | Uint8Array) => Buffer.from(data).toString('base64');
  const chunk = (data: string | Uint8Array) => update({ sessionUpdate: 'terminal_output_chunk', terminalId: 'term-1', data: base64(data) });
  const e = Buffer.from('é');

  await chunk('replaced by the snapshot\n');
  await update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'run-1',
    title: 'npm test',
    kind: 'execute',
    status: 'completed',
    content: [{ type: 'terminal', terminalId: 'term-1' }],
  });
  await update({ sessionUpdate: 'terminal_update', terminalId: 'term-1', command: 'npm test', cwd: process.cwd(), output: { data: base64('\x1b[32mPASS\x1b[0m a.test.ts\n') } });
  await chunk(Buffer.concat([Buffer.from('Downloading 5%\rDownloading done\ncaf'), e.subarray(0, 1)]));
  await chunk(Buffer.concat([e.subarray(1), Buffer.from('\n')]));
  await update({ sessionUpdate: 'terminal_update', terminalId: 'term-1', exitStatus: { exitCode: 1 } });
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
  .onRequest(methods.agent.session.list, ({ params }) => {
    listings += 1;
    return { sessions: [{ sessionId: `listed-${listings}`, cwd: params.cwd ?? process.cwd(), title: `Listed ${listings}` }] };
  })
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
    } else if (text.startsWith('review ')) {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await changeForReview(client, params.sessionId, text.slice('review '.length));
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text.startsWith('again ')) {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await changeAgain(client, params.sessionId, text.slice('again '.length));
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text.startsWith('three ')) {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await changeThree(client, params.sessionId, text.slice('three '.length));
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text.startsWith('switch ')) {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: [modelOption(text.slice('switch '.length))] },
        });
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text === 'run') {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await run(client, params.sessionId);
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
