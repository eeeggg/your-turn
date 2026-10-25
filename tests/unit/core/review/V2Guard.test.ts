import { afterEach, describe, expect, it } from 'vitest';
import type { FileChange, SessionUpdate, ToolCallContent, ToolCallStatus } from '@/core/acp/AcpDriver';
import { setLogSink } from '@/core/Log';
import { Review, type FileContent } from '@/core/review/Review';
import { V2Guard } from '@/core/review/V2Guard';

const change = (operation: FileChange['operation'], path: string, fileType: FileChange['fileType'] = 'text'): FileChange =>
  ({ operation, path, fileType, mimeType: null });
const changes = (patch: string | null, ...changed: FileChange[]): ToolCallContent =>
  ({ kind: 'diff', diff: { kind: 'changes', changes: changed, patch: patch === null ? null : { format: 'git_patch', text: patch } } });
const toolCall = (toolCallId: string, status?: ToolCallStatus, content?: ToolCallContent[]): SessionUpdate =>
  ({ kind: 'toolCall', toolCallId, ...(status && { status }), ...(content && { content }) });

/** `git_patch` text as the schema has it: absolute paths with no prefixes, `/dev/null` on the missing side. */
const modifyA = ['diff --git /w/a.ts /w/a.ts', '--- /w/a.ts', '+++ /w/a.ts', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO', ''].join('\n');
const addNew = ['diff --git /w/new.ts /w/new.ts', 'new file mode 100644', '--- /dev/null', '+++ /w/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n');
const deleteGone = ['diff --git /w/gone.ts /w/gone.ts', 'deleted file mode 100644', '--- /w/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', ''].join('\n');
const modifyB = ['diff --git /w/b.ts /w/b.ts', '--- /w/b.ts', '+++ /w/b.ts', '@@ -1 +1 @@', '-b', '+B', ''].join('\n');

/** A guard over a review, reading files from `disk`, where a missing path holds nothing and an `Error` fails to read. */
function guarded(disk: Record<string, string | Error>) {
  const review = new Review(async () => {});
  const reads: string[] = [];
  const logged: string[] = [];
  setLogSink({ log: (message) => logged.push(message), warn() {}, error() {}, traffic() {} });
  const guard = new V2Guard(review, async (path): Promise<FileContent> => {
    reads.push(path);
    const content = disk[path];
    if (content instanceof Error) { throw content; }
    return content ?? null;
  });
  const files = () => review.files().map((file): [string, FileContent, FileContent] => [file.path, file.baseline, file.current]);
  const feed = async (...updates: SessionUpdate[]) => {
    for (const update of updates) { await guard.handleSessionUpdate(update); }
  };
  return { feed, files, reads, logged };
}

const notReviewed = (path: string, reason: string) => `Review: ${path}'s change is not reviewed, as ${reason}`;

afterEach(() => { setLogSink(undefined); });

describe('V2Guard', () => {
  it("takes a modified file's change as evidence when its patch undoes against the file, to what it held", async () => {
    const { feed, files, logged } = guarded({ '/w/a.ts': 'one\nTWO\n' });
    await feed(toolCall('t1', 'completed', [changes(modifyA, change('modify', '/w/a.ts'))]));
    expect(files()).toEqual([['/w/a.ts', 'one\ntwo\n', 'one\nTWO\n']]);
    expect(logged).toEqual([]);
  });

  it('drops a modified file whose patch does not undo against it', async () => {
    const { feed, files, logged } = guarded({ '/w/a.ts': 'one\nTHREE\n' });
    await feed(toolCall('t1', 'completed', [changes(modifyA, change('modify', '/w/a.ts'))]));
    expect(files()).toEqual([]);
    expect(logged).toEqual([notReviewed('/w/a.ts', 'its patch does not undo against the file')]);
  });

  it('takes an added file as holding nothing before, when its patch undoes it to nothing', async () => {
    const { feed, files } = guarded({ '/w/new.ts': 'one\ntwo\n' });
    await feed(toolCall('t1', 'completed', [changes(addNew, change('add', '/w/new.ts'))]));
    expect(files()).toEqual([['/w/new.ts', null, 'one\ntwo\n']]);
  });

  it('drops an added file holding more than its patch added', async () => {
    const { feed, files, logged } = guarded({ '/w/new.ts': 'one\ntwo\nthree\n' });
    await feed(toolCall('t1', 'completed', [changes(addNew, change('add', '/w/new.ts'))]));
    expect(files()).toEqual([]);
    expect(logged).toEqual([notReviewed('/w/new.ts', 'the file holds more than its patch added')]);
  });

  it('takes a deleted file, nothing at its path, as holding what its patch removed', async () => {
    const { feed, files } = guarded({});
    await feed(toolCall('t1', 'completed', [changes(deleteGone, change('delete', '/w/gone.ts'))]));
    expect(files()).toEqual([['/w/gone.ts', 'bye\n', null]]);
  });

  it('drops a deleted file that is at its path again', async () => {
    const { feed, files, logged } = guarded({ '/w/gone.ts': 'hello\n' });
    await feed(toolCall('t1', 'completed', [changes(deleteGone, change('delete', '/w/gone.ts'))]));
    expect(files()).toEqual([]);
    expect(logged).toEqual([notReviewed('/w/gone.ts', 'a file is at its path again')]);
  });

  it('drops a modified or added file with nothing at its path', async () => {
    const { feed, files, logged } = guarded({});
    await feed(toolCall('t1', 'completed', [changes(modifyA + addNew, change('modify', '/w/a.ts'), change('add', '/w/new.ts'))]));
    expect(files()).toEqual([]);
    expect(logged).toEqual([notReviewed('/w/a.ts', 'nothing is at its path'), notReviewed('/w/new.ts', 'nothing is at its path')]);
  });

  it('reads a change with no file type as text', async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'one\nTWO\n' });
    await feed(toolCall('t1', 'completed', [changes(modifyA, change('modify', '/w/a.ts', null))]));
    expect(files()).toEqual([['/w/a.ts', 'one\ntwo\n', 'one\nTWO\n']]);
  });

  it("matches each change to its file patch by the path it leaves the file at, taking them in the changes' order", async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'one\nTWO\n', '/w/new.ts': 'one\ntwo\n' });
    await feed(toolCall('t1', 'completed', [changes(deleteGone + addNew + modifyA, change('modify', '/w/a.ts'), change('delete', '/w/gone.ts'), change('add', '/w/new.ts'))]));
    expect(files()).toEqual([['/w/a.ts', 'one\ntwo\n', 'one\nTWO\n'], ['/w/gone.ts', 'bye\n', null], ['/w/new.ts', null, 'one\ntwo\n']]);
  });

  it("takes a tool call's several diffs, each against its own patch, in the order reported across them", async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'one\nTWO\n', '/w/b.ts': 'B' });
    await feed(toolCall('t1', 'completed', [changes(modifyB, change('modify', '/w/b.ts')), changes(modifyA, change('modify', '/w/a.ts'))]));
    expect(files()).toEqual([['/w/b.ts', 'b', 'B'], ['/w/a.ts', 'one\ntwo\n', 'one\nTWO\n']]);
  });

  it.each([
    ['its diff has no patch', changes(null, change('modify', '/w/a.ts'))],
    ['its patch is not a git_patch', { kind: 'diff', diff: { kind: 'changes', changes: [change('modify', '/w/a.ts')], patch: { format: 'other', text: modifyA } } } satisfies ToolCallContent],
    ['its patch cannot be read', changes(['--- /w/a.ts', '+++ /w/a.ts', '@@ -1 +1 @@', '*one', ''].join('\n'), change('modify', '/w/a.ts'))],
    ['its patch has no lines for it', changes(modifyB, change('modify', '/w/a.ts'))],
    ['its patch has no lines for it', changes(['diff --git /w/a.ts /w/a.ts', 'new file mode 100644', 'index 0000000..e69de29', ''].join('\n'), change('add', '/w/a.ts'))],
    ['its operation, move, is not reviewed yet', changes(modifyA, { ...change('move', '/w/a.ts'), oldPath: '/w/old.ts' })],
    ['its operation, copy, is not reviewed yet', changes(modifyA, { ...change('copy', '/w/a.ts'), oldPath: '/w/old.ts' })],
    ['its file type, binary, is not reviewed yet', changes(modifyA, change('modify', '/w/a.ts', 'binary'))],
    ['its file type, directory, is not reviewed yet', changes(modifyA, change('modify', '/w/a.ts', 'directory'))],
    ['its file type, symlink, is not reviewed yet', changes(modifyA, change('modify', '/w/a.ts', 'symlink'))],
    ['its file type, other, is not reviewed yet', changes(modifyA, change('modify', '/w/a.ts', 'other'))],
  ])('leaves out a change, reading nothing, when %s', async (reason, content) => {
    const { feed, files, reads, logged } = guarded({ '/w/a.ts': 'one\nTWO\n' });
    await feed(toolCall('t1', 'completed', [content]));
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
    expect(logged).toEqual([notReviewed('/w/a.ts', reason)]);
  });

  it('leaves out a change with a relative path, as ACP paths are absolute', async () => {
    const { feed, files, reads, logged } = guarded({ 'a.ts': 'one\nTWO\n' });
    await feed(toolCall('t1', 'completed', [changes(modifyA, change('modify', 'a.ts'))]));
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
    expect(logged).toEqual([notReviewed('a.ts', 'its path is not absolute')]);
  });

  it('waits for the tool call to complete, with diffs reported before or after', async () => {
    const { feed, files, reads } = guarded({ '/w/a.ts': 'one\nTWO\n', '/w/b.ts': 'B' });
    await feed(toolCall('t1', 'running', [changes(modifyA, change('modify', '/w/a.ts'))]));
    expect(reads).toEqual([]);
    await feed(toolCall('t1', 'completed'));
    await feed(toolCall('t2', 'completed'), toolCall('t2', undefined, [changes(modifyB, change('modify', '/w/b.ts'))]));
    expect(files()).toEqual([['/w/a.ts', 'one\ntwo\n', 'one\nTWO\n'], ['/w/b.ts', 'b', 'B']]);
  });

  it('takes the diffs of its latest content only', async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'one\nTWO\n', '/w/b.ts': 'B' });
    await feed(
      toolCall('t1', 'running', [changes(modifyA, change('modify', '/w/a.ts'))]),
      toolCall('t1', 'completed', [changes(modifyB, change('modify', '/w/b.ts'))]),
    );
    expect(files()).toEqual([['/w/b.ts', 'b', 'B']]);
  });

  it('takes nothing from a tool call that failed or has not completed', async () => {
    const { feed, files, reads, logged } = guarded({ '/w/a.ts': 'one\nTWO\n' });
    await feed(
      toolCall('t1', 'failed', [changes(modifyA, change('modify', '/w/a.ts'))]),
      toolCall('t2', 'pending', [changes(null, change('modify', '/w/a.ts'))]),
    );
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('reads nothing again for a completed tool call updated with neither status nor content', async () => {
    const { feed, reads } = guarded({ '/w/a.ts': 'one\nTWO\n' });
    await feed(toolCall('t1', 'completed', [changes(modifyA, change('modify', '/w/a.ts'))]), { kind: 'toolCall', toolCallId: 't1', title: 'Edit a.ts' });
    expect(reads).toEqual(['/w/a.ts']);
  });

  it("drops a change whose file cannot be read, and still takes the tool call's others", async () => {
    const { feed, files, logged } = guarded({ '/w/a.ts': new Error('binary'), '/w/b.ts': 'B' });
    await feed(toolCall('t1', 'completed', [changes(modifyA + modifyB, change('modify', '/w/a.ts'), change('modify', '/w/b.ts'))]));
    expect(files()).toEqual([['/w/b.ts', 'b', 'B']]);
    expect(logged).toEqual(['Review: /w/a.ts not read, so its change is not reviewed: binary']);
  });

  it("puts a tool call's files under review in the order reported, however their reads land", async () => {
    const review = new Review(async () => {});
    let readA: (content: string) => void = () => {};
    const a = new Promise<string>((resolve) => { readA = resolve; });
    const reads: string[] = [];
    const guard = new V2Guard(review, async (path) => {
      reads.push(path);
      return path === '/w/a.ts' ? a : 'B';
    });
    const handled = guard.handleSessionUpdate(toolCall('t1', 'completed', [changes(modifyA + modifyB, change('modify', '/w/a.ts'), change('modify', '/w/b.ts'))]));
    expect(reads).toEqual(['/w/a.ts', '/w/b.ts']);
    readA('one\nTWO\n');
    await handled;
    expect(review.files().map((file) => file.path)).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it("ignores a tool call's other content and other session updates", async () => {
    const { feed, files, reads, logged } = guarded({ '/w/a.ts': 'new' });
    await feed(
      toolCall('t1', 'completed', [{ kind: 'text', text: 'done' }, { kind: 'diff', diff: { kind: 'wholeFile', path: '/w/a.ts', oldText: 'old', newText: 'new' } }]),
      { kind: 'agentText', messageId: null, text: 'hi' },
    );
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
    expect(logged).toEqual([]);
  });
});
