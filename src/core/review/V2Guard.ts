import { isAbsolute } from 'node:path';
import { parsePatch, type StructuredPatch } from 'diff';
import type { FileChange, FileDiff, SessionUpdate, ToolCallStatus } from '@/core/acp/AcpDriver';
import { logWarning, messageOf } from '@/core/Log';
import { changeSides } from '@/core/ReportedFiles';
import type { FileContent, ReadFile, Review } from '@/core/review/Review';

type Changes = Extract<FileDiff, { kind: 'changes' }>;
type Hunks = StructuredPatch['hunks'];

/** A tool call as its updates left it: an update leaves out what did not change. */
interface ToolCallSeen {
  status: ToolCallStatus | null;
  diffs: Changes[];
}

/** A change with its patch's lines for it, or why it is left out. */
type Matched = { change: FileChange; hunks: Hunks } | { change: FileChange; leftOut: string };

/**
 * Turns one session's ACP v2 diffs into evidence for its review. A text file's change counts only once its tool call
 * completed, and only when its `git_patch` lines undo against the file, read then: a modified file undoing to what it
 * held, an added one to nothing, and a deleted one, with nothing at the path, to what the patch removed.
 */
export class V2Guard {
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
    if (update.content !== undefined) { seen.diffs = update.content.flatMap((item) => (item.kind === 'diff' && item.diff.kind === 'changes' ? [item.diff] : [])); }
    if (seen.status !== 'completed' || (update.status === undefined && update.content === undefined)) { return; }
    const read = await Promise.all(seen.diffs.flatMap(matched).map(async (match) => ({ match, content: 'hunks' in match ? await this.read(match.change.path) : undefined })));
    for (const { match, content } of read) {
      if ('leftOut' in match) {
        leftOut(match.change, match.leftOut);
      } else if (content !== undefined) {
        this.take(match.change, match.hunks, content);
      }
    }
  }

  private take(change: FileChange, hunks: Hunks, content: FileContent): void {
    const before = heldBefore(change.operation, hunks, content);
    if (typeof before === 'object' && before !== null) { leftOut(change, before.leftOut); return; }
    this.review.changed(change.path, before, content);
  }

  /** `undefined` for a file that could not be read. */
  private async read(path: string): Promise<FileContent | undefined> {
    try {
      return await this.readFile(path);
    } catch (e) {
      logWarning('Review change not examined because file could not be read', { path, reason: messageOf(e) });
      return undefined;
    }
  }
}

/**
 * Each change of a diff with its patch's lines for it, matched by the path its file patch leaves the file at, as a
 * `git_patch` names files by their absolute paths and the missing side `/dev/null`; or why it is left out.
 */
function matched(diff: Changes): Matched[] {
  const parsed = diff.patch?.format === 'git_patch' ? filePatches(diff.patch.text) : null;
  const unmatched = [...(parsed ?? [])];
  return diff.changes.map((change): Matched => {
    if (change.operation !== 'add' && change.operation !== 'modify' && change.operation !== 'delete') { return { change, leftOut: `its operation, ${change.operation}, is not reviewed yet` }; }
    if (change.fileType !== 'text' && change.fileType !== null) { return { change, leftOut: `its file type, ${change.fileType}, is not reviewed yet` }; }
    if (!isAbsolute(change.path)) { return { change, leftOut: 'its path is not absolute' }; }
    if (diff.patch === null) { return { change, leftOut: 'its diff has no patch' }; }
    if (diff.patch.format !== 'git_patch') { return { change, leftOut: 'its patch is not a git_patch' }; }
    if (parsed === null) { return { change, leftOut: 'its patch cannot be read' }; }
    const index = unmatched.findIndex((filePatch) => endPath(filePatch) === change.path);
    const filePatch = index === -1 ? undefined : unmatched.splice(index, 1)[0];
    if (!filePatch || filePatch.hunks.length === 0) { return { change, leftOut: 'its patch has no lines for it' }; }
    return { change, hunks: filePatch.hunks };
  });
}

/** What the file held before the change, undone from `content`, what it holds now; or why it cannot be trusted. */
function heldBefore(operation: FileChange['operation'], hunks: Hunks, content: FileContent): FileContent | { leftOut: string } {
  if (operation === 'delete' && content !== null) { return { leftOut: 'a file is at its path again' }; }
  if (operation !== 'delete' && content === null) { return { leftOut: 'nothing is at its path' }; }
  const sides = changeSides({ kind: 'hunks', hunks }, operation, content);
  if (sides === null) { return { leftOut: 'its patch does not undo against the file' }; }
  if (operation !== 'add') { return sides.before; }
  return sides.before === '' ? null : { leftOut: 'the file holds more than its patch added' };
}

function filePatches(text: string): StructuredPatch[] | null {
  try {
    return parsePatch(text);
  } catch {
    return null;
  }
}

function endPath(filePatch: StructuredPatch): string | undefined {
  return filePatch.isDelete || filePatch.newFileName === '/dev/null' ? filePatch.oldFileName : filePatch.newFileName;
}

function leftOut(change: FileChange, reason: string): void {
  logWarning('Review change not examined', { path: change.path, reason });
}
