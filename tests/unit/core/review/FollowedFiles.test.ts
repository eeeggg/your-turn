import { describe, expect, it, vi } from 'vitest';
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
    reads[0]?.give('edited');
    await vi.waitFor(() => expect(current('/w/a.ts')).toBe('edited'));
  });

  it('lets a file go once a read finds it back at its baseline', async () => {
    const { review, reads, watchers, change } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    reads[0]?.give('one');
    await vi.waitFor(() => expect(review.files()).toEqual([]));
    expect(watchers.size).toBe(0);
  });

  it('reads one at a time, reading once more after changes heard meanwhile, so the latest read lands last', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    change('/w/a.ts');
    change('/w/a.ts');
    expect(reads.map((read) => read.path)).toEqual(['/w/a.ts']);
    reads[0]?.give('older');
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]?.give('newer');
    await vi.waitFor(() => expect(current('/w/a.ts')).toBe('newer'));
    expect(reads).toHaveLength(2);
  });

  it('keeps following after a read fails', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    reads[0]?.fail(new Error('EACCES'));
    await vi.waitFor(() => expect(current('/w/a.ts')).toBe('two'));
    change('/w/a.ts');
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]?.give('three');
    await vi.waitFor(() => expect(current('/w/a.ts')).toBe('three'));
  });

  it('drops a read that lands after its file left the review, though it came back since', async () => {
    const { review, reads, change, current } = followed();
    review.changed('/w/a.ts', 'one', 'two');
    change('/w/a.ts');
    review.keepFile('/w/a.ts');
    review.changed('/w/a.ts', 'two', 'three');
    reads[0]?.give('read before it left');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current('/w/a.ts')).toBe('three');
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
