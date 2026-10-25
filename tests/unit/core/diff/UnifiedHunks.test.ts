import { applyPatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineChanges, splitLines } from '@/core/diff/LineChanges';
import { unifiedHunks } from '@/core/diff/UnifiedHunks';
import { setLogSink } from '@/core/Log';
import { editedTexts } from './editedTexts';

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  setLogSink({ log() {}, warn: (message) => warnings.push(message), error() {}, traffic() {} });
});
afterEach(() => { setLogSink(undefined); });

const applied = (original: string, hunks: StructuredPatchHunk[]) =>
  applyPatch(original, { oldFileName: 'a', newFileName: 'b', oldHeader: '', newHeader: '', hunks });

const jsdiffHunks = (original: string, modified: string) => structuredPatch('a', 'b', original, modified, '', '', { context: 3 }).hunks;

/** The changed lines the hunks describe, 0-based, each side's end exclusive. */
function changesOf(hunks: readonly StructuredPatchHunk[]) {
  const changes: { original: { start: number; end: number }; modified: { start: number; end: number } }[] = [];
  for (const hunk of hunks) {
    let line1 = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    let line2 = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    let open = false;
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) { continue; }
      if (line.startsWith(' ')) { line1++; line2++; open = false; continue; }
      if (!open) { changes.push({ original: { start: line1, end: line1 }, modified: { start: line2, end: line2 } }); open = true; }
      const change = changes[changes.length - 1] as (typeof changes)[number];
      if (line.startsWith('-')) { change.original.end = ++line1; } else { change.modified.end = ++line2; }
    }
  }
  return changes;
}

const CASES: [string, string, string][] = [
  ['a line changed', 'a\nb\nc\n', 'a\nB\nc\n'],
  ['a line added at the start', 'b\nc\n', 'a\nb\nc\n'],
  ['a line added at the end', 'a\nb\n', 'a\nb\nc\n'],
  ['a line deleted', 'a\nb\nc\n', 'a\nc\n'],
  ['every line deleted', 'a\nb\n', ''],
  ['a file created', '', 'a\nb\n'],
  ['a final line break removed', 'a\nb\n', 'a\nb'],
  ['a final line break added', 'a\nb', 'a\nb\n'],
  ['a last line without a break changed', 'a\nb', 'a\nc'],
  ['two changes far apart', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n'],
  ['a block replaced', 'a\nb\nc\nd\ne\n', 'a\nx\ny\nz\ne\n'],
];

describe('unifiedHunks', () => {
  it.each(CASES)('gives jsdiff\'s hunks for %s, which apply', (_, original, modified) => {
    const hunks = unifiedHunks(original, modified, 3);
    expect(hunks).toEqual(jsdiffHunks(original, modified));
    expect(applied(original, hunks)).toBe(modified);
  });

  it('gives no hunks for equal texts', () => {
    expect(unifiedHunks('a\nb\n', 'a\nb\n', 3)).toEqual([]);
  });

  it('joins changes at most twice the context apart', () => {
    const original = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const changed = (apart: number) => original.map((line, i) => (i === 2 || i === 3 + apart ? line + '!' : line)).join('\n') + '\n';
    expect(unifiedHunks(original.join('\n') + '\n', changed(6), 3)).toHaveLength(1);
    expect(unifiedHunks(original.join('\n') + '\n', changed(7), 3)).toHaveLength(2);
  });

  it('gives lines without their CRLF breaks, which still apply', () => {
    const hunks = unifiedHunks('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n', 3);
    expect(hunks[0]?.lines).toEqual([' a', '-b', '+B', ' c']);
    expect(applied('a\r\nb\r\nc\r\n', hunks)).toBe('a\r\nB\r\nc\r\n');
  });

  it('aligns as quick diff does where jsdiff differs', () => {
    const original = 'function a() {\n  return 1;\n}\n\nfunction c() {\n  return 3;\n}\n';
    const modified = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 3;\n}\n';
    const hunks = unifiedHunks(original, modified, 3);
    expect(changesOf(hunks)).toEqual([{ original: { start: 3, end: 3 }, modified: { start: 3, end: 7 } }]);
    expect(changesOf(jsdiffHunks(original, modified))).toEqual([{ original: { start: 4, end: 4 }, modified: { start: 4, end: 8 } }]);
    expect(applied(original, hunks)).toBe(modified);
  });

  it('gives nothing past its timeout', () => {
    const original = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
    const modified = original.split('\n').reverse().join('\n');
    expect(unifiedHunks(original, modified, 3, { timeout: 1 })).toBeUndefined();
  });
});

describe('unifiedHunks on generated texts', () => {
  const texts = editedTexts(2, 2_000);

  it('gives hunks that apply, even where the diff fails its own checks', () => {
    for (const { original, modified } of texts) {
      expect(applied(original, unifiedHunks(original, modified, 3))).toBe(modified);
    }
  });

  it('gives quick diff\'s changes where both texts end with a line break and the diff passes its checks', () => {
    let failed = 0;
    for (const { original, modified } of texts.filter((text) => text.original.endsWith('\n') && text.modified.endsWith('\n'))) {
      warnings = [];
      const changes = lineChanges(splitLines(original), splitLines(modified)).map(({ original, modified }) => ({ original, modified }));
      if (warnings.length > 0) { failed++; continue; }
      expect(changesOf(unifiedHunks(original, modified, 3))).toEqual(changes);
    }
    expect(failed).toBe(1);
  });

  it('gives jsdiff\'s hunks where its changes are quick diff\'s', () => {
    let agreed = 0;
    for (const { original, modified } of texts) {
      const hunks = unifiedHunks(original, modified, 3);
      const expected = jsdiffHunks(original, modified);
      if (JSON.stringify(changesOf(hunks)) !== JSON.stringify(changesOf(expected))) { continue; }
      expect(hunks).toEqual(expected);
      agreed++;
    }
    expect(agreed).toBe(1_437);
  });
});
