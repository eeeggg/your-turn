import { errorHandler } from 'monaco-editor/base/common/errors.js';
import { DefaultLinesDiffComputer } from 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { logWarning, messageOf } from '@/core/Log';

/** Lines from `start` up to `end`, 0-based; empty where a change has no lines on that side, before line `start`. */
interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Text from a line and column up to another, 0-based, the end column exclusive. */
interface TextRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** Text of the original replaced by text of the modified, within a line change. */
interface CharacterChange {
  readonly original: TextRange;
  readonly modified: TextRange;
}

/** Lines of the original replaced by lines of the modified text. */
export interface LineChange {
  readonly original: LineRange;
  readonly modified: LineRange;
  /** Where within the lines the text changed; none when VS Code narrowed nothing. */
  readonly characters: readonly CharacterChange[];
}

export interface DiffOptions {
  /** Milliseconds the diff may take, above 0; past them there are no changes to give. */
  readonly timeout: number;
}

/** A text's lines without their line breaks, as VS Code splits them. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

const computer = new DefaultLinesDiffComputer();

/**
 * The changes from `original` to `modified`, whitespace included, computed by VS Code's own diff as its quick diff does,
 * and kept as it keeps them when the diff fails its own checks, which are logged.
 */
export function lineChanges(original: readonly string[], modified: readonly string[]): LineChange[];
export function lineChanges(original: readonly string[], modified: readonly string[], options: DiffOptions): LineChange[] | undefined;
export function lineChanges(original: readonly string[], modified: readonly string[], options?: DiffOptions): LineChange[] | undefined {
  const failures: unknown[] = [];
  const handler = errorHandler.unexpectedErrorHandler;
  errorHandler.unexpectedErrorHandler = (error) => failures.push(error);
  let diff;
  try {
    diff = computer.computeDiff([...original], [...modified], {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: options?.timeout ?? 0,
    });
  } finally {
    errorHandler.unexpectedErrorHandler = handler;
  }
  for (const failure of failures) {
    logWarning(`Diff: VS Code's diff failed its own check, so its changes of ${original.length} lines against ${modified.length} may be wrong: ${messageOf(failure)}`);
  }
  if (diff.hitTimeout) { return undefined; }
  return diff.changes.map((change) => ({
    original: { start: change.original.startLineNumber - 1, end: change.original.endLineNumberExclusive - 1 },
    modified: { start: change.modified.startLineNumber - 1, end: change.modified.endLineNumberExclusive - 1 },
    characters: (change.innerChanges ?? []).map(({ originalRange, modifiedRange }) => ({
      original: textRange(originalRange),
      modified: textRange(modifiedRange),
    })),
  }));
}

function textRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): TextRange {
  return { startLine: range.startLineNumber - 1, startColumn: range.startColumn - 1, endLine: range.endLineNumber - 1, endColumn: range.endColumn - 1 };
}
