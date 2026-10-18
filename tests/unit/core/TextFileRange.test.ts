import { describe, expect, it } from 'vitest';
import { selectLines } from '@/core/TextFileRange';

const content = 'one\ntwo\nthree\nfour';

describe('selectLines', () => {
  it('returns the whole file when neither line nor limit is given', () => {
    expect(selectLines(content)).toBe(content);
    expect(selectLines(content, null, null)).toBe(content);
  });

  it('starts at the 1-based line and reads to the end', () => {
    expect(selectLines(content, 3)).toBe('three\nfour');
  });

  it('reads at most limit lines from the first line', () => {
    expect(selectLines(content, null, 2)).toBe('one\ntwo');
  });

  it('combines line and limit', () => {
    expect(selectLines(content, 2, 2)).toBe('two\nthree');
  });

  it('reads nothing for a limit of zero', () => {
    expect(selectLines(content, 1, 0)).toBe('');
  });

  it('treats a line before the first as the first', () => {
    expect(selectLines(content, 0, 1)).toBe('one');
  });

  it('reads nothing past the last line', () => {
    expect(selectLines(content, 10)).toBe('');
  });

  it('keeps carriage returns of CRLF lines', () => {
    expect(selectLines('a\r\nb\r\nc', 2, 1)).toBe('b\r');
  });
});
