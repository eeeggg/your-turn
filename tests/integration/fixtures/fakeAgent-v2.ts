import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/experimental/v2';
import type { AgentContext, ContentBlock, SessionConfigOption, SessionUpdate, StateUpdate } from '@agentclientprotocol/sdk/experimental/v2';
import { appendFileSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
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
 * With `ACP_TEST_RECORDS` set to a file, it takes additional directories, resumes any session, and appends each
 * session it creates or resumes to that file as a line of JSON: its method, directories and any replay asked for. It
 * replays a session it is asked to, as `replay` describes, and reports a session it resumes with the options
 * `restoredOptions` describes, appending each request to set one to the file too. It does not know a session `gone`,
 * and refuses `busy` as in use.
 */

const SESSION_ID = process.env['ACP_TEST_SESSION_ID'] ?? 'fake-session';
const RECORDS = process.env['ACP_TEST_RECORDS'];
let listings = 0;
let setupResponse: unknown;
const AUTHENTICATION_QUESTION = process.env['ACP_TEST_AUTHENTICATION_QUESTION'] === '1';
let authenticated = false;
let authenticationResponse: unknown;
let sessionCreationAttempts = 0;

function record(method: string, { cwd, additionalDirectories, replayFrom }: { cwd: string; additionalDirectories?: string[] | undefined; replayFrom?: { type: string } | null | undefined }): void {
  if (RECORDS) {
    appendFileSync(RECORDS, `${JSON.stringify({ method, cwd, additionalDirectories: additionalDirectories ?? null, ...(replayFrom ? { replayFrom: replayFrom.type } : {}) })}\n`);
  }
}

interface Choices { model: string; effort: string; fast: boolean }

/** The options of each session resumed, by its ID. */
const restored = new Map<string, Choices>();

/**
 * A resumed session's options, as `fakeAgent-v1.ts` reports them too: its model, an effort whose values depend on the
 * model, and whether it is fast. Choosing a model resets the effort; only model B offers high effort. A session
 * `fixed-effort` refuses to change its effort.
 */
function restoredOptions({ model, effort, fast }: Choices): SessionConfigOption[] {
  return [
    modelOption(model),
    {
      configId: 'effort',
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
    { configId: 'fast', name: 'Fast', type: 'boolean', currentValue: fast },
  ];
}

/** Open a session it is asked to resume, which starts out with model A at low effort and not fast. */
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

/** The prompt and answer a resumed session replays when asked to. */
async function replay(client: AgentContext, sessionId: string): Promise<void> {
  const update = (sessionUpdate: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update: sessionUpdate });
  await update({ sessionUpdate: 'user_message_chunk', messageId: 'earlier-question', content: { type: 'text', text: 'earlier question' } });
  await update({ sessionUpdate: 'agent_message_chunk', messageId: 'earlier-answer', content: { type: 'text', text: 'earlier answer' } });
}

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

let questionsIdle = false;
const autonomousSessions = new Set<string>();
let promptNumber = 0;

async function autonomousWork(client: AgentContext, sessionId: string, directory: string): Promise<void> {
  const restart = new Promise<void>((resolve) => {
    const watcher = watch(directory, (_event, name) => {
      if (name === 'foreground.trigger') { watcher.close(); resolve(); }
    });
  });
  await reportState(client, sessionId, { state: 'running' });
  await say(client, sessionId, 'Initial foreground complete.');
  await reportState(client, sessionId, { state: 'idle', stopReason: 'end_turn' });
  await restart;
  autonomousSessions.add(sessionId);
  await reportState(client, sessionId, { state: 'running' });
  await say(client, sessionId, 'Autonomous foreground running.');
}

async function withdrawnQuestions(client: AgentContext, sessionId: string, directory: string): Promise<void> {
  const controller = new AbortController();
  const trigger = new Promise<void>((resolve) => {
    const watcher = watch(directory, (_event, name) => {
      if (name === 'questions-withdraw.trigger') { watcher.close(); resolve(); }
    });
  });
  const form = (title: string) => ({
    sessionId, mode: 'form' as const, message: 'Enter an answer.',
    requestedSchema: { type: 'object' as const, title, required: ['answer'], properties: { answer: { type: 'string' as const, title: 'Answer' } } },
  });
  await reportState(client, sessionId, { state: 'running' });
  const withdrawn = client.request(methods.client.elicitation.create, form('Withdrawn settings'), { cancellationSignal: controller.signal }).then(
    async (response) => { await say(client, sessionId, `ERROR: withdrawn response ${response.action}`); },
    async (error: unknown) => { await say(client, sessionId, `Withdrawal error: ${error instanceof RequestError ? error.code : 'unknown'}`); },
  );
  const surviving = client.request(methods.client.elicitation.create, form('Surviving settings')).then(async (response) => {
    await say(client, sessionId, `Surviving answer: ${response.action === 'accept' ? JSON.stringify(response.content) : response.action}`);
  });
  await reportState(client, sessionId, { state: 'requires_action' });
  await trigger;
  controller.abort();
  await withdrawn;
  const replacement = client.request(methods.client.elicitation.create, form('Replacement settings')).then(async (response) => {
    await say(client, sessionId, `Replacement answer: ${response.action === 'accept' ? JSON.stringify(response.content) : response.action}`);
  });
  await Promise.all([surviving, replacement]);
  await reportState(client, sessionId, { state: 'idle', stopReason: 'end_turn' });
}

async function concurrentQuestions(client: AgentContext, sessionId: string, directory: string): Promise<void> {
  questionsIdle = false;
  const idleGate = new Promise<void>((resolve) => {
    const watcher = watch(directory, (_event, name) => {
      if (name === 'questions-idle.trigger') { watcher.close(); resolve(); }
    });
  });
  await reportState(client, sessionId, { state: 'running' });
  const first = client.request(methods.client.elicitation.create, {
    sessionId, mode: 'form', message: 'Choose a count.',
    requestedSchema: { type: 'object', title: 'First settings', required: ['count'], properties: { count: { type: 'integer', title: 'Count' } } },
  }).then(async (response) => { await say(client, sessionId, `First response: ${JSON.stringify({ action: response.action, ...(response.action === 'accept' ? { content: response.content } : {}) })}`); });
  const second = client.request(methods.client.elicitation.create, {
    sessionId, mode: 'form', message: 'Choose whether enabled.',
    requestedSchema: { type: 'object', title: 'Second settings', required: ['enabled'], properties: { enabled: { type: 'boolean', title: 'Enabled' } } },
  }).then(async (response) => { await say(client, sessionId, `Second response: ${JSON.stringify({ action: response.action, ...(response.action === 'accept' ? { content: response.content } : {}) })}`); });
  await reportState(client, sessionId, { state: 'requires_action' });
  await Promise.all([first, second]);
  await say(client, sessionId, 'Answers settled; waiting to report idle.');
  await idleGate;
  questionsIdle = true;
  await reportState(client, sessionId, { state: 'idle', stopReason: 'end_turn' });
}

agent({ name: 'fake-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    info: { name: 'FakeAgent', version: '0.0.1' },
    capabilities: { session: RECORDS ? { additionalDirectories: {} } : {} },
    authMethods: AUTHENTICATION_QUESTION ? [{ type: 'agent', methodId: 'preference', name: 'Test preference' }] : [],
  }))
  .onRequest(methods.agent.session.list, ({ params }) => {
    listings += 1;
    return { sessions: [{ sessionId: `listed-${listings}`, cwd: params.cwd ?? process.cwd(), title: `Listed ${listings}` }] };
  })
  .onRequest(methods.agent.auth.login, async ({ client, requestId }) => {
    if (requestId === null) { throw new Error('Authentication needs a parent request ID'); }
    const response = await client.request(methods.client.elicitation.create, {
      requestId, mode: 'form', message: 'Choose a non-sensitive authentication preference.',
      requestedSchema: { type: 'object', title: 'Authentication preference', required: ['enabled'], properties: { enabled: { type: 'boolean', title: 'Enabled' } } },
    });
    authenticationResponse = { action: response.action, ...(response.action === 'accept' ? { content: response.content } : {}) };
    if (response.action !== 'accept') { throw RequestError.internalError(undefined, 'Authentication preference not accepted'); }
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, async ({ params, client, requestId }) => {
    sessionCreationAttempts++;
    if (AUTHENTICATION_QUESTION && !authenticated) { throw new RequestError(-32000, 'Authentication required'); }
    record('session/new', params);
    if (process.env['ACP_TEST_PRE_SESSION_QUESTION'] === '1') {
      if (requestId === null) { throw new Error('Session creation needs a parent request ID'); }
      const response = await client.request(methods.client.elicitation.create, {
        requestId, mode: 'form', message: 'Choose a non-sensitive setup preference before creating the session.',
        requestedSchema: { type: 'object', title: 'Before session setup', required: ['enabled'], properties: { enabled: { type: 'boolean', title: 'Enabled' } } },
      });
      setupResponse = { action: response.action, ...(response.action === 'accept' ? { content: response.content } : {}) };
    }
    return { sessionId: SESSION_ID, configOptions: [modelOption('model-a')] };
  })
  .onRequest(methods.agent.session.resume, async ({ params, client }) => {
    record('session/resume', params);
    const configOptions = restore(params.sessionId);
    if (params.replayFrom) {
      await replay(client, params.sessionId);
    }
    return { configOptions };
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const choices = restored.get(params.sessionId);
    if (!choices) {
      return { configOptions: [modelOption(String(params.value))] };
    }
    if (RECORDS) {
      appendFileSync(RECORDS, `${JSON.stringify({ method: 'session/set_config_option', ...params })}\n`);
    }
    return { configOptions: choose(choices, params.sessionId, params.configId, params.value as string | boolean) };
  })
  .onRequest(methods.agent.session.prompt, ({ params, client }) => {
    const text = promptText(params.prompt);
    if (text === 'steer-check' && autonomousSessions.has(params.sessionId)) {
      void say(client, params.sessionId, 'Steering received without cancellation.');
    } else if (text.startsWith('autonomous ')) {
      void autonomousWork(client, params.sessionId, text.slice('autonomous '.length));
    } else if (text === 'url-elicitation') {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        const response = await client.request(methods.client.elicitation.create, {
          mode: 'url', sessionId: params.sessionId, elicitationId: 'desktop-url',
          message: 'Connect the test service in your browser.', url: `https://example.org/connect?state=${'a'.repeat(180)}`,
        });
        await say(client, params.sessionId, `URL response: ${JSON.stringify(response)}`);
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text === 'verify-authentication') {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await say(client, params.sessionId, `Authentication response: ${JSON.stringify(authenticationResponse)}; session creation attempts: ${sessionCreationAttempts}`);
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text === 'verify-pre-session') {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await say(client, params.sessionId, `Setup response before session creation: ${JSON.stringify(setupResponse)}`);
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text.startsWith('questions-withdraw ')) {
      void withdrawnQuestions(client, params.sessionId, text.slice('questions-withdraw '.length));
    } else if (text.startsWith('questions-concurrent ')) {
      void concurrentQuestions(client, params.sessionId, text.slice('questions-concurrent '.length));
    } else if (text === 'after-questions') {
      void (async () => {
        await reportState(client, params.sessionId, { state: 'running' });
        await say(client, params.sessionId, questionsIdle ? 'Queued prompt received after agent idle.' : 'ERROR: queued prompt received before agent idle.');
        await reportState(client, params.sessionId, { state: 'idle', stopReason: 'end_turn' });
      })();
    } else if (text.startsWith('edit ')) {
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
    return { messageId: `prompt-message-${++promptNumber}` };
  })
  .onNotification(methods.agent.session.cancel, async ({ params, client }) => {
    await say(client, params.sessionId, 'cancel-ack');
    if (autonomousSessions.delete(params.sessionId)) {
      await reportState(client, params.sessionId, { state: 'idle', stopReason: 'cancelled' });
    }
  })
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ));
