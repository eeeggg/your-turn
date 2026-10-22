import { applyPatch, reversePatch } from 'diff';
import type { FileChange } from '@/core/acp/AcpDriver';

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line with its marker: `+` added, `-` removed, ` ` unchanged, `\` Git's "no newline at end of file". */
  lines: string[];
}

/** One file of a tool call's diff as the agent reported it. */
export interface ReportedFile {
  path: string;
  operation: FileChange['operation'];
  /** Null when it reported none of its lines. */
  lines: { kind: 'wholeFile'; oldText: string | null; newText: string } | { kind: 'hunks'; hunks: PatchHunk[] } | null;
}

/** What opening a tool call's files needs from the editor. */
export interface FileEditor {
  exists(path: string): PromiseLike<boolean>;
  /** The file's text; null when there is no file to read. */
  readText(path: string): PromiseLike<string | null>;
  /** Open it as VS Code opens a file the user picks, following the user's settings for preview editors and tabs. */
  open(path: string): PromiseLike<void>;
  /** VS Code's diff editor, both sides read-only. */
  showChanges(path: string, before: string, after: string): PromiseLike<void>;
  showInformationMessage(message: string): PromiseLike<unknown>;
}

type ReportedLines = NonNullable<ReportedFile['lines']>;

/**
 * The file before and after the change the agent reported. A whole file says both; a patch says only what changed, so
 * the sides are the file as it is now, or empty for a deletion, and that undone by the patch: null when the file has
 * changed so that the patch no longer undoes, or is gone.
 */
export function changeSides(lines: ReportedLines, operation: ReportedFile['operation'], current: string | null): { before: string; after: string } | null {
  if (lines.kind === 'wholeFile') {
    return { before: lines.oldText ?? '', after: lines.newText };
  }
  const after = operation === 'delete' ? '' : current;
  if (after === null) {
    return null;
  }
  const undo = reversePatch({ oldFileName: undefined, newFileName: undefined, oldHeader: undefined, newHeader: undefined, hunks: lines.hunks });
  const before = applyPatch(after, undo);
  return before === false ? null : { before, after };
}

/** Open File: the file itself, or, as nothing is left to open, what the agent removed. */
export async function openReportedFile(file: ReportedFile, editor: FileEditor): Promise<void> {
  if (file.operation !== 'delete' || (await editor.exists(file.path))) {
    await editor.open(file.path);
    return;
  }
  if (file.lines === null) {
    await editor.showInformationMessage(`${file.path} was deleted, and the agent reported none of its content.`);
    return;
  }
  await openReportedChanges(file, editor);
}

/** Open Changes: the change the agent reported, in VS Code's diff editor. */
export async function openReportedChanges(file: ReportedFile, editor: FileEditor): Promise<void> {
  if (file.lines === null) {
    return;
  }
  const current = file.lines.kind === 'hunks' && file.operation !== 'delete' ? await editor.readText(file.path) : null;
  const sides = changeSides(file.lines, file.operation, current);
  if (!sides) {
    await editor.showInformationMessage(`${file.path} has changed since the agent reported its change, so the change can no longer be shown.`);
    return;
  }
  await editor.showChanges(file.path, sides.before, sides.after);
}
