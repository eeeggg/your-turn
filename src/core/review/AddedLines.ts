import { diffLines } from 'diff';
import type { FileContent } from './Review';

/** A run of whole lines, numbered from 0, `last` included. */
export interface LineRange {
  readonly first: number;
  readonly last: number;
}

/** The lines of `text` not in `baseline`: every line, for a file that had none. */
export function addedLines(baseline: FileContent, text: string): LineRange[] {
  const added: LineRange[] = [];
  let line = 0;
  for (const change of diffLines(baseline ?? '', text)) {
    if (change.removed) { continue; }
    if (change.added) { added.push({ first: line, last: line + change.count - 1 }); }
    line += change.count;
  }
  return added;
}
