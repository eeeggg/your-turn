import { isAbsolute } from 'node:path';
import type { FileDiff, SessionUpdate, ToolCallStatus } from '@/core/acp/AcpDriver';
import type { ExamineEvidence } from '@/core/review/Review';

type WholeFile = Extract<FileDiff, { kind: 'wholeFile' }>;

/** A tool call as its updates left it: an update leaves out what did not change. */
interface ToolCallSeen {
  status: ToolCallStatus | null;
  diffs: WholeFile[];
  candidates: Map<string, { revision: string; consumed: Set<string>; pending: Map<string, Promise<void>> }>;
}

/**
 * Turns one session's ACP v1 diffs into evidence for its review. A diff counts only once its tool call completed and
 * its `newText` is what the file holds, read then; v1 cannot say a file was deleted, so an empty `newText` with
 * nothing at the path is a deletion.
 */
export class V1Guard {
  private readonly toolCalls = new Map<string, ToolCallSeen>();

  constructor(private readonly examine: ExamineEvidence) {}

  /** Settles once the files its evidence names were read. */
  async handleSessionUpdate(update: SessionUpdate): Promise<void> {
    if (update.kind !== 'toolCall') { return; }
    const seen: ToolCallSeen = this.toolCalls.get(update.toolCallId) ?? { status: null, diffs: [], candidates: new Map() };
    this.toolCalls.set(update.toolCallId, seen);
    if (update.status !== undefined) { seen.status = update.status; }
    if (update.content !== undefined) { seen.diffs = update.content.flatMap((item) => (item.kind === 'diff' && item.diff.kind === 'wholeFile' ? [item.diff] : [])); }
    if (update.content !== undefined) {
      const paths = new Set(seen.diffs.map((diff) => diff.path));
      for (const path of seen.candidates.keys()) { if (!paths.has(path)) { seen.candidates.delete(path); } }
      for (const path of paths) {
        const revision = JSON.stringify(seen.diffs.filter((diff) => diff.path === path));
        if (seen.candidates.get(path)?.revision !== revision) {
          seen.candidates.set(path, { revision, consumed: new Set(), pending: new Map() });
        }
      }
    }
    if (seen.status !== 'completed' || (update.status === undefined && update.content === undefined)) { return; }
    const reads: Promise<void>[] = [];
    for (const diff of seen.diffs) {
      if (!isAbsolute(diff.path)) { continue; }
      const candidate = seen.candidates.get(diff.path);
      const key = JSON.stringify(diff);
      if (!candidate || candidate.consumed.has(key)) { continue; }
      const pending = candidate.pending.get(key);
      if (pending) { reads.push(pending); continue; }
      const reading = this.examine(diff.path, (content) =>
        content === diff.newText || (content === null && diff.newText === '') ? { before: diff.oldText } : undefined,
      ).then((admitted) => {
        if (admitted) { candidate.consumed.add(key); }
      }).finally(() => candidate.pending.delete(key));
      candidate.pending.set(key, reading);
      reads.push(reading);
    }
    await Promise.all(reads);
  }

}
