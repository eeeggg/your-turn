import { describe, expect, it } from 'vitest';
import type { SessionUpdate, ToolCallContent, ToolCallStatus } from '@/core/acp/AcpDriver';
import { Review, type FileContent } from '@/core/review/Review';
import { V1Guard } from '@/core/review/V1Guard';

const diff = (path: string, oldText: string | null, newText: string): ToolCallContent =>
  ({ kind: 'diff', diff: { kind: 'wholeFile', path, oldText, newText } });
const toolCall = (toolCallId: string, status?: ToolCallStatus, content?: ToolCallContent[]): SessionUpdate =>
  ({ kind: 'toolCall', toolCallId, ...(status && { status }), ...(content && { content }) });

/** A guard over a review, reading files from `disk`, where a missing path holds nothing and an `Error` fails to read. */
function guarded(disk: Record<string, string | Error>) {
  const review = new Review(async () => {});
  const reads: string[] = [];
  const guard = new V1Guard(review, async (path): Promise<FileContent> => {
    reads.push(path);
    const content = disk[path];
    if (content instanceof Error) { throw content; }
    return content ?? null;
  });
  const files = () => review.files().map((file): [string, FileContent, FileContent] => [file.path, file.baseline, file.current]);
  const feed = async (...updates: SessionUpdate[]) => {
    for (const update of updates) { await guard.handleSessionUpdate(update); }
  };
  return { feed, files, reads };
}

describe('V1Guard', () => {
  it("takes a completed tool call's diff as evidence when its new text is what the file holds", async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'new' });
    await feed(toolCall('t1', 'completed', [diff('/w/a.ts', 'old', 'new')]));
    expect(files()).toEqual([['/w/a.ts', 'old', 'new']]);
  });

  it('drops a diff whose new text is not what the file holds', async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'changed since' });
    await feed(toolCall('t1', 'completed', [diff('/w/a.ts', 'old', 'new')]));
    expect(files()).toEqual([]);
  });

  it('takes a created file as holding nothing before', async () => {
    const { feed, files } = guarded({ '/w/new.ts': 'made' });
    await feed(toolCall('t1', 'completed', [diff('/w/new.ts', null, 'made')]));
    expect(files()).toEqual([['/w/new.ts', null, 'made']]);
  });

  it('takes an empty new text as a deletion when nothing is at the path, and as an emptied file when one is', async () => {
    const { feed, files } = guarded({ '/w/emptied.ts': '' });
    await feed(toolCall('t1', 'completed', [diff('/w/deleted.ts', 'gone', ''), diff('/w/emptied.ts', 'full', '')]));
    expect(files()).toEqual([['/w/deleted.ts', 'gone', null], ['/w/emptied.ts', 'full', '']]);
  });

  it('drops a diff whose file is missing but whose new text is not empty', async () => {
    const { feed, files } = guarded({});
    await feed(toolCall('t1', 'completed', [diff('/w/a.ts', 'old', 'new')]));
    expect(files()).toEqual([]);
  });

  it('waits for the tool call to complete, with diffs reported before or after', async () => {
    const { feed, files, reads } = guarded({ '/w/a.ts': 'new', '/w/b.ts': 'B' });
    await feed(toolCall('t1', 'running', [diff('/w/a.ts', 'old', 'new')]));
    expect(reads).toEqual([]);
    await feed(toolCall('t1', 'completed'));
    await feed(toolCall('t2', 'completed'), toolCall('t2', undefined, [diff('/w/b.ts', 'b', 'B')]));
    expect(files()).toEqual([['/w/a.ts', 'old', 'new'], ['/w/b.ts', 'b', 'B']]);
  });

  it('takes the diffs of its latest content only', async () => {
    const { feed, files } = guarded({ '/w/a.ts': 'new', '/w/b.ts': 'B' });
    await feed(toolCall('t1', 'running', [diff('/w/a.ts', 'old', 'new')]), toolCall('t1', 'completed', [diff('/w/b.ts', 'b', 'B')]));
    expect(files()).toEqual([['/w/b.ts', 'b', 'B']]);
  });

  it('takes nothing from a tool call that failed or has not completed', async () => {
    const { feed, files, reads } = guarded({ '/w/a.ts': 'new' });
    await feed(toolCall('t1', 'failed', [diff('/w/a.ts', 'old', 'new')]), toolCall('t2', 'pending', [diff('/w/a.ts', 'old', 'new')]));
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('reads nothing again for a completed tool call updated with neither status nor content', async () => {
    const { feed, reads } = guarded({ '/w/a.ts': 'new' });
    await feed(toolCall('t1', 'completed', [diff('/w/a.ts', 'old', 'new')]), { kind: 'toolCall', toolCallId: 't1', title: 'Edit a.ts' });
    expect(reads).toEqual(['/w/a.ts']);
  });

  it('ignores a diff with a relative path, as ACP paths are absolute', async () => {
    const { feed, files, reads } = guarded({ 'a.ts': 'new' });
    await feed(toolCall('t1', 'completed', [diff('a.ts', 'old', 'new')]));
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("drops a diff whose file cannot be read, and still takes the tool call's others", async () => {
    const { feed, files } = guarded({ '/w/a.bin': new Error('binary'), '/w/b.ts': 'B' });
    await feed(toolCall('t1', 'completed', [diff('/w/a.bin', 'old', 'new'), diff('/w/b.ts', 'b', 'B')]));
    expect(files()).toEqual([['/w/b.ts', 'b', 'B']]);
  });

  it("puts a tool call's files under review in the order reported, however their reads land", async () => {
    const review = new Review(async () => {});
    const guard = new V1Guard(review, async (path) => {
      if (path === '/w/a.ts') { await new Promise((resolve) => setTimeout(resolve, 10)); }
      return path === '/w/a.ts' ? 'A' : 'B';
    });
    await guard.handleSessionUpdate(toolCall('t1', 'completed', [diff('/w/a.ts', 'a', 'A'), diff('/w/b.ts', 'b', 'B')]));
    expect(review.files().map((file) => file.path)).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it("ignores a tool call's other content and other session updates", async () => {
    const { feed, files, reads } = guarded({});
    await feed(
      toolCall('t1', 'completed', [{ kind: 'text', text: 'done' }, { kind: 'diff', diff: { kind: 'changes', changes: [], patch: null } }]),
      { kind: 'agentText', messageId: null, text: 'hi' },
    );
    expect(files()).toEqual([]);
    expect(reads).toEqual([]);
  });
});
