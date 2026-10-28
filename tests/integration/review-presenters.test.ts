import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setup, suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';
import { ReviewPresenters, createReviewEditors, type ReviewDisplay } from '@/adapters/review/ReviewPresenters';
import { workspaceFiles } from '@/adapters/review/WorkspaceFiles';

/** A completed tool call that changed `file` from `old` to `now`, the empty text with nothing there for a deletion. */
const edited = (toolCallId: string, file: string, old: string, now: string): SessionUpdate => ({
  kind: 'toolCall',
  toolCallId,
  status: 'completed',
  content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: file, oldText: old, newText: now } }],
});

/** What was last put on screen: whether the buttons are, the files that enable those for a file, and the status bar's text. */
function recording() {
  const shown = {
    buttons: false,
    files: [] as string[],
    position: undefined as string | undefined,
    paused: false,
  };
  const display: ReviewDisplay = {
    review: (sessionShown, files) => {
      shown.buttons = sessionShown;
      shown.files = files.map((uri) => uri.toString());
    },
    position: (text) => { shown.position = text; },
    paused: (paused) => { shown.paused = paused; },
    dispose: () => {},
  };
  return { shown, display };
}

const open = async (file: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
const activeFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

suite('Review presenters', () => {
  let folder: string;
  let reviews: Reviews;
  let controls: ReviewControls;
  let shown: ReturnType<typeof recording>['shown'];
  let a: string;
  let b: string;
  let prior: unknown;
  let owned: { reviews?: Reviews; presenters?: ReviewPresenters; editors?: ReturnType<typeof createReviewEditors> } = {};

  /** `a.txt` and `b.txt` changed in session `s1`, shown, in that order. */
  setup(async () => {
    owned = {};
    folder = '';
    prior = vscode.workspace.getConfiguration('acp').inspect('review.presentation')?.globalValue;
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-presenters-'));
    a = path.join(folder, 'a.txt');
    b = path.join(folder, 'b.txt');
    fs.writeFileSync(a, 'one\nadded\n');
    fs.writeFileSync(b, 'B\n');
    owned.reviews = reviews = new Reviews(workspaceFiles);
    owned.editors = createReviewEditors();
    controls = new ReviewControls(reviews, owned.editors);
    const record = recording();
    shown = record.shown;
    owned.presenters = new ReviewPresenters(controls, reviews, record.display);
    reviews.activeSessionChanged('s1');
    await reviews.handleSessionUpdate('s1', edited('t1', a, 'one\n', 'one\nadded\n'), 'v1');
    await reviews.handleSessionUpdate('s1', edited('t2', b, 'b\n', 'B\n'), 'v1');
  });

  teardown(async function () {
    const failures: unknown[] = [];
    const cleanup = async (action: () => unknown) => {
      try { await action(); } catch (error) { failures.push(error); }
    };
    await Promise.all([
      cleanup(() => owned.presenters?.dispose()),
      cleanup(() => owned.editors?.dispose()),
      cleanup(() => owned.reviews?.dispose()),
    ]);
    await cleanup(() => vscode.commands.executeCommand('workbench.action.files.revert'));
    await cleanup(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));
    await cleanup(() => vscode.workspace.getConfiguration('acp').update('review.presentation', prior, vscode.ConfigurationTarget.Global));
    await cleanup(() => { if (folder) { fs.rmSync(folder, { recursive: true, force: true }); } });
    if (failures.length > 0) {
      const error = new AggregateError(failures, 'Failed to clean up review presenters');
      if (this.currentTest?.err) { console.error(error); } else { throw error; }
    }
  });

  test("shows the buttons while a session is shown, enabled for a file on the shown review's files only", async () => {
    assert.strictEqual(shown.buttons, true);
    assert.deepStrictEqual(shown.files, [vscode.Uri.file(a).toString(), vscode.Uri.file(b).toString()]);
    await controls.keepFile(a);
    assert.deepStrictEqual(shown.files, [vscode.Uri.file(b).toString()]);
    reviews.activeSessionChanged('s2');
    assert.strictEqual(shown.buttons, true);
    assert.deepStrictEqual(shown.files, []);
    reviews.activeSessionChanged(null);
    assert.strictEqual(shown.buttons, false);
  });

  test('disposal stops display updates and drains a presentation already started by tab entry', async () => {
    const config = vscode.workspace.getConfiguration('acp');
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opening = new Promise<void>((resolve) => { started = resolve; });
    let finished = false;
    let updates = 0;
    await owned.presenters?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await config.update('review.presentation', 'quickDiff', vscode.ConfigurationTarget.Global);
    assert.ok(owned.editors);
    const subject = new ReviewPresenters(new ReviewControls(reviews, {
      ...owned.editors,
      showChange: async () => { started(); await gate; finished = true; },
    }), reviews, {
      review: () => { updates++; }, position: () => { updates++; }, paused: () => { updates++; }, dispose: () => {},
    });
    owned.presenters = subject;
    try {
      await open(a);
      await opening;
      const disposed = subject.dispose();
      const finishedAtDisposal = Promise.resolve(disposed).then(() => finished);
      assert.strictEqual(subject.dispose(), disposed);
      const before = updates;
      reviews.shown()?.keepFile(b);
      subject.turnInProgress(true);
      await open(b);
      release();
      await disposed;
      await subject.settled();

      assert.strictEqual(await finishedAtDisposal, true);
      assert.strictEqual(updates, before);
      assert.deepStrictEqual(controls.reviewedPaths(), [a]);
    } finally {
      release();
      await subject.settled();
      await subject.dispose();
    }
  });

  test('quick-diff disposal cancels a retry wait and issues no later editor command', async () => {
    const commands: string[] = [];
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = false;
    let waitFinished = false;
    const editors = createReviewEditors(
      async (command) => { commands.push(command); },
      (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled = true;
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        started();
      }).finally(() => { waitFinished = true; }),
    );
    const showing = editors.showChange(a);
    try {
      await waiting;
      const disposed = editors.dispose();
      const finishedAtDisposal = disposed.then(() => waitFinished);
      assert.strictEqual(editors.dispose(), disposed);
      await disposed;
      await showing;
      assert.strictEqual(cancelled, true);
      assert.strictEqual(await finishedAtDisposal, true);
      assert.deepStrictEqual(commands, ['editor.action.dirtydiff.next']);
      await editors.showChange(b);
      await editors.showChangeOf(a, controls.changes(a), 0);
      await editors.open(b);
      assert.deepStrictEqual(commands, ['editor.action.dirtydiff.next']);
    } finally {
      await editors.dispose();
      await showing;
    }
  });

  for (const operation of ['open', 'showChange', 'showChangeOf'] as const) {
    test(`quick-diff disposal drains an accepted ${operation} command without starting another`, async () => {
      let release: () => void = () => {};
      let started: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const commandStarted = new Promise<void>((resolve) => { started = resolve; });
      const commands: string[] = [];
      let finished = false;
      const editors = createReviewEditors(async (command, ...args) => {
        commands.push(command);
        started();
        await gate;
        await vscode.commands.executeCommand(command, ...args);
        finished = true;
      }, async () => { throw new Error('disposed work must not start a retry wait'); });
      const showing = operation === 'showChangeOf'
        ? editors.showChangeOf(a, [{ original: { start: 1, end: 1 }, modified: { start: 1, end: 2 } }], 0)
        : editors[operation](a);
      try {
        await commandStarted;
        const disposed = editors.dispose();
        const finishedAtDisposal = disposed.then(() => finished);
        release();
        await disposed;
        await showing;
        assert.strictEqual(await finishedAtDisposal, true);
        assert.deepStrictEqual(commands, [operation === 'open' ? 'vscode.open'
          : operation === 'showChange' ? 'editor.action.dirtydiff.next' : 'workbench.action.editor.nextChange']);
      } finally {
        release();
        await Promise.allSettled([showing, editors.dispose()]);
      }
    });
  }

  test('quick-diff disposal drains a sibling command before reporting an accepted command failure', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error('opening failed during shutdown');
    let siblingFinished = false;
    const editors = createReviewEditors(async (_command, uri) => {
      if (uri instanceof vscode.Uri && uri.fsPath === a) { throw failure; }
      await gate;
      siblingFinished = true;
    });
    const opening = editors.open(a);
    const rejected = assert.rejects(opening, (error: unknown) => error === failure);
    const sibling = editors.open(b);
    try {
      const disposed = editors.dispose();
      const finishedAtDisposal = disposed.then(() => siblingFinished, () => siblingFinished);
      const failedDisposal = assert.rejects(disposed, (error: unknown) =>
        error instanceof AggregateError && error.errors.includes(failure));
      release();
      await Promise.all([rejected, sibling, failedDisposal]);
      assert.strictEqual(await finishedAtDisposal, true);
    } finally {
      release();
      await Promise.allSettled([opening, sibling, editors.dispose()]);
    }
  });

  test('a superseded quick-diff presentation awaits its replacement during disposal', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const commandStarted = new Promise<void>((resolve) => { started = resolve; });
    let finished = false;
    const editors = createReviewEditors(async (command, ...args) => {
      started();
      await gate;
      await vscode.commands.executeCommand(command, ...args);
      finished = true;
    }, async () => { throw new Error('disposed work must not start a retry wait'); });
    const earlier = editors.showChange(a);
    const finishedAtEarlierCompletion = earlier.then(() => finished);
    const replacement = editors.showChange(a);
    try {
      await commandStarted;
      const disposed = editors.dispose();
      release();
      await disposed;
      await Promise.all([earlier, replacement]);
      assert.strictEqual(await finishedAtEarlierCompletion, true);
    } finally {
      release();
      await Promise.allSettled([earlier, replacement, editors.dispose()]);
    }
  });

  test("shows the active file's place among the files under review and advances after keeping it", async () => {
    await open(a);
    assert.strictEqual(shown.position, '1 of 2');
    await open(b);
    assert.strictEqual(shown.position, '2 of 2');
    const other = path.join(folder, 'other.txt');
    fs.writeFileSync(other, 'other\n');
    await open(other);
    assert.strictEqual(shown.position, '– of 2');
    await vscode.window.showTextDocument(vscode.Uri.file(b));
    assert.strictEqual(shown.position, '2 of 2');
    await controls.keepFile(b);
    assert.strictEqual(activeFile(), a);
    assert.strictEqual(shown.position, '1 of 1');
    controls.keepAll();
    assert.strictEqual(shown.position, '0 of 0');
    reviews.activeSessionChanged(null);
    assert.strictEqual(shown.position, undefined);
  });

  test('moves to the next and previous files, opening them, round from the last to the first', async () => {
    await open(a);
    await controls.next();
    assert.strictEqual(activeFile(), b);
    await controls.next();
    assert.strictEqual(activeFile(), a);
    await controls.previous();
    assert.strictEqual(activeFile(), b);
  });

  test("undoes a deleted file from its editor, which says it was not found, and opens it again with its baseline", async () => {
    const gone = path.join(folder, 'gone.txt');
    await reviews.handleSessionUpdate('s1', edited('t3', gone, 'gone\n', ''), 'v1');
    await controls.previous(a);
    assert.strictEqual(shown.position, '3 of 3');
    assert.strictEqual(activeFile(), undefined);

    await controls.undoFile();

    assert.strictEqual(fs.readFileSync(gone, 'utf8'), 'gone\n');
    assert.strictEqual(activeFile(), a);
    assert.deepStrictEqual(controls.reviewedPaths(), [a, b]);
  });
});
