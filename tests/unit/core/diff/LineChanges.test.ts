import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineChanges, splitLines, type LineChange } from '@/core/diff/LineChanges';
import { setLogSink } from '@/core/Log';
import { editedTexts } from '@tests/unit/core/diff/editedTexts';

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  setLogSink({ trace() {}, debug() {}, info() {}, warn: (message) => warnings.push(message), error() {} });
});
afterEach(() => { setLogSink(undefined); });

const lines = (text: string) => splitLines(text);
const ranges = (changes: readonly LineChange[]) => changes.map(({ original, modified }) => ({ original, modified }));
const range = (start1: number, end1: number, start2: number, end2: number) => ({ original: { start: start1, end: end1 }, modified: { start: start2, end: end2 } });

describe('splitLines', () => {
  it('splits on every kind of line break, an empty line after a final one', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('a\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual(['']);
  });
});

// Each as VS Code's quick diff showed it in the window (review-hunks, Slice 3.1, Step 1), where jsdiff differed.
describe('lineChanges as quick diff shows them', () => {
  it('takes a function added between blank lines with the blank before it', () => {
    const original = 'function a() {\n  return 1;\n}\n\nfunction c() {\n  return 3;\n}\n';
    const modified = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction c() {\n  return 3;\n}\n';
    expect(ranges(lineChanges(lines(original), lines(modified)))).toEqual([range(3, 3, 3, 7)]);
    expect(ranges(lineChanges(lines(modified), lines(original)))).toEqual([range(3, 7, 3, 3)]);
  });

  it('adds a repeated pair of lines at the top', () => {
    expect(ranges(lineChanges(['x', 'y', 'x', 'y', ''], ['x', 'y', 'x', 'y', 'x', 'y', '']))).toEqual([range(0, 0, 0, 2)]);
  });

  it('adds a line to a file without a final line break, the last line unchanged', () => {
    expect(ranges(lineChanges(lines('a\nb'), lines('a\nb\nc')))).toEqual([range(2, 2, 2, 3)]);
    expect(ranges(lineChanges(lines('a\nb'), lines('a\nb\n')))).toEqual([range(2, 2, 2, 3)]);
  });

  it('agrees with jsdiff on braces, whitespace and a line replaced by two', () => {
    expect(ranges(lineChanges(['if (x) {', '  if (y) {', '  }', '}', ''], ['if (x) {', '  if (y) {', '    z();', '  }', '}', '']))).toEqual([range(2, 2, 2, 3)]);
    expect(ranges(lineChanges(['if (x) {', '  y();', '}'], ['if (x) {', '    y();', '}']))).toEqual([range(1, 2, 1, 2)]);
    expect(ranges(lineChanges(['a', 'b', 'c'], ['a', 'b1', 'b2', 'c']))).toEqual([range(1, 2, 1, 3)]);
  });

  it('gives no changes for equal texts', () => {
    expect(lineChanges(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  // monaco-diff-report in open-items.md: a fix in Monaco fails this test.
  it("keeps VS Code's wrong change of a whitespace-only line added at the end, and logs its failed check", () => {
    expect(ranges(lineChanges(lines('a\n'), lines('a\n \n')))).toEqual([range(1, 2, 1, 2)]);
    expect(warnings).toEqual(["Diff: VS Code's diff failed its own check, so its changes of 2 lines against 3 may be wrong: Assertion Failed"]);
  });

  it('logs nothing when the diff passes its checks', () => {
    lineChanges(lines('a\nb\n'), lines('a\nc\n'));
    expect(warnings).toEqual([]);
  });
});

describe('lineChanges within lines', () => {
  it('narrows a change to the characters that changed', () => {
    const [change] = lineChanges(['const a = 1;'], ['const b = 1;']);
    expect(change?.characters).toEqual([{
      original: { startLine: 0, startColumn: 6, endLine: 0, endColumn: 7 },
      modified: { startLine: 0, startColumn: 6, endLine: 0, endColumn: 7 },
    }]);
  });

  it('gives an added line as text added before the next line', () => {
    const [change] = lineChanges(['a', 'c'], ['a', 'b', 'c']);
    expect(change?.characters).toEqual([{
      original: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
      modified: { startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
    }]);
  });
});

describe('lineChanges with a timeout', () => {
  it('gives nothing past its timeout', () => {
    const original = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    expect(lineChanges(original, [...original].reverse(), { timeout: 1 })).toBeUndefined();
  });

  it('gives the changes within it', () => {
    expect(ranges(lineChanges(['a', 'b'], ['a', 'c'], { timeout: 1_000 }) ?? [])).toEqual([range(1, 2, 1, 2)]);
  });
});

describe('lineChanges on generated texts', () => {
  it('describes how to make the modified text of the original, unless the diff fails its own checks', () => {
    let failed = 0;
    for (const { original, modified } of editedTexts(1, 2_000)) {
      const lines1 = lines(original);
      const lines2 = lines(modified);
      warnings = [];
      const changes = lineChanges(lines1, lines2);
      if (warnings.length > 0) { failed++; continue; }
      const rebuilt: string[] = [];
      let line = 0;
      for (const change of changes) {
        expect(change.original.start).toBeGreaterThanOrEqual(line);
        rebuilt.push(...lines1.slice(line, change.original.start), ...lines2.slice(change.modified.start, change.modified.end));
        line = change.original.end;
      }
      rebuilt.push(...lines1.slice(line));
      expect(rebuilt).toEqual(lines2);
    }
    expect(failed).toBe(2);
  });
});
