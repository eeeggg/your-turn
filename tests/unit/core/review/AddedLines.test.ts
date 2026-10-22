import { describe, expect, it } from 'vitest';
import { addedLines } from '@/core/review/AddedLines';

describe('addedLines', () => {
  it('finds the runs of lines added to the baseline, numbered from 0, and not the lines it kept', () => {
    expect(addedLines('a\nb\nc\n', 'a\nnew 1\nnew 2\nb\nc\nnew 3\n')).toEqual([
      { first: 1, last: 2 },
      { first: 5, last: 5 },
    ]);
  });

  it('counts a changed line as added, and a removed one not at all', () => {
    expect(addedLines('a\nb\nc\n', 'a\nB\n')).toEqual([{ first: 1, last: 1 }]);
  });

  it('takes every line of a file that had none as added, and nothing of an empty one', () => {
    expect(addedLines(null, 'a\nb\n')).toEqual([{ first: 0, last: 1 }]);
    expect(addedLines(null, '')).toEqual([]);
  });

  it('counts a last line with no line ending, and lines ending in \\r\\n', () => {
    expect(addedLines('a\r\nb\r\n', 'a\r\nb\r\nc')).toEqual([{ first: 2, last: 2 }]);
  });

  it('finds nothing when the text is the baseline', () => {
    expect(addedLines('a\nb\n', 'a\nb\n')).toEqual([]);
  });
});
