/**
 * The lines of `content` an `fs/read_text_file` request asks for: from the
 * 1-based `line` (the first line when absent), at most `limit` lines (to the
 * end when absent).
 */
export function selectLines(content: string, line?: number | null, limit?: number | null): string {
  const from = line ?? undefined;
  const count = limit ?? undefined;
  if (from === undefined && count === undefined) {
    return content;
  }
  const lines = content.split('\n');
  const start = Math.max((from ?? 1) - 1, 0);
  const end = count === undefined ? lines.length : start + Math.max(count, 0);
  return lines.slice(start, end).join('\n');
}
