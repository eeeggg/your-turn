import { parsePatch, structuredPatch, type StructuredPatch } from 'diff';
import type { DiffHunk, FileChange, ReportedFile, ToolCallDiff } from '@/shared/WebviewMessages';

/** Lines of unchanged text shown around each change. */
const CONTEXT_LINES = 3;

/** How long working out a whole file's hunks may take; past it the file is too large to show. */
const DIFF_TIMEOUT_MS = 200;

/** A tool call shows at most this many diff lines across its files. */
export const TOOL_CALL_DIFF_LINE_LIMIT = 2_000;

/** Why a file shows fewer lines than it changed, or none. */
export type DiffNote =
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
  readonly hunks: readonly DiffHunk[];
  readonly note: DiffNote | null;
  /** What the editor opens, whole whatever the line limit cuts; null for a directory, which it cannot open. */
  readonly reported: ReportedFile | null;
}

/**
 * The files a diff changed. A whole file is diffed here; a patch's file patches go to the changes whose path they end
 * at, as `changes` gives the files and their order, and one with lines that no change names follows them, under its
 * own name.
 */
export function diffFiles(diff: ToolCallDiff, cwd: string | null): DiffFile[] {
  if (diff.kind === 'wholeFile') {
    const patch = structuredPatch(diff.path, diff.path, diff.oldText ?? '', diff.newText, '', '', {
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    });
    const operation = diff.oldText === null ? 'add' : 'modify';
    const reported: ReportedFile = { path: diff.path, operation, lines: { kind: 'wholeFile', oldText: diff.oldText, newText: diff.newText } };
    return [file(operation, shownPath(diff.path, cwd), null, patch ? hunksOf(patch) : [], patch ? null : 'tooLarge', reported)];
  }
  const { patch } = diff;
  const parsed = patch?.format === 'git_patch' ? filePatches(patch.text) : null;
  const patchNote: DiffNote | null = patch === null ? 'noPatch' : patch.format !== 'git_patch' ? 'unknownFormat' : parsed === null ? 'unreadablePatch' : null;
  const unmatched = [...(parsed ?? [])];
  const files = diff.changes.map((change) => {
    const index = unmatched.findIndex((filePatch) => endPath(filePatch) === change.path);
    const matched = index === -1 ? undefined : unmatched.splice(index, 1)[0];
    const hunks = matched ? hunksOf(matched) : [];
    const oldPath = change.oldPath === undefined ? null : shownPath(change.oldPath, cwd);
    const reported: ReportedFile | null =
      change.fileType === 'directory' ? null : { path: change.path, operation: change.operation, lines: matched && hunks.length > 0 ? { kind: 'hunks', hunks: matched.hunks } : null };
    const note = hunks.length > 0 ? null : (patchNote ?? fileTypeNote(change));
    return file(change.operation, shownPath(change.path, cwd), oldPath, hunks, note, reported);
  });
  const rest = unmatched.flatMap((filePatch) => {
    const path = endPath(filePatch);
    const hunks = hunksOf(filePatch);
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
    const hunks: DiffHunk[] = [];
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
  hunks: readonly DiffHunk[],
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

function hunksOf(patch: StructuredPatch): DiffHunk[] {
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.filter((line) => !line.startsWith('\\')),
  }));
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
