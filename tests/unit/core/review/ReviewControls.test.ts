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

/**
 * Controls over session `s1`'s review, shown, with `/w/a.ts`, `/w/b.ts` and `/w/c.ts` changed in that order, and
 * `/w/gone.ts` deleted when `deleted` is set; the editors record what they were asked, and `failing` makes restores
 * reject.
 */
async function controls({ deleted = false } = {}) {
  const disk: Record<string, FileContent> = { '/w/a.ts': 'A\n', '/w/b.ts': 'B\n', '/w/c.ts': 'C\n', '/w/gone.ts': null };
  const restored: [string, FileContent][] = [];
  const opened: string[] = [];
  const errors: string[] = [];
  let failing = false;
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
  const subject = new ReviewControls(reviews, {
    activePath: () => active,
    open: async (path) => { opened.push(path); },
    showError: (message) => errors.push(message),
  });
  return {
    controls: subject,
    reviews,
    restored,
    opened,
    errors,
    activate: (path: string | undefined) => { active = path; },
    fail: () => { failing = true; },
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

  it('finds the lines added to a file under review, and none to a file not under review', async () => {
    const { controls: subject } = await controls();
    expect(subject.addedLines('/w/a.ts', 'A\n')).toEqual([{ first: 0, last: 0 }]);
    expect(subject.addedLines('/w/other.ts', 'A\n')).toEqual([]);
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

  it('tells the human when an undo fails, keeping the file under review and opening nothing', async () => {
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
});
