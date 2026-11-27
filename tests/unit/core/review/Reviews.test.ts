import { describe, expect, it, onTestFinished } from 'vitest';
import type { AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';
import { Reviews, type ReviewFiles, type ReviewAdmission } from '@/core/review/Reviews';
import type { FileContent } from '@/core/review/Review';
import { setLogSink } from '@/core/Log';
import type { QualifiedSessionUpdate, SessionRegistration, SessionLoad } from '@/core/sessions/UpdateHandler';

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
  it('notifies both sessions when a shared file is kept, but not an unrelated session', async () => {
    const { reviews: subject } = reviews();
    const first = { configuredName: SESSION_ID.agentName, sessionId: SESSION_ID.sessionId };
    const second = { configuredName: OTHER_SESSION_ID.agentName, sessionId: OTHER_SESSION_ID.sessionId };
    const unrelated = { ...SESSION_ID, agentName: 'other configuration' };
    const third = { configuredName: unrelated.agentName, sessionId: unrelated.sessionId };
    const empty = { fileCount: 0, modified: false, created: false, deleted: false };
    const modified = { ...empty, fileCount: 1, modified: true };
    const notices: (typeof first)[] = [];
    const visibleCounts: number[][] = [];
    const unsubscribe = subject.onSummaryChanged((identity) => {
      notices.push(identity);
      visibleCounts.push([first, second, third].map((session) => subject.summary(session).fileCount));
    });
    expect(subject.summary(third)).toEqual(empty);
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('same file', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(unrelated, edited('unrelated', '/w/b.ts', 'b', 'B'), 'v1'));
    expect(notices.splice(0)).toEqual([first, second, third]);
    expect(subject.summary(second)).toEqual(modified);
    const keep = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!keep) { throw new Error('Missing decision'); }
    visibleCounts.length = 0;
    expect(await subject.decide(keep)).toMatchObject({ kind: 'applied' });
    expect(notices.splice(0)).toEqual([first, second]);
    expect(visibleCounts).toEqual([[0, 0, 1], [0, 0, 1]]);
    expect(subject.summary(first)).toEqual(empty);
    expect(subject.summary(second)).toEqual(empty);
    expect(subject.summary(third)).toEqual(modified);
    unsubscribe();
    await subject.handleSessionUpdate(input(SESSION_ID, edited('fresh', '/w/a.ts', 'a', 'A'), 'v1'));
    expect(notices).toEqual([]);
  });

  it('distinguishes an empty file from a missing file and ignores text-only changes to the summary', async () => {
    let contents: FileContent = '';
    const { reviews: subject } = reviews({ read: async () => contents });
    const identity = { configuredName: SESSION_ID.agentName, sessionId: SESSION_ID.sessionId };
    const notices: number[] = [];
    const unsubscribe = subject.onSummaryChanged((changed) => notices.push(subject.summary(changed).fileCount));
    onTestFinished(unsubscribe);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('empty', '/w/a.ts', 'a', ''), 'v1'));
    expect(subject.summary(identity)).toEqual({ fileCount: 1, modified: true, created: false, deleted: false });
    contents = 'other';
    await subject.handleSessionUpdate(input(SESSION_ID, edited('edit', '/w/a.ts', '', contents), 'v1'));
    expect(notices).toEqual([1]);
    contents = null;
    await subject.handleSessionUpdate(input(SESSION_ID, edited('removed', '/w/a.ts', 'other', ''), 'v1'));
    expect(subject.summary(identity)).toEqual({ fileCount: 1, modified: false, created: false, deleted: true });
    expect(notices).toEqual([1, 1]);
  });

  it('reports a created file under its new identity after a configuration rename', async () => {
    const { reviews: subject } = reviews();
    const old = { configuredName: SESSION_ID.agentName, sessionId: SESSION_ID.sessionId };
    const renamed = { ...old, configuredName: 'renamed' };
    const notices: { identity: typeof old; oldCount: number; newCount: number }[] = [];
    const unsubscribe = subject.onSummaryChanged((identity) => notices.push({
      identity, oldCount: subject.summary(old).fileCount, newCount: subject.summary(renamed).fileCount,
    }));
    onTestFinished(unsubscribe);
    await subject.handleSessionUpdate(input(SESSION_ID, {
      kind: 'toolCall', toolCallId: 'create', status: 'completed', content: [{ kind: 'diff', diff: {
        kind: 'changes', changes: [{ operation: 'add', path: '/w/a.ts', fileType: 'text', mimeType: null }],
        patch: { format: 'git_patch', text: '--- /dev/null\n+++ /w/a.ts\n@@ -0,0 +1 @@\n+A\n\\ No newline at end of file\n' },
      } }],
    }, 'v2'));
    expect(subject.summary(old)).toEqual({ fileCount: 1, modified: false, created: true, deleted: false });
    expect(notices.splice(0)).toEqual([{ identity: old, oldCount: 1, newCount: 0 }]);
    subject.configurationRenamed(old.configuredName, renamed.configuredName);
    expect(notices).toEqual([{ identity: old, oldCount: 0, newCount: 1 }, { identity: renamed, oldCount: 0, newCount: 1 }]);
    expect(subject.summary(old)).toEqual({ fileCount: 0, modified: false, created: false, deleted: false });
    expect(subject.summary(renamed)).toEqual({ fileCount: 1, modified: false, created: true, deleted: false });
  });

  it('drains an admitted restore before authority disposal completes', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const restoring = new Promise<void>((resolve) => { started = resolve; });
    let restored = false;
    const { reviews: subject } = reviews({ restore: async () => { started(); await gate; restored = true; } });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    const deciding = subject.decide(captured);
    try {
      await restoring;
      const disposed = subject.dispose();
      let decisionFinished = false;
      void deciding.then(() => { decisionFinished = true; });
      const effectAtDisposal = disposed.then(() => ({ restored, decisionFinished }));
      release();
      expect(await effectAtDisposal).toEqual({ restored: true, decisionFinished: true });
      await disposed;
    } finally { release(); await deciding; }
  });

  it('reports the applied effect without advancing when newer evidence arrives during save', async () => {
    const document = { instance: {}, version: 1, dirty: false, text: 'A\nb\nC\n' };
    let disk = document.text;
    const { reviews: subject } = reviews({ read: async () => disk, snapshot: () => document,
      save: async () => {
        disk = 'newer';
        await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('new', '/w/a.ts', document.text, disk), 'v1'));
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a\nb\nc\n', document.text), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toMatchObject({ kind: 'failed', applied: ['/w/a.ts'], unsaved: [] });
    expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'A\nb\nc\n', current: 'newer' });
  });

  it('prevents a staged edit when new target evidence is received but has not finished reading', async () => {
    const document = { instance: {}, version: 1, dirty: false, text: 'A' };
    let held = false;
    let release: (content: FileContent) => void = () => {};
    let receiving: Promise<void> | undefined;
    let allowed: boolean | undefined;
    const { reviews: subject } = reviews({ snapshot: () => document,
      read: () => held ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('A'),
      applyEdit: async (_path, _edit, current) => {
        held = true;
        receiving = subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('new', '/w/a.ts', 'A', 'newer'), 'v1'));
        allowed = current();
        return false;
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing decision'); }
    try {
      expect(await subject.decide(captured)).toMatchObject({ kind: 'stale' });
      expect(allowed).toBe(false);
    } finally { release('newer'); await receiving; }
    expect(subject.shown()?.file('/w/a.ts')?.current).toBe('newer');
  });

  it('settles target observations after an issued restore without saving the dirty document', async () => {
    let document = { instance: {}, version: 1, dirty: true, text: 'A' };
    let observed: Promise<void> | undefined;
    const { reviews: subject } = reviews({ snapshot: () => document,
      restore: async () => {
        document = { ...document, version: 2, text: 'a' };
        observed = subject.observeDocument({ path: '/w/a.ts', source: 'review', before: 'A', after: 'a',
          edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: 'a' }],
        });
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: false, resolved: ['/w/a.ts'] });
    await observed;
    expect(subject.shown()?.files()).toEqual([]);
  });

  it('settles a received watcher read before Keep instead of letting it restore resolved work', async () => {
    let refresh = () => {};
    let held = false;
    let release: (content: FileContent) => void = () => {};
    const { reviews: subject } = reviews({
      read: () => held ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('A'),
      watch: (_path, changed) => { refresh = changed; return { dispose() {} }; },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    held = true;
    refresh();
    const deciding = subject.decide(captured);
    release('newer');
    expect(await deciding).toMatchObject({ kind: 'stale' });
    expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'a', current: 'newer' });
  });

  it('reserves a coalesced watcher refresh before evidence received while an older read runs', async () => {
    let refresh = () => {};
    let held = false;
    let release: (content: FileContent) => void = () => {};
    let reads = 0;
    const { reviews: subject } = reviews({
      read: () => {
        reads++;
        return held && reads === 2 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(reads === 1 ? 'A' : 'B');
      },
      watch: (_path, changed) => { refresh = changed; return { dispose() {} }; },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    held = true;
    refresh();
    refresh();
    refresh();
    const receiving = subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('second', '/w/a.ts', 'A', 'B'), 'v1'));
    const readsBeforeRelease = reads;
    held = false;
    release('older');
    await receiving;
    expect(readsBeforeRelease).toBe(2);
    expect(reads).toBe(4);
    expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'a', current: 'B' });
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(subject.shown()?.file('/w/a.ts')?.current).toBe('B');
  });

  it('settles received sibling evidence and document observations on shared paths before turn-end presentation', async () => {
    let held = false;
    let release: (content: FileContent) => void = () => {};
    const { reviews: subject } = reviews({ read: () => held
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('A'),
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    held = true;
    const receiving = subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('sibling', '/w/a.ts', 'A', 'newer'), 'v1'));
    const observing = subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'newer', after: 'typed',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 5, text: 'typed' }],
    });
    const presented: unknown[] = [];
    const presenting = subject.afterShownTurn(SESSION_ID, async (view, current) => {
      presented.push({ files: view.files(), current: current() });
    });
    release('newer');
    await Promise.all([receiving, observing, presenting]);
    expect(presented).toEqual([{ files: [{ path: '/w/a.ts', baseline: 'typed', current: 'newer' }], current: true }]);
  });

  it('does not wait for unrelated sibling evidence at turn-end presentation', async () => {
    let release: (content: FileContent) => void = () => {};
    const { reviews: subject } = reviews({ read: (path) => path === '/w/b.ts'
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('A'),
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const receiving = subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('other', '/w/b.ts', 'b', 'B'), 'v1'));
    const presented: unknown[] = [];
    try {
      await subject.afterShownTurn(SESSION_ID, async (view) => { presented.push(view.files()); });
      expect(presented).toEqual([[{ path: '/w/a.ts', baseline: 'a', current: 'A' }]]);
    } finally { release('B'); await receiving; }
  });

  it('applies a document observation after earlier evidence establishes its pending file', async () => {
    let release: (content: FileContent) => void = () => {};
    const { reviews: subject } = reviews({ read: () => new Promise((resolve) => { release = resolve; }) });
    subject.activeSessionChanged(SESSION_ID);
    const receiving = subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const observing = subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'typed',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: 'typed' }],
    });
    release('A');
    await Promise.all([receiving, observing]);
    expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'typed', current: 'A' });
  });

  it('does not apply an old queued document observation to a replacement pending lifetime', async () => {
    let release: (content: FileContent) => void = () => {};
    let held = false;
    const { reviews: subject } = reviews({ read: () => held
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('A'),
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    held = true;
    const crossing = subject.handleSessionUpdate(input(SESSION_ID, edited('back', '/w/a.ts', 'A', 'a'), 'v1'));
    held = false;
    const fresh = subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('fresh', '/w/a.ts', 'fresh baseline', 'A'), 'v1'));
    const observing = subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'old edit',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: 'old edit' }],
    });
    release('a');
    await Promise.all([crossing, fresh, observing]);
    expect(subject.shown()?.files()).toEqual([]);
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'fresh baseline', current: 'A' });
  });

  it('does not attach an observation received before initial evidence to work after a queued baseline crossing', async () => {
    let release: (content: FileContent) => void = () => {};
    const contents = ['a', 'fresh'];
    let reads = 0;
    const { reviews: subject } = reviews({ read: () => ++reads === 1
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(contents.shift() ?? null),
    });
    subject.activeSessionChanged(SESSION_ID);
    const first = subject.handleSessionUpdate(input(SESSION_ID, edited('first', '/w/a.ts', 'a', 'A'), 'v1'));
    const crossing = subject.handleSessionUpdate(input(SESSION_ID, edited('back', '/w/a.ts', 'A', 'a'), 'v1'));
    const fresh = subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('fresh', '/w/a.ts', 'a', 'fresh'), 'v1'));
    const observing = subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'fresh', after: 'old observation',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 5, text: 'old observation' }],
    });
    release('A');
    await Promise.all([first, crossing, fresh, observing]);
    expect(subject.shown()?.files()).toEqual([]);
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(subject.shown()?.files()).toEqual([{ path: '/w/a.ts', baseline: 'a', current: 'fresh' }]);
  });

  describe.each([
    ['v1', edited],
    ['v2', patched],
  ] as const)('%s shared pending files', (schema, report) => {
    it.each([
      ['unchanged', 'A', 'applied'],
      ['changed', 'newer', 'stale'],
    ] as const)('settles received %s evidence before deciding a captured file', async (_name, content, outcome) => {
      let release: (content: FileContent) => void = () => {};
      let held = false;
      const { reviews: subject } = reviews({ read: () => held
        ? new Promise<FileContent>((resolve) => { release = resolve; }) : Promise.resolve('A'),
      });
      subject.activeSessionChanged(SESSION_ID);
      await subject.handleSessionUpdate(input(SESSION_ID, report('first', '/w/a.ts', 'a', 'A'), schema));
      const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
      if (!captured) { throw new Error('Missing decision'); }
      held = true;
      const receiving = subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('received', '/w/a.ts', 'A', content), schema));
      const deciding = subject.decide(captured);
      release(content);
      await receiving;
      expect(await deciding).toMatchObject({ kind: outcome });
      expect(subject.shown()?.files()).toEqual(outcome === 'applied' ? [] : [{ path: '/w/a.ts', baseline: 'a', current: 'newer' }]);
      subject.activeSessionChanged(OTHER_SESSION_ID);
      expect(subject.shown()?.files()).toEqual(outcome === 'applied' ? [] : [{ path: '/w/a.ts', baseline: 'a', current: 'newer' }]);
    });

    it('does not wait for evidence reads of unrelated files before deciding', async () => {
      let release: (content: FileContent) => void = () => {};
      const { reviews: subject } = reviews({ read: (path) => path === '/w/b.ts'
        ? new Promise<FileContent>((resolve) => { release = resolve; }) : Promise.resolve('A'),
      });
      subject.activeSessionChanged(SESSION_ID);
      await subject.handleSessionUpdate(input(SESSION_ID, report('first', '/w/a.ts', 'a', 'A'), schema));
      const captured = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
      if (!captured) { throw new Error('Missing decision'); }
      const receiving = subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('other', '/w/b.ts', 'b', 'B'), schema));
      try {
        expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
        expect(subject.shown()?.files()).toEqual([]);
      } finally { release('B'); await receiving; }
      subject.activeSessionChanged(OTHER_SESSION_ID);
      expect(subject.shown()?.files()).toEqual([{ path: '/w/b.ts', baseline: 'b', current: 'B' }]);
    });

    it('shares the first baseline, current comparison and one watcher across sessions', async () => {
      let disk = 'timeout';
      const { reviews: subject, watched } = reviews({ read: async () => disk });
      subject.activeSessionChanged(SESSION_ID);
      await subject.handleSessionUpdate(input(SESSION_ID, report('a', '/w/a.ts', 'original', 'timeout'), schema));
      const a = subject.shown();
      disk = 'timeout and retries';
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('b', '/w/a.ts', 'timeout', disk), schema));
      subject.activeSessionChanged(OTHER_SESSION_ID);
      expect(subject.shown()?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'original', current: 'timeout and retries' });
      expect(subject.shown()?.file('/w/a.ts')).toBe(a?.file('/w/a.ts'));
      expect(watched).toEqual(['/w/a.ts']);
    });

    it('keeps a shared file everywhere without resolving another session\'s disjoint file', async () => {
      const { reviews: subject, watched } = reviews();
      subject.activeSessionChanged(SESSION_ID);
      await subject.handleSessionUpdate(input(SESSION_ID, report('a', '/w/a.ts', 'a', 'A'), schema));
      const a = subject.shown();
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('a', '/w/a.ts', 'a', 'A'), schema));
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('b', '/w/b.ts', 'b', 'B'), schema));
      subject.activeSessionChanged(OTHER_SESSION_ID);
      const b = subject.shown();
      subject.activeSessionChanged(SESSION_ID);
      const keep = subject.captureDecision({ action: 'keep-all' });
      if (!keep) { throw new Error('Missing decision'); }
      expect(await subject.decide(keep)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
      expect(a?.files()).toEqual([]);
      expect(b?.files()).toEqual([{ path: '/w/b.ts', baseline: 'b', current: 'B' }]);
      expect(watched).toEqual(['/w/b.ts']);
    });

    it('retires every old association at baseline and admits fresh associations only', async () => {
      let disk = 'A';
      const { reviews: subject, watched } = reviews({ read: async () => disk });
      subject.activeSessionChanged(SESSION_ID);
      await subject.handleSessionUpdate(input(SESSION_ID, report('a', '/w/a.ts', 'a', 'A'), schema));
      const a = subject.shown();
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('b', '/w/a.ts', 'A', 'A'), schema));
      disk = 'a';
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('back', '/w/a.ts', 'A', 'a'), schema));
      expect(a?.files()).toEqual([]);
      expect(watched).toEqual([]);
      disk = 'fresh';
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('fresh', '/w/a.ts', 'a', 'fresh'), schema));
      expect(a?.files()).toEqual([]);
      subject.activeSessionChanged(OTHER_SESSION_ID);
      expect(subject.shown()?.files()).toEqual([{ path: '/w/a.ts', baseline: 'a', current: 'fresh' }]);
      expect(watched).toEqual(['/w/a.ts']);
    });

    it('publishes association-only changes coherently without invalidating an unchanged capture', async () => {
      const { reviews: subject } = reviews();
      subject.activeSessionChanged(SESSION_ID);
      await subject.handleSessionUpdate(input(SESSION_ID, report('a', '/w/a.ts', 'a', 'A'), schema));
      const a = subject.shown();
      // Create a stable empty B view without associating the file.
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, { kind: 'commands', commands: [] }, schema));
      subject.activeSessionChanged(OTHER_SESSION_ID);
      const b = subject.shown();
      const published: unknown[] = [];
      subject.addListener(() => published.push({ a: a?.files(), b: b?.files() }));
      await subject.handleSessionUpdate(input(OTHER_SESSION_ID, report('b', '/w/a.ts', 'A', 'A'), schema));
      expect(published).toEqual([{
        a: [{ path: '/w/a.ts', baseline: 'a', current: 'A' }],
        b: [{ path: '/w/a.ts', baseline: 'a', current: 'A' }],
      }]);
      // Selection invalidates captures, so check association stability with A selected.
      subject.activeSessionChanged(SESSION_ID);
      const current = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
      if (!current) { throw new Error('Missing decision'); }
      await subject.handleSessionUpdate(input({ ...OTHER_SESSION_ID, sessionId: 'third' }, report('join', '/w/a.ts', 'A', 'A'), schema));
      expect(await subject.decide(current)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
      expect(a?.files()).toEqual([]);
      expect(b?.files()).toEqual([]);
    });
  });

  it('updates shared takeover history when no associated session is selected', async () => {
    const { reviews: subject } = reviews();
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'different baseline', 'A'), 'v1'));
    subject.activeSessionChanged(SESSION_ID);
    const a = subject.shown();
    subject.activeSessionChanged(OTHER_SESSION_ID);
    const b = subject.shown();
    subject.activeSessionChanged(null);
    await subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'typed',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: 'typed' }],
    });
    expect(a?.file('/w/a.ts')?.baseline).toBe('typed');
    expect(b?.file('/w/a.ts')?.baseline).toBe('typed');
    await subject.observeDocument({ path: '/w/a.ts', source: 'undo', before: 'typed', after: 'A',
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 5, text: 'A' }],
    });
    expect(a?.file('/w/a.ts')?.baseline).toBe('a');
    expect(b?.file('/w/a.ts')).toBe(a?.file('/w/a.ts'));
  });

  it('keeps one change through B and leaves the shared remainder in both sessions', async () => {
    const document = { instance: {}, version: 1, dirty: false, text: 'A\nb\nC\n' };
    const saved: string[] = [];
    const { reviews: subject } = reviews({ read: async () => document.text, snapshot: () => document,
      save: async (path) => { saved.push(path); },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a\nb\nc\n', document.text), 'v1'));
    const a = subject.shown();
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'A\nb\nc\n', document.text), 'v1'));
    subject.activeSessionChanged(OTHER_SESSION_ID);
    const b = subject.shown();
    const keep = subject.captureDecision({ action: 'keep-change', path: '/w/a.ts',
      change: { original: { start: 2, end: 3 }, modified: { start: 2, end: 3 } },
    });
    if (!keep) { throw new Error('Missing decision'); }
    expect(await subject.decide(keep)).toEqual({ kind: 'applied', saved: true, resolved: [] });
    expect(a?.file('/w/a.ts')).toEqual({ path: '/w/a.ts', baseline: 'a\nb\nC\n', current: document.text });
    expect(b?.file('/w/a.ts')).toBe(a?.file('/w/a.ts'));
    expect(saved).toEqual(['/w/a.ts']);
  });

  it('undoes the shared first baseline once and removes the file from every session', async () => {
    let disk = 'A';
    const restored: [string, FileContent][] = [];
    const { reviews: subject, watched } = reviews({ read: async () => disk,
      restore: async (path, content, current) => {
        if (!current?.()) { throw new Error('Stale restore'); }
        restored.push([path, content]);
        disk = content ?? '';
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const a = subject.shown();
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'other', 'A'), 'v1'));
    subject.activeSessionChanged(OTHER_SESSION_ID);
    const b = subject.shown();
    const undo = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!undo) { throw new Error('Missing decision'); }
    expect(await subject.decide(undo)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });
    expect(restored).toEqual([['/w/a.ts', 'a']]);
    expect(disk).toBe('a');
    expect(a?.files()).toEqual([]);
    expect(b?.files()).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('retains independent association order when sessions report shared files in opposite orders', async () => {
    const { reviews: subject } = reviews();
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    await subject.handleSessionUpdate(input(SESSION_ID, edited('b', '/w/b.ts', 'b', 'B'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/b.ts', 'b', 'B'), 'v1'));
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    subject.activeSessionChanged(SESSION_ID);
    expect(subject.shown()?.files().map((file) => file.path)).toEqual(['/w/a.ts', '/w/b.ts']);
    subject.activeSessionChanged(OTHER_SESSION_ID);
    expect(subject.shown()?.files().map((file) => file.path)).toEqual(['/w/b.ts', '/w/a.ts']);
  });

  describe.each([
    ['v1', edited],
    ['v2', patched],
  ] as const)('%s completed evidence delivery', (schema, report) => {
    it('publishes a ready path without waiting for another path in the same report', async () => {
      let release: (content: FileContent) => void = () => {};
      const a = new Promise<FileContent>((resolve) => { release = resolve; });
      const { reviews: subject } = reviews({ read: async (path) => path === '/w/a.ts' ? a : 'B' });
      subject.activeSessionChanged(SESSION_ID);
      const first = subject.handleSessionUpdate(input(SESSION_ID, {
        ...report('first', '/w/a.ts', 'a', 'A'),
        content: [...report('first', '/w/a.ts', 'a', 'A').content ?? [], ...report('first', '/w/b.ts', 'b', 'B').content ?? []],
      }, schema));
      try {
        await subject.handleSessionUpdate(input(SESSION_ID, report('second', '/w/b.ts', 'different baseline', 'B'), schema));
        expect(subject.shown()?.file('/w/b.ts')).toEqual({ path: '/w/b.ts', baseline: 'b', current: 'B' });
        expect(subject.shown()?.files().map((file) => file.path)).toEqual(['/w/b.ts']);
      } finally { release('A'); await first; }
      expect(subject.shown()?.files().map((file) => file.path)).toEqual(['/w/a.ts', '/w/b.ts']);
    });

    it('starts a later read for the same path only after earlier evidence settles', async () => {
      let release: (content: FileContent) => void = () => {};
      const firstRead = new Promise<FileContent>((resolve) => { release = resolve; });
      let reads = 0;
      const { reviews: subject } = reviews({ read: () => ++reads === 1 ? firstRead : Promise.resolve('B') });
      subject.activeSessionChanged(SESSION_ID);
      const first = subject.handleSessionUpdate(input(SESSION_ID, report('first', '/w/a.ts', 'a', 'A'), schema));
      const second = subject.handleSessionUpdate(input(SESSION_ID, report('second', '/w/a.ts', 'A', 'B'), schema));
      try { expect(reads).toBe(1); }
      finally { release('A'); await Promise.all([first, second]); }
      expect(reads).toBe(2);
      expect(subject.shown()?.files()).toEqual([{ path: '/w/a.ts', baseline: 'a', current: 'B' }]);
    });

    it('does not reopen resolved review for a successful duplicate completion', async () => {
      const { reviews: subject, watched } = reviews();
      subject.activeSessionChanged(SESSION_ID);
      const update = report('a', '/w/a.ts', 'a', 'A');
      await subject.handleSessionUpdate(input(SESSION_ID, update, schema));
      const decision = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
      if (!decision) { throw new Error('Missing decision'); }
      expect(await subject.decide(decision)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });

      await subject.handleSessionUpdate(input(SESSION_ID, update, schema));
      await subject.handleSessionUpdate(input(SESSION_ID, { kind: 'toolCall', toolCallId: 'a', status: 'completed' }, schema));

      expect(subject.shown()?.files()).toEqual([]);
      expect(watched).toEqual([]);
    });

    it('admits the same candidate when an earlier validation failed', async () => {
      let disk = 'not the reported content';
      const { reviews: subject } = reviews({ read: async () => disk });
      subject.activeSessionChanged(SESSION_ID);
      const update = report('a', '/w/a.ts', 'a', 'A');
      await subject.handleSessionUpdate(input(SESSION_ID, update, schema));
      expect(subject.shown()?.files()).toEqual([]);

      disk = 'A';
      await subject.handleSessionUpdate(input(SESSION_ID, update, schema));

      expect(subject.shown()?.files()).toEqual([{ path: '/w/a.ts', baseline: 'a', current: 'A' }]);
    });

    it('admits a fresh revision that returns to previously consumed content', async () => {
      let disk = 'A';
      const { reviews: subject } = reviews({ read: async () => disk });
      subject.activeSessionChanged(SESSION_ID);
      const original = report('a', '/w/a.ts', 'a', 'A');
      await subject.handleSessionUpdate(input(SESSION_ID, original, schema));
      const decision = subject.captureDecision({ action: 'keep-file', path: '/w/a.ts' });
      if (!decision) { throw new Error('Missing decision'); }
      expect(await subject.decide(decision)).toEqual({ kind: 'applied', saved: true, resolved: ['/w/a.ts'] });

      disk = 'B';
      await subject.handleSessionUpdate(input(SESSION_ID, { ...report('a', '/w/a.ts', 'A', 'B'), status: 'running' }, schema));
      disk = 'A';
      await subject.handleSessionUpdate(input(SESSION_ID, original, schema));

      expect(subject.shown()?.files()).toEqual([{ path: '/w/a.ts', baseline: 'a', current: 'A' }]);
    });
  });

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
  it('applies a save observation to shared pending work after selection changes', async () => {
    let document = { instance: {}, version: 1, dirty: false, text: 'A\nb\nC\n' };
    const { reviews: subject } = reviews({ read: async () => 'A\nb\nC\n', snapshot: () => document,
      save: async () => {
        subject.activeSessionChanged(OTHER_SESSION_ID);
        document = { ...document, version: 2, dirty: true, text: 'A\nB\nC\n' };
        await subject.observeDocument({ path: '/w/a.ts', source: 'save', before: 'A\nb\nC\n', after: document.text,
          edits: [{ first: 1, last: 1, addedLines: 0, start: 2, end: 3, text: 'B' }],
        });
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a\nb\nc\n', 'A\nb\nC\n'), 'v1'));
    const a = subject.shown();
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'other\nb\nc\n', 'A\nb\nC\n'), 'v1'));
    const captured = subject.captureDecision({ action: 'keep-change', path: '/w/a.ts',
      change: { original: { start: 0, end: 1 }, modified: { start: 0, end: 1 } },
    });
    if (!captured) { throw new Error('Missing decision'); }
    await subject.decide(captured);
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('A\nB\nc\n');
    expect(a?.file('/w/a.ts')).toBe(subject.shown()?.file('/w/a.ts'));
  });
  it('shares takeover history when another session associates with the same path', async () => {
    const { reviews: subject } = reviews();
    const observe = (source: 'user' | 'undo', before: string, after: string) => subject.observeDocument({
      path: '/w/a.ts', source, before, after, edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: before.length, text: after }],
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    await observe('user', 'A', 'typed A');
    subject.activeSessionChanged(OTHER_SESSION_ID);
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'b', 'A'), 'v1'));
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('typed A');
    const b = subject.shown();
    subject.activeSessionChanged(SESSION_ID);
    await observe('undo', 'typed A', 'A');
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('a');
    expect(b?.file('/w/a.ts')).toBe(subject.shown()?.file('/w/a.ts'));
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
  it('resolves shared dirty whole-file Undo without saving or admitting editor undo as evidence', async () => {
    let document = { instance: {}, version: 1, dirty: true, text: 'my edits' };
    const { reviews: subject, watched } = reviews({
      snapshot: () => document,
      restore: async (_path, content, current) => {
        if (!current?.()) { throw new Error('Stale restore'); }
        document = { ...document, version: 2, text: content ?? '' };
      },
    });
    subject.activeSessionChanged(SESSION_ID);
    await subject.handleSessionUpdate(input(SESSION_ID, edited('a', '/w/a.ts', 'a', 'A'), 'v1'));
    const a = subject.shown();
    await subject.handleSessionUpdate(input(OTHER_SESSION_ID, edited('b', '/w/a.ts', 'other', 'A'), 'v1'));
    subject.activeSessionChanged(OTHER_SESSION_ID);
    const b = subject.shown();
    const captured = subject.captureDecision({ action: 'undo-file', path: '/w/a.ts' });
    if (!captured) { throw new Error('Missing decision'); }
    expect(await subject.decide(captured)).toEqual({ kind: 'applied', saved: false, resolved: ['/w/a.ts'] });
    expect(document.text).toBe('a');
    expect(document.dirty).toBe(true);
    expect(a?.files()).toEqual([]);
    expect(b?.files()).toEqual([]);
    expect(watched).toEqual([]);
    document = { ...document, version: 3, text: 'my edits' };
    await subject.observeDocument({ path: '/w/a.ts', source: 'undo', before: 'a', after: document.text,
      edits: [{ first: 0, last: 0, addedLines: 0, start: 0, end: 1, text: document.text }],
    });
    expect(a?.files()).toEqual([]);
    expect(b?.files()).toEqual([]);
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
    await subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'Typed',
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
    await subject.observeDocument({ path: '/w/a.ts', source: 'user', before: 'A', after: 'Typed',
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

  it('keeps admitted descendant evidence across Load without carrying partial tool calls into the new transcript', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged(SESSION_ID);
    const childReport = (update: SessionUpdate): QualifiedSessionUpdate => ({
      ...input(OTHER_SESSION_ID, update, 'v2'), reviewOwner: load.origin.identity,
    });
    await subject.handleSessionUpdate(childReport(patched('done', '/w/a.ts', 'a', 'A')));
    await subject.handleSessionUpdate(childReport({ ...patched('partial', '/w/b.ts', 'b', 'B'), status: 'running' }));
    subject.loadStarted(load);
    await subject.handleSessionUpdate(childReport(patched('replayed', '/w/b.ts', 'b', 'B')));
    subject.loadEnded(load);
    await subject.handleSessionUpdate(childReport({ kind: 'toolCall', toolCallId: 'partial', status: 'completed' }));
    expect(shownPaths()).toEqual(['/w/a.ts']);
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
