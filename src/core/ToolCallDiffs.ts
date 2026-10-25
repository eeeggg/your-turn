import { parsePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff';
import type { FileChange, FileDiff } from '@/core/acp/AcpDriver';
import { unifiedHunks } from '@/core/diff/UnifiedHunks';
import type { PatchHunk, ReportedFile } from './ReportedFiles';

/** Lines of unchanged text shown around each change. */
const CONTEXT_LINES = 3;

/** How long working out a whole file's hunks may take; past it the file is too large to show. */
const DIFF_TIMEOUT_MS = 200;

/** A tool call shows at most this many diff lines across its files. */
export const TOOL_CALL_DIFF_LINE_LIMIT = 2_000;

/** Why a file shows fewer lines than it changed, or none. */
type DiffNote =
  | 'binary'
  | 'directory'
  | 'symlink'
  | 'noPatch'
  | 'unknownFormat'
  | 'unreadablePatch'
  | 'tooLarge'
  | 'noLines'
  | 'cutOff';

/** One file a tool call's diff changed, as the chat view shows it. */
export interface DiffFile {
  readonly operation: FileChange['operation'];
  /** Relative to the session's working directory when inside it. */
  readonly path: string;
  /** Where a moved or copied file came from, shown as `path` is. */
  readonly oldPath: string | null;
  readonly added: number;
  readonly removed: number;
  /** Without Git's "no newline" marks, as the view has no place for them. */
  readonly hunks: readonly PatchHunk[];
  readonly note: DiffNote | null;
  /** What the editor opens, whole whatever the line limit cuts; null for a directory, which it cannot open. */
  readonly reported: ReportedFile | null;
}

/** A tool call's diffs as shown: each diff's files, in the order reported, cut to the line limit across them. */
export type ShownDiffs = readonly (readonly DiffFile[])[];

interface KeptDiffs {
  readonly diffs: readonly FileDiff[];
  readonly cwd: string | null;
  readonly shown: ShownDiffs;
}

/**
 * Each session's tool calls' diffs as the chat view shows them: kept so that an update with the same diffs is not
 * diffed again, and so that the editor opens a file by its place among them, as the chat view holds no whole files.
 */
export class ToolCallDiffs {
  private readonly sessions = new Map<string, Map<string, KeptDiffs>>();

  /** The tool call's diffs as shown, replacing what it showed; paths relative to `cwd` when inside it. */
  shown(sessionId: string, toolCallId: string, diffs: readonly FileDiff[], cwd: string | null): ShownDiffs {
    let toolCalls = this.sessions.get(sessionId);
    if (diffs.length === 0) {
      toolCalls?.delete(toolCallId);
      return [];
    }
    const kept = toolCalls?.get(toolCallId);
    if (kept?.cwd === cwd && sameDiffs(kept.diffs, diffs)) {
      return kept.shown;
    }
    let room = TOOL_CALL_DIFF_LINE_LIMIT;
    const shown = diffs.map((diff) => {
      const { files, shown: lines } = withinLineLimit(diffFiles(diff, cwd), room);
      room -= lines;
      return files;
    });
    if (!toolCalls) {
      toolCalls = new Map();
      this.sessions.set(sessionId, toolCalls);
    }
    toolCalls.set(toolCallId, { diffs, cwd, shown });
    return shown;
  }

  /** The `index`th file across the tool call's diffs, as last shown; undefined when there is none. */
  file(sessionId: string, toolCallId: string, index: number): DiffFile | undefined {
    return this.sessions.get(sessionId)?.get(toolCallId)?.shown.flat()[index];
  }

  /** The session is gone, or is about to show all its tool calls again. */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * The files a diff changed. A whole file is diffed here; a patch's file patches go to the changes whose path they end
 * at, as `changes` gives the files and their order, and one with lines that no change names follows them, under its
 * own name. Each of a patch's hunks is diffed again within itself, so its changes are shaped as a whole file's are.
 */
export function diffFiles(diff: FileDiff, cwd: string | null): DiffFile[] {
  if (diff.kind === 'wholeFile') {
    const hunks = unifiedHunks(diff.oldText ?? '', diff.newText, CONTEXT_LINES, { timeout: DIFF_TIMEOUT_MS });
    const operation = diff.oldText === null ? 'add' : 'modify';
    const reported: ReportedFile = { path: diff.path, operation, lines: { kind: 'wholeFile', oldText: diff.oldText, newText: diff.newText } };
    return [file(operation, shownPath(diff.path, cwd), null, hunks ? shownHunks(hunks) : [], hunks ? null : 'tooLarge', reported)];
  }
  const { patch } = diff;
  const parsed = patch?.format === 'git_patch' ? filePatches(patch.text) : null;
  const patchNote: DiffNote | null = patch === null ? 'noPatch' : patch.format !== 'git_patch' ? 'unknownFormat' : parsed === null ? 'unreadablePatch' : null;
  const unmatched = [...(parsed ?? [])];
  const files = diff.changes.map((change) => {
    const index = unmatched.findIndex((filePatch) => endPath(filePatch) === change.path);
    const matched = index === -1 ? undefined : unmatched.splice(index, 1)[0];
    const hunks = matched ? rediffed(matched) : [];
    const oldPath = change.oldPath === undefined ? null : shownPath(change.oldPath, cwd);
    const reported: ReportedFile | null =
      change.fileType === 'directory' ? null : { path: change.path, operation: change.operation, lines: matched && hunks.length > 0 ? { kind: 'hunks', hunks: matched.hunks } : null };
    const note = hunks.length > 0 ? null : (patchNote ?? fileTypeNote(change));
    return file(change.operation, shownPath(change.path, cwd), oldPath, hunks, note, reported);
  });
  const rest = unmatched.flatMap((filePatch) => {
    const path = endPath(filePatch);
    const hunks = rediffed(filePatch);
    if (path === undefined || hunks.length === 0) {
      return [];
    }
    const from = filePatch.isRename || filePatch.isCopy ? filePatch.oldFileName : undefined;
    const operation = patchOperation(filePatch);
    const reported: ReportedFile = { path, operation, lines: { kind: 'hunks', hunks: filePatch.hunks } };
    return [file(operation, shownPath(path, cwd), from === undefined ? null : shownPath(from, cwd), hunks, null, reported)];
  });
  return [...files, ...rest];
}

/** The files with their hunks cut to `room` lines in all, and how many lines they show. */
export function withinLineLimit(files: readonly DiffFile[], room: number): { files: DiffFile[]; shown: number } {
  let left = room;
  const limited = files.map((shown): DiffFile => {
    const hunks: PatchHunk[] = [];
    for (const hunk of shown.hunks) {
      if (left === 0) {
        break;
      }
      const lines = hunk.lines.slice(0, left);
      hunks.push(lines.length === hunk.lines.length ? hunk : { ...hunk, lines });
      left -= lines.length;
    }
    const cut = hunks.length < shown.hunks.length || hunks.at(-1) !== shown.hunks.at(-1);
    return cut ? { ...shown, hunks, note: 'cutOff' } : shown;
  });
  return { files: limited, shown: room - left };
}

/** The path relative to the working directory when inside it, as the agent reported it otherwise. */
export function shownPath(path: string, cwd: string | null): string {
  if (!cwd) {
    return path;
  }
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) && path.length > root.length ? path.slice(root.length) : path;
}

function file(
  operation: FileChange['operation'],
  path: string,
  oldPath: string | null,
  hunks: readonly PatchHunk[],
  note: DiffNote | null,
  reported: ReportedFile | null,
): DiffFile {
  const lines = hunks.flatMap((hunk) => hunk.lines);
  return {
    operation,
    path,
    oldPath,
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length,
    hunks,
    note,
    reported,
  };
}

/** A patch's file patches; none when it cannot be read. */
function filePatches(text: string): StructuredPatch[] | null {
  try {
    return parsePatch(text);
  } catch {
    return null;
  }
}

/** The path a file patch leaves the file at: its new name, or its old one when it deletes the file; none without hunks. */
function endPath(filePatch: StructuredPatch): string | undefined {
  return filePatch.isDelete || filePatch.newFileName === '/dev/null' ? filePatch.oldFileName : filePatch.newFileName;
}

function patchOperation(filePatch: StructuredPatch): FileChange['operation'] {
  if (filePatch.isRename) {
    return 'move';
  }
  if (filePatch.isCopy) {
    return 'copy';
  }
  if (filePatch.isCreate || filePatch.oldFileName === '/dev/null') {
    return 'add';
  }
  return filePatch.isDelete || filePatch.newFileName === '/dev/null' ? 'delete' : 'modify';
}

/**
 * The file patch's hunks, each diffed again from the text its lines give either side, the whole hunk as context so its
 * bounds stay the agent's; a hunk that does not come back as one, as with no change in it, is shown as sent.
 */
function rediffed(filePatch: StructuredPatch): PatchHunk[] {
  return shownHunks(filePatch.hunks.map((hunk) => {
    const { before, after } = hunkSides(hunk);
    const again = unifiedHunks(before, after, Math.max(hunk.oldLines, hunk.newLines), { timeout: DIFF_TIMEOUT_MS });
    const only = again?.length === 1 ? again[0] : undefined;
    return only ? { ...only, oldStart: hunk.oldStart + only.oldStart - 1, newStart: hunk.newStart + only.newStart - 1 } : hunk;
  }));
}

/** The text a hunk's lines give before and after it; a line ends with a line break unless Git's mark follows it. */
function hunkSides(hunk: StructuredPatchHunk): { before: string; after: string } {
  let before = '';
  let after = '';
  hunk.lines.forEach((line, index) => {
    if (line.startsWith('\\')) { return; }
    const text = line.slice(1) + (hunk.lines[index + 1]?.startsWith('\\') ? '' : '\n');
    if (!line.startsWith('+')) { before += text; }
    if (!line.startsWith('-')) { after += text; }
  });
  return { before, after };
}

function shownHunks(hunks: readonly StructuredPatchHunk[]): PatchHunk[] {
  return hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.filter((line) => !line.startsWith('\\')),
  }));
}

function sameDiffs(kept: readonly FileDiff[], diffs: readonly FileDiff[]): boolean {
  return kept.length === diffs.length && kept.every((diff, index) => sameDiff(diff, diffs[index] as FileDiff));
}

function sameDiff(a: FileDiff, b: FileDiff): boolean {
  if (a.kind === 'wholeFile' || b.kind === 'wholeFile') {
    return a.kind === 'wholeFile' && b.kind === 'wholeFile' && a.path === b.path && a.oldText === b.oldText && a.newText === b.newText;
  }
  return a.patch?.format === b.patch?.format && a.patch?.text === b.patch?.text && JSON.stringify(a.changes) === JSON.stringify(b.changes);
}

function fileTypeNote(change: FileChange): DiffNote {
  switch (change.fileType) {
    case 'binary':
    case 'directory':
    case 'symlink':
      return change.fileType;
    default:
      return 'noLines';
  }
}
