import { isAbsolute } from 'node:path';
import type { FileDiff, SessionUpdate, ToolCallStatus } from '@/core/acp/AcpDriver';
import { logWarning, messageOf } from '@/core/Log';
import type { FileContent, ReadFile, Review } from './Review';

type WholeFile = Extract<FileDiff, { kind: 'wholeFile' }>;

/** A tool call as its updates left it: an update leaves out what did not change. */
interface ToolCallSeen {
  status: ToolCallStatus | null;
  diffs: WholeFile[];
}

/**
 * Turns one session's ACP v1 diffs into evidence for its review. A diff counts only once its tool call completed and
 * its `newText` is what the file holds, read then; v1 cannot say a file was deleted, so an empty `newText` with
 * nothing at the path is a deletion.
 */
export class V1Guard {
  private readonly toolCalls = new Map<string, ToolCallSeen>();

  constructor(
    private readonly review: Review,
    private readonly readFile: ReadFile,
  ) {}

  /** Settles once the files its evidence names were read. */
  async handleSessionUpdate(update: SessionUpdate): Promise<void> {
    if (update.kind !== 'toolCall') { return; }
    const seen = this.toolCalls.get(update.toolCallId) ?? { status: null, diffs: [] };
    this.toolCalls.set(update.toolCallId, seen);
    if (update.status !== undefined) { seen.status = update.status; }
    if (update.content !== undefined) { seen.diffs = update.content.flatMap((item) => (item.kind === 'diff' && item.diff.kind === 'wholeFile' ? [item.diff] : [])); }
    if (seen.status !== 'completed' || (update.status === undefined && update.content === undefined)) { return; }
    const read = await Promise.all(seen.diffs.map(async (diff) => ({ diff, content: await this.read(diff.path) })));
    for (const { diff: { path, oldText, newText }, content } of read) {
      if (content === newText || (content === null && newText === '')) { this.review.changed(path, oldText, content); }
    }
  }

  /** `undefined` for a path not to be read, or a file that could not be. */
  private async read(path: string): Promise<FileContent | undefined> {
    if (!isAbsolute(path)) { return undefined; }
    try {
      return await this.readFile(path);
    } catch (e) {
      logWarning('Review change not examined because file could not be read', { path, reason: messageOf(e) });
      return undefined;
    }
  }
}
