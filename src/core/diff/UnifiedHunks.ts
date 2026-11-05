import type { StructuredPatchHunk } from 'diff';
import { lineChanges, splitLines, type DiffOptions, type LineChange } from '@/core/diff/LineChanges';

/** A change's lines, without where within them the text changed. */
type LineSpan = Pick<LineChange, 'original' | 'modified'>;

/** A text's lines as a patch counts them: an empty text has none, and a final line break ends a line, not begins one. */
interface PatchSide {
  readonly lines: readonly string[];
  readonly count: number;
  readonly endsWithBreak: boolean;
}

/**
 * The hunks from `original` to `modified` as jsdiff's `structuredPatch` gives them, `context` unchanged lines around
 * each change and a "\ No newline at end of file" line after a last line without one, but their changes those quick
 * diff shows (`lineChanges`); lines split as VS Code splits them, so a hunk's lines hold no line breaks of any kind.
 */
export function unifiedHunks(original: string, modified: string, context: number): StructuredPatchHunk[];
export function unifiedHunks(original: string, modified: string, context: number, options: DiffOptions): StructuredPatchHunk[] | undefined;
export function unifiedHunks(original: string, modified: string, context: number, options?: DiffOptions): StructuredPatchHunk[] | undefined {
  const lines1 = splitLines(original);
  const lines2 = splitLines(modified);
  const changes = options ? lineChanges(lines1, lines2, options) : lineChanges(lines1, lines2);
  if (!changes) { return undefined; }
  const side1 = patchSide(original, lines1);
  const side2 = patchSide(modified, lines2);
  const hunks: StructuredPatchHunk[] = [];
  let group: LineSpan[] = [];
  for (const current of patchChanges(changes, side1, side2)) {
    const last = group.at(-1);
    if (last && current.original.start - last.original.end > 2 * context) {
      hunks.push(hunk(group, side1, side2, context));
      group = [];
    }
    group.push(current);
  }
  if (group.length > 0) { hunks.push(hunk(group, side1, side2, context)); }
  return hunks;
}

function patchSide(text: string, lines: readonly string[]): PatchSide {
  const endsWithBreak = /[\r\n]$/.test(text);
  return { lines, count: text === '' ? 0 : endsWithBreak ? lines.length - 1 : lines.length, endsWithBreak };
}

function hasBreak(side: PatchSide, line: number): boolean {
  return line < side.count - 1 || side.endsWithBreak;
}

/**
 * The changes in the lines a patch counts: a line VS Code aligns as equal is changed when only one side ends it with a
 * line break, and the empty line VS Code counts after a final line break is no line at all.
 */
function patchChanges(changes: readonly LineSpan[], side1: PatchSide, side2: PatchSide): LineSpan[] {
  const all: LineSpan[] = [];
  const add = (start1: number, end1: number, start2: number, end2: number) => {
    const clipped = span(Math.min(start1, side1.count), Math.min(end1, side1.count), Math.min(start2, side2.count), Math.min(end2, side2.count));
    if (clipped.original.start < clipped.original.end || clipped.modified.start < clipped.modified.end) { all.push(clipped); }
  };
  let line1 = 0;
  let line2 = 0;
  const scan = (end1: number) => {
    for (; line1 < end1; line1++, line2++) {
      const real1 = line1 < side1.count;
      const real2 = line2 < side2.count;
      if ((real1 || real2) && !(real1 && real2 && hasBreak(side1, line1) === hasBreak(side2, line2))) {
        add(line1, line1 + 1, line2, line2 + 1);
      }
    }
  };
  for (const current of changes) {
    scan(current.original.start);
    add(current.original.start, current.original.end, current.modified.start, current.modified.end);
    line1 = current.original.end;
    line2 = current.modified.end;
  }
  scan(side1.lines.length);
  const joined: LineSpan[] = [];
  for (const current of all) {
    const last = joined.at(-1);
    if (last && current.original.start <= last.original.end && current.modified.start <= last.modified.end) {
      joined[joined.length - 1] = span(last.original.start, Math.max(last.original.end, current.original.end), last.modified.start, Math.max(last.modified.end, current.modified.end));
    } else {
      joined.push(current);
    }
  }
  return joined;
}

/** The changes of one hunk with their context; lines between them are equal, so as many on each side. */
function hunk(group: readonly LineSpan[], side1: PatchSide, side2: PatchSide, context: number): StructuredPatchHunk {
  const first = group[0] as LineSpan;
  const last = group[group.length - 1] as LineSpan;
  const before = Math.min(context, first.original.start);
  const after = Math.min(context, side1.count - last.original.end);
  const start1 = first.original.start - before;
  const start2 = first.modified.start - before;
  const lines: string[] = [];
  const push = (prefix: string, side: PatchSide, line: number) => {
    lines.push(prefix + (side.lines[line] ?? ''));
    if (!hasBreak(side, line)) { lines.push('\\ No newline at end of file'); }
  };
  let line1 = start1;
  let line2 = start2;
  for (const current of group) {
    for (; line1 < current.original.start; line1++, line2++) { push(' ', side1, line1); }
    for (; line1 < current.original.end; line1++) { push('-', side1, line1); }
    for (; line2 < current.modified.end; line2++) { push('+', side2, line2); }
  }
  for (let k = 0; k < after; k++, line1++, line2++) { push(' ', side1, line1); }
  return { oldStart: start1 + 1, oldLines: line1 - start1, newStart: start2 + 1, newLines: line2 - start2, lines };
}

function span(originalStart: number, originalEnd: number, modifiedStart: number, modifiedEnd: number): LineSpan {
  return { original: { start: originalStart, end: originalEnd }, modified: { start: modifiedStart, end: modifiedEnd } };
}
