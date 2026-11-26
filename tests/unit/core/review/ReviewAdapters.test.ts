import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyReviewEdit, ReviewTakeovers } from '@/adapters/review/ReviewTakeovers';
import * as vscode from 'vscode';
import { ReviewSourceControl } from '@/adapters/review/ReviewSourceControl';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews, type ReviewFiles } from '@/core/review/Reviews';

const SESSION_ID = { sessionId: '67d942be-3e51-4d08-8a62-f910b53c74e6', agentName: 'fake', agentId: 'source' };
const OTHER_SESSION_ID = { ...SESSION_ID, sessionId: 'ba43f621-805d-49e2-a376-0fd65ec9814b' };

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
  return { changed, selected, activated, willSave, didSave, opened, closed, document, editor, window, execute: vi.fn(async () => {}), apply: vi.fn(async () => true) };
});

vi.mock('vscode', () => ({
  workspace: {
    textDocuments: [host.document],
    applyEdit: host.apply,
    onDidOpenTextDocument: host.opened.subscribe,
    onDidCloseTextDocument: host.closed.subscribe,
    onDidChangeTextDocument: host.changed.subscribe,
    onWillSaveTextDocument: host.willSave.subscribe,
    onDidSaveTextDocument: host.didSave.subscribe,
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  window: host.window,
  WorkspaceEdit: class { readonly size = 0; },
  commands: { executeCommand: host.execute, registerCommand: () => ({ dispose() {} }) },
  TabInputTextDiff: class { readonly original = undefined; },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  scm: { createSourceControl: () => ({ inputBox: {}, createResourceGroup: () => ({ resourceStates: [] }), dispose() {} }) },
  Uri: { file: (path: string) => ({ scheme: 'file', fsPath: path, with: () => ({ fsPath: path }) }) },
}));

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).map(async (dispose) => { await dispose(); }));
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  host.execute.mockReset();
  host.execute.mockResolvedValue(undefined);
  host.apply.mockReset();
  host.apply.mockResolvedValue(true);
  host.window.activeTextEditor = host.editor;
  host.editor.selections = ['file cursor'];
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) { throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to clean up review adapters'); }
});

async function setup(blocked = false, save: () => Promise<void> = async () => { throw new Error('Unexpected save'); }, read: ReviewFiles['read'] = async () => 'after\n') {
  vi.useFakeTimers();
  let text = 'after\n';
  host.document.getText = () => text;
  const reviews = new Reviews({ read, restore: async () => {}, watch: () => ({ dispose() {} }),
    snapshot: () => ({ instance: host.document, version: 1, dirty: true, text: host.document.getText() }),
    applyEdit: async () => { throw new Error('Unexpected edit'); }, save,
  }, {
    resolutionBlocked: () => blocked, onChanged: () => () => {},
    runDecision: async (action) => blocked ? { kind: 'blocked' } : { kind: 'completed', value: await action(() => true) },
  });
  cleanup.push(() => reviews.dispose());
  reviews.activeSessionChanged(SESSION_ID);
  await reviews.handleSessionUpdate({ origin: { identity: { configuredName: 'fake', sessionId: SESSION_ID.sessionId }, sourceId: 'source' }, update: {
    kind: 'toolCall', toolCallId: 'edit', status: 'completed',
    content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: host.document.uri.fsPath, oldText: 'before\n', newText: 'after\n' } }],
  }, schema: 'v1' });
  const unused = () => { throw new Error('Unexpected editor interaction'); };
  const controls = new ReviewControls(reviews, {
    captureNavigation: () => () => true,
    activePath: unused, isOpen: unused, open: unused, showChange: unused, showChangeOf: unused,
    closeChange: unused, showError: unused, text: () => host.document.getText(),
  });
  const adapter = new ReviewTakeovers(reviews, controls);
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
  it('drains document ingestion queued behind an evidence read before disposal completes', async () => {
    let held = false;
    let release: (content: string) => void = () => {};
    const { reviews, adapter, change } = await setup(false, undefined, () => held
      ? new Promise<string>((resolve) => { release = resolve; }) : Promise.resolve('after\n'));
    host.window.activeTextEditor = { ...host.editor, document: { ...host.document } };
    held = true;
    const receiving = reviews.handleSessionUpdate({
      origin: { identity: { configuredName: 'fake', sessionId: SESSION_ID.sessionId }, sourceId: 'source' },
      schema: 'v1', update: { kind: 'toolCall', toolCallId: 'later', status: 'completed', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: host.document.uri.fsPath, oldText: 'before\n', newText: 'after\n' } },
      ] },
    });
    change();
    const disposed = adapter.dispose();
    const baselineAtDisposal = disposed.then(() => reviews.shown()?.file(host.document.uri.fsPath)?.baseline);
    release('after\n');
    expect(await baselineAtDisposal).toBe('before\ntyped\n');
    await receiving;
  });

  it('retires quick-diff captures when the shown session changes and after disposal', async () => {
    const { reviews, controls } = await setup();
    const sourceControl = new ReviewSourceControl(controls, reviews);
    cleanup.push(() => sourceControl.dispose());
    const path = '/review/file.txt';
    const changes = [{ original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } }];
    sourceControl.originalResource(vscode.Uri.file(path));
    expect(sourceControl.captureChange('keep', path, changes, 0)).toBeDefined();
    reviews.activeSessionChanged(OTHER_SESSION_ID);
    expect(sourceControl.captureChange('keep', path, changes, 0)).toBeUndefined();
    reviews.activeSessionChanged(SESSION_ID);
    sourceControl.dispose();
    sourceControl.originalResource(vscode.Uri.file(path));
    expect(sourceControl.captureChange('keep', path, changes, 0)).toBeUndefined();
  });

  it('keeps unchanged quick-diff captures executable through a publication refresh', async () => {
    const { reviews, controls } = await setup(false, async () => {});
    const sourceControl = new ReviewSourceControl(controls, reviews);
    cleanup.push(() => sourceControl.dispose());
    const path = '/review/file.txt';
    const uri = vscode.Uri.file(path);
    const changes = [{ original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } }];
    sourceControl.originalResource(uri);
    const captured = sourceControl.captureChange('keep', path, changes, 0);
    expect(captured).toBeDefined();
    sourceControl.originalResource(uri);
    if (!captured) { throw new Error('Missing published decision'); }
    expect(await reviews.decide(captured)).toMatchObject({ kind: 'applied' });
  });

  it('delivers own save observations after selection moves to a review without that file', async () => {
    const { reviews, change } = await setup();
    reviews.activeSessionChanged(OTHER_SESSION_ID);
    const delivered = vi.spyOn(reviews, 'observeDocument');
    host.willSave.fire({ document: host.document });
    change();
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ path: '/review/file.txt', source: 'save' }));
  });
  it('does not classify an unrelated user edit as the pending review edit', async () => {
    const { reviews, change } = await setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    host.apply.mockImplementation(async () => { await gate; return true; });
    const applying = applyReviewEdit('/review/file.txt', new vscode.WorkspaceEdit(), { before: 'after\n', after: 'before\n' });
    try {
      change();
      expect(reviews.shown()?.file('/review/file.txt')?.baseline).toBe('before\ntyped\n');
    } finally { release(); await applying; }
  });
  it('keeps user edits observable through authority ingress while resolution is blocked', async () => {
    const { reviews, change } = await setup(true);
    change();
    expect(reviews.shown()?.file('/review/file.txt')).toEqual({
      path: '/review/file.txt', baseline: 'before\ntyped\n', current: 'after\n',
    });
  });

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
    reviews.activeSessionChanged(OTHER_SESSION_ID);
    expect(paths).not.toHaveBeenCalled();
    reviews.activeSessionChanged(SESSION_ID);
    expect(controls.reviewedPaths()).toEqual(['/review/file.txt']);
  });
});
