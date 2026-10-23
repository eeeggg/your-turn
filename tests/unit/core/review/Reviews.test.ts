import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { Reviews } from '@/core/review/Reviews';

/** A completed tool call that changed `path` from `old` to `now`, which the disk holds. */
const edited = (toolCallId: string, path: string, old: string, now: string): SessionUpdate => ({
  kind: 'toolCall',
  toolCallId,
  status: 'completed',
  content: [{ kind: 'diff', diff: { kind: 'wholeFile', path, oldText: old, newText: now } }],
});

/** As `edited`, the way a v2 driver passes it up: `path` modified from the single line `old` to `now`, as a `git_patch`. */
const patched = (toolCallId: string, path: string, old: string, now: string): SessionUpdate => ({
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
function reviews() {
  const disk: Record<string, string> = { '/w/a.ts': 'A', '/w/b.ts': 'B' };
  const watched: string[] = [];
  const subject = new Reviews({
    read: async (path) => disk[path] ?? null,
    restore: async () => {},
    watch: (path) => {
      watched.push(path);
      return { dispose: () => watched.splice(watched.indexOf(path), 1) };
    },
  });
  let heard = 0;
  subject.addListener(() => heard++);
  const shownPaths = () => subject.shown()?.files().map((file) => file.path);
  return { reviews: subject, heard: () => heard, shownPaths, watched };
}

describe('Reviews', () => {
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
    subject.dispose();
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
