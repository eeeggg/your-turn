// monaco-editor ships its diff code as JavaScript only; its own types cover the public editor, not this.
declare module 'monaco-editor/base/common/errors.js' {
  /** Called as a check fails; by default it throws the error from a timer. */
  export const errorHandler: { unexpectedErrorHandler: (error: unknown) => void };
}

declare module 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js' {
  /** 1-based, the end exclusive. */
  interface LineRange {
    readonly startLineNumber: number;
    readonly endLineNumberExclusive: number;
  }

  /** 1-based lines and columns, the end column exclusive. */
  interface Range {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
  }

  interface RangeMapping {
    readonly originalRange: Range;
    readonly modifiedRange: Range;
  }

  interface DetailedLineRangeMapping {
    readonly original: LineRange;
    readonly modified: LineRange;
    readonly innerChanges: readonly RangeMapping[] | undefined;
  }

  interface LinesDiff {
    readonly changes: readonly DetailedLineRangeMapping[];
    readonly hitTimeout: boolean;
  }

  export class DefaultLinesDiffComputer {
    computeDiff(
      originalLines: string[],
      modifiedLines: string[],
      options: { ignoreTrimWhitespace: boolean; computeMoves: boolean; maxComputationTimeMs: number },
    ): LinesDiff;
  }
}
