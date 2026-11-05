import { describe, expect, it, vi } from 'vitest';
import {
  changeSides,
  openReportedChanges,
  openReportedFile,
  type FileEditor,
  type PatchHunk as DiffHunk,
  type ReportedFile
} from '@/core/ReportedFiles';

/** As the chat view sends them, from jsdiff's `parsePatch`, which starts an empty side at line 1 where Git writes 0. */
const hunks = (...given: DiffHunk[]) => ({ kind: 'hunks' as const, hunks: given });
const edit: DiffHunk = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] };
const removal: DiffHunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-x', '-y'] };
const addition: DiffHunk = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] };

/** The files on disk, by path. */
class FakeEditor implements FileEditor {
  constructor(private readonly files: Record<string, string> = {}) {}

  exists = vi.fn<FileEditor['exists']>(async (path) => path in this.files);
  readText = vi.fn<FileEditor['readText']>(async (path) => this.files[path] ?? null);
  open = vi.fn<FileEditor['open']>(async () => {});
  showChanges = vi.fn<FileEditor['showChanges']>(async () => {});
  showInformationMessage = vi.fn<FileEditor['showInformationMessage']>(async () => undefined);
}

describe('the two sides of a reported change', () => {
  it("are a whole file's old and new text as the agent reported them, the old empty for a new file", () => {
    expect(changeSides({ kind: 'wholeFile', oldText: 'a\n', newText: 'b\n' }, 'modify', null)).toEqual({ before: 'a\n', after: 'b\n' });
    expect(changeSides({ kind: 'wholeFile', oldText: null, newText: 'b\n' }, 'add', null)).toEqual({ before: '', after: 'b\n' });
  });

  it('are, for a patch, the file as it is now and that with the patch undone', () => {
    expect(changeSides(hunks(edit), 'modify', 'a\nB\nc\n')).toEqual({ before: 'a\nb\nc\n', after: 'a\nB\nc\n' });
    expect(changeSides(hunks(addition), 'add', 'x\ny\n')).toEqual({ before: '', after: 'x\ny\n' });
  });

  it('are, for a deletion, what the agent removed against an empty file, whatever is at the path now', () => {
    expect(changeSides(hunks(removal), 'delete', null)).toEqual({ before: 'x\ny\n', after: '' });
    expect(changeSides(hunks(removal), 'delete', 'something new\n')).toEqual({ before: 'x\ny\n', after: '' });
  });

  it('keep a last line without a newline as Git marked it', () => {
    const noNewline: DiffHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'] };

    expect(changeSides(hunks(noNewline), 'modify', 'new')).toEqual({ before: 'old', after: 'new' });
  });

  it('are none when the file has changed where the patch touched it, or is gone', () => {
    expect(changeSides(hunks(edit), 'modify', 'a\nX\nc\n')).toBeNull();
    expect(changeSides(hunks(edit), 'modify', null)).toBeNull();
  });
});

describe('Open File', () => {
  it('opens the file at the path the agent reported, inside the workspace or not, without looking for it first', async () => {
    const editor = new FakeEditor();

    await openReportedFile({ path: '/elsewhere/a.ts', operation: 'modify', lines: null }, editor);

    expect(editor.open.mock.calls).toEqual([['/elsewhere/a.ts']]);
    expect(editor.exists).not.toHaveBeenCalled();
  });

  it('opens what the agent removed from a deleted file, as nothing is left to open', async () => {
    const editor = new FakeEditor();

    await openReportedFile({ path: '/work/gone.ts', operation: 'delete', lines: hunks(removal) }, editor);

    expect(editor.showChanges.mock.calls).toEqual([['/work/gone.ts', 'x\ny\n', '']]);
    expect(editor.open).not.toHaveBeenCalled();
  });

  it('opens a deleted file like any other when something is at its path again', async () => {
    const editor = new FakeEditor({ '/work/gone.ts': 'back\n' });

    await openReportedFile({ path: '/work/gone.ts', operation: 'delete', lines: hunks(removal) }, editor);

    expect(editor.open.mock.calls).toEqual([['/work/gone.ts']]);
    expect(editor.showChanges).not.toHaveBeenCalled();
  });

  it('says so when a deleted file is gone and the agent reported none of its content', async () => {
    const editor = new FakeEditor();

    await openReportedFile({ path: '/work/logo.png', operation: 'delete', lines: null }, editor);

    expect(editor.showInformationMessage.mock.calls).toEqual([['/work/logo.png was deleted, and the agent reported none of its content.']]);
    expect(editor.open).not.toHaveBeenCalled();
  });
});

describe('Open Changes', () => {
  it("shows a patch's change against the file as it is now, at the path the file ended at", async () => {
    const editor = new FakeEditor({ '/work/b.ts': 'a\nB\nc\n' });

    await openReportedChanges({ path: '/work/b.ts', operation: 'move', lines: hunks(edit) }, editor);

    expect(editor.showChanges.mock.calls).toEqual([['/work/b.ts', 'a\nb\nc\n', 'a\nB\nc\n']]);
  });

  it('says so when the file has changed since, so the change no longer undoes', async () => {
    const editor = new FakeEditor({ '/work/a.ts': 'a\nX\nc\n' });

    await openReportedChanges({ path: '/work/a.ts', operation: 'modify', lines: hunks(edit) }, editor);

    expect(editor.showInformationMessage.mock.calls).toEqual([
      ['/work/a.ts has changed since the agent reported its change, so the change can no longer be shown.'],
    ]);
    expect(editor.showChanges).not.toHaveBeenCalled();
  });

  it('shows a whole file as reported without reading the file', async () => {
    const editor = new FakeEditor();
    const file: ReportedFile = { path: '/work/a.ts', operation: 'modify', lines: { kind: 'wholeFile', oldText: 'a\n', newText: 'b\n' } };

    await openReportedChanges(file, editor);

    expect(editor.showChanges.mock.calls).toEqual([['/work/a.ts', 'a\n', 'b\n']]);
    expect(editor.readText).not.toHaveBeenCalled();
  });
});
