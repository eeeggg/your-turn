import { lineChanges, splitLines, type LineChange } from '@/core/diff/LineChanges';

/** One of quick diff's changes between a file's baseline (`original`) and its document (`modified`), by their lines. */
export type Change = Pick<LineChange, 'original' | 'modified'>;

/** The text from offset `start` up to `end` replaced by `text`. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** An edit of the user's: the lines of the text before it it replaced, `first` to `last`, and how many it added in all, negative when it removed lines. */
export interface UserEdit {
  readonly first: number;
  readonly last: number;
  readonly addedLines: number;
}

/** The baseline once `change` is kept: the document's lines in place of the baseline's. */
export function keptChange(baseline: string, document: string, change: Change): string {
  return withChanges(baseline, document, [change]);
}

/** The edit putting the baseline's lines back in place of the document's, undoing `change`. */
export function undoneChange(baseline: string, document: string, change: Change): TextEdit {
  return changeEdit(new Lines(document), new Lines(baseline), inverted(change));
}

/**
 * The baseline once the user's `edits`, which made `after` of `before`, are taken in: each of the document's changes an
 * edit touched leaves the review, and the user's edits anywhere else never become changes, so the baseline is `after`
 * with every change no edit touched put back. Changes are those quick diff showed of `before`, as the user saw them.
 */
export function takenOver(baseline: string, before: string, after: string, edits: readonly UserEdit[]): string {
  const untouched = lineChanges(splitLines(baseline), splitLines(before))
    .filter((change) => !edits.some((edit) => touches(edit, change)))
    .map((change): Change => {
      const shift = edits.filter((edit) => edit.last < change.modified.start).reduce((lines, edit) => lines + edit.addedLines, 0);
      return { original: { start: change.modified.start + shift, end: change.modified.end + shift }, modified: change.original };
    });
  return withChanges(after, baseline, untouched);
}

/**
 * The baseline once a save's own edits, a formatter's say, made of `before`: an edit touching none of the document's
 * changes goes into the baseline, so it raises no change, and one touching a change leaves the change under review.
 */
export function savedOver(baseline: string, before: string, edits: readonly (UserEdit & TextEdit)[]): string {
  const changes = lineChanges(splitLines(baseline), splitLines(before));
  const untouching = edits.filter((edit) => !changes.some((change) => touches(edit, change)));
  const after = [...untouching]
    .sort((a, b) => b.start - a.start)
    .reduce((text, { start, end, text: inserted }) => text.slice(0, start) + inserted + text.slice(end), before);
  return takenOver(baseline, before, after, untouching);
}

/** A change with no lines of the document is between two lines, so an edit touches it across them, not within one. */
function touches(edit: UserEdit, { modified }: Change): boolean {
  return edit.first < modified.end && edit.last >= modified.start;
}

function inverted({ original, modified }: Change): Change {
  return { original: modified, modified: original };
}

/** `original` with each of `changes`, in order and apart, taken from `modified`. */
function withChanges(original: string, modified: string, changes: readonly Change[]): string {
  const target = new Lines(original);
  const source = new Lines(modified);
  let text = original;
  for (const change of [...changes].reverse()) {
    const edit = changeEdit(target, source, change);
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}

/**
 * The edit to `target` giving its lines of `change` the source's. A change at the end of a text with no final line break
 * moves the line break between the last unchanged line and the change, as git's Stage Change and Revert Change do.
 */
function changeEdit(target: Lines, source: Lines, { original, modified }: Change): TextEdit {
  if (original.start === original.end) {
    if (original.start < target.count) {
      const at = target.start(original.start);
      return { start: at, end: at, text: source.slice(source.start(modified.start), source.start(modified.end)) };
    }
    const at = target.text.length;
    return { start: at, end: at, text: source.slice(source.end(modified.start - 1), source.end(modified.end - 1)) };
  }
  if (modified.start === modified.end) {
    if (original.end < target.count) {
      return { start: target.start(original.start), end: target.start(original.end), text: '' };
    }
    return { start: target.end(original.start - 1), end: target.text.length, text: '' };
  }
  return {
    start: target.start(original.start),
    end: target.end(original.end - 1),
    text: source.slice(source.start(modified.start), source.end(modified.end - 1)),
  };
}

/** Where a text's lines start and end, split as `splitLines` splits them; a line's end is before its line break. */
class Lines {
  private readonly starts: number[] = [0];
  private readonly ends: number[] = [];

  constructor(readonly text: string) {
    for (const lineBreak of text.matchAll(/\r\n|\r|\n/g)) {
      this.ends.push(lineBreak.index);
      this.starts.push(lineBreak.index + lineBreak[0].length);
    }
    this.ends.push(text.length);
  }

  get count(): number {
    return this.starts.length;
  }

  /** Where line `line` starts; past the last line, the text's end. */
  start(line: number): number {
    return this.starts[line] ?? this.text.length;
  }

  /** Where line `line` ends; before the first line, the text's start. */
  end(line: number): number {
    return line < 0 ? 0 : this.ends[line] ?? this.text.length;
  }

  slice(start: number, end: number): string {
    return this.text.slice(start, end);
  }
}
