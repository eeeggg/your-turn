import { describe, expect, it, onTestFinished } from 'vitest';
import type { AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';
import { Reviews, type ReviewFiles, type ReviewAdmission } from '@/core/review/Reviews';
import type { FileContent } from '@/core/review/Review';
import { setLogSink } from '@/core/Log';
import type { QualifiedSessionUpdate, SessionRegistration, SessionLoad } from '@/core/SessionUpdateHandler';

const SESSION_ID = { sessionId: '9f0a753c-2018-4a39-9be2-458f06ba72d1', agentName: 'fake', agentId: 'source' };
const OTHER_SESSION_ID = { sessionId: '28ec645b-c197-45da-a461-d0b72685ef39', agentName: 'fake', agentId: 'source' };

function input(registration: SessionRegistration, update: SessionUpdate, schema: AcpSchema): QualifiedSessionUpdate {
  return { origin: { identity: { configuredName: registration.agentName, sessionId: registration.sessionId }, sourceId: registration.agentId }, update, schema };
}

const load: SessionLoad = { registration: SESSION_ID, origin: input(SESSION_ID, { kind: 'commands', commands: [] }, 'v1').origin, attempt: Symbol() };

/** A completed tool call that changed `path` from `old` to `now`, which the disk holds. */
const edited = (toolCallId: string, path: string, old: string, now: string): Extract<SessionUpdate, { kind: 'toolCall' }> => ({
  kind: 'toolCall',
  toolCallId,
  status: 'completed',
  content: [{ kind: 'diff', diff: { kind: 'wholeFile', path, oldText: old, newText: now } }],
});

/** As `edited`, the way a v2 driver passes it up: `path` modified from the single line `old` to `now`, as a `git_patch`. */
const patched = (toolCallId: string, path: string, old: string, now: string): Extract<SessionUpdate, { kind: 'toolCall' }> => ({
  kind: 'toolCall',
  toolCallId,
  status: 'completed',
  content: [{
    kind: 'diff',
    diff: {
      kind: 'changes',
      changes: [{ operation: 'modify', path, fileType: 'text', mimeType: null }],
      patch: { format: 'git_patch', text: [`diff --git ${path} ${path}`, `--- ${path}`, `+++ ${path}`, '@@ -1 +1 @@', `-${old}`, '\\ No newline at end of file', `+${now}`, '\\ No newline at end of file', ''].join('\n') },
    },
  }],
});

/**
 * Reviews over a disk where `/w/a.ts` holds `A` and `/w/b.ts` holds `B`, with how often its listener heard and the
 * paths watched now.
 */
function reviews(files: Partial<ReviewFiles> = {}, admission: ReviewAdmission = {
  resolutionBlocked: () => false,
  onChanged: () => () => {},
  runDecision: async (action) => ({ kind: 'completed', value: await action(() => true) }),
}) {
  const disk: Record<string, string> = { '/w/a.ts': 'A', '/w/b.ts': 'B' };
  const watched: string[] = [];
  const subject = new Reviews({
    read: async (path) => disk[path] ?? null,
    restore: async () => {},
    watch: (path) => {
      watched.push(path);
      return { dispose: () => watched.splice(watched.indexOf(path), 1) };
    },
    snapshot: () => undefined,
    applyEdit: async () => { throw new Error('Unexpected edit'); },
    save: async () => { throw new Error('Unexpected save'); },
    ...files,
  }, admission);
  onTestFinished(async () => { await subject.dispose(); });
  let heard = 0;
  subject.addListener(() => heard++);
  const shownPaths = () => subject.shown()?.files().map((file) => file.path);
  return { reviews: subject, heard: () => heard, shownPaths, watched };
}

describe('Reviews', () => {
  it('does not save an issued hunk edit over evidence that settles before it returns', async () => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A' };
    let disk = 'A';
    const saved: string[] = [];
    const { reviews: subject } = reviews({ snapshot: () => document, read: async () => disk,
      applyEdit: async () => {
        document = { ...document, version: 2, dirty: true, text: 'a' };
        disk = 'newer';
        await subject.handleSessionUpdate(input(SESSION_ID, edited('newer', '/w/a.ts', 'A', 'newer'), 'v1'));
        return true;
      }, save: async (path) => { saved.push(path); },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const decision = subject.captureDecision({ action: 'undo-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!decision) { throw new Error('Missing decision'); }
    expect(await subject.decide(decision)).toMatchObject({ kind: 'failed', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] });
    expect(saved).toEqual([]);
    expect(subject.shown()?.file('/w/a.ts')?.current).toBe('newer');
  });
  it('exposes a stable read-only projection without mutable review methods', async () => {
    const { reviews: subject } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const view = subject.shown();
    expect(view).toBe(subject.shown());
    expect(Object.keys(view ?? {}).sort()).toEqual(['file', 'files']);
    expect(view?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'a', current: 'A' });
  });
  it('routes a save observation to its captured owner after selection changes', async () => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A\nb\n' };
    const { reviews: subject } = reviews({ read: async () => 'A\nb\n', snapshot: () => document,
      save: async () => {
        subject.activeSessionChanged(OTHER_SESSION_ID);
        document = { ...document, version: 2, dirty: true, text: 'A\nB\n' };
        subject.observeDocument({ path: '/w/a.ts', source: 'save', before: 'A\nb\n', after: document.text,
          edits: [{ first: 1, last: 1, addedLines: 0, start: 2, end: 3, text: 'B' }],
        });
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a\nb\n', 'A\nb\n'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'other\nb\n', 'A\nb\n'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing decision'); }
    await subject.decide(captured);
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('other\nb\n');
  });
  it('keeps takeover history with its session when another session reviews the same path', async () => {
    const { reviews: subject } = reviews();
    const observe = (source: 'user' | 'undo', before: string, after: string) => subject.observeDocument({
      path: '/w/a.ts', source, before, after, edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: before.length, text: after }],
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    observe('user', 'A', 'typed A');
    subject.activeSessionChanged(OTHER_SESSION_ID);
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'b', 'A'), 'v1'));
    observe('user', 'A', 'typed B');
    subject.activeSessionChanged(SESSION_ID);
    observe('undo', 'typed A', 'A');
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('a');
  });
  it('does not save unrelated edits made before a review edit settles', async () => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A' };
    const saved: string[] = [];
    const { reviews: subject } = reviews({ snapshot: () => document,
      applyEdit: async () => {
        document = { ...document, version: 3, dirty: true, text: 'a plus user edit' };
        return true;
      }, save: async (path) => { saved.push(path); },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const decision = subject.captureDecision({ action: 'undo-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!decision) { throw new Error('Missing decision'); }
    expect(await subject.decide(decision)).toMatchObject({ kind: 'failed', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] });
    expect(saved).toEqual([]);
    expect(document.text).toBe('a plus user edit');
  });
  it('retains newer evidence received after a whole-file restore was issued', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const restoring = new Promise<void>((resolve) => { started = resolve; });
    let disk = 'A';
    const { reviews: subject } = reviews({ read: async () => disk, restore: async () => { started(); await gate; } });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    const deciding = subject.decide(captured);
    try {
      await restoring;
      disk = 'newer';
      await subject.handleSessionUpdate(input(SESSION_ID, edited('new', '/w/a.ts', 'A', 'newer'), 'v1'));
      release();
      expect(await deciding).toMatchObject({ kind: 'failed', applied: ['/w/a.ts'], unsaved: [] });
      expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'a', current: 'newer' });
    } finally { release(); await deciding; }
  });
  it('publishes workspace admission changes and detaches them on disposal', async () => {
    let blocked = false;
    let notify = () => {};
    let detached = false;
    const { reviews: subject } = reviews({}, {
      resolutionBlocked: () => blocked,
      onChanged: (listener) => { notify = listener; return () => { detached = true; }; },
      runDecision: async () => ({ kind: 'blocked' }),
    });
    const states: boolean[] = [];
    subject.addListener(() => states.push(subject.resolutionBlocked()));
    blocked = true;
    notify();
    expect(states).toEqual([true]);
    await subject.dispose();
    expect(detached).toBe(true);
  });
  it('leaves a dirty whole-file Undo pending until its document is saved', async () => {
    let document = { instance: {}, version: 1, dirty: true, text: 'my edits' };
    const { reviews: subject } = reviews({
      snapshot: () => document,
      restore: async (_path, content, current) => {
        if (!current?.()) { throw new Error('Stale restore'); }
        document = { ...document, version: 2, text: content ?? '' };
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: false, resolved: [] });
    expect(document.text).toBe('a');
    expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'a', current: 'A' });
  });

  it('does not save an issued hunk edit after independent activity invalidates admission', async () => {
    let admitted = true;
    let document = { instance: {}, version: 1, dirty: false, text: 'A' };
    const saved: string[] = [];
    const { reviews: subject } = reviews({
      snapshot: () => document,
      applyEdit: async (_path, edit) => {
        document = { ...document, version: 2, dirty: true, text: edit.text };
        admitted = false;
        return true;
      },
      save: async (path) => { saved.push(path); },
    }, {
      resolutionBlocked: () => false, onChanged: () => () => {},
      runDecision: async (action) => ({ kind: 'completed', value: await action(() => admitted) }),
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toMatchObject({ kind: 'failed', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] });
    expect(document.text).toBe('a');
    expect(saved).toEqual([]);
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('a');
  });

  it('does not save into a replacement document after an issued hunk edit', async () => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A' };
    const saved: string[] = [];
    const { reviews: subject } = reviews({
      snapshot: () => document,
      applyEdit: async () => {
        document = { instance: {}, version: 1, dirty: true, text: 'replacement' };
        return true;
      },
      save: async (path) => { saved.push(path); },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toMatchObject({ kind: 'failed', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] });
    expect(document.text).toBe('replacement');
    expect(saved).toEqual([]);
  });

  it('admits user document observations while workspace resolution is blocked', async () => {
    const { reviews: subject } = reviews({}, {
      resolutionBlocked: () => true, onChanged: () => () => {},
      runDecision: async () => ({ kind: 'blocked' }),
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'Typed',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: 'Typed' }],
    });
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('Typed');
  });

  it('ignores document observations after disposal', async () => {
    const { reviews: subject } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const retained = subject.shown();
    await subject.dispose();
    subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'Typed',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: 'Typed' }],
    });
    expect(retained?.file('/w/a.ts')?.baseline).toBe('a');
  });

  it.each(['keep-change', 'undo-change'] as const)('preserves actual %s effects when saving fails', async (action) => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A\nb\n' };
    const { reviews: subject } = reviews({
      read: async () => 'A\nb\n',
      snapshot: () => document,
      applyEdit: async (_path, edit, current) => {
        if (!current()) { return false; }
        document = { ...document, version: 2, dirty: true,
          text: document.text.slice(0, edit.start) + edit.text + document.text.slice(edit.end) };
        return true;
      },
      save: async () => { throw new Error('Disk full'); },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a\nb\n', 'A\nb\n'), 'v1'));
    const captured = subject.captureDecision({ action, path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing change decision'); }
    expect(await subject.decide(captured)).toEqual({ kind: 'failed', reason: 'Disk full', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] });
    expect(document.text).toBe(action === 'keep-change' ? 'A\nb\n' : 'a\nb\n');
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe(action === 'keep-change' ? undefined : 'a\nb\n');
  });

  it('restores the captured baseline before resolving Undo File', async () => {
    const restored: [string, FileContent][] = [];
    const { reviews: subject, shownPaths } = reviews({ restore: async (path, content) => { restored.push([path, content]); } });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
    expect(restored).toEqual([['/w/a.ts', 'a']]);
    expect(shownPaths()).toEqual([]);
  });

  it.each(['instance', 'version', 'dirty', 'text'] as const)('rejects a captured file decision after document %s changes', async (field) => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A' };
    const { reviews: subject, shownPaths } = reviews({ snapshot: () => document });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    document = { ...document, [field]: field === 'instance' ? {} : field === 'version' ? 2 : field === 'dirty' ? true : 'new' };
    expect(await subject.decide(captured)).toMatchObject({ kind: 'stale' });
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it.each(['away-back', 'removed', 'retired', 'replacement', 'recreated'] as const)('rejects a captured decision after its target is %s', async (invalidation) => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    switch (invalidation) {
      case 'away-back': subject.activeSessionChanged(OTHER_SESSION_ID); subject.activeSessionChanged(SESSION_ID); break;
      case 'removed': subject.sessionRemoved(SESSION_ID); break;
      case 'retired': subject.sourceRetired(SESSION_ID.agentId); break;
      case 'replacement': subject.activeSessionChanged({ ...SESSION_ID }); break;
      case 'recreated':
        await subject.decide(captured);
        await subject.handleSessionUpdate(input(SESSION_ID, edited('again', '/w/a.ts', 'a', 'A'), 'v1'));
        break;
    }
    expect(await subject.decide(captured)).toMatchObject({ kind: 'stale' });
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('invalidates a decision during deletion preparation when independent activity starts', async () => {
    let admitted = true;
    let checking = false;
    let release: (text: FileContent) => void = () => {};
    const { reviews: subject, shownPaths } = reviews({ read: async () => checking
      ? new Promise<FileContent>((resolve) => { release = resolve; }) : null }, {
      resolutionBlocked: () => false, onChanged: () => () => {},
      runDecision: async (action) => ({ kind: 'completed', value: await action(() => admitted) }),
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('delete', '/w/a.ts', 'a', ''), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    checking = true;
    const deciding = subject.decide(captured);
    admitted = false;
    release(null);
    expect(await deciding).toMatchObject({ kind: 'blocked' });
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('retains a captured deletion when preparation fails', async () => {
    let failing = false;
    const { reviews: subject, shownPaths } = reviews({ read: async () => {
      if (failing) { throw new Error('Unreadable'); }
      return null;
    } });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('delete', '/w/a.ts', 'a', ''), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    failing = true;
    expect(await subject.decide(captured)).toEqual({ kind: 'failed', reason: 'Unreadable', applied: [], unsaved: [] });
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('rejects a captured deletion when the file reappears before Keep', async () => {
    let disk: FileContent = null;
    const { reviews: subject, shownPaths } = reviews({ read: async () => disk });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('delete', '/w/a.ts', 'a', ''), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing deletion decision'); }
    disk = 'recreated';
    expect(await subject.decide(captured)).toMatchObject({ kind: 'stale' });
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('rejects selection changes during asynchronous deletion validation', async () => {
    let release: (text: FileContent) => void = () => {};
    let checking = false;
    const { reviews: subject, shownPaths } = reviews({ read: async () => checking
      ? new Promise<FileContent>((resolve) => { release = resolve; }) : null });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('delete', '/w/a.ts', 'a', ''), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing deletion decision'); }
    checking = true;
    const deciding = subject.decide(captured);
    subject.activeSessionChanged(OTHER_SESSION_ID);
    subject.activeSessionChanged(SESSION_ID);
    release(null);
    expect(await deciding).toMatchObject({ kind: 'stale' });
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('freezes Keep All membership and never adds files received after capture', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-all' });
    if (!captured) { throw new Error('Missing bulk decision'); }
    await subject.handleSessionUpdate(input(SESSION_ID, edited('b', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it('rejects all of a frozen Keep All when one comparison changes', async () => {
    let disk = 'A';
    const { reviews: subject, shownPaths } = reviews({ read: async (path) => path === '/w/a.ts' ? disk : 'B' });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(SESSION_ID, edited('b', '/w/b.ts', 'b', 'B'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-all' });
    if (!captured) { throw new Error('Missing bulk decision'); }
    disk = 'newer';
    await subject.handleSessionUpdate(input(SESSION_ID, edited('new', '/w/a.ts', 'A', 'newer'), 'v1'));
    expect(await subject.decide(captured)).toMatchObject({ kind: 'stale' });
    expect(shownPaths()).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it('applies a captured Keep File through idle decision admission without writing', async () => {
    const writes: string[] = [];
    let admitted = 0;
    const { reviews: subject, shownPaths } = reviews({ restore: async (path) => { writes.push(path); } }, {
      resolutionBlocked: () => false,
      onChanged: () => () => {},
      runDecision: async (action) => { admitted++; return { kind: 'completed', value: await action(() => true) }; },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
    expect(admitted).toBe(1);
    expect(shownPaths()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('keeps an empty selected registration selected through rename before its first evidence', async () => {
    const { reviews: subject, shownPaths } = reviews();
    const selected = { ...SESSION_ID };
    subject.activeSessionChanged(selected);
    selected.agentName = 'renamed';
    subject.configurationRenamed('fake', 'renamed');
    await subject.handleSessionUpdate(input(selected, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it.each(['v1', 'v2'] as const)('keeps same-source sibling %s guards and replay independent when A is removed', async (schema) => {
    const { reviews: subject, shownPaths } = reviews();
    const evidence = schema === 'v1' ? edited : patched;
    await subject.handleSessionUpdate(input(SESSION_ID, { ...evidence('same', '/w/a.ts', 'a', 'A'), status: 'running' }, schema));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, { ...evidence('same', '/w/b.ts', 'b', 'B'), status: 'running' }, schema));
    subject.loadStarted(load);
    await subject.handleSessionUpdate(input(SESSION_ID, { kind: 'toolCall', toolCallId: 'same', status: 'completed' }, schema));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, { kind: 'toolCall', toolCallId: 'same', status: 'completed' }, schema));
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(shownPaths()).toEqual(['/w/b.ts']);
    subject.sessionRemoved(SESSION_ID);
    subject.loadEnded(load);
    expect(shownPaths()).toEqual(['/w/b.ts']);
    subject.activeSessionChanged(SESSION_ID);
    expect(shownPaths()).toEqual([]);
    await subject.handleSessionUpdate(input(SESSION_ID, { kind: 'toolCall', toolCallId: 'same', status: 'completed' }, schema));
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('moves retained review and an admitted read through two renames without binding reused names', async () => {
    let release: (text: FileContent) => void = () => {};
    const { reviews: subject, shownPaths } = reviews({ read: () => new Promise((resolve) => { release = resolve; }) });
    const registration = { ...SESSION_ID };
    subject.activeSessionChanged(registration);
    const reading = subject.handleSessionUpdate(input(registration, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    registration.agentName = 'renamed';
    subject.configurationRenamed('fake', 'renamed');
    registration.agentName = 'again';
    subject.configurationRenamed('renamed', 'again');
    release('A');
    await reading;
    expect(shownPaths()).toEqual(['/w/a.ts']);
    subject.activeSessionChanged({ ...SESSION_ID, agentId: 'another' });
    expect(shownPaths()).toBeUndefined();
    subject.activeSessionChanged(registration);
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('keeps admitted evidence after retirement but drops the retired source partial-tool state', async () => {
    let release: (text: FileContent) => void = () => {};
    const { reviews: subject, shownPaths } = reviews({ read: (path) => path === '/w/a.ts'
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('B') });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, { ...edited('partial', '/w/b.ts', 'b', 'B'), status: 'running' }, 'v1'));
    const reading = subject.handleSessionUpdate(input(SESSION_ID, edited('done', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.sourceRetired(SESSION_ID.agentId);
    release('A');
    await reading;
    expect(shownPaths()).toEqual(['/w/a.ts']);
    await subject.handleSessionUpdate(input(SESSION_ID, { kind: 'toolCall', toolCallId: 'partial', status: 'completed' }, 'v1'));
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it('starts a fresh guard on a replacement source while preserving its retained review', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    const old = edited('same', '/w/a.ts', 'a', 'A');
    await subject.handleSessionUpdate(input(SESSION_ID, { ...old, status: 'running' }, 'v1'));
    const replacement = { ...SESSION_ID, agentId: 'replacement' };
    subject.activeSessionChanged(replacement);
    await subject.handleSessionUpdate(input(replacement, { kind: 'toolCall', toolCallId: 'same', status: 'completed' }, 'v1'));
    expect(shownPaths()).toEqual([]);
  });

  it('does not let an obsolete load completion end replacement replay suppression', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    const replacement = { ...load, attempt: Symbol() };
    subject.loadStarted(load);
    subject.loadStarted(replacement);
    subject.loadEnded(load);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    expect(shownPaths() ?? []).toEqual([]);
    subject.loadEnded(replacement);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t2', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it('keeps equal session and tool IDs from separate configurations in separate retained reviews', async () => {
    const { reviews: subject, shownPaths } = reviews();
    const a: SessionRegistration = { sessionId: SESSION_ID.sessionId, agentName: 'a', agentId: 'source-a' };
    const b: SessionRegistration = { sessionId: SESSION_ID.sessionId, agentName: 'b', agentId: 'source-b' };
    const input = (registration: SessionRegistration, update: SessionUpdate): QualifiedSessionUpdate => ({
      origin: { identity: { configuredName: registration.agentName, sessionId: registration.sessionId }, sourceId: registration.agentId },
      update, schema: 'v1',
    });
    subject.activeSessionChanged(a);
    await subject.handleSessionUpdate(input(a, edited('same', '/w/a.ts', 'a', 'A')));
    await subject.handleSessionUpdate(input(b, edited('same', '/w/b.ts', 'b', 'B')));
    expect(shownPaths()).toEqual(['/w/a.ts']);
    subject.activeSessionChanged(b);
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it.each(['v1', 'v2'] as const)('drains %s evidence after session removal without new watchers or notifications during disposal', async (schema) => {
    const reads: { path: string; give: (text: FileContent) => void }[] = [];
    const { reviews: subject, watched, heard } = reviews({
      read: (path) => new Promise((resolve) => {
        reads.push({ path, give: resolve });
        if (path === '/w/c.ts') { resolve('C'); }
      }),
    });
    const handling: Promise<void>[] = [];
    onTestFinished(async () => {
      const disposed = subject.dispose();
      for (const read of reads) { read.give(null); }
      await Promise.all([...handling, disposed]);
    });
    subject.activeSessionChanged(SESSION_ID);
    const evidence = schema === 'v1' ? edited : patched;
    const handlingOld = subject.handleSessionUpdate(input(SESSION_ID, evidence('t1', '/w/a.ts', 'a', 'A'), schema));
    handling.push(handlingOld);
    subject.sessionRemoved(SESSION_ID);
    handling.push(subject.handleSessionUpdate(input(SESSION_ID, evidence('t2', '/w/b.ts', 'b', 'B'), schema)));
    const before = heard();
    let oldFinished = false;
    void handlingOld.then(() => { oldFinished = true; });
    const disposed = subject.dispose();
    const finishedAtDisposal = Promise.resolve(disposed).then(() => oldFinished);
    expect(subject.dispose()).toBe(disposed);
    reads[1]?.give('B');
    await handling[1];
    reads[0]?.give('A');
    await disposed;
    await Promise.all(handling);
    await subject.handleSessionUpdate(input({ ...SESSION_ID, sessionId: 'late' }, evidence('t3', '/w/c.ts', 'c', 'C'), schema));
    subject.activeSessionChanged({ ...SESSION_ID, sessionId: 'late' });

    expect(await finishedAtDisposal).toBe(true);
    expect(reads.map(({ path }) => path)).toEqual(['/w/a.ts', '/w/b.ts']);
    expect(watched).toEqual([]);
    expect(heard()).toBe(before);
    expect(subject.shown()).toBeUndefined();
    expect(subject.sessionShown()).toBe(false);
  });

  it.each(['v1', 'v2'] as const)('awaits a failed %s evidence read and its sibling before disposal completes', async (schema) => {
    const reads: { give: (text: FileContent) => void; fail: (error: Error) => void }[] = [];
    const { reviews: subject, watched, heard } = reviews({
      read: () => new Promise((resolve, reject) => { reads.push({ give: resolve, fail: reject }); }),
    });
    const messages: string[] = [];
    const failed = new Promise<void>((resolve) => {
      setLogSink({ trace() {}, debug() {}, info() {}, warn: (message, context) => { messages.push(`${message}: ${String(context?.['path'])} ${String(context?.['reason'])}`); resolve(); }, error() {} });
    });
    onTestFinished(() => { setLogSink(undefined); });
    const evidence = schema === 'v1' ? edited : patched;
    const handling = subject.handleSessionUpdate(input(SESSION_ID, {
      kind: 'toolCall',
      toolCallId: 't1',
      status: 'completed',
      content: [
        ...evidence('t1', '/w/a.ts', 'a', 'A').content ?? [],
        ...evidence('t1', '/w/b.ts', 'b', 'B').content ?? [],
      ],
    }, schema));
    onTestFinished(async () => {
      const disposed = subject.dispose();
      for (const read of reads) { read.give(null); }
      await Promise.all([handling, disposed]);
    });
    let siblingFinished = false;
    const disposed = subject.dispose();
    const finishedAtDisposal = Promise.resolve(disposed).then(() => siblingFinished);
    reads[0]?.fail(new Error('EACCES'));
    await failed;
    reads[1]?.give('B');
    siblingFinished = true;
    await disposed;
    await handling;

    expect(await finishedAtDisposal).toBe(true);
    expect(messages).toEqual(['Review change not examined because file could not be read: /w/a.ts EACCES']);
    expect(watched).toEqual([]);
    expect(heard()).toBe(0);
  });

  it('drains watcher reads from every session while detaching watchers and suppressing notifications', async () => {
    const reads: { give: (text: FileContent) => void; fail: (error: Error) => void }[] = [];
    const watchers = new Map<string, () => void>();
    let refreshing = false;
    const { reviews: subject, heard } = reviews({
      read: (path) => refreshing
        ? new Promise((resolve, reject) => { reads.push({ give: resolve, fail: reject }); })
        : Promise.resolve(path === '/w/a.ts' ? 'A' : 'B'),
      watch: (path, changed) => {
        watchers.set(path, changed);
        return { dispose: () => { watchers.delete(path); } };
      },
    });
    onTestFinished(async () => {
      const disposed = subject.dispose();
      for (const read of reads) { read.give(null); }
      await disposed;
    });
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    subject.activeSessionChanged(SESSION_ID);
    const before = heard();
    refreshing = true;
    watchers.get('/w/a.ts')?.();
    watchers.get('/w/b.ts')?.();
    watchers.get('/w/b.ts')?.();
    const failed = new Promise<void>((resolve) => {
      setLogSink({ trace() {}, debug() {}, info() {}, warn: () => resolve(), error() {} });
    });
    onTestFinished(() => { setLogSink(undefined); });
    let siblingFinished = false;
    const disposed = subject.dispose();
    const finishedAtDisposal = disposed.then(() => siblingFinished);
    expect(watchers.size).toBe(0);
    reads[0]?.fail(new Error('EACCES'));
    await failed;
    reads[1]?.give('late');
    siblingFinished = true;
    await disposed;

    expect(await finishedAtDisposal).toBe(true);
    expect(reads).toHaveLength(2);
    expect(heard()).toBe(before);
  });

  it('drains sibling sessions before reporting a watcher disposal failure', async () => {
    const watchers = new Map<string, () => void>();
    const reads: { give: (content: FileContent) => void }[] = [];
    const failure = new Error('watcher disposal failed');
    let refreshing = false;
    let readFinished = false;
    const subject = new Reviews({
      read: (path) => refreshing
        ? new Promise<FileContent>((resolve) => { reads.push({ give: resolve }); })
          .finally(() => { readFinished = true; })
        : Promise.resolve(path === '/w/a.ts' ? 'A' : 'B'),
      restore: async () => {},
      snapshot: () => undefined,
      applyEdit: async () => { throw new Error('Unexpected edit'); },
      save: async () => { throw new Error('Unexpected save'); },
      watch: (path, changed) => {
        watchers.set(path, changed);
        return {
          dispose: () => {
            watchers.delete(path);
            if (path === '/w/a.ts') { throw failure; }
          },
        };
      },
    }, {
      resolutionBlocked: () => false, onChanged: () => () => {},
      runDecision: async (action) => ({ kind: 'completed', value: await action(() => true) }),
    });
    onTestFinished(async () => {
      const disposed = subject.dispose();
      for (const read of reads) { read.give(null); }
      await expect(disposed).rejects.toMatchObject({ errors: [{ errors: [failure] }] });
    });
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    refreshing = true;
    watchers.get('/w/b.ts')?.();
    const disposed = subject.dispose();
    const finishedAtDisposal = disposed.catch(() => readFinished);
    expect(subject.dispose()).toBe(disposed);
    expect(watchers.size).toBe(0);
    reads[0]?.give('late');
    await expect(disposed).rejects.toMatchObject({ errors: [{ errors: [failure] }] });

    expect(await finishedAtDisposal).toBe(true);
  });

  it("shows the active session's review, each session's evidence kept apart", async () => {
    const { reviews: subject, shownPaths } = reviews();
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(shownPaths()).toBeUndefined();
    subject.activeSessionChanged(SESSION_ID);
    expect(shownPaths()).toEqual(['/w/a.ts']);
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it("feeds each session's updates to the guard of the driver that passed them up", async () => {
    const { reviews: subject, shownPaths } = reviews();
    await subject.handleSessionUpdate(input(SESSION_ID, patched('t1', '/w/a.ts', 'a', 'A'), 'v2'));
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t2', '/w/b.ts', 'b', 'B'), 'v2'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, patched('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t2', '/w/b.ts', 'b', 'B'), 'v1'));
    subject.activeSessionChanged(SESSION_ID);
    expect(shownPaths()).toEqual(['/w/a.ts']);
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('a');
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it("keeps a session's review when another driver's update comes for it, fed to that driver's guard from then on", async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(SESSION_ID, patched('t2', '/w/b.ts', 'b', 'B'), 'v2'));
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t3', '/w/b.ts', 'x', 'B'), 'v2'));
    expect(shownPaths()).toEqual(['/w/a.ts', '/w/b.ts']);
    expect(subject.shown()?.file('/w/b.ts')?.baseline).toBe('b');
  });

  it('keeps collecting evidence for a session not shown', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it('tells its listener when another session is shown, and when the shown review changes, not when another does', async () => {
    const { reviews: subject, heard } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    expect(heard()).toBe(1);
    subject.activeSessionChanged(SESSION_ID);
    expect(heard()).toBe(1);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    expect(heard()).toBe(2);
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(heard()).toBe(2);
  });

  it("takes nothing of a load's replay as evidence, and what comes after it", async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    subject.loadStarted(load);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.loadEnded(load);
    expect(shownPaths() ?? []).toEqual([]);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t2', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it("keeps a removed session's review, shown again when its session is", async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.sessionRemoved(SESSION_ID);
    subject.activeSessionChanged(null);
    expect(shownPaths()).toBeUndefined();
    subject.activeSessionChanged(SESSION_ID);
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it("watches the files of every session's review, shown or not, its session removed or not", async () => {
    const { reviews: subject, watched } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    subject.sessionRemoved(OTHER_SESSION_ID);
    expect(watched).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it("stops watching every session's files when disposed", async () => {
    const { reviews: subject, watched } = reviews();
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('t1', '/w/b.ts', 'b', 'B'), 'v1'));
    await subject.dispose();
    expect(watched).toEqual([]);
  });

  it('follows evidence read after its session was removed, as its turn may go on', async () => {
    const { reviews: subject, watched } = reviews();
    const reading = subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.sessionRemoved(SESSION_ID);
    await reading;
    expect(watched).toEqual(['/w/a.ts']);
  });

  it('takes evidence again for a session removed mid-load, keeping its review', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t1', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.loadStarted(load);
    subject.sessionRemoved(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('t2', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(shownPaths()).toEqual(['/w/a.ts', '/w/b.ts']);
  });
});
