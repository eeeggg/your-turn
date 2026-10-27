import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { setLogSink } from '@/core/Log';
import { FollowedFiles } from '@/core/review/FollowedFiles';
import { Review, type FileContent } from '@/core/review/Review';

/** A read the test settles, with what it gives or how it fails. */
interface PendingRead {
  path: string;
  finished: boolean;
  give(content: FileContent): void;
  fail(error: Error): void;
}

/** A review's files followed, with the reads asked for, the watchers by path, and a change heard by a path's watcher. */
function followed() {
  const review = new Review(async () => {});
  const reads: PendingRead[] = [];
  const pending = new Set<PendingRead>();
  const watchers = new Map<string, () => void>();
  const subject = new FollowedFiles(
    review,
    (path) => {
      let read: PendingRead;
      const reading = new Promise<FileContent>((resolve, reject) => {
        read = { path, finished: false, give: resolve, fail: reject };
        reads.push(read);
        pending.add(read);
      });
      return reading.finally(() => { read.finished = true; pending.delete(read); });
    },
    (path, changed) => {
      watchers.set(path, changed);
      return { dispose: () => watchers.delete(path) };
    },
  );
  onTestFinished(async () => {
    const disposed = subject.dispose();
    for (const read of pending) { read.give(null); }
    await disposed;
  });
  const change = (path: string) => watchers.get(path)?.();
  const current = (path: string) => review.file(path)?.current;
  return { review, subject, reads, watchers, change, current };
}

/** Settles on the first review change after which `condition` holds. */
function reviewChanged(review: Review, condition: () => boolean): Promise<void> {
  if (condition()) { return Promise.resolve(); }
  return new Promise((resolve) => {
    review.addListener(() => {
      if (condition()) { resolve(); }
    });
  });
}

afterEach(() => { setLogSink(undefined); });

describe('FollowedFiles', () => {
  it('reports a watcher disposal failure only after detaching sibling watchers and draining their reads', async () => {
    const review = new Review(async () => {});
    const watchers = new Map<string, () => void>();
    const reads: { give: (content: FileContent) => void }[] = [];
    const failure = new Error('watcher disposal failed');
    const subject = new FollowedFiles(
      review,
      () => new Promise((resolve) => { reads.push({ give: resolve }); }),
      (path, changed) => {
        watchers.set(path, changed);
        return {
          dispose: () => {
            watchers.delete(path);
            if (path === '/w/a.ts') { throw failure; }
          },
        };
      },
    );
    onTestFinished(async () => {
      let disposed: Promise<void> | undefined;
      try { disposed = subject.dispose(); }
      finally { for (const read of reads) { read.give(null); } }
      await expect(disposed).rejects.toMatchObject({ errors: [failure] });
    });
    review.changed('/w/a.ts', 'a', 'A');
    review.changed('/w/b.ts', 'b', 'B');
    watchers.get('/w/b.ts')?.();
    let readFinished = false;
    const disposed = subject.dispose();
    const finishedAtDisposal = disposed.catch(() => readFinished);
    expect(subject.dispose()).toBe(disposed);
    expect(watchers.size).toBe(0);
    reads[0]?.give('late');
    readFinished = true;
    await expect(disposed).rejects.toMatchObject({ errors: [failure] });

    expect(await finishedAtDisposal).toBe(true);
    expect(review.file('/w/b.ts')?.current).toBe('B');
  });

  it('awaits a pending read after disposal and discards queued refreshes and late results', async () => {
    const { review, subject, reads, watchers, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    const queued = watchers.get('/w/a.ts');
    change('/w/a.ts');
    change('/w/a.ts');
    const disposed = subject.dispose();
    const finishedAtDisposal = disposed.then(() => reads[0]?.finished);
    expect(subject.dispose()).toBe(disposed);
    expect(watchers.size).toBe(0);
    queued?.();
    reads[0]?.give('late');
    await disposed;

    expect(await finishedAtDisposal).toBe(true);
    expect(reads).toHaveLength(1);
    expect(current('/w/a.ts')).toBe('two');
  });

  it('drains reads for files that left and returned, even when an older read fails', async () => {
    const { review, subject, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    review.keepFile('/w/a.ts');
    review.changed('/w/a.ts', 'two', 'three');
    change('/w/a.ts');
    const messages: string[] = [];
    const failed = new Promise<void>((resolve) => {
      setLogSink({ log: (message) => { messages.push(message); resolve(); }, warn() {}, error() {}, traffic() {} });
    });
    const disposed = subject.dispose();
    const finishedAtDisposal = disposed.then(() => reads.every((read) => read.finished));
    reads[0]?.fail(new Error('EACCES'));
    await failed;
    reads[1]?.give('too late');
    await disposed;

    expect(await finishedAtDisposal).toBe(true);
    expect(messages).toEqual(['Review: /w/a.ts not read after it changed: EACCES']);
    expect(reads).toHaveLength(2);
    expect(current('/w/a.ts')).toBe('three');
  });

  it('watches a file while it is under review', () => {
    const { review, watchers } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    expect([...watchers.keys()]).toEqual(['/w/a.ts']);
    review.keepFile('/w/a.ts');
    expect([...watchers.keys()]).toEqual([]);
  });

  it('reads a file again when its watcher hears a change, and the review follows what it holds', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    const changed = reviewChanged(review, () => current('/w/a.ts') === 'edited');
    reads[0]?.give('edited');
    await changed;
    expect(current('/w/a.ts')).toBe('edited');
  });

  it('lets a file go once a read finds it back at its baseline', async () => {
    const { review, reads, watchers, change } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    const left = reviewChanged(review, () => review.files().length === 0);
    reads[0]?.give('one');
    await left;
    expect(review.files()).toEqual([]);
    expect(watchers.size).toBe(0);
  });

  it('reads one at a time, reading once more after changes heard meanwhile, so the latest read lands last', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    change('/w/a.ts');
    change('/w/a.ts');
    expect(reads.map((read) => read.path)).toEqual(['/w/a.ts']);
    const older = reviewChanged(review, () => current('/w/a.ts') === 'older');
    reads[0]?.give('older');
    await older;
    expect(reads).toHaveLength(2);
    const newer = reviewChanged(review, () => current('/w/a.ts') === 'newer');
    reads[1]?.give('newer');
    await newer;
    expect(current('/w/a.ts')).toBe('newer');
    expect(reads).toHaveLength(2);
  });

  it('keeps following after a read fails', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    const failed = new Promise<void>((resolve) => {
      setLogSink({ log: () => resolve(), warn() {}, error() {}, traffic() {} });
    });
    reads[0]?.fail(new Error('EACCES'));
    await failed;
    expect(current('/w/a.ts')).toBe('two');
    change('/w/a.ts');
    expect(reads).toHaveLength(2);
    const changed = reviewChanged(review, () => current('/w/a.ts') === 'three');
    reads[1]?.give('three');
    await changed;
    expect(current('/w/a.ts')).toBe('three');
  });

  it('drops a read that lands after its file left the review, though it came back since', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    review.keepFile('/w/a.ts');
    review.changed('/w/a.ts', 'two', 'three');
    const seen: FileContent[] = [];
    review.addListener((path) => {
      if (path === '/w/a.ts') { seen.push(current(path) ?? null); }
    });
    reads[0]?.give('read before it left');
    change('/w/a.ts');
    const currentRead = reviewChanged(review, () => current('/w/a.ts') === 'read after it returned');
    reads[1]?.give('read after it returned');
    await currentRead;
    expect(current('/w/a.ts')).toBe('read after it returned');
    expect(seen).not.toContain('read before it left');
  });

  it('stops every watcher once disposed, and starts none for evidence after', async () => {
    const { review, subject, watchers } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    await subject.dispose();
    expect(watchers.size).toBe(0);
    review.changed('/w/b.ts', 'one', 'two');
    expect(watchers.size).toBe(0);
  });
});
