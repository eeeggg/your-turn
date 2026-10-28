import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewTakeovers } from '@/adapters/review/ReviewTakeovers';
import { ReviewSourceControl } from '@/adapters/review/ReviewSourceControl';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';
import { Takeovers } from '@/core/review/Takeovers';

const host = vi.hoisted(() => {
  function event() {
    const listeners = new Set<(value: never) => void>();
    return {
      subscribe: (listener: (value: never) => void) => {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
      fire: (value: unknown) => { for (const listener of listeners) { listener(value as never); } },
      count: () => listeners.size,
    };
  }
  const changed = event();
  const selected = event();
  const activated = event();
  const willSave = event();
  const didSave = event();
  const opened = event();
  const closed = event();
  const document = { uri: { scheme: 'file', fsPath: '/review/file.txt' }, isDirty: true, getText: () => 'after\n' };
  const editor = { document, viewColumn: 1 as number | undefined, selections: ['file cursor'] };
  const window = {
    activeTextEditor: editor,
    visibleTextEditors: [editor],
    tabGroups: { activeTabGroup: { activeTab: undefined } },
    onDidChangeActiveTextEditor: activated.subscribe,
    onDidChangeTextEditorSelection: selected.subscribe,
  };
  return { changed, selected, activated, willSave, didSave, opened, closed, document, editor, window, execute: vi.fn(async () => {}) };
});

vi.mock('vscode', () => ({
  workspace: {
    textDocuments: [host.document],
    onDidOpenTextDocument: host.opened.subscribe,
    onDidCloseTextDocument: host.closed.subscribe,
    onDidChangeTextDocument: host.changed.subscribe,
    onWillSaveTextDocument: host.willSave.subscribe,
    onDidSaveTextDocument: host.didSave.subscribe,
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  window: host.window,
  commands: { executeCommand: host.execute },
  TabInputTextDiff: class { readonly original = undefined; },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  scm: { createSourceControl: () => ({ inputBox: {}, createResourceGroup: () => ({ resourceStates: [] }), dispose() {} }) },
  Uri: { file: (path: string) => ({ fsPath: path, with: () => ({ fsPath: path }) }) },
}));

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(async (dispose) => { await dispose(); }));
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  host.execute.mockReset();
  host.execute.mockResolvedValue(undefined);
  host.window.activeTextEditor = host.editor;
  host.editor.selections = ['file cursor'];
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) { throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to clean up review adapters'); }
});

async function setup() {
  vi.useFakeTimers();
  let text = 'after\n';
  host.document.getText = () => text;
  const reviews = new Reviews({ read: async () => 'after\n', restore: async () => {}, watch: () => ({ dispose() {} }) });
  cleanup.push(() => reviews.dispose());
  reviews.activeSessionChanged('s1');
  await reviews.handleSessionUpdate('s1', {
    kind: 'toolCall', toolCallId: 'edit', status: 'completed',
    content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: host.document.uri.fsPath, oldText: 'before\n', newText: 'after\n' } }],
  }, 'v1');
  const unused = () => { throw new Error('Unexpected editor interaction'); };
  const controls = new ReviewControls(reviews, {
    activePath: unused, isOpen: unused, open: unused, showChange: unused, showChangeOf: unused,
    closeChange: unused, showError: unused, text: unused, applyEdit: unused, save: unused,
  });
  const adapter = new ReviewTakeovers(new Takeovers(reviews), controls);
  cleanup.push(() => adapter.dispose());
  const change = () => {
    const offset = text.length;
    const line = text.split('\n').length - 1;
    text += 'typed\n';
    host.changed.fire({
      document: host.document,
      contentChanges: [{ range: { start: { line }, end: { line, character: 0 } }, rangeOffset: offset, rangeLength: 0, text: 'typed\n' }],
    });
  };
  return { reviews, controls, adapter, change };
}

describe('Review adapter shutdown', () => {
  it('cancels a pending cursor handover without moving the cursor or closing a later view', async () => {
    const { adapter, change } = await setup();
    const view = { document: host.document, viewColumn: undefined, selections: ['view cursor'] };
    host.window.activeTextEditor = view;
    change();
    expect(host.selected.count()).toBe(1);
    await adapter.dispose();
    expect(host.selected.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(host.editor.selections).toEqual(['file cursor']);
    expect(host.execute).not.toHaveBeenCalled();
  });

  it('drains an accepted close command and stops accepting document changes', async () => {
    const { adapter, change } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    host.execute.mockImplementation(async () => { await gate; finished = true; });
    change();
    try {
      const disposed = Promise.resolve(adapter.dispose()).then(() => finished);
      change();
      release();
      expect(await disposed).toBe(true);
      expect(host.execute).toHaveBeenCalledExactlyOnceWith('closeQuickDiff');
    } finally {
      release();
      await adapter.dispose();
    }
  });

  it('cancels save watchdogs when disposed', async () => {
    const { adapter } = await setup();
    host.willSave.fire({ document: host.document });
    expect(vi.getTimerCount()).toBe(1);
    await adapter.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still transfers the cursor and closes the view when selection arrives before shutdown', async () => {
    const { adapter, change } = await setup();
    const view = { document: host.document, viewColumn: undefined, selections: ['view cursor'] };
    host.window.activeTextEditor = view;
    let closed: () => void = () => {};
    const closing = new Promise<void>((resolve) => { closed = resolve; });
    host.execute.mockImplementation(async () => { closed(); });
    change();
    host.selected.fire({ textEditor: view });
    await closing;
    await adapter.dispose();
    expect(host.editor.selections).toEqual(['view cursor']);
    expect(host.execute).toHaveBeenCalledExactlyOnceWith('closeQuickDiff');
  });

  it('waits for sibling commands before reporting a close failure during shutdown', async () => {
    const { adapter, change } = await setup();
    let fail: (error: Error) => void = () => {};
    let release: () => void = () => {};
    const first = new Promise<void>((_resolve, reject) => { fail = reject; });
    const sibling = new Promise<void>((resolve) => { release = resolve; });
    let siblingFinished = false;
    host.execute.mockImplementationOnce(async () => first).mockImplementationOnce(async () => { await sibling; siblingFinished = true; });
    change();
    change();
    const failure = new Error('close failed');
    const disposed = Promise.resolve(adapter.dispose()).then(
      () => ({ error: undefined as unknown, siblingFinished }),
      (error: unknown) => ({ error, siblingFinished }),
    );
    try {
      fail(failure);
      release();
      const result = await disposed;
      expect(result).toMatchObject({ siblingFinished: true });
      expect(result.error).toBeInstanceOf(AggregateError);
      expect((result.error as AggregateError).errors).toEqual([failure]);
    } finally {
      fail(failure);
      release();
      await disposed;
      cleanup.pop();
    }
  });

  it('detaches source control from review changes without disposing the review', async () => {
    const { reviews, controls } = await setup();
    const sourceControl = new ReviewSourceControl(controls, reviews);
    cleanup.push(() => sourceControl.dispose());
    const paths = vi.spyOn(controls, 'reviewedPaths');
    sourceControl.dispose();
    reviews.activeSessionChanged('s2');
    expect(paths).not.toHaveBeenCalled();
    reviews.activeSessionChanged('s1');
    expect(controls.reviewedPaths()).toEqual(['/review/file.txt']);
  });
});
