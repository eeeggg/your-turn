import { describe, expect, it, onTestFinished } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import type { FileContent } from '@/core/review/Review';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';

const SESSION_ID = { sessionId: 'e6a9042f-7b38-46d1-9c52-130fb8ade765', agentName: 'fake', agentId: 'source' };
const OTHER_SESSION_ID = { ...SESSION_ID, sessionId: '410dc953-ae62-4f78-b905-67e8213acdb4' };
const input = (update: SessionUpdate) => ({ origin: { identity: { configuredName: 'fake', sessionId: SESSION_ID.sessionId }, sourceId: 'source' }, update, schema: 'v1' as const });

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
 * Controls over the shown session's review, with `/w/a.ts`, `/w/b.ts` and `/w/c.ts` changed in that order, then
 * `/w/gone.ts` deleted when `deleted` is set and `/w/m.ts` changed twice when `changes` is; the editors record what
 * they were asked, their open documents being what the disk holds, and `failing` makes restores reject.
 */
async function controls({ deleted = false, changes = false, canRevealDeferred = true } = {}) {
  const disk: Record<string, FileContent> = { '/w/a.ts': 'A\n', '/w/b.ts': 'B\n', '/w/c.ts': 'C\n', '/w/gone.ts': null, '/w/m.ts': twoChanges.after };
  const documents = new Map<string, string>(Object.entries(disk).flatMap(([path, text]) => text === null ? [] : [[path, text]]));
  const versions = new Map<string, number>();
  const watchers = new Map<string, () => void>();
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
  let navigation = 0;
  let blocked = false;
  let followUp: ((current?: () => boolean) => void) | undefined;
  let read = async (path: string): Promise<FileContent> => disk[path] ?? null;
  const reviews = new Reviews({
    read: (path) => read(path),
    restore: async (path, content) => {
      if (failing) { throw new Error('disk full'); }
      restored.push([path, content]);
      disk[path] = content;
    },
    watch: (path, changed) => { watchers.set(path, changed); return { dispose: () => { watchers.delete(path); } }; },
    snapshot: (path) => {
      const text = documents.get(path);
      return text === undefined ? undefined : { instance: documents, version: versions.get(path) ?? 1, dirty: false, text };
    },
    applyEdit: async (path, { start, end, text }, current) => {
      const document = documents.get(path);
      if (!current() || !applies || document === undefined) { return false; }
      documents.set(path, document.slice(0, start) + text + document.slice(end));
      versions.set(path, (versions.get(path) ?? 1) + 1);
      return true;
    },
    save: async (path) => {
      if (failSave) { throw new Error('disk full'); }
      saved.push(path);
      const text = documents.get(path);
      if (text !== undefined) {
        disk[path] = text;
        watchers.get(path)?.();
      }
    },
  }, {
    resolutionBlocked: () => blocked, onChanged: () => () => {},
    runDecision: async (action) => blocked ? { kind: 'blocked' } : { kind: 'completed', value: await action(() => true) },
  });
  onTestFinished(async () => { await reviews.dispose(); });
  reviews.activeSessionChanged(SESSION_ID);
  await reviews.handleSessionUpdate(input(edited('t1', '/w/a.ts', 'a\n', 'A\n')));
  await reviews.handleSessionUpdate(input(edited('t2', '/w/b.ts', 'b\n', 'B\n')));
  await reviews.handleSessionUpdate(input(edited('t3', '/w/c.ts', 'c\n', 'C\n')));
  if (deleted) { await reviews.handleSessionUpdate(input(edited('t4', '/w/gone.ts', 'gone\n', ''))); }
  if (changes) { await reviews.handleSessionUpdate(input(edited('t5', '/w/m.ts', twoChanges.before, twoChanges.after))); }
  const subject = new ReviewControls(reviews, {
    captureNavigation: () => { const captured = navigation; return () => navigation === captured; },
    activePath: () => active,
    isOpen: (path) => active === path || opened.includes(path) || shown.includes(path),
    open: async (path, current) => { followUp?.(current); if (!current || current()) { opened.push(path); } },
    showChange: async (path, current) => {
      followUp?.(current);
      if (current && !current()) { return; }
      shown.push(path);
    },
    showChangeOf: async (path, changes, index) => {
      views.push(`show ${path} at ${String(changes[index]?.modified.start)} of ${changes.map(({ modified }) => modified.start).join()}`);
    },
    closeChange: async (path) => { views.push(`close ${path} with ${documents.get(path) === twoChanges.after ? 'both' : 'one'}`); },
    showError: (message) => errors.push(message),
    text: (path) => documents.get(path),
  }, () => canRevealDeferred);
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
    disk,
    setRead: (next: typeof read) => { read = next; },
    activate: (path: string | undefined) => { active = path; navigation++; },
    fail: () => { failing = true; },
    failSaves: () => { failSave = true; },
    refuseEdits: () => { applies = false; },
    block: () => { blocked = true; },
    beforeFollowUp: (action: (current?: () => boolean) => void) => { followUp = action; },
  };
}

describe('ReviewControls', () => {
  it('does not open a deferred review in quick diff mode but keeps selected turn-end behavior', async () => {
    const { controls: subject, shown } = await controls({ canRevealDeferred: false });
    expect(await subject.turnEnded(SESSION_ID, () => true, true)).toBe('not-automatic');
    expect(shown).toEqual([]);
    expect(await subject.turnEnded(SESSION_ID)).toBe('opened');
    expect(shown).toEqual(['/w/a.ts']);
  });

  it('reports an invalidated attempt when an editor rejects the final guard', async () => {
    const { controls: subject, reviews, shown, beforeFollowUp } = await controls();
    beforeFollowUp(() => reviews.activeSessionChanged(OTHER_SESSION_ID));
    const attempt = await subject.turnEnded(SESSION_ID);
    expect(attempt).toBe('invalidated');
    expect(shown).toEqual([]);
  });

  it('guards final advancement against a session switch inside editor preparation', async () => {
    const { controls: subject, reviews, opened, activate, beforeFollowUp } = await controls();
    activate('/w/a.ts');
    beforeFollowUp(() => reviews.activeSessionChanged(OTHER_SESSION_ID));
    await subject.keepFile();
    expect(opened).toEqual([]);
  });
  it.each(['keep-file', 'undo-file', 'keep-all', 'keep-change', 'undo-change'] as const)('blocks %s through authority without effects or advancement', async (action) => {
    const { controls: subject, block, opened, saved, restored, activate, documents } = await controls({ changes: true });
    activate('/w/m.ts');
    block();
    switch (action) {
      case 'keep-file': await subject.keepFile('/w/m.ts'); break;
      case 'undo-file': await subject.undoFile('/w/m.ts'); break;
      case 'keep-all': await subject.keepAll(); break;
      case 'keep-change': await subject.keepChange('/w/m.ts', lineChanged(1)); break;
      case 'undo-change': await subject.undoChange('/w/m.ts', lineChanged(1)); break;
    }
    expect(subject.reviewedPaths()).toEqual(['/w/a.ts', '/w/b.ts', '/w/c.ts', '/w/m.ts']);
    expect(documents.get('/w/m.ts')).toBe(twoChanges.after);
    expect(opened).toEqual([]);
    expect(saved).toEqual([]);
    expect(restored).toEqual([]);
  });

  it('does not cancel selected A presentation when sibling B emits output and ends its turn', async () => {
    const { controls: subject, shown, reviews, setRead } = await controls();
    await subject.keepAll();
    let release: (text: FileContent) => void = () => {};
    setRead(() => new Promise((resolve) => { release = resolve; }));
    const reading = reviews.handleSessionUpdate(input(edited('late', '/w/b.ts', 'b\n', 'B\n')));
    const presenting = subject.turnEnded(SESSION_ID);
    await reviews.handleSessionUpdate({ origin: {
      identity: { configuredName: OTHER_SESSION_ID.agentName, sessionId: OTHER_SESSION_ID.sessionId }, sourceId: OTHER_SESSION_ID.agentId,
    }, update: { kind: 'agentText', messageId: null, text: 'B finished' }, schema: 'v1' });
    await subject.turnEnded(OTHER_SESSION_ID);
    release('B\n');
    await Promise.all([reading, presenting]);
    expect(shown).toEqual(['/w/b.ts']);
  });

  it('does not open after editor navigation away and back during evidence settlement', async () => {
    const { controls: subject, shown, reviews, setRead, activate } = await controls();
    await subject.keepAll();
    let release: (text: FileContent) => void = () => {};
    setRead(() => new Promise((resolve) => { release = resolve; }));
    const reading = reviews.handleSessionUpdate(input(edited('late', '/w/b.ts', 'b\n', 'B\n')));
    const presenting = subject.turnEnded(SESSION_ID);
    activate('/w/other.ts');
    activate(undefined);
    release('B\n');
    await Promise.all([reading, presenting]);
    expect(shown).toEqual([]);
    expect(subject.reviewedPaths()).toEqual(['/w/b.ts']);
  });

  it.each(['switch', 'away-back', 'remove', 'retire'] as const)('does not present a settled turn after registration invalidation by %s', async (change) => {
    const { controls: subject, shown, reviews, setRead } = await controls();
    await subject.keepAll();
    let release: (text: FileContent) => void = () => {};
    setRead(() => new Promise((resolve) => { release = resolve; }));
    const reading = reviews.handleSessionUpdate(input(edited('late', '/w/b.ts', 'b\n', 'B\n')));
    const presenting = subject.turnEnded(SESSION_ID);
    if (change === 'remove') { reviews.sessionRemoved(SESSION_ID); }
    else if (change === 'retire') { reviews.sourceRetired(SESSION_ID.agentId); }
    else {
      reviews.activeSessionChanged(OTHER_SESSION_ID);
      if (change === 'away-back') { reviews.activeSessionChanged(SESSION_ID); }
    }
    release('B\n');
    await Promise.all([reading, presenting]);
    expect(shown).toEqual([]);
    reviews.activeSessionChanged(SESSION_ID);
    expect(subject.reviewedPaths()).toEqual(['/w/b.ts']);
  });

  it.each(['keep', 'undo'] as const)('rejects %s File for a deletion recreated before its watcher reads it', async (action) => {
    const { controls: subject, reviews, disk, restored, saved } = await controls({ deleted: true });
    disk['/w/gone.ts'] = 'recreated\n';
    if (action === 'keep') { await subject.keepFile('/w/gone.ts'); }
    else { await subject.undoFile('/w/gone.ts'); }
    expect(disk['/w/gone.ts']).toBe('recreated\n');
    expect(reviews.shown()?.file('/w/gone.ts')).toEqual({ path: '/w/gone.ts', baseline: 'gone\n', current: null });
    expect(restored).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('offers no text changes for a deletion even when an old disk document is still open', async () => {
    const { controls: subject, documents, saved, restored } = await controls({ deleted: true });
    documents.set('/w/gone.ts', 'stale document\n');
    expect(subject.changes('/w/gone.ts')).toEqual([]);
    await subject.keepChange('/w/gone.ts', lineChanged(0));
    await subject.undoChange('/w/gone.ts', lineChanged(0));
    expect(subject.baseline('/w/gone.ts')).toBe('gone\n');
    expect(saved).toEqual([]);
    expect(restored).toEqual([]);
  });

  it('keeps a deletion without restoring or saving a document', async () => {
    const { controls: subject, disk, saved, restored } = await controls({ deleted: true });
    await subject.keepFile('/w/gone.ts');
    expect(subject.baseline('/w/gone.ts')).toBeUndefined();
    expect(disk['/w/gone.ts']).toBeNull();
    expect(saved).toEqual([]);
    expect(restored).toEqual([]);
  });

  it.each(['keep', 'undo'] as const)('rejects %s when the shown session changes during its absence check', async (action) => {
    const { controls: subject, reviews, restored, setRead } = await controls({ deleted: true });
    let release: (content: FileContent) => void = () => {};
    const checked = new Promise<FileContent>((resolve) => { release = resolve; });
    setRead(async () => checked);
    try {
      const deciding = action === 'keep' ? subject.keepFile('/w/gone.ts') : subject.undoFile('/w/gone.ts');
      reviews.activeSessionChanged(OTHER_SESSION_ID);
      release(null);
      await deciding;
      reviews.activeSessionChanged(SESSION_ID);
      expect(subject.baseline('/w/gone.ts')).toBe('gone\n');
      expect(restored).toEqual([]);
    } finally { release(null); }
  });

  it('maps a cursor on either side to a current change, including a deletion anchor', async () => {
    const { controls: subject, documents } = await controls({ changes: true });
    expect(subject.changeAt('/w/m.ts', 6, 'original')).toEqual({ change: lineChanged(6), index: 1, total: 2 });
    documents.set('/w/m.ts', lines('1', '3', '4', '5', '6', '7'));
    expect(subject.changeAt('/w/m.ts', 0, 'modified')).toEqual({
      change: { original: { start: 1, end: 2 }, modified: { start: 1, end: 1 } }, index: 0, total: 1,
    });
    expect(subject.changeAt('/w/other.ts', 0, 'modified')).toBeUndefined();
  });

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
    await subject.keepFile('/w/a.ts');
    expect(subject.baseline('/w/a.ts')).toBeUndefined();
    reviews.activeSessionChanged(OTHER_SESSION_ID);
    expect(subject.baseline('/w/b.ts')).toBeUndefined();
  });

  it('places every file as 0 of 0 with nothing under review, a session with no review yet among them', async () => {
    const { controls: subject, reviews } = await controls();
    await subject.keepAll();
    expect(subject.position('/w/a.ts')).toBe('0 of 0');
    reviews.activeSessionChanged(OTHER_SESSION_ID);
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
    await subject.keepFile('/w/a.ts');
    expect(subject.reviewedPaths()).toEqual(['/w/b.ts', '/w/c.ts']);
    activate('/w/c.ts');
    await subject.keepFile();
    expect(subject.reviewedPaths()).toEqual(['/w/b.ts']);
    await subject.keepAll();
    expect(subject.reviewedPaths()).toEqual([]);
  });

  it('opens the next unresolved file after Keep File removes the active file from review', async () => {
    const { controls: subject, opened, activate } = await controls();
    activate('/w/b.ts');

    await subject.keepFile();

    expect(subject.reviewedPaths()).toEqual(['/w/a.ts', '/w/c.ts']);
    expect(opened).toEqual(['/w/c.ts']);
  });

  it("undoes the file it is given, or the active editor's, restoring its baseline", async () => {
    const { controls: subject, restored, activate, opened } = await controls();
    await subject.undoFile('/w/a.ts');
    activate('/w/b.ts');
    await subject.undoFile();
    expect(restored).toEqual([['/w/a.ts', 'a\n'], ['/w/b.ts', 'b\n']]);
    expect(subject.reviewedPaths()).toEqual(['/w/c.ts']);
    expect(opened).toEqual(['/w/c.ts']);
  });

  it('opens the next unresolved file after undoing the active file', async () => {
    const { controls: subject, opened, activate } = await controls();
    activate('/w/b.ts');

    await subject.undoFile();

    expect(subject.reviewedPaths()).toEqual(['/w/a.ts', '/w/c.ts']);
    expect(opened).toEqual(['/w/c.ts']);
  });

  it('does not advance after a failed Undo File that remains under review', async () => {
    const { controls: subject, opened, activate, fail } = await controls();
    activate('/w/b.ts');
    fail();

    await subject.undoFile();

    expect(subject.reviewedPaths()).toContain('/w/b.ts');
    expect(opened).toEqual([]);
  });

  it('opens a deleted file again once it is written back', async () => {
    const { controls: subject, restored, opened } = await controls({ deleted: true });
    await subject.undoFile('/w/gone.ts');
    expect(restored).toEqual([['/w/gone.ts', 'gone\n']]);
    expect(opened).toEqual(['/w/gone.ts']);
  });

  it('opens the next unresolved file instead of briefly opening an undone active deletion', async () => {
    const { controls: subject, opened, activate } = await controls({ deleted: true });
    activate('/w/gone.ts');

    await subject.undoFile();

    expect(opened).toEqual(['/w/a.ts']);
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
    await subject.keepFile('/w/other.ts');
    await subject.keepFile();
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

  it('opens the next unresolved file only after the last hunk resolves the active file', async () => {
    const { controls: subject, opened, activate } = await controls({ changes: true });
    activate('/w/m.ts');

    await subject.keepChange('/w/m.ts', lineChanged(1));
    expect(opened).toEqual([]);
    expect(subject.reviewedPaths()).toContain('/w/m.ts');

    await subject.keepChange('/w/m.ts', lineChanged(6));

    expect(subject.reviewedPaths()).not.toContain('/w/m.ts');
    expect(opened).toEqual(['/w/a.ts']);
  });

  it('opens the next unresolved file after undoing the last hunk of the active file', async () => {
    const { controls: subject, opened, activate, reviews, documents } = await controls({ changes: true });
    activate('/w/m.ts');

    await subject.undoChange('/w/m.ts', lineChanged(6));
    expect(opened).toEqual([]);
    expect(subject.reviewedPaths()).toContain('/w/m.ts');

    await subject.undoChange('/w/m.ts', lineChanged(1));

    expect(documents.get('/w/m.ts')).toBe(twoChanges.before);
    expect(reviews.shown()?.file('/w/m.ts')).toBeUndefined();
    expect(subject.reviewedPaths()).not.toContain('/w/m.ts');
    expect(opened).toEqual(['/w/a.ts']);
  });

  it('does not advance after resolving a file other than the active file', async () => {
    const { controls: subject, opened, activate } = await controls({ changes: true });
    activate('/w/a.ts');

    await subject.keepChange('/w/m.ts', lineChanged(1));
    await subject.keepChange('/w/m.ts', lineChanged(6));

    expect(opened).toEqual([]);
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

  it('opens the first unresolved file, ignoring the active editor and honoring removed files, and none with no review', async () => {
    const { controls: subject, shown, activate, reviews } = await controls();
    activate('/w/b.ts');
    await subject.openReview();
    activate('/w/other.ts');
    await subject.openReview();
    await subject.keepFile('/w/a.ts');
    await subject.openReview();
    await subject.keepAll();
    await subject.openReview();
    reviews.activeSessionChanged(null);
    await subject.openReview();
    expect(shown).toEqual(['/w/a.ts', '/w/a.ts', '/w/b.ts']);
  });

  it('opens the deleted first file, including when it is the only unresolved file', async () => {
    const shown: string[] = [];
    const reviews = new Reviews({
      read: async (path) => path === '/w/b.ts' ? 'B\n' : null,
      restore: async () => {},
      watch: () => ({ dispose: () => {} }),
      snapshot: () => undefined,
      applyEdit: async () => { throw new Error('Unexpected edit'); },
      save: async () => { throw new Error('Unexpected save'); },
    }, {
      resolutionBlocked: () => false, onChanged: () => () => {},
      runDecision: async (action) => ({ kind: 'completed', value: await action(() => true) }),
    });
    onTestFinished(async () => { await reviews.dispose(); });
    reviews.activeSessionChanged(SESSION_ID);
    await reviews.handleSessionUpdate(input(edited('t1', '/w/gone.ts', 'gone\n', '')));
    await reviews.handleSessionUpdate(input(edited('t2', '/w/b.ts', 'b\n', 'B\n')));
    const subject = new ReviewControls(reviews, {
      captureNavigation: () => () => true,
      activePath: () => undefined,
      isOpen: () => false,
      open: async () => {},
      showChange: async (path) => { shown.push(path); },
      showChangeOf: async () => {},
      closeChange: async () => {},
      showError: () => {},
      text: () => undefined,
    });
    await subject.openReview();
    expect(shown).toEqual(['/w/gone.ts']);
    await subject.keepFile('/w/b.ts');
    await subject.openReview();
    expect(shown).toEqual(['/w/gone.ts', '/w/gone.ts']);
  });

  it('shows the first unresolved file at turn end only when no review file is open', async () => {
    const { controls: subject, shown, activate, reviews } = await controls();
    activate('/w/b.ts');
    await subject.turnEnded(SESSION_ID);
    expect(shown).toEqual([]);
    activate('/w/other.ts');
    await subject.turnEnded(SESSION_ID);
    reviews.activeSessionChanged(null);
    await subject.turnEnded(SESSION_ID);
    expect(shown).toEqual(['/w/a.ts']);
  });

  it('does not replace an already open deletion at turn end', async () => {
    const { controls: subject, shown, activate } = await controls({ deleted: true });
    activate('/w/gone.ts');
    await subject.turnEnded(SESSION_ID);
    expect(shown).toEqual([]);
  });

  it('shows a change once the files the turn\'s edits name were read, as the turn can end before', async () => {
    const { controls: subject, shown, reviews } = await controls();
    await subject.keepAll();
    void reviews.handleSessionUpdate(input(edited('t6', '/w/b.ts', 'b\n', 'B\n')));
    await subject.turnEnded(SESSION_ID);
    expect(shown).toEqual(['/w/b.ts']);
  });

  it('shows existing and deleted files on entry, but not unreviewed or resolved files', async () => {
    const { controls: subject, shown } = await controls({ deleted: true });
    await subject.entered('/w/b.ts');
    await subject.entered('/w/other.ts');
    await subject.entered('/w/gone.ts');
    await subject.keepFile('/w/a.ts');
    await subject.entered('/w/a.ts');
    expect(shown).toEqual(['/w/b.ts', '/w/gone.ts']);
  });

  it.each([
    { names: ['gone', 'live'], want: ['/w/gone.ts', '/w/live.ts'] },
    { names: ['live', 'gone'], want: ['/w/live.ts', '/w/gone.ts'] },
    { names: ['gone', 'empty'], want: ['/w/gone.ts', '/w/empty.ts'] },
    { names: ['gone'], want: ['/w/gone.ts'] },
    { names: ['empty'], want: ['/w/empty.ts'] },
    { names: [], want: [] },
  ])('includes every existence change in entry and wraparound: $names', async ({ names, want }) => {
    const { controls: subject, reviews, disk, opened, shown } = await controls();
    await subject.keepAll();
    for (const name of names) {
      const path = `/w/${name}.ts`;
      disk[path] = name === 'live' ? 'changed\n' : null;
      await reviews.handleSessionUpdate(input(edited(name, path, name === 'empty' ? '' : 'before\n', name === 'live' ? 'changed\n' : '')));
    }
    expect(subject.reviewedPaths()).toEqual(want);
    await subject.openReview();
    expect(shown).toEqual(want.length ? [want[0]] : []);
    shown.length = 0;
    await subject.turnEnded(SESSION_ID);
    expect(shown).toEqual(want.length ? [want[0]] : []);
    for (const path of want) { await subject.entered(path); }
    expect(shown.slice(want.length ? 1 : 0)).toEqual(want);
    for (const path of want) { await subject.next(path); }
    expect(opened).toEqual(want.length ? [...want.slice(1), want[0]] : []);
    opened.length = 0;
    await subject.previous(want[0]);
    expect(opened).toEqual(want.length ? [want.at(-1)] : []);
    expect(subject.position(want[0])).toBe(want.length ? `1 of ${want.length}` : '0 of 0');
  });

  it.each(['keep', 'undo'] as const)('advances from live to deleted after %s, and resolves an all-deleted review', async (action) => {
    const { controls: subject, opened, activate } = await controls({ deleted: true });
    await subject.keepFile('/w/a.ts');
    await subject.keepFile('/w/b.ts');
    activate('/w/c.ts');
    if (action === 'keep') { await subject.keepFile(); } else { await subject.undoFile(); }
    expect(opened).toEqual(['/w/gone.ts']);
    activate('/w/gone.ts');
    if (action === 'keep') { await subject.keepFile(); } else { await subject.undoFile(); }
    expect(subject.reviewedPaths()).toEqual([]);
    expect(subject.position('/w/gone.ts')).toBe('0 of 0');
    expect(opened).toEqual(action === 'undo' ? ['/w/gone.ts', '/w/gone.ts'] : ['/w/gone.ts']);
  });
});
