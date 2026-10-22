import { describe, expect, it } from 'vitest';
import { Review, type FileContent } from '@/core/review/Review';

/** A review whose restores are recorded and succeed, or fail with `failure`, with the paths its listener heard. */
function review({ failure }: { failure?: Error } = {}) {
  const restored: [string, FileContent][] = [];
  const subject = new Review(async (path, content) => {
    if (failure) { throw failure; }
    restored.push([path, content]);
  });
  const heard: string[] = [];
  subject.addListener((path) => heard.push(path));
  const files = () => subject.files().map((file): [string, FileContent, FileContent] => [file.path, file.baseline, file.current]);
  return { review: subject, restored, heard, files };
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

  it('keeps a file by letting it go, and all files at once', () => {
    const { review: subject, files, heard } = review();
    subject.changed('/w/a.ts', 'a', 'A');
    subject.changed('/w/b.ts', 'b', 'B');
    subject.changed('/w/c.ts', 'c', 'C');
    subject.keepFile('/w/b.ts');
    expect(files().map(([path]) => path)).toEqual(['/w/a.ts', '/w/c.ts']);
    subject.keepAll();
    expect(files()).toEqual([]);
    expect(heard.slice(3)).toEqual(['/w/b.ts', '/w/a.ts', '/w/c.ts']);
  });

  it('undoes a file by restoring its baseline, then lets it go', async () => {
    const { review: subject, files, restored } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    subject.changed('/w/new.ts', null, 'made');
    subject.changed('/w/old.ts', 'gone', null);
    await subject.undoFile('/w/a.ts');
    await subject.undoFile('/w/new.ts');
    await subject.undoFile('/w/old.ts');
    expect(restored).toEqual([['/w/a.ts', 'one'], ['/w/new.ts', null], ['/w/old.ts', 'gone']]);
    expect(files()).toEqual([]);
  });

  it('keeps a file under review until its restore is done', async () => {
    const { review: subject, files } = review();
    subject.changed('/w/a.ts', 'one', 'two');
    const undone = subject.undoFile('/w/a.ts');
    expect(files()).toEqual([['/w/a.ts', 'one', 'two']]);
    await undone;
    expect(files()).toEqual([]);
  });

  it('keeps a file under review when its restore fails', async () => {
    const failure = new Error('EACCES');
    const { review: subject, files } = review({ failure });
    subject.changed('/w/a.ts', 'one', 'two');
    await expect(subject.undoFile('/w/a.ts')).rejects.toBe(failure);
    expect(files()).toEqual([['/w/a.ts', 'one', 'two']]);
  });

  it('restores nothing for a file not under review', async () => {
    const { review: subject, restored } = review();
    await subject.undoFile('/w/a.ts');
    subject.keepFile('/w/a.ts');
    expect(restored).toEqual([]);
  });
});
