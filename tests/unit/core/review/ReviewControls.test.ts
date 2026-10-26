import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import type { FileContent } from '@/core/review/Review';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';

/** A completed tool call that changed `path` from `old` to `now`, which the disk holds. */
const edited = (toolCallId: string, path: string, old: string | null, now: string): SessionUpdate => ({
  kind: 'toolCall',
  toolCallId,
  status: 'completed',
  content: [{ kind: 'diff', diff: { kind: 'wholeFile', path, oldText: old, newText: now } }],
});

const lines = (...texts: string[]) => texts.map((text) => `${text}\n`).join('');

/** `/w/m.ts` as the agent left it: two changes from its baseline, lines 2 and 7. */
const twoChanges = { before: lines('1', '2', '3', '4', '5', '6', '7'), after: lines('1', 'TWO', '3', '4', '5', '6', 'SEVEN') };

/** A change of line `line` (0-based) replaced by one line. */
const lineChanged = (line: number) => ({ original: { start: line, end: line + 1 }, modified: { start: line, end: line + 1 } });

/**
 * Controls over session `s1`'s review, shown, with `/w/a.ts`, `/w/b.ts` and `/w/c.ts` changed in that order, then
 * `/w/gone.ts` deleted when `deleted` is set and `/w/m.ts` changed twice when `changes` is; the editors record what
 * they were asked, their open documents being what the disk holds, and `failing` makes restores reject.
 */
async function controls({ deleted = false, changes = false } = {}) {
  const disk: Record<string, FileContent> = { '/w/a.ts': 'A\n', '/w/b.ts': 'B\n', '/w/c.ts': 'C\n', '/w/gone.ts': null, '/w/m.ts': twoChanges.after };
  const documents = new Map<string, string>(Object.entries(disk).flatMap(([path, text]) => text === null ? [] : [[path, text]]));
  const restored: [string, FileContent][] = [];
  const opened: string[] = [];
  const shown: string[] = [];
  const views: string[] = [];
  const errors: string[] = [];
  const saved: string[] = [];
  let failing = false;
  let failSave = false;
  let applies = true;
  let active: string | undefined;
  const reviews = new Reviews({
    read: async (path) => disk[path] ?? null,
    restore: async (path, content) => {
      if (failing) { throw new Error('disk full'); }
      restored.push([path, content]);
      disk[path] = content;
    },
    watch: () => ({ dispose: () => {} }),
  });
  reviews.activeSessionChanged('s1');
  await reviews.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a\n', 'A\n'), 'v1');
  await reviews.handleSessionUpdate('s1', edited('t2', '/w/b.ts', 'b\n', 'B\n'), 'v1');
  await reviews.handleSessionUpdate('s1', edited('t3', '/w/c.ts', 'c\n', 'C\n'), 'v1');
  if (deleted) { await reviews.handleSessionUpdate('s1', edited('t4', '/w/gone.ts', 'gone\n', ''), 'v1'); }
  if (changes) { await reviews.handleSessionUpdate('s1', edited('t5', '/w/m.ts', twoChanges.before, twoChanges.after), 'v1'); }
  const subject = new ReviewControls(reviews, {
    activePath: () => active,
    open: async (path) => { opened.push(path); },
    showChange: async (path) => { shown.push(path); },
    showChangeOf: async (path, changes, index) => {
      views.push(`show ${path} at ${String(changes[index]?.modified.start)} of ${changes.map(({ modified }) => modified.start).join()}`);
    },
    closeChange: async (path) => { views.push(`close ${path} with ${documents.get(path) === twoChanges.after ? 'both' : 'one'}`); },
    showError: (message) => errors.push(message),
    text: (path) => documents.get(path),
    applyEdit: async (path, { start, end, text }) => {
      const document = documents.get(path);
      if (!applies || document === undefined) { return false; }
      documents.set(path, document.slice(0, start) + text + document.slice(end));
      return true;
    },
    save: async (path) => {
      if (failSave) { throw new Error('disk full'); }
      saved.push(path);
    },
  });
  return {
    controls: subject,
    reviews,
    restored,
    opened,
    shown,
    views,
    errors,
    saved,
    documents,
    activate: (path: string | undefined) => { active = path; },
    fail: () => { failing = true; },
    failSaves: () => { failSave = true; },
    refuseEdits: () => { applies = false; },
  };
}

describe('ReviewControls', () => {
  it("lists the shown review's files, and a file's place among them, with a dash for a file not among them", async () => {
    const { controls: subject } = await controls();
    expect(subject.reviewedPaths()).toEqual(['/w/a.ts', '/w/b.ts', '/w/c.ts']);
    expect(subject.position('/w/b.ts')).toBe('2 of 3');
    expect(subject.position('/w/other.ts')).toBe('– of 3');
    expect(subject.position(undefined)).toBe('– of 3');
  });

  it("gives a file's baseline in the shown review, and none for a file not under review or another session's", async () => {
    const { controls: subject, reviews } = await controls({ deleted: true });
    expect(subject.baseline('/w/a.ts')).toBe('a\n');
    expect(subject.baseline('/w/gone.ts')).toBe('gone\n');
    expect(subject.baseline('/w/other.ts')).toBeUndefined();
    subject.keepFile('/w/a.ts');
    expect(subject.baseline('/w/a.ts')).toBeUndefined();
    reviews.activeSessionChanged('s2');
    expect(subject.baseline('/w/b.ts')).toBeUndefined();
  });

  it('places every file as 0 of 0 with nothing under review, a session with no review yet among them', async () => {
    const { controls: subject, reviews } = await controls();
    subject.keepAll();
    expect(subject.position('/w/a.ts')).toBe('0 of 0');
    reviews.activeSessionChanged('s2');
    expect(subject.sessionShown()).toBe(true);
    expect(subject.reviewedPaths()).toEqual([]);
    expect(subject.position(undefined)).toBe('0 of 0');
  });

  it('places nothing with no session shown', async () => {
    const { controls: subject, reviews } = await controls();
    reviews.activeSessionChanged(null);
    expect(subject.sessionShown()).toBe(false);
    expect(subject.position('/w/a.ts')).toBeUndefined();
  });

  it('keeps the file it is given, or the active editor\'s, and every file with Keep All', async () => {
    const { controls: subject, activate } = await controls();
    subject.keepFile('/w/a.ts');
    expect(subject.reviewedPaths()).toEqual(['/w/b.ts', '/w/c.ts']);
    activate('/w/c.ts');
    subject.keepFile();
    expect(subject.reviewedPaths()).toEqual(['/w/b.ts']);
    subject.keepAll();
    expect(subject.reviewedPaths()).toEqual([]);
  });

  it("undoes the file it is given, or the active editor's, restoring its baseline", async () => {
    const { controls: subject, restored, activate, opened } = await controls();
    await subject.undoFile('/w/a.ts');
    activate('/w/b.ts');
    await subject.undoFile();
    expect(restored).toEqual([['/w/a.ts', 'a\n'], ['/w/b.ts', 'b\n']]);
    expect(subject.reviewedPaths()).toEqual(['/w/c.ts']);
    expect(opened).toEqual([]);
  });

  it('opens a deleted file again once it is written back', async () => {
    const { controls: subject, restored, opened } = await controls({ deleted: true });
    await subject.undoFile('/w/gone.ts');
    expect(restored).toEqual([['/w/gone.ts', 'gone\n']]);
    expect(opened).toEqual(['/w/gone.ts']);
  });

  it('tells the user when an undo fails, keeping the file under review and opening nothing', async () => {
    const { controls: subject, errors, fail, opened } = await controls({ deleted: true });
    fail();
    await subject.undoFile('/w/gone.ts');
    expect(errors).toEqual(['gone.ts could not be undone: disk full']);
    expect(subject.reviewedPaths()).toContain('/w/gone.ts');
    expect(opened).toEqual([]);
  });

  it('does nothing for a file not under review, or with no file at all', async () => {
    const { controls: subject, restored } = await controls();
    subject.keepFile('/w/other.ts');
    subject.keepFile();
    await subject.undoFile('/w/other.ts');
    await subject.undoFile();
    expect(restored).toEqual([]);
    expect(subject.reviewedPaths()).toEqual(['/w/a.ts', '/w/b.ts', '/w/c.ts']);
  });

  it('keeps one change by taking it into the baseline and saving the file, the other change staying under review', async () => {
    const { controls: subject, saved, documents } = await controls({ changes: true });
    await subject.keepChange('/w/m.ts', lineChanged(1));
    expect(subject.baseline('/w/m.ts')).toBe(lines('1', 'TWO', '3', '4', '5', '6', '7'));
    expect(documents.get('/w/m.ts')).toBe(twoChanges.after);
    expect(saved).toEqual(['/w/m.ts']);
  });

  it('lets the file go once its last change is kept', async () => {
    const { controls: subject } = await controls({ changes: true });
    await subject.keepChange('/w/m.ts', lineChanged(1));
    await subject.keepChange('/w/m.ts', lineChanged(6));
    expect(subject.reviewedPaths()).toEqual(['/w/a.ts', '/w/b.ts', '/w/c.ts']);
  });

  it("undoes one change by putting the baseline's lines back into the document and saving it", async () => {
    const { controls: subject, saved, documents } = await controls({ changes: true });
    await subject.undoChange('/w/m.ts', lineChanged(6));
    expect(documents.get('/w/m.ts')).toBe(lines('1', 'TWO', '3', '4', '5', '6', '7'));
    expect(subject.baseline('/w/m.ts')).toBe(twoChanges.before);
    expect(saved).toEqual(['/w/m.ts']);
  });

  it("closes quick diff's view before keeping a change, then shows the next change once the file is saved", async () => {
    const { controls: subject, views } = await controls({ changes: true });
    await subject.keepChange('/w/m.ts', lineChanged(1));
    expect(views).toEqual(['close /w/m.ts with both', 'show /w/m.ts at 6 of 6']);
  });

  it('shows the first change after undoing the last, and none once the file has no change left', async () => {
    const { controls: subject, views } = await controls({ changes: true });
    await subject.undoChange('/w/m.ts', lineChanged(6));
    await subject.keepChange('/w/m.ts', lineChanged(1));
    expect(views).toEqual(['close /w/m.ts with both', 'show /w/m.ts at 1 of 1', 'close /w/m.ts with one']);
  });

  it('does nothing for a change that is no longer between the baseline and the document, as VS Code diffed before the agent wrote', async () => {
    const { controls: subject, saved, documents } = await controls({ changes: true });
    documents.set('/w/m.ts', lines('0', '1', 'TWO', '3', '4', '5', '6', 'SEVEN'));
    await subject.keepChange('/w/m.ts', lineChanged(1));
    await subject.undoChange('/w/m.ts', lineChanged(6));
    expect(subject.baseline('/w/m.ts')).toBe(twoChanges.before);
    expect(documents.get('/w/m.ts')).toBe(lines('0', '1', 'TWO', '3', '4', '5', '6', 'SEVEN'));
    expect(saved).toEqual([]);
  });

  it('does nothing for a change of a file not under review, or not open', async () => {
    const { controls: subject, saved, documents } = await controls({ changes: true });
    documents.delete('/w/m.ts');
    await subject.keepChange('/w/m.ts', lineChanged(1));
    await subject.undoChange('/w/other.ts', lineChanged(0));
    expect(subject.baseline('/w/m.ts')).toBe(twoChanges.before);
    expect(saved).toEqual([]);
  });

  it('tells the user when an undo is not applied or a save fails, saving nothing after an undo not applied', async () => {
    const { controls: subject, saved, errors, refuseEdits, failSaves } = await controls({ changes: true });
    refuseEdits();
    await subject.undoChange('/w/m.ts', lineChanged(6));
    failSaves();
    await subject.keepChange('/w/m.ts', lineChanged(1));
    expect(errors).toEqual(['m.ts: the change could not be undone', 'm.ts: the change was kept but the file could not be saved: disk full']);
    expect(saved).toEqual([]);
    expect(subject.baseline('/w/m.ts')).toBe(lines('1', 'TWO', '3', '4', '5', '6', '7'));
  });

  it('opens the next and previous files, going round at either end', async () => {
    const { controls: subject, opened, activate } = await controls();
    await subject.next('/w/b.ts');
    await subject.next('/w/c.ts');
    await subject.previous('/w/a.ts');
    activate('/w/b.ts');
    await subject.previous();
    expect(opened).toEqual(['/w/c.ts', '/w/a.ts', '/w/c.ts', '/w/a.ts']);
  });

  it('opens the first file going forward from a file not under review, and the last going back', async () => {
    const { controls: subject, opened } = await controls();
    await subject.next('/w/other.ts');
    await subject.previous(undefined);
    expect(opened).toEqual(['/w/a.ts', '/w/c.ts']);
  });

  it('opens nothing with no file under review', async () => {
    const { controls: subject, opened, reviews } = await controls();
    reviews.activeSessionChanged(null);
    await subject.next('/w/a.ts');
    await subject.previous('/w/a.ts');
    expect(opened).toEqual([]);
  });

  it('shows the first unresolved file when a turn ends, regardless of the active editor, and none with no file', async () => {
    const { controls: subject, shown, activate, reviews } = await controls();
    activate('/w/b.ts');
    await subject.turnEnded('s1');
    activate('/w/other.ts');
    await subject.turnEnded('s1');
    reviews.activeSessionChanged(null);
    await subject.turnEnded('s1');
    expect(shown).toEqual(['/w/a.ts', '/w/a.ts']);
  });

  it("shows no deleted file's change, as no editor shows it", async () => {
    const { controls: subject, shown, activate } = await controls({ deleted: true });
    activate('/w/gone.ts');
    await subject.turnEnded('s1');
    expect(shown).toEqual(['/w/a.ts']);
  });

  it('shows a change once the files the turn\'s edits name were read, as the turn can end before', async () => {
    const { controls: subject, shown, reviews } = await controls();
    reviews.shown()?.keepAll();
    void reviews.handleSessionUpdate('s1', edited('t6', '/w/b.ts', 'b\n', 'B\n'), 'v1');
    await subject.turnEnded('s1');
    expect(shown).toEqual(['/w/b.ts']);
  });

  it("shows a change of a file the user comes to while it is under review, none of a file not under review or deleted", async () => {
    const { controls: subject, shown, reviews } = await controls({ deleted: true });
    await subject.entered('/w/b.ts');
    await subject.entered('/w/other.ts');
    await subject.entered('/w/gone.ts');
    reviews.shown()?.keepFile('/w/a.ts');
    await subject.entered('/w/a.ts');
    expect(shown).toEqual(['/w/b.ts']);
  });
});
