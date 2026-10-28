import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setup, suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { DiffReviewPresentation } from '@/adapters/review/DiffReviewPresentation';
import { workspaceFiles } from '@/adapters/review/WorkspaceFiles';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';
import { Takeovers } from '@/core/review/Takeovers';
import { ReviewTakeovers } from '@/adapters/review/ReviewTakeovers';
import { createReviewEditors } from '@/adapters/review/ReviewPresenters';
import { observed } from './observed';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((give) => { resolve = give; });
  return { promise, resolve };
}

suite('Native review diff', () => {
  let folder: string;
  let file: string;
  let reviews: Reviews;
  let controls: ReviewControls;
  let presentation: DiffReviewPresentation;
  let prior: unknown;
  let openDiff: (...args: [vscode.Uri, vscode.Uri, string, vscode.TextDocumentShowOptions]) => Thenable<unknown>;
  let closeTabs: (tabs: readonly vscode.Tab[]) => Thenable<boolean>;
  let owned: { reviews?: Reviews; presentation?: DiffReviewPresentation; takeovers?: ReviewTakeovers; editors?: ReturnType<typeof createReviewEditors> } = {};
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
  const after = 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\n';

  const lenses = async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return presentation.provideCodeLenses(document);
  };
  const input = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const ownedTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'acp-review-diff');

  setup(async () => {
    owned = {};
    folder = '';
    prior = vscode.workspace.getConfiguration('acp').inspect('review.presentation')?.globalValue;
    await vscode.workspace.getConfiguration('acp').update('review.presentation', 'diffEditor', vscode.ConfigurationTarget.Global);
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-native-review-'));
    file = path.join(folder, 'file.txt');
    fs.writeFileSync(file, after);
    owned.reviews = reviews = new Reviews(workspaceFiles);
    openDiff = (...args) => vscode.commands.executeCommand('vscode.diff', ...args);
    closeTabs = (tabs) => vscode.window.tabGroups.close(tabs, true);
    owned.presentation = presentation = new DiffReviewPresentation(reviews, (...args) => openDiff(...args), (tabs) => closeTabs(tabs));
    controls = new ReviewControls(reviews, presentation);
    presentation.attach(controls);
    owned.takeovers = new ReviewTakeovers(new Takeovers(reviews), controls);
    const session = `native-${path.basename(folder)}`;
    reviews.activeSessionChanged(session);
    await reviews.handleSessionUpdate(session, {
      kind: 'toolCall', toolCallId: 'edit', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: file, oldText: before, newText: after } }],
    }, 'v1');
    await controls.turnEnded(session);
  });

  teardown(async function () {
    const failures: unknown[] = [];
    const cleanup = async (action: () => unknown) => {
      try { await action(); } catch (error) { failures.push(error); }
    };
    await cleanup(() => owned.takeovers?.dispose());
    await cleanup(() => owned.presentation?.dispose());
    await cleanup(() => owned.editors?.dispose());
    await cleanup(() => owned.reviews?.dispose());
    await cleanup(() => vscode.commands.executeCommand('workbench.action.files.revert'));
    await cleanup(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));
    await cleanup(() => vscode.workspace.getConfiguration('acp').update('review.presentation', prior, vscode.ConfigurationTarget.Global));
    await cleanup(() => { if (folder) { fs.rmSync(folder, { recursive: true, force: true }); } });
    if (failures.length > 0) {
      const error = new AggregateError(failures, 'Failed to clean up review diff');
      if (this.currentTest?.err) { console.error(error); } else { throw error; }
    }
  });

  test('opens the actual writable file against a baseline and updates it after Keep', async () => {
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.toString(), vscode.Uri.file(file).toString());
    const original = await vscode.workspace.openTextDocument(diff.original);
    assert.equal(original.getText(), before);
    const keep = (await lenses()).find((lens) => lens.command?.command === 'acp.keepDiffChange');
    assert.ok(keep);
    await presentation.decide('keep', keep.command?.arguments?.[0]);
    assert.equal(controls.baseline(file), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\n');
    assert.equal(fs.readFileSync(file, 'utf8'), after);
    assert.equal(ownedTabs().length, 1);
    assert.equal((await lenses()).filter((lens) => lens.command?.command === 'acp.undoDiffChange').length, 1);
  });

  test('settles an active diff opening, not only retired-tab closure', async () => {
    const { promise: gate, resolve: release } = deferred();
    const { promise: opening, resolve: started } = deferred();
    let finished = false;
    openDiff = async () => { started(); await gate; finished = true; };
    const showing = presentation.showChange(file);
    try {
      await opening;
      const settled = presentation.settled().then(() => finished);
      release();
      assert.equal(await settled, true);
      await showing;
    } finally {
      release();
      await showing;
    }
  });

  test('disposal drains an opening, abandons queued openings and leaves unresolved review intact', async () => {
    await vscode.window.tabGroups.close(ownedTabs(), true);
    const { promise: gate, resolve: release } = deferred();
    const { promise: opening, resolve: started } = deferred();
    let calls = 0;
    let finished = false;
    openDiff = async (...args) => {
      calls++;
      started();
      await gate;
      await vscode.commands.executeCommand('vscode.diff', ...args);
      finished = true;
    };
    const showing = presentation.showChangeOf(file, controls.changes(file), 0);
    let queued: Promise<void> | undefined;
    try {
      await opening;
      queued = presentation.showChangeOf(file, controls.changes(file), 1);
      const disposed = presentation.dispose();
      const finishedAtDisposal = Promise.resolve(disposed).then(() => finished);
      assert.equal(presentation.dispose(), disposed);
      release();
      await disposed;
      await Promise.all([showing, queued]);

      assert.equal(await finishedAtDisposal, true);
      assert.equal(calls, 1);
      assert.equal(ownedTabs().length, 0);
      assert.equal(controls.changes(file).length, 2);
      await presentation.showChange(file);
      await presentation.showChangeOf(file, controls.changes(file), 0);
      reviews.activeSessionChanged('other-session');
      reviews.activeSessionChanged(`native-${path.basename(folder)}`);
      assert.equal(calls, 1);
      assert.equal(controls.changes(file).length, 2);
    } finally {
      release();
      await Promise.all([showing, queued]);
    }
  });

  test('rejects a stale lens even when an intervening edit preserves the hunk coordinates', async () => {
    const keep = (await lenses()).find((lens) => lens.command?.command === 'acp.keepDiffChange');
    assert.ok(keep);
    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(1, 0, 1, 3), 'NEW');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const baseline = controls.baseline(file);
    await presentation.decide('keep', keep.command?.arguments?.[0]);
    assert.equal(controls.baseline(file), baseline);
    assert.equal(document.isDirty, true);
    assert.equal(ownedTabs().length, 1);
    assert.equal(document.getText(), 'one\nNEW\nthree\nfour\nfive\nsix\nSEVEN\n');
  });

  test('disposal drains a retired tab closure and reports its failure after a sibling closes', async () => {
    const other = path.join(folder, 'other.txt');
    fs.writeFileSync(other, 'NEW\n');
    const session = `native-${path.basename(folder)}`;
    await reviews.handleSessionUpdate(session, {
      kind: 'toolCall', toolCallId: 'other', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: other, oldText: 'old\n', newText: 'NEW\n' } }],
    }, 'v1');
    await presentation.showChange(other);
    const { promise: gate, resolve: release } = deferred();
    const { promise: closing, resolve: started } = deferred();
    const failure = new Error('retired tab closure failed');
    let siblingFinished = false;
    closeTabs = async (tabs) => {
      const input = tabs[0]?.input;
      if (input instanceof vscode.TabInputTextDiff && input.modified.fsPath === file) {
        started();
        await gate;
        throw failure;
      }
      await gate;
      const closed = await vscode.window.tabGroups.close(tabs, true);
      siblingFinished = true;
      return closed;
    };
    await controls.keepFile(file);
    try {
      await closing;
      const disposed = presentation.dispose();
      const finishedAtDisposal = disposed.then(() => siblingFinished, () => siblingFinished);
      const rejected = assert.rejects(disposed, (error: unknown) =>
        error instanceof AggregateError && error.errors.includes(failure));
      release();
      await rejected;
      assert.equal(await finishedAtDisposal, true);
      assert.equal(ownedTabs().length, 1);
      assert.equal(controls.baseline(other), 'old\n');
    } finally {
      release();
      await presentation.dispose().catch(() => {});
      delete owned.presentation;
    }
  });

  test('opens an evidenced review even before an existing document reload exposes its hunks', async () => {
    await vscode.window.tabGroups.close(ownedTabs(), true);
    owned.editors = createReviewEditors();
    controls = new ReviewControls(reviews, {
      ...owned.editors,
      text: () => before,
      showChange: (path) => presentation.showChange(path),
    });
    presentation.attach(controls);
    assert.equal(controls.changes(file).length, 0, 'the open document still matches the baseline');
    await controls.turnEnded(`native-${path.basename(folder)}`);
    assert.equal(ownedTabs().length, 1, 'disk evidence is enough to open the review diff');
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.fsPath, file);
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), before);
  });

  test('opens the first review when only an ordinary file tab is open', async () => {
    assert.equal(presentation.isOpen(file), true, 'the current review diff is open');
    await vscode.window.tabGroups.close(ownedTabs(), true);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    assert.equal(presentation.isOpen(file), false, 'an ordinary text tab is not a review diff');

    await controls.turnEnded(`native-${path.basename(folder)}`);

    assert.equal(ownedTabs().length, 1, 'an ordinary text tab must not suppress the review diff');
  });

  test('rejects a retained lens after an earlier decision reindexes the remaining hunk, then accepts its fresh lens', async () => {
    const undo = (await lenses()).filter((lens) => lens.command?.command === 'acp.undoDiffChange');
    assert.equal(undo.length, 2);
    await presentation.decide('undo', undo[0]?.command?.arguments?.[0]);
    const remaining = 'one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n';
    assert.equal(fs.readFileSync(file, 'utf8'), remaining);
    await presentation.decide('undo', undo[1]?.command?.arguments?.[0]);
    assert.equal(fs.readFileSync(file, 'utf8'), remaining, 'a stale lens cannot act on another hunk');
    const fresh = (await lenses()).find((lens) => lens.command?.command === 'acp.undoDiffChange');
    assert.ok(fresh);
    const completed = new Promise<void>((resolve) => {
      reviews.addListener(() => { if (reviews.shown()?.files().length === 0) { resolve(); } });
    });
    await presentation.decide('undo', fresh.command?.arguments?.[0]);
    await completed;
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(controls.changes(file).length, 0);
    await presentation.settled();
    assert.equal(ownedTabs().length, 0);
  });

  test('title Undo saves its edit and session switches close only the owned review diff', async () => {
    await presentation.decide('undo');
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n');
    const document = await vscode.workspace.openTextDocument(file);
    assert.equal(document.isDirty, false);
    const other = path.join(folder, 'other.txt');
    fs.writeFileSync(other, 'other\n');
    await vscode.window.showTextDocument(vscode.Uri.file(other), { preview: false });
    reviews.activeSessionChanged('another-session');
    await presentation.settled();
    assert.equal(ownedTabs().length, 0);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, other);
  });

  test('closes the completed review without expiring its open baseline content to an empty file', async () => {
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    const baseline = await vscode.workspace.openTextDocument(diff.original);
    await controls.keepFile(file);
    await presentation.settled();
    assert.equal(ownedTabs().length, 0);
    assert.equal(baseline.getText(), before);
  });

  test('closes a diff still opening when the session disconnects and preserves its original for reopening', async () => {
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    await vscode.window.tabGroups.close(ownedTabs(), true);
    let release: () => void = () => { throw new Error('opening did not start'); };
    let started: () => void = () => { throw new Error('listener not registered'); };
    const opening = new Promise<void>((resolve) => { started = resolve; });
    openDiff = async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; started(); });
      return vscode.commands.executeCommand('vscode.diff', ...args);
    };
    const showing = presentation.showChange(file);
    try {
      await opening;
      reviews.activeSessionChanged(null);
      release();
      await showing;
      await presentation.settled();
      assert.equal(ownedTabs().length, 0);
      assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), before);
    } finally {
      release();
      await showing;
    }
  });

  test('retries Open ACP Review after an opening fails without changing the unresolved review', async () => {
    await vscode.window.tabGroups.close(ownedTabs(), true);
    openDiff = async () => { throw new Error('opening failed'); };
    await assert.rejects(controls.openReview(), /opening failed/);
    assert.equal(ownedTabs().length, 0);
    openDiff = (...args) => vscode.commands.executeCommand('vscode.diff', ...args);
    await controls.openReview();
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.fsPath, file);
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), before);
    assert.equal(controls.changes(file).length, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), after);
  });

  test('opens a queued change after the preceding opening fails', async () => {
    await vscode.window.tabGroups.close(ownedTabs(), true);
    let fail: (error: Error) => void = () => { throw new Error('gate not registered'); };
    const gate = new Promise<never>((_, reject) => { fail = reject; });
    let started: () => void = () => { throw new Error('listener not registered'); };
    const opening = new Promise<void>((resolve) => { started = resolve; });
    openDiff = async () => { started(); return gate; };
    const rejected = assert.rejects(presentation.showChangeOf(file, controls.changes(file), 0), /opening failed/);
    let queued: Promise<void> | undefined;
    try {
      await opening;
      queued = presentation.showChangeOf(file, controls.changes(file), 1);
      openDiff = (...args) => vscode.commands.executeCommand('vscode.diff', ...args);
      fail(new Error('opening failed'));
      await Promise.all([rejected, queued]);
    } finally {
      fail(new Error('opening failed'));
      await Promise.allSettled([rejected, queued]);
    }
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.fsPath, file);
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, 6);
    assert.equal(ownedTabs().length, 1);
  });

  test('closes the owned diff after disconnect even when its pending opening fails', async () => {
    assert.equal(ownedTabs().length, 1);
    let fail: (error: Error) => void = () => { throw new Error('gate not registered'); };
    const gate = new Promise<never>((_, reject) => { fail = reject; });
    let started: () => void = () => { throw new Error('listener not registered'); };
    const opening = new Promise<void>((resolve) => { started = resolve; });
    openDiff = async () => { started(); return gate; };
    const rejected = assert.rejects(presentation.showChange(file), /opening failed/);
    try {
      await opening;
      reviews.activeSessionChanged(null);
      fail(new Error('opening failed'));
      await rejected;
    } finally {
      fail(new Error('opening failed'));
      await Promise.allSettled([rejected]);
    }
    await presentation.settled();
    assert.equal(ownedTabs().length, 0);
  });

  test('serializes overlapping openings and abandons the queued opening after disconnect', async () => {
    await vscode.window.tabGroups.close(ownedTabs(), true);
    let release: () => void = () => { throw new Error('gate not registered'); };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => { throw new Error('listener not registered'); };
    const opening = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    openDiff = async (...args) => {
      calls++;
      started();
      await gate;
      return vscode.commands.executeCommand('vscode.diff', ...args);
    };
    const showing = presentation.showChangeOf(file, controls.changes(file), 0);
    let queued: Promise<void> | undefined;
    try {
      await opening;
      queued = presentation.showChangeOf(file, controls.changes(file), 1);
      reviews.activeSessionChanged(null);
      release();
      await Promise.all([showing, queued, presentation.settled()]);
    } finally {
      release();
      await Promise.allSettled([showing, queued]);
    }
    assert.equal(calls, 1);
    assert.equal(ownedTabs().length, 0);
  });

  test('keeps tracking user takeovers after the virtual original closes while the real file stays open', async () => {
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    const closed = observed(vscode.workspace.onDidCloseTextDocument, () =>
      vscode.workspace.textDocuments.some((document) => document.uri.toString() === diff.original.toString()) ? undefined : true);
    await vscode.window.tabGroups.close(ownedTabs(), true);
    await closed;
    assert.equal(await editor.edit((edit) => edit.replace(new vscode.Range(0, 0, 0, 3), 'USER')), true);
    assert.equal(controls.baseline(file), 'USER\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    assert.equal(controls.changes(file).length, 2);
  });
});
