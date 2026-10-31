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
import { createReviewEditors, ReviewPresenters } from '@/adapters/review/ReviewPresenters';
import { observed } from './observed';
import { ReviewSourceControl } from '@/adapters/review/ReviewSourceControl';

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
  let owned: { reviews?: Reviews; sourceControl?: ReviewSourceControl; control?: vscode.SourceControl; presentation?: DiffReviewPresentation; presenters?: ReviewPresenters; takeovers?: ReviewTakeovers; editors?: ReturnType<typeof createReviewEditors> } = {};
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
    await cleanup(() => owned.sourceControl?.dispose());
    await cleanup(() => owned.control?.dispose());
    await cleanup(() => owned.presenters?.dispose());
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

  test('SCM resource clicks open review diffs and reject entries from another shown session', async () => {
    // Capture the real resource group without replacing VS Code's command or SCM implementation.
    const control = owned.control = vscode.scm.createSourceControl('checkpoint-review', 'Checkpoint Review');
    const create = control.createResourceGroup.bind(control);
    let group: vscode.SourceControlResourceGroup | undefined;
    control.createResourceGroup = (...args) => { group = create(...args); return group; };
    owned.sourceControl = new ReviewSourceControl(controls, reviews, control);
    assert.ok(group);
    const click = async (command: vscode.Command) => vscode.commands.executeCommand(command.command, ...(command.arguments ?? []) as unknown[]);
    const live = group.resourceStates.find((resource) => resource.resourceUri.fsPath === file)?.command;
    assert.ok(live);
    assert.equal((await vscode.commands.getCommands(false)).includes(live.command), true, 'SCM owns an executable command');
    assert.equal((await vscode.commands.getCommands(true)).includes(live.command), false, 'SCM callbacks must not become public commands');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await click(live);
    assert.ok(input() instanceof vscode.TabInputTextDiff);
    const deleted = path.join(folder, 'scm-deleted.txt');
    const session = `native-${path.basename(folder)}`;
    await reviews.handleSessionUpdate(session, {
      kind: 'toolCall', toolCallId: 'delete-scm', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: deleted, oldText: 'removed\n', newText: '' } }],
    }, 'v1');
    const resource = group.resourceStates.find((resource) => resource.resourceUri.fsPath === deleted);
    assert.ok(resource?.command);
    await click(resource.command);
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.scheme, 'acp-review-diff');
    assert.deepEqual(presentation.provideFileDecoration(diff.original), { badge: 'D', tooltip: 'Deleted' });
    assert.deepEqual(presentation.provideFileDecoration(diff.modified), { badge: 'D', tooltip: 'Deleted' });
    assert.deepEqual(presentation.provideFileDecoration(vscode.Uri.file(deleted)), { badge: 'D', tooltip: 'Deleted' });
    assert.match(vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '', /\(Deleted\)/);
    assert.equal(fs.existsSync(deleted), false);
    reviews.activeSessionChanged('other');
    await reviews.handleSessionUpdate('other', {
      kind: 'toolCall', toolCallId: 'other-delete', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: deleted, oldText: 'other baseline\n', newText: '' } }],
    }, 'v1');
    await presentation.settled();
    assert.equal(presentation.provideFileDecoration(diff.original), undefined);
    assert.equal(presentation.provideFileDecoration(diff.modified), undefined);
    await click(resource.command);
    assert.equal(ownedTabs().length, 0, 'a stale entry cannot open the newly shown review');
    assert.equal(controls.baseline(deleted), 'other baseline\n');
    owned.sourceControl.dispose();
    delete owned.sourceControl;
    assert.equal((await vscode.commands.getCommands(false)).includes(live.command), false, 'disposing SCM unregisters its callback');
  });

  test('replaces an open review on live deletion and recreation without taking unrelated focus', async () => {
    const other = path.join(folder, 'unrelated.txt');
    fs.writeFileSync(other, 'unrelated\n');
    await vscode.window.showTextDocument(vscode.Uri.file(other), { preview: false });
    const original = ownedTabs()[0]?.input;
    assert.ok(original instanceof vscode.TabInputTextDiff);
    fs.unlinkSync(file);
    reviews.shown()?.read(file, null);
    await presentation.settled();
    const deleted = ownedTabs()[0]?.input;
    assert.ok(deleted instanceof vscode.TabInputTextDiff);
    assert.equal(deleted.modified.scheme, 'acp-review-diff');
    assert.equal((await vscode.workspace.openTextDocument(deleted.original)).getText(), before);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, other);
    assert.equal(presentation.pathOf(original.original), undefined);
    fs.writeFileSync(file, 'recreated\n');
    reviews.shown()?.read(file, 'recreated\n');
    await presentation.settled();
    const recreated = ownedTabs()[0]?.input;
    assert.ok(recreated instanceof vscode.TabInputTextDiff);
    assert.equal(recreated.modified.toString(), vscode.Uri.file(file).toString());
    assert.equal(presentation.activePath(), other);
    assert.equal(presentation.pathOf(deleted.original), undefined);
    assert.equal(presentation.pathOf(deleted.modified), undefined);
    assert.equal(presentation.provideFileDecoration(vscode.Uri.file(file)), undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), 'recreated\n');
    await controls.keepFile(file);
    await presentation.settled();
    assert.equal(ownedTabs().length, 0);
  });

  test('live deletion retains unsaved document edits without recreating or discarding the file', async () => {
    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'UNSAVED\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    fs.unlinkSync(file);
    reviews.shown()?.read(file, null);
    await presentation.settled();
    assert.equal(document.isDirty, true);
    assert.equal(document.getText(), `UNSAVED\n${after}`);
    assert.equal(fs.existsSync(file), false);
    assert.equal(controls.deleted(file), true);
    await controls.keepFile(file);
    await presentation.settled();
    assert.equal(document.isDirty, true);
    assert.equal(fs.existsSync(file), false);
  });

  test('a created file removed again resolves and closes its review without a phantom deletion', async () => {
    const created = path.join(folder, 'created.txt');
    fs.writeFileSync(created, 'new\n');
    await reviews.handleSessionUpdate(`native-${path.basename(folder)}`, {
      kind: 'toolCall', toolCallId: 'created', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: created, oldText: null, newText: 'new\n' } }],
    }, 'v1');
    await presentation.open(created);
    fs.unlinkSync(created);
    reviews.shown()?.read(created, null);
    await presentation.settled();
    assert.equal(controls.baseline(created), undefined);
    assert.equal(ownedTabs().some(({ input }) => input instanceof vscode.TabInputTextDiff && input.modified.fsPath === created), false);
    assert.equal(fs.existsSync(created), false);
  });

  test('SCM quick-diff clicks retain real editors for existing files and native diffs for deleted files', async () => {
    await vscode.workspace.getConfiguration('acp').update('review.presentation', 'quickDiff', vscode.ConfigurationTarget.Global);
    const control = owned.control = vscode.scm.createSourceControl('checkpoint-quick-review', 'Checkpoint Quick Review');
    const create = control.createResourceGroup.bind(control);
    let group: vscode.SourceControlResourceGroup | undefined;
    control.createResourceGroup = (...args) => { group = create(...args); return group; };
    owned.sourceControl = new ReviewSourceControl(controls, reviews, control);
    assert.ok(group);
    const live = group.resourceStates.find((resource) => resource.resourceUri.fsPath === file)?.command;
    assert.ok(live);
    await vscode.commands.executeCommand(live.command, ...(live.arguments ?? []) as unknown[]);
    assert.ok(input() instanceof vscode.TabInputText);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, file);
    const deleted = path.join(folder, 'quick-deleted.txt');
    await reviews.handleSessionUpdate(`native-${path.basename(folder)}`, {
      kind: 'toolCall', toolCallId: 'quick-delete', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: deleted, oldText: '', newText: '' } }],
    }, 'v1');
    const resource = group.resourceStates.find((resource) => resource.resourceUri.fsPath === deleted);
    assert.ok(resource?.command);
    await vscode.commands.executeCommand(resource.command.command, ...(resource.command.arguments ?? []) as unknown[]);
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.scheme, 'acp-review-diff');
    assert.equal(fs.existsSync(deleted), false);
    fs.writeFileSync(deleted, 'recreated\n');
    reviews.shown()?.read(deleted, 'recreated\n');
    await presentation.settled();
    assert.equal(ownedTabs().some(({ input }) => input instanceof vscode.TabInputTextDiff && input.modified.fsPath === deleted), false);
    assert.equal(vscode.window.tabGroups.all.some(({ tabs }) => tabs.some(({ input }) =>
      input instanceof vscode.TabInputText && input.uri.fsPath === deleted)), true);
    assert.equal(fs.readFileSync(deleted, 'utf8'), 'recreated\n');
  });

  for (const baseline of ['removed\ntext\n', '']) {
    for (const setting of ['diffEditor', 'quickDiff']) {
      test(`reviews ${baseline === '' ? 'empty' : 'nonempty'} deletion with ${setting} without opening a disk document`, async () => {
        const deleted = path.join(folder, 'deleted.txt');
        await vscode.workspace.getConfiguration('acp').update('review.presentation', setting, vscode.ConfigurationTarget.Global);
        await reviews.handleSessionUpdate(`native-${path.basename(folder)}`, {
          kind: 'toolCall', toolCallId: 'delete', status: 'completed',
          content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: deleted, oldText: baseline, newText: '' } }],
        }, 'v1');
        assert.deepEqual(reviews.shown()?.file(deleted), { path: deleted, baseline, current: null });
        await presentation.open(deleted);
        const diff = input();
        assert.ok(diff instanceof vscode.TabInputTextDiff);
        assert.equal(diff.original.scheme, 'acp-review-diff');
        assert.notEqual(diff.modified.scheme, 'file');
        assert.notEqual(diff.original.toString(), diff.modified.toString());
        const original = await vscode.workspace.openTextDocument(diff.original);
        const modified = await vscode.workspace.openTextDocument(diff.modified);
        assert.equal(original.getText(), baseline);
        assert.equal(modified.getText(), '');
        assert.equal(vscode.workspace.textDocuments.some((document) => document.uri.scheme === 'file' && document.uri.fsPath === deleted), false);
        assert.equal(fs.existsSync(deleted), false);
        assert.equal(presentation.activePath(), deleted);
        assert.equal(presentation.isOpen(deleted), true);
        assert.equal(controls.position(presentation.activePath()), '2 of 2');
        assert.equal(presentation.pathOf(diff.original), deleted);
        assert.equal(presentation.pathOf(diff.modified), deleted);
        let resources: vscode.Uri[] = [];
        let position: string | undefined;
        owned.presenters = new ReviewPresenters(controls, reviews, {
          review: (_shown, uris) => { resources = uris; },
          position: (text) => { position = text; },
          dispose() {},
        });
    assert.equal(position, '2 of 2');
    await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
    assert.equal(controls.position(presentation.activePath()), '2 of 2');
    await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
    assert.equal(controls.position(presentation.activePath()), '2 of 2');
        assert.ok(resources.some((uri) => uri.toString() === diff.original.toString()));
        assert.ok(resources.some((uri) => uri.toString() === diff.modified.toString()));
        assert.deepEqual(presentation.provideCodeLenses(original), []);
        assert.deepEqual(presentation.provideCodeLenses(modified), []);
        await vscode.window.showTextDocument(modified);
        await vscode.commands.executeCommand('type', { text: 'not writable' });
        assert.equal(modified.getText(), '');
        await presentation.open(deleted);
        await presentation.decide('undo');
        assert.equal(fs.existsSync(deleted), false, 'hunk commands cannot undo a deletion');
        await controls.undoFile();
        await presentation.settled();
        assert.equal(fs.readFileSync(deleted, 'utf8'), baseline);
        assert.equal(reviews.shown()?.file(deleted), undefined);
        assert.equal(presentation.pathOf(diff.original), undefined, 'retired original cannot target a later review');
        assert.equal(presentation.pathOf(diff.modified), undefined, 'retired absence cannot target a later review');
      });
    }
  }

  test('keeps absence through the virtual modified editor without creating a file', async () => {
    const deleted = path.join(folder, 'kept-deletion.txt');
    await reviews.handleSessionUpdate(`native-${path.basename(folder)}`, {
      kind: 'toolCall', toolCallId: 'delete', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: deleted, oldText: 'gone\n', newText: '' } }],
    }, 'v1');
    await presentation.showChange(deleted);
    await controls.keepFile();
    await presentation.settled();
    assert.equal(fs.existsSync(deleted), false);
    assert.equal(reviews.shown()?.file(deleted), undefined);
  });

  test('an existing empty file keeps a real editable modified side', async () => {
    const empty = path.join(folder, 'empty.txt');
    fs.writeFileSync(empty, '');
    await reviews.handleSessionUpdate(`native-${path.basename(folder)}`, {
      kind: 'toolCall', toolCallId: 'empty', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: empty, oldText: 'was full\n', newText: '' } }],
    }, 'v1');
    await presentation.open(empty);
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.equal(diff.modified.toString(), vscode.Uri.file(empty).toString());
    assert.equal(reviews.shown()?.file(empty)?.current, '');
    assert.equal(presentation.provideCodeLenses(await vscode.workspace.openTextDocument(diff.modified)).length, 3);
    await vscode.commands.executeCommand('type', { text: 'editable' });
    assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), 'editable');
    await controls.undoFile(empty);
    await presentation.settled();
  });

  test('both retained deletion URIs stop targeting the file after recreation', async () => {
    const deleted = path.join(folder, 'recreated.txt');
    await reviews.handleSessionUpdate(`native-${path.basename(folder)}`, {
      kind: 'toolCall', toolCallId: 'delete', status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: deleted, oldText: 'gone\n', newText: '' } }],
    }, 'v1');
    await presentation.open(deleted);
    const diff = input();
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    fs.writeFileSync(deleted, 'recreated\n');
    reviews.shown()?.read(deleted, 'recreated\n');
    assert.equal(presentation.pathOf(diff.original), undefined);
    assert.equal(presentation.pathOf(diff.modified), undefined);
    assert.equal(fs.readFileSync(deleted, 'utf8'), 'recreated\n');
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
