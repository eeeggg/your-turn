import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type { AgentContext, SessionConfigOption } from '@agentclientprotocol/sdk';
import { appendFileSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
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
 * A prompt of "switch <model>" makes it switch its model option to that value itself.
 * With `ACP_TEST_LISTS_SESSIONS` set, it lists sessions: one, new each time it is asked, titled "Listed <n>".
 * With `ACP_TEST_COMPACTION` set, it checks the repeated v1 initialize, lists a session with one completed
 * compaction, and holds a live compaction at permission acknowledgements for rendered-transcript assertions.
 * With `ACP_TEST_RECORDS` set to a file, it takes additional directories, loads and resumes any session, and appends
 * each session it creates, loads or resumes to that file as a line of JSON: its method and directories. It replays a
 * session it loads, as `replay` describes, and reports a session it loads or resumes with the options `restoredOptions`
 * describes, appending each request to set one to the file too. It does not know a session `gone`, and refuses `busy`
 * as in use.
 */

const SESSION_ID = process.env['ACP_TEST_SESSION_ID'] ?? 'fake-session';
const LISTS_SESSIONS = process.env['ACP_TEST_LISTS_SESSIONS'] !== undefined;
const RECORDS = process.env['ACP_TEST_RECORDS'];
const COMPACTION = process.env['ACP_TEST_COMPACTION'] !== undefined;
const initializes: number[] = [];
let listings = 0;

function record(method: string, { cwd, additionalDirectories }: { cwd: string; additionalDirectories?: string[] | undefined }): void {
  if (RECORDS) {
    appendFileSync(RECORDS, `${JSON.stringify({ method, cwd, additionalDirectories: additionalDirectories ?? null })}\n`);
  }
}

interface Choices { model: string; effort: string; fast: boolean }

/** The options of each session loaded or resumed, by its ID. */
const restored = new Map<string, Choices>();

/**
 * A loaded or resumed session's options, as `fakeAgent-v2.ts` reports them too: its model, an effort whose values
 * depend on the model, and whether it is fast. Choosing a model resets the effort; only model B offers high effort.
 * A session `fixed-effort` refuses to change its effort.
 */
function restoredOptions({ model, effort, fast }: Choices): SessionConfigOption[] {
  return [
    modelOption(model),
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: effort,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        ...(model === 'model-b' ? [{ value: 'high', name: 'High' }] : []),
      ],
    },
    { id: 'fast', name: 'Fast', type: 'boolean', currentValue: fast },
  ];
}

/** Open a session it is asked to load or resume, which starts out with model A at low effort and not fast. */
function restore(sessionId: string): SessionConfigOption[] {
  if (sessionId === 'gone') {
    throw new RequestError(-32002, 'Resource not found', { sessionId });
  }
  if (sessionId === 'busy') {
    throw RequestError.internalError(undefined, 'Session is in use by another client');
  }
  const choices = { model: 'model-a', effort: 'low', fast: false };
  restored.set(sessionId, choices);
  return restoredOptions(choices);
}

function choose(choices: Choices, sessionId: string, configId: string, value: string | boolean): SessionConfigOption[] {
  if (configId === 'model') {
    choices.model = String(value);
    choices.effort = 'medium';
  } else if (configId === 'effort' && sessionId !== 'fixed-effort') {
    choices.effort = String(value);
  } else if (configId === 'fast') {
    choices.fast = value === true;
  } else {
    throw RequestError.invalidParams(undefined, `Cannot set ${configId}`);
  }
  return restoredOptions(choices);
}

/** The prompt and answer a loaded session replays. */
async function replay(client: AgentContext, sessionId: string): Promise<void> {
  const update = (sessionUpdate: 'user_message_chunk' | 'agent_message_chunk', text: string) =>
    client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate, content: { type: 'text', text } } });
  await update('user_message_chunk', 'earlier question');
  await update('agent_message_chunk', 'earlier answer');
}

async function replayCompaction(client: AgentContext, sessionId: string): Promise<void> {
  await client.notify(methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'compaction_update', compactionId: 'replayed', status: 'completed',
      summary: [{ type: 'text', text: 'Historical **summary**.' }] },
  });
  await client.notify(methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Historical question' } },
  });
  await client.notify(methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Historical answer' } },
  });
}

async function compact(client: AgentContext, sessionId: string): Promise<void> {
  const say = (text: string) => client.notify(methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
  const chunk = (text: string) => client.notify(methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'live', content: { type: 'text', text } },
  });
  const acknowledge = async (name: string) => {
    const response = await client.request(methods.client.session.requestPermission, {
      sessionId, toolCall: { toolCallId: 'compaction-checkpoint', title: name, status: 'pending' },
      options: [{ optionId: 'continue', name, kind: 'allow_once' }],
    });
    if (response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'continue') {
      throw RequestError.invalidParams(undefined, 'Compaction checkpoint not acknowledged');
    }
  };
  await say('Before live compaction.');
  await client.notify(methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'compaction_update', compactionId: 'live', status: 'in_progress' },
  });
  await chunk('Live **sum');
  await chunk('mary**.');
  await say('After live compaction.');
  await acknowledge('Continue summary');
  await chunk(' More detail.');
  await acknowledge('Complete compaction');
  await client.notify(methods.client.session.update, {
    sessionId, update: { sessionUpdate: 'compaction_update', compactionId: 'live', status: 'completed',
      summary: [{ type: 'text', text: 'Live **summary**. More detail.' }] },
  });
  await say('Turn finished.');
}

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

async function changeDiffReview(client: AgentContext, sessionId: string, dir: string): Promise<void> {
  const path = join(dir, 'm.ts');
  const oldText = readFileSync(path, 'utf8');
  const newText = oldText.replace('l2\n', 'AGENT changed\n')
    .replace('l15\n', 'l15\nAGENT added\n').replace('l28\n', '');
  writeFileSync(path, newText);
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call', toolCallId: 'review-diff-1', title: 'Change, add and delete lines',
      kind: 'edit', status: 'completed', content: [{ type: 'diff', path, oldText, newText }],
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
  .onRequest(methods.agent.initialize, ({ params }) => {
    initializes.push(params.protocolVersion);
    if (COMPACTION && params.protocolVersion === 1
      && (initializes.join(',') !== '2,1' || !params.clientCapabilities?.session?.compaction)) {
      throw RequestError.invalidParams(undefined, 'Expected repeated v1 initialize advertising compaction');
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: RECORDS !== undefined || COMPACTION,
        sessionCapabilities: {
          ...(LISTS_SESSIONS ? { list: {} } : {}),
          ...(RECORDS ? { additionalDirectories: {}, resume: {} } : {}),
        },
      },
      authMethods: [],
      agentInfo: { name: 'FakeAgent', version: '0.0.1' },
    };
  })
  .onRequest(methods.agent.session.list, ({ params }) => {
    if (COMPACTION) {
      if (initializes.join(',') !== '2,1') { throw RequestError.invalidParams(undefined, 'Missing v1 initialize'); }
      return { sessions: [{ sessionId: SESSION_ID, cwd: params.cwd ?? process.cwd(), title: 'Compaction session' }] };
    }
    listings += 1;
    return { sessions: [{ sessionId: `listed-${listings}`, cwd: params.cwd ?? process.cwd(), title: `Listed ${listings}` }] };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    record('session/new', params);
    return { sessionId: SESSION_ID, configOptions: [modelOption('model-a')] };
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    record('session/load', params);
    const configOptions = restore(params.sessionId);
    if (COMPACTION) { await replayCompaction(client, params.sessionId); }
    else { await replay(client, params.sessionId); }
    return { configOptions };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    record('session/resume', params);
    return { configOptions: restore(params.sessionId) };
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const choices = restored.get(params.sessionId);
    if (!choices) {
      return { configOptions: [modelOption(String(params.value))] };
    }
    if (RECORDS) {
      appendFileSync(RECORDS, `${JSON.stringify({ method: 'session/set_config_option', ...params })}\n`);
    }
    return { configOptions: choose(choices, params.sessionId, params.configId, params.value) };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    if (text.startsWith('question-hidden ')) {
      const directory = text.slice('question-hidden '.length);
      const trigger = new Promise<void>((resolve) => {
        const watcher = watch(directory, (_event, name) => {
          if (name === 'question.trigger') { watcher.close(); resolve(); }
        });
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Question armed.' } },
      });
      await trigger;
      const response = await client.request(methods.client.elicitation.create, {
        mode: 'form', sessionId: params.sessionId, message: 'Choose the settings to send.', requestedSchema: {
          title: 'Desktop settings', required: ['count'], properties: {
            count: { type: 'integer', title: 'Count', minimum: 0, maximum: 3 },
            enabled: { type: 'boolean', title: 'Enabled', default: false },
          },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Received question response: ${JSON.stringify(response)}` } },
      });
      return { stopReason: 'end_turn' };
    }
    if (COMPACTION && text === 'compact') {
      await compact(client, params.sessionId);
      return { stopReason: 'end_turn' };
    }
    if (text === 'usage') {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', used: 254264, size: 272000, cost: { amount: 11.931669815, currency: 'USD' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('noted ')) {
      return { stopReason: 'end_turn' };
    }
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
    if (text.startsWith('review-diff ')) {
      await changeDiffReview(client, params.sessionId, text.slice('review-diff '.length));
      return { stopReason: 'end_turn' };
    }
    if (text === 'run') {
      await run(client, params.sessionId);
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('switch ')) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: [modelOption(text.slice('switch '.length))] },
      });
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
