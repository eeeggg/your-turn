import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineChanges, splitLines } from '@/core/diff/LineChanges';
import { setLogSink } from '@/core/Log';
import { keptChange, savedOver, takenOver, undoneChange, type Change, type TextEdit, type UserEdit } from '@/core/review/Hunks';
import { editedTexts } from '@tests/unit/core/diff/editedTexts';

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  setLogSink({ trace() {}, debug() {}, info() {}, warn: (message) => warnings.push(message), error() {} });
});
afterEach(() => { setLogSink(undefined); });

const changesOf = (baseline: string, document: string): Change[] =>
  lineChanges(splitLines(baseline), splitLines(document)).map(({ original, modified }) => ({ original, modified }));

const applied = (text: string, { start, end, text: replacement }: TextEdit) => text.slice(0, start) + replacement + text.slice(end);

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) { throw new Error(`No item ${index} of ${items.length}`); }
  return item;
}

/** The only change between the two texts. */
function only(baseline: string, document: string): Change {
  const changes = changesOf(baseline, document);
  expect(changes).toHaveLength(1);
  return at(changes, 0);
}

describe('Keep and Undo of one change', () => {
  const cases: [string, string, string][] = [
    ['a line replaced', text('a', 'b', 'c'), text('a', 'B', 'c')],
    ['lines added', text('a', 'c'), text('a', 'b1', 'b2', 'c')],
    ['lines deleted', text('a', 'b1', 'b2', 'c'), text('a', 'c')],
    ['lines added at the start', text('b', 'c'), text('a', 'b', 'c')],
    ['the first line deleted', text('a', 'b', 'c'), text('b', 'c')],
    ['a line appended to a text without a final line break', 'a\nb', 'a\nb\nc'],
    ['the last line deleted from a text without a final line break', 'a\nb\nc', 'a\nb'],
    ['a final line break added', 'a\nb', 'a\nb\n'],
    ['a final line break removed', 'a\nb\n', 'a\nb'],
    ['lines added to a text without a final line break, which then has one', 'a', 'a\nb\n'],
    ['a created file', '', text('a', 'b')],
    ['everything deleted', text('a', 'b'), ''],
  ];

  for (const [name, baseline, document] of cases) {
    it(`keeps and undoes ${name}`, () => {
      const change = only(baseline, document);
      expect(keptChange(baseline, document, change)).toBe(document);
      expect(applied(document, undoneChange(baseline, document, change))).toBe(baseline);
    });
  }

  it('keeps one of several changes, the others staying changes', () => {
    const baseline = text('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i');
    const document = text('A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I1', 'I2');
    const changes = changesOf(baseline, document);
    const kept = keptChange(baseline, document, at(changes, 0));
    expect(kept).toBe(text('A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'));
    expect(changesOf(kept, document)).toEqual([at(changes, 1)]);
  });

  it('undoes one of several changes by an edit of its lines only, so the others and Ctrl+Z are untouched', () => {
    const baseline = text('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i');
    const document = text('A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I1', 'I2');
    const changes = changesOf(baseline, document);
    expect(undoneChange(baseline, document, at(changes, 1))).toEqual({ start: 16, end: 21, text: 'i' });
    const undone = applied(document, undoneChange(baseline, document, at(changes, 0)));
    expect(undone).toBe(text('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I1', 'I2'));
    expect(changesOf(baseline, undone)).toEqual([at(changes, 1)]);
  });

  it("keeps each text's own line breaks around a change, and takes the change's lines with theirs", () => {
    const baseline = 'a\r\nb\r\nc\r\n';
    const document = 'a\nB1\nB2\nc\n';
    const change = only(baseline, document);
    expect(keptChange(baseline, document, change)).toBe('a\r\nB1\nB2\r\nc\r\n');
    expect(applied(document, undoneChange(baseline, document, change))).toBe('a\nb\nc\n');
  });
});

describe('Keep and Undo on generated texts', () => {
  const texts = editedTexts(3, 1_000);

  /** Applies `step` to the first change between the texts until none is left, as the user keeping or undoing each in turn would. */
  function eachInTurn(baseline: string, document: string, step: (baseline: string, document: string, change: Change) => [string, string]) {
    for (let steps = 0; steps < 20; steps++) {
      const [change] = changesOf(baseline, document);
      if (!change) { return { baseline, document }; }
      [baseline, document] = step(baseline, document, change);
    }
    return undefined;
  }

  it('reaches the document by keeping each change in turn, and the baseline by undoing each', () => {
    let failed = 0;
    for (const { original, modified } of texts) {
      warnings = [];
      const kept = eachInTurn(original, modified, (baseline, document, change) => [keptChange(baseline, document, change), document]);
      const undone = eachInTurn(original, modified, (baseline, document, change) => [baseline, applied(document, undoneChange(baseline, document, change))]);
      if (warnings.length > 0) { failed++; continue; }
      expect(kept?.baseline).toBe(modified);
      expect(undone?.document).toBe(original);
    }
    expect(failed).toBe(4);
  });

  it('leaves every other change as quick diff showed it, moved by the lines the change added or removed, but where diffing again aligns them otherwise', () => {
    let leftAsShown = 0;
    let tried = 0;
    for (const { original, modified } of texts) {
      warnings = [];
      const changes = changesOf(original, modified);
      if (warnings.length > 0) { continue; }
      changes.forEach((change, index) => {
        const others = changes.filter((_, other) => other !== index);
        const added = (change.modified.end - change.modified.start) - (change.original.end - change.original.start);
        const keptOthers = others.map(({ original, modified }) => ({
          original: original.start > change.original.start ? { start: original.start + added, end: original.end + added } : original,
          modified,
        }));
        const undoneOthers = others.map(({ original, modified }) => ({
          original,
          modified: modified.start > change.modified.start ? { start: modified.start - added, end: modified.end - added } : modified,
        }));
        tried++;
        const kept = changesOf(keptChange(original, modified, change), modified);
        const undone = changesOf(original, applied(modified, undoneChange(original, modified, change)));
        if (JSON.stringify(kept) === JSON.stringify(keptOthers) && JSON.stringify(undone) === JSON.stringify(undoneOthers)) { leftAsShown++; }
      });
    }
    expect([leftAsShown, tried]).toEqual([1_433, 1_444]);
  });
});

describe('the takeover', () => {
  const baseline = text('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight');
  const before = text('one', 'TWO', 'three', 'four', 'five', 'six', 'SEVEN', 'eight');
  const edit = (first: number, last: number, addedLines = 0): UserEdit => ({ first, last, addedLines });

  it("takes an edit outside every change into the baseline, so it never shows as one, and leaves the changes as they were", () => {
    const after = text('one', 'TWO', 'three', 'four!', 'five', 'six', 'SEVEN', 'eight');
    const taken = takenOver(baseline, before, after, [edit(3, 3)]);
    expect(taken).toBe(text('one', 'two', 'three', 'four!', 'five', 'six', 'seven', 'eight'));
    expect(changesOf(taken, after)).toEqual(changesOf(baseline, before));
  });

  it('takes a change the edit touched out of the review with it, and leaves the others', () => {
    const after = text('one', 'TWO!', 'three', 'four', 'five', 'six', 'SEVEN', 'eight');
    const taken = takenOver(baseline, before, after, [edit(1, 1)]);
    expect(taken).toBe(text('one', 'TWO!', 'three', 'four', 'five', 'six', 'seven', 'eight'));
    expect(changesOf(taken, after)).toEqual([{ original: { start: 6, end: 7 }, modified: { start: 6, end: 7 } }]);
  });

  it('moves the changes below an edit by the lines it added, and only by the edits above each', () => {
    const after = text('one', 'zero', 'TWO', 'three', 'four', 'four and a half', 'five', 'six', 'SEVEN', 'eight');
    const taken = takenOver(baseline, before, after, [edit(0, 0, 1), edit(3, 3, 1)]);
    expect(taken).toBe(text('one', 'zero', 'two', 'three', 'four', 'four and a half', 'five', 'six', 'seven', 'eight'));
  });

  it('leaves lines deleted before a line the user types in, and takes them when the edit joins the lines either side', () => {
    const fewer = text('one', 'four');
    const all = text('one', 'two', 'three', 'four');
    expect(takenOver(all, fewer, text('one', 'four!'), [edit(1, 1)])).toBe(text('one', 'two', 'three', 'four!'));
    expect(takenOver(all, fewer, text('onefour'), [edit(0, 1, -1)])).toBe(text('onefour'));
  });

  it('puts back a last line deleted from a text without a final line break', () => {
    expect(takenOver('a\nb', 'a', 'a!', [edit(0, 0)])).toBe('a!\nb');
  });

  it('gives the baseline back for no edits, on generated texts', () => {
    let failed = 0;
    for (const { original, modified } of editedTexts(4, 1_000)) {
      warnings = [];
      const taken = takenOver(original, modified, modified, []);
      if (warnings.length > 0) { failed++; continue; }
      expect(taken).toBe(original);
    }
    expect(failed).toBe(1);
  });

  it('leaves the changes an edit did not touch as quick diff showed them, but where diffing again aligns them otherwise, on generated texts', () => {
    let leftAsShown = 0;
    let tried = 0;
    editedTexts(5, 1_000).forEach(({ original, modified }, index) => {
      warnings = [];
      const changes = changesOf(original, modified);
      if (warnings.length > 0) { return; }
      const lines = splitLines(modified);
      const line = (index * 7) % lines.length;
      const typed = index % 2 === 0
        ? { after: [...lines.slice(0, line), `typed ${at(lines, line)}`, ...lines.slice(line + 1)], edit: edit(line, line) }
        : { after: [...lines.slice(0, line + 1), 'typed', ...lines.slice(line + 1)], edit: edit(line, line, 1) };
      const after = typed.after.join('\n');
      const expected = changes
        .filter(({ modified }) => modified.start === modified.end ? !(line < modified.start && line >= modified.start) : !(line < modified.end && line >= modified.start))
        .map(({ modified }) => {
          const shift = line < modified.start ? typed.edit.addedLines : 0;
          return { start: modified.start + shift, end: modified.end + shift };
        });
      tried++;
      const shown = changesOf(takenOver(original, modified, after, [typed.edit]), after).map(({ modified }) => modified);
      if (JSON.stringify(shown) === JSON.stringify(expected)) { leftAsShown++; }
    });
    expect([leftAsShown, tried]).toEqual([998, 999]);
  });
});

describe("a save's edits", () => {
  const baseline = text('one', 'two', 'three');
  const before = text('one', 'TWO', 'three');
  /** `line`'s text replaced by `replacement`, as a formatter's edit. */
  const lineEdit = (line: number, replacement: string): UserEdit & TextEdit => {
    const start = before.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
    return { first: line, last: line, addedLines: 0, start, end: start + at(before.split('\n'), line).length, text: replacement };
  };

  it('go into the baseline where they touch no change, so they raise none', () => {
    expect(savedOver(baseline, before, [lineEdit(2, 'THREE')])).toBe(text('one', 'two', 'THREE'));
  });

  it('leave a change they touch under review, and still take those touching none', () => {
    expect(savedOver(baseline, before, [lineEdit(1, 'TWO;'), lineEdit(0, 'ONE')])).toBe(text('ONE', 'two', 'three'));
  });
});
