import { describe, expect, it, onTestFinished } from 'vitest';
import { Review, type FileContent } from '@/core/review/Review';
import { Reviews } from '@/core/review/Reviews';

/** A shared file store with the paths its listener heard. */
function review() {
  const subject = new Review();
  const heard: string[] = [];
  subject.addListener((path) => heard.push(path));
  const files = () => subject.files().map((file): [string, FileContent, FileContent] => [file.path, file.baseline, file.current]);
  return { review: subject, heard, files };
}

/** Decision scenarios use the authority, not the mutable file store. */
function authority(restore?: (path: string, content: FileContent) => Promise<void>) {
  const disk = new Map<string, FileContent>();
  const restored: [string, FileContent][] = [];
  const subject = new Reviews({
    read: async (path) => disk.get(path) ?? null,
    restore: async (path, content) => {
      if (restore) { await restore(path, content); }
      restored.push([path, content]);
      disk.set(path, content);
    },
    watch: () => ({ dispose() {} }), snapshot: () => undefined,
    applyEdit: async () => { throw new Error('Unexpected edit'); },
    save: async () => { throw new Error('Unexpected save'); },
  }, { resolutionBlocked: () => false, onChanged: () => () => {},
    runDecision: async (action) => ({ kind: 'completed', value: await action(() => true) }),
  });
  onTestFinished(() => subject.dispose());
  subject.activeSessionChanged({ agentName: 'fake', agentId: 'source', sessionId: 'session' });
  let sequence = 0;
  const changed = async (path: string, before: FileContent, after: FileContent) => {
    disk.set(path, after);
    await subject.handleSessionUpdate({ origin: { identity: { configuredName: 'fake', sessionId: 'session' }, sourceId: 'source' },
      schema: 'v1', update: { kind: 'toolCall', toolCallId: String(++sequence), status: 'completed',
        content: [{ kind: 'diff', diff: { kind: 'wholeFile', path, oldText: before, newText: after ?? '' } }],
      },
    });
  };
  const decide = async (action: 'keep-file' | 'keep-all' | 'undo-file', path?: string) => {
    const captured = subject.captureDecision({ action, ...(path === undefined ? {} : { path }) });
    return captured ? subject.decide(captured) : undefined;
  };
  const files = () => (subject.shown()?.files() ?? []).map((file) => [file.path, file.baseline, file.current]);
  return { changed, decide, files, restored, subject };
}

describe('Review', () => {
  it('puts a changed file under review, its baseline what it held first and its current content what it holds now', () => {
    const { review: subject, files, heard } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    subject.changed('/w/a.ts', 'two', 'three');
    expect(files()).toEqual([['/w/a.ts', 'one', 'three']]);
    expect(heard).toEqual(['/w/a.ts', '/w/a.ts']);
  });

  it('keeps files in the order they came under review', () => {
    const { review: subject, files } = review();
    subject.changed('/w/b.ts', 'b', 'B');
    subject.changed('/w/a.ts', 'a', 'A');
    subject.changed('/w/b.ts', 'B', 'BB');
    expect(files().map(([path]) => path)).toEqual(['/w/b.ts', '/w/a.ts']);
  });

  it('takes a created file as holding nothing before, and a deleted one as holding nothing after', () => {
    const { review: subject, files } = review();
    subject.changed('/w/new.ts', null, 'made');
    subject.changed('/w/old.ts', 'gone', null);
    expect(files()).toEqual([['/w/new.ts', null, 'made'], ['/w/old.ts', 'gone', null]]);
  });

  it('preserves a created file baseline across edits and restoration of its initial content, so undo deletes it', async () => {
    const { changed, decide, files, restored } = authority();
    await changed('/w/new.ts', null, 'made');
    await changed('/w/new.ts', 'made', 'modified');
    expect(files()).toEqual([['/w/new.ts', null, 'modified']]);
    await changed('/w/new.ts', 'modified', 'made');
    expect(files()).toEqual([['/w/new.ts', null, 'made']]);
    expect(await decide('undo-file', '/w/new.ts')).toEqual({ kind: 'applied', saved: true, resolved: ['/w/new.ts'] });
    expect(restored).toEqual([['/w/new.ts', null]]);
    expect(files()).toEqual([]);
  });

  it('removes a created file from review when later change evidence deletes it', () => {
    const { review: subject, files } = review();
    subject.changed('/w/new.ts', null, 'made');
    subject.changed('/w/new.ts', 'made', null);
    expect(files()).toEqual([]);
  });

  it('ignores a change that leaves a file as it was', () => {
    const { review: subject, files, heard } = review();
    subject.changed('/w/a.ts', 'same', 'same');
    expect(files()).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('follows what a file under review holds, whoever wrote it, and lets it go once back at its baseline', () => {
    const { review: subject, files, heard } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    subject.read('/w/a.ts', 'two, edited');
    expect(files()).toEqual([['/w/a.ts', 'one', 'two, edited']]);
    subject.read('/w/a.ts', 'one');
    expect(files()).toEqual([]);
    expect(heard).toEqual(['/w/a.ts', '/w/a.ts', '/w/a.ts']);
  });

  it('lets a created file go once it is deleted again', () => {
    const { review: subject, files } = review();
    subject.changed('/w/new.ts', null, 'made');
    subject.read('/w/new.ts', null);
    expect(files()).toEqual([]);
  });

  it('takes nothing read of a file not under review as evidence', () => {
    const { review: subject, files, heard } = review();
    subject.read('/w/a.ts', 'changed by someone');
    expect(files()).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('tells nothing when a read finds what it already holds', () => {
    const { review: subject, heard } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    subject.read('/w/a.ts', 'two');
    expect(heard).toEqual(['/w/a.ts']);
  });

  it('starts a new baseline for a file that changes again after it left the review', () => {
    const { review: subject, files } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    subject.keepFile('/w/a.ts');
    subject.changed('/w/a.ts', 'two', 'three');
    expect(files()).toEqual([['/w/a.ts', 'two', 'three']]);
  });

  it('keeps a file by letting it go, and all files at once', async () => {
    const { changed, decide, files, subject } = authority();
    await changed('/w/a.ts', 'a', 'A');
    await changed('/w/b.ts', 'b', 'B');
    await changed('/w/c.ts', 'c', 'C');
    const heard: unknown[] = [];
    subject.addListener(() => heard.push(files()));
    await decide('keep-file', '/w/b.ts');
    expect(files().map(([path]) => path)).toEqual(['/w/a.ts', '/w/c.ts']);
    await decide('keep-all');
    expect(files()).toEqual([]);
    expect(heard).toEqual([
      [['/w/a.ts', 'a', 'A'], ['/w/c.ts', 'c', 'C']],
      [['/w/c.ts', 'c', 'C']],
      [],
    ]);
  });

  it('undoes a file by restoring its baseline, then lets it go', async () => {
    const { changed, decide, files, restored } = authority();
    await changed('/w/a.ts', 'one', 'two');
    await changed('/w/new.ts', null, 'made');
    await changed('/w/old.ts', 'gone', null);
    for (const path of ['/w/a.ts', '/w/new.ts', '/w/old.ts']) {
      expect(await decide('undo-file', path)).toEqual({ kind: 'applied', saved: true, resolved: [path] });
    }
    expect(restored).toEqual([['/w/a.ts', 'one'], ['/w/new.ts', null], ['/w/old.ts', 'gone']]);
    expect(files()).toEqual([]);
  });

  it('keeps a file under review until its restore is done', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = () => {};
    const restoring = new Promise<void>((resolve) => { started = resolve; });
    const { changed, decide, files } = authority(async () => { started(); await gate; });
    await changed('/w/a.ts', 'one', 'two');
    const undone = decide('undo-file', '/w/a.ts');
    try {
      await restoring;
      expect(files()).toEqual([['/w/a.ts', 'one', 'two']]);
    } finally { release(); await undone; }
    expect(files()).toEqual([]);
  });

  it('keeps a file under review when its restore fails', async () => {
    const failure = new Error('EACCES');
    const { changed, decide, files } = authority(async () => { throw failure; });
    await changed('/w/a.ts', 'one', 'two');
    expect(await decide('undo-file', '/w/a.ts')).toEqual({ kind: 'failed', reason: 'EACCES', applied: [], unsaved: [] });
    expect(files()).toEqual([['/w/a.ts', 'one', 'two']]);
  });

  it('sets a baseline of its own, telling its listeners, and keeps the file under review until it holds the baseline', () => {
    const { review: subject, files, heard } = review();
    subject.changed('/w/a.ts', 'one\n', 'one\ntwo\nthree\n');
    subject.setBaseline('/w/a.ts', 'one\ntwo\n');
    expect(files()).toEqual([['/w/a.ts', 'one\ntwo\n', 'one\ntwo\nthree\n']]);
    subject.setBaseline('/w/a.ts', 'one\ntwo\nthree, typed\n');
    expect(files()).toEqual([['/w/a.ts', 'one\ntwo\nthree, typed\n', 'one\ntwo\nthree\n']]);
    subject.read('/w/a.ts', 'one\ntwo\nthree, typed\n');
    expect(files()).toEqual([]);
    expect(heard).toEqual(['/w/a.ts', '/w/a.ts', '/w/a.ts', '/w/a.ts']);
  });

  it('lets a file go at once when the baseline it sets is what the file holds', () => {
    const { review: subject, files } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    subject.setBaseline('/w/a.ts', 'two');
    expect(files()).toEqual([]);
  });

  it('sets no baseline for a file not under review', () => {
    const { review: subject, files, heard } = review();
    subject.setBaseline('/w/a.ts', 'one');
    expect(files()).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('restores nothing for a file not under review', async () => {
    const { decide, restored } = authority();
    expect(await decide('undo-file', '/w/a.ts')).toBeUndefined();
    expect(await decide('keep-file', '/w/a.ts')).toBeUndefined();
    expect(restored).toEqual([]);
  });
});
