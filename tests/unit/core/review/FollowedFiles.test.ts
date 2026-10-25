import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink } from '@/core/Log';
import { FollowedFiles } from '@/core/review/FollowedFiles';
import { Review, type FileContent } from '@/core/review/Review';

/** A read the test settles, with what it gives or how it fails. */
interface PendingRead {
  path: string;
  give(content: FileContent): void;
  fail(error: Error): void;
}

/** A review's files followed, with the reads asked for, the watchers by path, and a change heard by a path's watcher. */
function followed() {
  const review = new Review(async () => {});
  const reads: PendingRead[] = [];
  const watchers = new Map<string, () => void>();
  const subject = new FollowedFiles(
    review,
    (path) => new Promise<FileContent>((resolve, reject) => reads.push({ path, give: resolve, fail: reject })),
    (path, changed) => {
      watchers.set(path, changed);
      return { dispose: () => watchers.delete(path) };
    },
  );
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

  it('stops every watcher once disposed, and starts none for evidence after', () => {
    const { review, subject, watchers } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    subject.dispose();
    expect(watchers.size).toBe(0);
    review.changed('/w/b.ts', 'one', 'two');
    expect(watchers.size).toBe(0);
  });
});
