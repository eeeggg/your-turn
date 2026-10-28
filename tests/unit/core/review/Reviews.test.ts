import { describe, expect, it, onTestFinished } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { Reviews, type ReviewFiles } from '@/core/review/Reviews';
import type { FileContent } from '@/core/review/Review';
import { setLogSink } from '@/core/Log';

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
function reviews(files: Partial<ReviewFiles> = {}) {
  const disk: Record<string, string> = { '/w/a.ts': 'A', '/w/b.ts': 'B' };
  const watched: string[] = [];
  const subject = new Reviews({
    read: async (path) => disk[path] ?? null,
    restore: async () => {},
    watch: (path) => {
      watched.push(path);
      return { dispose: () => watched.splice(watched.indexOf(path), 1) };
    },
    ...files,
  });
  onTestFinished(async () => { await subject.dispose(); });
  let heard = 0;
  subject.addListener(() => heard++);
  const shownPaths = () => subject.shown()?.files().map((file) => file.path);
  return { reviews: subject, heard: () => heard, shownPaths, watched };
}

describe('Reviews', () => {
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
    subject.activeSessionChanged('s1');
    const evidence = schema === 'v1' ? edited : patched;
    const handlingOld = subject.handleSessionUpdate('s1', evidence('t1', '/w/a.ts', 'a', 'A'), schema);
    handling.push(handlingOld);
    subject.sessionRemoved('s1');
    handling.push(subject.handleSessionUpdate('s1', evidence('t2', '/w/b.ts', 'b', 'B'), schema));
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
    await subject.handleSessionUpdate('late', evidence('t3', '/w/c.ts', 'c', 'C'), schema);
    subject.activeSessionChanged('late');

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
    const handling = subject.handleSessionUpdate('s1', {
      kind: 'toolCall',
      toolCallId: 't1',
      status: 'completed',
      content: [
        ...evidence('t1', '/w/a.ts', 'a', 'A').content ?? [],
        ...evidence('t1', '/w/b.ts', 'b', 'B').content ?? [],
      ],
    }, schema);
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
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
    subject.activeSessionChanged('s1');
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
      watch: (path, changed) => {
        watchers.set(path, changed);
        return {
          dispose: () => {
            watchers.delete(path);
            if (path === '/w/a.ts') { throw failure; }
          },
        };
      },
    });
    onTestFinished(async () => {
      const disposed = subject.dispose();
      for (const read of reads) { read.give(null); }
      await expect(disposed).rejects.toMatchObject({ errors: [{ errors: [failure] }] });
    });
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
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
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
    expect(shownPaths()).toBeUndefined();
    subject.activeSessionChanged('s1');
    expect(shownPaths()).toEqual(['/w/a.ts']);
    subject.activeSessionChanged('s2');
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it("feeds each session's updates to the guard of the driver that passed them up", async () => {
    const { reviews: subject, shownPaths } = reviews();
    await subject.handleSessionUpdate('s1', patched('t1', '/w/a.ts', 'a', 'A'), 'v2');
    await subject.handleSessionUpdate('s1', edited('t2', '/w/b.ts', 'b', 'B'), 'v2');
    await subject.handleSessionUpdate('s2', patched('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s2', edited('t2', '/w/b.ts', 'b', 'B'), 'v1');
    subject.activeSessionChanged('s1');
    expect(shownPaths()).toEqual(['/w/a.ts']);
    expect(subject.shown()?.file('/w/a.ts')?.baseline).toBe('a');
    subject.activeSessionChanged('s2');
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it("keeps a session's review when another driver's update comes for it, fed to that driver's guard from then on", async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged('s1');
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s1', patched('t2', '/w/b.ts', 'b', 'B'), 'v2');
    await subject.handleSessionUpdate('s1', edited('t3', '/w/b.ts', 'x', 'B'), 'v2');
    expect(shownPaths()).toEqual(['/w/a.ts', '/w/b.ts']);
    expect(subject.shown()?.file('/w/b.ts')?.baseline).toBe('b');
  });

  it('keeps collecting evidence for a session not shown', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged('s1');
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
    subject.activeSessionChanged('s2');
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it('tells its listener when another session is shown, and when the shown review changes, not when another does', async () => {
    const { reviews: subject, heard } = reviews();
    subject.activeSessionChanged('s1');
    expect(heard()).toBe(1);
    subject.activeSessionChanged('s1');
    expect(heard()).toBe(1);
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    expect(heard()).toBe(2);
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
    expect(heard()).toBe(2);
  });

  it("takes nothing of a load's replay as evidence, and what comes after it", async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged('s1');
    subject.loadStarted('s1');
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    subject.loadEnded('s1');
    expect(shownPaths() ?? []).toEqual([]);
    await subject.handleSessionUpdate('s1', edited('t2', '/w/b.ts', 'b', 'B'), 'v1');
    expect(shownPaths()).toEqual(['/w/b.ts']);
  });

  it("keeps a removed session's review, shown again when its session is", async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged('s1');
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    subject.sessionRemoved('s1');
    subject.activeSessionChanged(null);
    expect(shownPaths()).toBeUndefined();
    subject.activeSessionChanged('s1');
    expect(shownPaths()).toEqual(['/w/a.ts']);
  });

  it("watches the files of every session's review, shown or not, its session removed or not", async () => {
    const { reviews: subject, watched } = reviews();
    subject.activeSessionChanged('s1');
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
    subject.sessionRemoved('s2');
    expect(watched).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it("stops watching every session's files when disposed", async () => {
    const { reviews: subject, watched } = reviews();
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    await subject.handleSessionUpdate('s2', edited('t1', '/w/b.ts', 'b', 'B'), 'v1');
    await subject.dispose();
    expect(watched).toEqual([]);
  });

  it('follows evidence read after its session was removed, as its turn may go on', async () => {
    const { reviews: subject, watched } = reviews();
    const reading = subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    subject.sessionRemoved('s1');
    await reading;
    expect(watched).toEqual(['/w/a.ts']);
  });

  it('takes evidence again for a session removed mid-load, keeping its review', async () => {
    const { reviews: subject, shownPaths } = reviews();
    subject.activeSessionChanged('s1');
    await subject.handleSessionUpdate('s1', edited('t1', '/w/a.ts', 'a', 'A'), 'v1');
    subject.loadStarted('s1');
    subject.sessionRemoved('s1');
    await subject.handleSessionUpdate('s1', edited('t2', '/w/b.ts', 'b', 'B'), 'v1');
    expect(shownPaths()).toEqual(['/w/a.ts', '/w/b.ts']);
  });
});
