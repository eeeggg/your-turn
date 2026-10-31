import { assert, describe, expect, it } from 'vitest';
import type { DiffFile, ToolCallContent } from '@/shared/WebviewMessages';
import type { Action } from '@/webview/state/RootState';
import { shownContent, statusGlyph, TOOL_CALL_CONTENT_LIMIT, type ContentContext } from '@/webview/state/Transcript';
import { chatView, promptEnd } from './TranscriptTestSupport';

const texts = (...items: string[]): ToolCallContent[] => items.map((text) => ({ kind: 'text', text }));
/** A file as the extension sends it, added with one line. */
const addedFile = (path: string): DiffFile => ({
  operation: 'add',
  path,
  oldPath: null,
  added: 1,
  removed: 0,
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
  note: null,
  opens: 'fileAndChanges',
});
const diff: ToolCallContent = { kind: 'diff', files: [addedFile('a.ts')] };
/** Content shown in a session with no terminals, still going. */
const inSession = (): ContentContext => ({ terminals: new Map(), sessionEnded: false });

describe('tool calls', () => {
  it('adds a tool call to the current turn as pending unless the agent says otherwise', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });

    view.toolCall('t1', { title: 'Read', content: texts('body') });

    expect(view.toolCalls()).toEqual([{ toolCallId: 't1', title: 'Read', status: 'pending', content: texts('body'), open: false }]);
  });

  it("keeps a tool call's diffs where they were reported among its texts", () => {
    const view = chatView();
    view.connect();

    view.toolCall('t1', { title: 'Edit', content: [...texts('before'), diff, ...texts('after')] });

    expect(view.toolCalls()[0]?.content).toEqual([...texts('before'), diff, ...texts('after')]);
  });

  it('groups tool calls reported one after another, and starts another group after anything else', () => {
    const view = chatView();
    view.connect();

    view.toolCall('t1', { title: 'Read' });
    view.toolCall('t2', { title: 'Read' });
    view.answer('found it');
    view.toolCall('t3', { title: 'Edit' });

    expect(view.summary()).toEqual(['turn: tools t1, t2 | found it | tools t3']);
  });

  it('opens a tool call that fails, whether from the start or by an update, and only when it becomes failed', () => {
    const view = chatView();
    view.connect();
    view.toolCall('early', { title: 'A', status: 'failed' });
    view.toolCall('late', { title: 'B', status: 'running' });
    const turnId = view.lastTurn().id;

    view.toolCall('late', { status: 'failed' });
    expect(view.toolCalls().map((call) => call.open)).toEqual([true, true]);

    view.send({ type: 'toolCallToggled', turnId, toolCallId: 'late', open: false });
    view.toolCall('late', { status: 'failed', title: 'B again' });
    expect(view.toolCalls()[1]).toMatchObject({ title: 'B again', open: false });
  });

  it('keeps what a report leaves out', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Run', status: 'running', content: texts('out') });

    view.toolCall('t1');

    expect(view.toolCalls()[0]).toMatchObject({ title: 'Run', status: 'running', content: texts('out') });
  });

  it('replaces the text and the title a report carries', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Edit', content: [...texts('old'), diff] });

    view.toolCall('t1', { title: 'Edit foo.ts', content: texts('new') });

    expect(view.toolCalls()[0]).toMatchObject({ title: 'Edit foo.ts', content: texts('new') });
  });

  it('revises a tool call the agent reports again, wherever it is', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t0', { title: 'List' });
    view.answer('then');
    view.toolCall('t1', { title: 'Read', status: 'pending' });
    view.send(promptEnd, { type: 'promptStart' });
    view.answer('next turn');

    view.toolCall('t1', { title: 'Read foo.ts', status: 'completed' });
    view.toolCall('t1', { content: texts('body') });

    expect(view.summary()).toEqual(['turn: tools t0 | then | tools t1', 'turn: next turn']);
    const first = view.turns()[0];
    assert.exists(first);
    expect(first.parts[2]).toEqual({
      kind: 'toolCalls',
      toolCalls: [{ toolCallId: 't1', title: 'Read foo.ts', status: 'completed', content: texts('body'), open: false }],
      collapsed: false,
    });
  });

  it('shows a tool call first reported without a title, and takes the title once the agent gives one', () => {
    const view = chatView();
    view.connect();

    view.toolCall('t1', { status: 'running' });
    expect(view.toolCalls()).toEqual([{ toolCallId: 't1', title: '', status: 'running', content: [], open: false }]);

    view.toolCall('t1', { title: 'Read foo.ts' });
    expect(view.toolCalls()[0]?.title).toBe('Read foo.ts');
  });

  it('changes nothing when a toggle names a tool call it never saw, or matches the tool call', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Read' });
    const before = view.transcript();

    view.send({ type: 'toolCallToggled', turnId: view.lastTurn().id, toolCallId: 'unknown', open: true });
    view.send({ type: 'toolCallToggled', turnId: view.lastTurn().id, toolCallId: 't1', open: false });

    expect(view.transcript()).toBe(before);
  });

  it('collapses each group of more than three tool calls when the turn ends, which the user can undo', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    for (const count of [3, 4]) {
      for (let index = 0; index < count; index++) {
        view.toolCall(`${count}-${index}`, { title: 'Read', status: 'completed' });
      }
      view.answer(`after ${count}`);
    }
    expect(view.groups().map((group) => group.collapsed)).toEqual([false, false]);

    view.send(promptEnd);
    expect(view.groups().map((group) => group.collapsed)).toEqual([false, true]);

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 2 });
    expect(view.groups().map((group) => group.collapsed)).toEqual([false, false]);
  });

  it('keeps a short group the user collapsed collapsed when the turn ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.toolCall('t1', { title: 'Read' });

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 0 }, promptEnd);

    expect(view.groups()[0]?.collapsed).toBe(true);
  });

  it('changes nothing when a group toggle names a part that is not a group', () => {
    const view = chatView();
    view.connect();
    view.answer('answer');
    const before = view.transcript();

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 0 }, { type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 1 });

    expect(view.transcript()).toBe(before);
  });
});

describe("a tool call's files", () => {
  const edited: ToolCallContent = { kind: 'diff', files: [addedFile('a.ts')] };
  const twoFiles: ToolCallContent = {
    kind: 'diff',
    files: [{ ...addedFile('b.bin'), operation: 'delete', added: 0, hunks: [], note: 'binary', opens: 'file' }, addedFile('c.ts')],
  };

  it("asks the extension to open the file clicked, by its place across the tool call's diffs, changing nothing", () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Edit', content: [edited, ...texts('done'), twoFiles] });
    const before = view.transcript();

    view.send({ type: 'diffFileClicked', toolCallId: 't1', file: 2 });

    expect(view.takePosted()).toEqual([{ type: 'openFile', toolCallId: 't1', file: 2 }]);
    expect(view.transcript()).toBe(before);
  });

  it("gives each diff shown its first file's place across the tool call's diffs", () => {
    const { blocks } = shownContent([edited, ...texts('done'), twoFiles, edited], inSession(), true);

    expect(blocks.map((block) => (block.kind === 'diff' ? block.firstFile : block.text))).toEqual([0, 'done', 1, 3]);
  });
});

describe('commands', () => {
  type TerminalReport = Omit<Extract<Action, { type: 'terminal' }>, 'type' | 'terminalId'>;
  const running: TerminalReport = { text: 'building', truncated: false, exitStatus: null };
  const terminalIn = (terminalId: string): ToolCallContent[] => [{ kind: 'terminal', terminalId }];

  /** The command blocks a tool call shows, in the session's context. */
  function commands(view: ReturnType<typeof chatView>, toolCallId: string) {
    const call = view.toolCalls().find((candidate) => candidate.toolCallId === toolCallId);
    assert.exists(call);
    const { terminals, sessionEnded } = view.transcript();
    const shown = shownContent(call.content, { terminals, sessionEnded }, false);
    return { blocks: shown.blocks.filter((block) => block.kind === 'command'), running: shown.running };
  }

  it("shows a terminal where its tool call reported it, whichever came first, in every tool call showing it, and nothing until it is reported", () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, { type: 'terminal', terminalId: 'early', ...running });
    view.toolCall('c1', { content: [...texts('before'), ...terminalIn('early'), ...terminalIn('late')] });
    view.toolCall('c2', { content: terminalIn('early') });

    expect(commands(view, 'c1').blocks).toEqual([
      { kind: 'command', text: 'building', truncated: false, status: 'running', failure: null, terminalId: 'early' },
    ]);
    expect(commands(view, 'c2').blocks).toHaveLength(1);

    view.send({ type: 'terminal', terminalId: 'late', text: '', truncated: true, exitStatus: null });
    expect(commands(view, 'c1').blocks.map((block) => [block.terminalId, block.text, block.truncated])).toEqual([
      ['early', 'building', false],
      ['late', '', true],
    ]);
  });

  it('shows a command running while its terminal has no exit status, says how it failed, and says nothing of a success', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    const report = (terminalId: string, exitStatus: TerminalReport['exitStatus']) => {
      view.send({ type: 'terminal', terminalId, text: 'out', truncated: false, exitStatus });
      view.toolCall(terminalId, { content: terminalIn(terminalId) });
      return commands(view, terminalId);
    };

    expect(report('running', null)).toMatchObject({ blocks: [{ status: 'running', failure: null }], running: true });
    expect(report('passed', { exitCode: 0, signal: null })).toMatchObject({ blocks: [{ status: 'ended', failure: null }], running: false });
    expect(report('failed', { exitCode: 2, signal: null })).toMatchObject({ blocks: [{ status: 'ended', failure: 'Exit code 2' }] });
    expect(report('killed', { exitCode: null, signal: 'SIGTERM' })).toMatchObject({ blocks: [{ status: 'ended', failure: 'Ended by SIGTERM' }] });
    expect(report('unknown', { exitCode: null, signal: null })).toMatchObject({ blocks: [{ status: 'ended', failure: null }] });
  });

  it('says a command still running when its session ended was cut off by the disconnect, and keeps the terminals through the end', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, { type: 'terminal', terminalId: 't1', ...running });
    view.toolCall('c1', { content: terminalIn('t1') });

    view.send({ type: 'sessionEnded', message: 'Fake exited unexpectedly (code 1).' }, { type: 'state', activeSessionId: null, session: null });

    expect(commands(view, 'c1')).toEqual({
      blocks: [{ kind: 'command', text: 'building', truncated: false, status: 'disconnected', failure: null, terminalId: 't1' }],
      running: false,
    });
  });

  it('forgets the terminals when the transcript is cleared, as for another session', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'terminal', terminalId: 't1', ...running });

    view.connect({ sessionId: 's2' });
    expect(view.transcript().terminals.size).toBe(0);
    view.send({ type: 'terminal', terminalId: 't1', ...running }, { type: 'clearTranscript' });
    expect(view.transcript().terminals.size).toBe(0);
  });

  it("shows a command's text as the extension cleaned and cut it, outside the limit on other text", () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);
    const output: ToolCallContent = { kind: 'commandOutput', text: 'b'.repeat(TOOL_CALL_CONTENT_LIMIT), truncated: true };

    expect(shownContent([...texts(half), output, ...texts(half)], inSession(), false)).toEqual({
      blocks: [
        { kind: 'text', text: half },
        { kind: 'command', text: output.text, truncated: true, status: 'ended', failure: null, terminalId: null },
        { kind: 'text', text: half },
      ],
      truncated: false,
      running: false,
    });
  });
});

describe('what is shown', () => {
  it('truncates tool call content past the limit, across blocks', () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);

    expect(shownContent(texts(half, half), inSession(), true)).toEqual({ blocks: texts(half, half), truncated: false, running: false });
    expect(shownContent(texts(half, `${half}b`), inSession(), true)).toEqual({ blocks: texts(half, half), truncated: true, running: false });
    expect(shownContent(texts(half, half, 'c'), inSession(), true)).toEqual({ blocks: texts(half, half), truncated: true, running: false });
  });

  it("shows a tool call's diffs where they were reported among its texts, their files relative to the working directory", () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);

    const { blocks, truncated } = shownContent([diff, ...texts(half), diff, ...texts(half, 'c'), diff], inSession(), true);

    expect(truncated).toBe(true);
    expect(blocks.map((block) => (block.kind !== 'diff' ? block.text.length : block.files.map((file) => `${file.operation} ${file.path}`)))).toEqual([
      ['add a.ts'],
      half.length,
      ['add a.ts'],
      half.length,
      ['add a.ts'],
    ]);
  });

  it('leaves the diffs out unless asked for them, as a closed tool call shows none', () => {
    expect(shownContent([...texts('before'), diff, ...texts('after')], inSession(), false)).toEqual({
      blocks: texts('before', 'after'),
      truncated: false,
      running: false,
    });
  });

  it('marks each tool call status with a glyph', () => {
    expect((['pending', 'running', 'completed', 'failed'] as const).map(statusGlyph)).toEqual(['…', '⟳', '✓', '✗']);
  });
});
