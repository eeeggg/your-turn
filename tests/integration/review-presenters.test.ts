import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setup, suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';
import { ReviewPresenters, vscodeReviewEditors, type ReviewDisplay } from '@/adapters/review/ReviewPresenters';
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
const activeText = () => vscode.window.activeTextEditor?.document.getText();

suite('Review presenters', () => {
  let folder: string;
  let reviews: Reviews;
  let controls: ReviewControls;
  let presenters: ReviewPresenters;
  let shown: ReturnType<typeof recording>['shown'];
  let a: string;
  let b: string;

  /** `a.txt` and `b.txt` changed in session `s1`, shown, in that order. */
  setup(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-presenters-'));
    a = path.join(folder, 'a.txt');
    b = path.join(folder, 'b.txt');
    fs.writeFileSync(a, 'one\nadded\n');
    fs.writeFileSync(b, 'B\n');
    reviews = new Reviews(workspaceFiles);
    controls = new ReviewControls(reviews, vscodeReviewEditors);
    const record = recording();
    shown = record.shown;
    presenters = new ReviewPresenters(controls, reviews, record.display);
    reviews.activeSessionChanged('s1');
    await reviews.handleSessionUpdate('s1', edited('t1', a, 'one\n', 'one\nadded\n'), 'v1');
    await reviews.handleSessionUpdate('s1', edited('t2', b, 'b\n', 'B\n'), 'v1');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    presenters.dispose();
    reviews.dispose();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  test("shows the buttons while a session is shown, enabled for a file on the shown review's files only", async () => {
    assert.strictEqual(shown.buttons, true);
    assert.deepStrictEqual(shown.files, [vscode.Uri.file(a).toString(), vscode.Uri.file(b).toString()]);
    controls.keepFile(a);
    assert.deepStrictEqual(shown.files, [vscode.Uri.file(b).toString()]);
    reviews.activeSessionChanged('s2');
    assert.strictEqual(shown.buttons, true);
    assert.deepStrictEqual(shown.files, []);
    reviews.activeSessionChanged(null);
    assert.strictEqual(shown.buttons, false);
  });

  test("shows the active file's place among the files under review, a dash for another file, and 0 of 0 with none", async () => {
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
    controls.keepFile(b);
    assert.strictEqual(shown.position, '– of 1');
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
    assert.strictEqual(activeFile(), gone);
    assert.strictEqual(activeText(), 'gone\n');
    assert.deepStrictEqual(controls.reviewedPaths(), [a, b]);
  });
});
