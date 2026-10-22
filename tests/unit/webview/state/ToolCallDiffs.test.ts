import { describe, expect, it } from 'vitest';
import type { FileChange, ToolCallDiff } from '@/shared/WebviewMessages';
import { diffFiles, shownPath, withinLineLimit, type DiffFile } from '@/webview/state/ToolCallDiffs';

/** As ACP asks: absolute paths, no `a/` or `b/`. Git writes no hunks for a binary file. */
const gitPatch = `diff --git /work/logo.png /work/logo.png
index f14bf99..3ca8acd 100644
Binary files /work/logo.png and /work/logo.png differ
diff --git /work/src/config.ts /work/src/config.ts
index 451c364..291ce48 100644
--- /work/src/config.ts
+++ /work/src/config.ts
@@ -1,3 +1,4 @@
 import { readFileSync } from 'node:fs';
+import { clamp } from './math';
 
 export interface Config {
diff --git /work/src/legacy.ts /work/src/legacy.ts
deleted file mode 100644
index da9ee9d..0000000
--- /work/src/legacy.ts
+++ /dev/null
@@ -1 +0,0 @@
-legacy
diff --git /work/src/util.ts /work/src/math.ts
similarity index 73%
rename from /work/src/util.ts
rename to /work/src/math.ts
index 0210f95..aac585f 100644
--- /work/src/util.ts
+++ /work/src/math.ts
@@ -1,2 +1,3 @@
+/** The value, kept within min and max. */
 export function clamp(value: number, min: number, max: number): number {
   return Math.min(Math.max(value, min), max);
diff --git /work/src/version.ts /work/src/version.ts
new file mode 100644
index 0000000..a1e424e
--- /dev/null
+++ /work/src/version.ts
@@ -0,0 +1 @@
+export const version = "1.1.0";
diff --git /work/extra.ts /work/extra.ts
index 1111111..2222222 100644
--- /work/extra.ts
+++ /work/extra.ts
@@ -1 +1 @@
-old
+new
`;

function change(operation: FileChange['operation'], path: string, extra: Partial<FileChange> = {}): FileChange {
  return { operation, path, fileType: 'text', mimeType: null, ...extra };
}

const changes: FileChange[] = [
  change('modify', '/work/src/config.ts'),
  change('move', '/work/src/math.ts', { oldPath: '/work/src/util.ts' }),
  change('delete', '/work/src/legacy.ts'),
  change('add', '/work/src/version.ts'),
  change('modify', '/work/logo.png', { fileType: 'binary', mimeType: 'image/png' }),
  change('add', '/work/src/empty.ts'),
];

type Shown = Omit<DiffFile, 'reported'>;

function shown(file: Partial<Shown> & Pick<Shown, 'operation' | 'path'>): Shown {
  return { oldPath: null, added: 0, removed: 0, hunks: [], note: null, ...file };
}

/** The files as the view draws them, leaving out what the editor would open. */
function displayed(files: readonly DiffFile[]): Shown[] {
  return files.map(({ reported: _, ...file }) => file);
}

describe('a whole file', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';

  it('shows an edit as hunks with three lines of context, numbered in each file, and its lines added and removed', () => {
    const edit: ToolCallDiff = { kind: 'wholeFile', path: '/work/src/a.ts', oldText: before, newText: 'a\nb\nc\nD\ne\nf\ng\nh\n' };

    expect(displayed(diffFiles(edit, '/work'))).toEqual([
      shown({
        operation: 'modify',
        path: 'src/a.ts',
        added: 1,
        removed: 1,
        hunks: [{ oldStart: 1, oldLines: 7, newStart: 1, newLines: 7, lines: [' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g'] }],
      }),
    ]);
  });

  it('shows a new file as all added and an emptied one as all removed, without Git\'s "no newline" marks', () => {
    const created: ToolCallDiff = { kind: 'wholeFile', path: '/work/new.ts', oldText: null, newText: 'x\ny' };
    const emptied: ToolCallDiff = { kind: 'wholeFile', path: '/work/old.ts', oldText: 'x\n', newText: '' };

    expect(displayed(diffFiles(created, '/work'))).toEqual([
      shown({ operation: 'add', path: 'new.ts', added: 2, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }] }),
    ]);
    expect(displayed(diffFiles(emptied, '/work'))).toEqual([
      shown({ operation: 'modify', path: 'old.ts', removed: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-x'] }] }),
    ]);
  });

  it('says a file is too large to show when its hunks take too long to work out', () => {
    const lines = Array.from({ length: 100_000 }, (_, index) => `line ${index}`);
    const edited = lines.map((line, index) => (index % 7 === 0 ? `${line} edited` : line));
    const large: ToolCallDiff = { kind: 'wholeFile', path: '/work/big.ts', oldText: lines.join('\n'), newText: edited.join('\n') };

    expect(diffFiles(large, '/work')).toEqual([
      { ...shown({ operation: 'modify', path: 'big.ts', note: 'tooLarge' }), reported: { path: '/work/big.ts', operation: 'modify', lines: { kind: 'wholeFile', oldText: large.oldText, newText: large.newText } } },
    ]);
  });

  it('gives the editor the whole file, before and after, at the path the agent reported', () => {
    const created: ToolCallDiff = { kind: 'wholeFile', path: '/work/new.ts', oldText: null, newText: 'x\n' };

    expect(diffFiles(created, '/work').map((file) => file.reported)).toEqual([
      { path: '/work/new.ts', operation: 'add', lines: { kind: 'wholeFile', oldText: null, newText: 'x\n' } },
    ]);
  });
});

describe('changes with a patch', () => {
  it("gives each change its file patch by the path it ends at, in the changes' order, then file patches no change names", () => {
    const diff: ToolCallDiff = { kind: 'changes', changes, patch: { format: 'git_patch', text: gitPatch } };

    expect(displayed(diffFiles(diff, '/work'))).toEqual([
      shown({
        operation: 'modify',
        path: 'src/config.ts',
        added: 1,
        hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" import { readFileSync } from 'node:fs';", "+import { clamp } from './math';", ' ', ' export interface Config {'] }],
      }),
      shown({
        operation: 'move',
        path: 'src/math.ts',
        oldPath: 'src/util.ts',
        added: 1,
        hunks: [{
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            '+/** The value, kept within min and max. */',
            ' export function clamp(value: number, min: number, max: number): number {',
            '   return Math.min(Math.max(value, min), max);',
          ],
        }],
      }),
      shown({ operation: 'delete', path: 'src/legacy.ts', removed: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-legacy'] }] }),
      shown({ operation: 'add', path: 'src/version.ts', added: 1, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export const version = "1.1.0";'] }] }),
      shown({ operation: 'modify', path: 'logo.png', note: 'binary' }),
      shown({ operation: 'add', path: 'src/empty.ts', note: 'noLines' }),
      shown({ operation: 'modify', path: 'extra.ts', added: 1, removed: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }),
    ]);
  });

  it('notes a directory and a symbolic link, which have no lines', () => {
    const diff: ToolCallDiff = {
      kind: 'changes',
      changes: [change('add', '/work/dist', { fileType: 'directory' }), change('add', '/work/latest', { fileType: 'symlink' })],
      patch: { format: 'git_patch', text: '' },
    };

    expect(diffFiles(diff, '/work').map((file) => file.note)).toEqual(['directory', 'symlink']);
  });

  it("gives the editor each file's hunks as reported, with Git's \"no newline\" marks; no lines for a file without them; nothing for a directory", () => {
    const patch = [
      'diff --git /work/a.ts /work/a.ts',
      '--- /work/a.ts',
      '+++ /work/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const diff: ToolCallDiff = {
      kind: 'changes',
      changes: [change('modify', '/work/a.ts'), change('modify', '/work/b.bin', { fileType: 'binary' }), change('add', '/work/dist', { fileType: 'directory' })],
      patch: { format: 'git_patch', text: patch },
    };

    const files = diffFiles(diff, '/work');

    expect(files.map((file) => file.reported)).toEqual([
      {
        path: '/work/a.ts',
        operation: 'modify',
        lines: { kind: 'hunks', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'] }] },
      },
      { path: '/work/b.bin', operation: 'modify', lines: null },
      null,
    ]);
    expect(files[0]?.hunks[0]?.lines).toEqual(['-old', '+new']);
  });
});

describe('changes without lines to show', () => {
  const twoFiles = [change('modify', '/work/a.ts'), change('delete', '/work/b.bin', { fileType: 'binary' })];

  it('notes each file of a diff with no patch, whatever its type', () => {
    expect(displayed(diffFiles({ kind: 'changes', changes: twoFiles, patch: null }, '/work'))).toEqual([
      shown({ operation: 'modify', path: 'a.ts', note: 'noPatch' }),
      shown({ operation: 'delete', path: 'b.bin', note: 'noPatch' }),
    ]);
  });

  it('notes a patch in another format, and a Git patch that cannot be read', () => {
    const other: ToolCallDiff = { kind: 'changes', changes: twoFiles, patch: { format: 'other', text: gitPatch } };
    const unreadable: ToolCallDiff = { kind: 'changes', changes: twoFiles, patch: { format: 'git_patch', text: '--- /work/a.ts\n+++ /work/a.ts\n@@ -1,2 +1,2 @@\n-a\n' } };

    expect(diffFiles(other, '/work').map((file) => file.note)).toEqual(['unknownFormat', 'unknownFormat']);
    expect(diffFiles(unreadable, '/work').map((file) => file.note)).toEqual(['unreadablePatch', 'unreadablePatch']);
  });
});

describe('the line limit', () => {
  const hunk = (lines: string[]) => ({ oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, lines });
  const limited = (file: Parameters<typeof shown>[0]): DiffFile => ({ ...shown(file), reported: null });
  const first = limited({ operation: 'modify', path: 'a.ts', added: 3, hunks: [hunk(['+1', '+2']), hunk(['+3'])] });
  const second = limited({ operation: 'modify', path: 'b.ts', added: 1, hunks: [hunk(['+4'])] });
  const empty = limited({ operation: 'modify', path: 'c.bin', note: 'binary' });

  it('leaves the files as they are when they fit, and says how many lines they show', () => {
    expect(withinLineLimit([first, empty, second], 4)).toEqual({ files: [first, empty, second], shown: 4 });
  });

  it("cuts the hunks off at the limit, within a hunk too, noting each file cut, but not one that had no lines; the counts stay the file's", () => {
    expect(withinLineLimit([first, empty, second], 1)).toEqual({
      files: [{ ...first, hunks: [{ ...hunk(['+1', '+2']), lines: ['+1'] }], note: 'cutOff' }, empty, { ...second, hunks: [], note: 'cutOff' }],
      shown: 1,
    });
    expect(withinLineLimit([first, second], 2)).toEqual({
      files: [{ ...first, hunks: [hunk(['+1', '+2'])], note: 'cutOff' }, { ...second, hunks: [], note: 'cutOff' }],
      shown: 2,
    });
    const oneHunk = limited({ operation: 'add', path: 'd.ts', added: 2, hunks: [hunk(['+1', '+2'])] });
    expect(withinLineLimit([oneHunk], 1)).toEqual({ files: [{ ...oneHunk, hunks: [{ ...hunk(['+1', '+2']), lines: ['+1'] }], note: 'cutOff' }], shown: 1 });
  });
});

describe('paths', () => {
  it('shows a path relative to the working directory only when inside it', () => {
    expect(shownPath('/work/src/a.ts', '/work')).toBe('src/a.ts');
    expect(shownPath('/work/src/a.ts', '/work/')).toBe('src/a.ts');
    expect(shownPath('/workshop/a.ts', '/work')).toBe('/workshop/a.ts');
    expect(shownPath('/work', '/work')).toBe('/work');
    expect(shownPath('/work/a.ts', null)).toBe('/work/a.ts');
  });
});
