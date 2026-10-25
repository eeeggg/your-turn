import { memo, useMemo } from 'react';
import { Diff, Hunk, type ChangeData, type DiffType, type HunkData } from 'react-diff-view';
import type { DiffFile, DiffHunk, DiffNote } from '@/shared/WebviewMessages';
import { useDispatch } from '@/webview/views/StoreContext';

const operationLabel: Record<DiffFile['operation'], string> = {
  add: 'Added',
  delete: 'Deleted',
  modify: 'Modified',
  move: 'Moved',
  copy: 'Copied',
};

const diffType: Record<DiffFile['operation'], DiffType> = {
  add: 'add',
  delete: 'delete',
  modify: 'modify',
  move: 'rename',
  copy: 'copy',
};

const noteText: Record<DiffNote, string> = {
  binary: 'Binary file',
  directory: 'Directory',
  symlink: 'Symbolic link',
  noPatch: 'No patch reported',
  unknownFormat: 'A patch in a format the chat view cannot show',
  unreadablePatch: 'The patch could not be read',
  tooLarge: 'Too large to show',
  noLines: "No lines in the agent's patch",
  cutOff: '... (diff cut off)',
};

/**
 * A tool call's diff, as the agent reported it: a section for each file it changed. `firstFile` is the first one's
 * place across the tool call's diffs, by which the extension finds a file the user opens.
 */
export function ToolCallDiffView({ files, toolCallId, firstFile }: { files: readonly DiffFile[]; toolCallId: string; firstFile: number }) {
  return (
    <div className="tc-diff mb-1 flex flex-col gap-1 last:mb-0">
      {files.map((file, index) => (
        <FileSection key={index} file={file} toolCallId={toolCallId} index={firstFile + index} />
      ))}
    </div>
  );
}

const FileSection = memo(function FileSection({ file, toolCallId, index }: { file: DiffFile; toolCallId: string; index: number }) {
  const hunks = useMemo(() => file.hunks.map(hunkData), [file.hunks]);
  return (
    <div className="tc-diff-file">
      <div className="tc-diff-header flex items-baseline gap-1.5 font-sans">
        <span className="tc-diff-operation flex-none text-muted-foreground">{operationLabel[file.operation]}</span>
        <span className="tc-diff-path flex-1 wrap-anywhere">
          {file.oldPath !== null && `${file.oldPath} → `}
          {file.opens === null ? file.path : <FileLink path={file.path} toolCallId={toolCallId} index={index} hasLines={file.opens === 'fileAndChanges'} />}
        </span>
        {file.added > 0 && <span className="tc-diff-added flex-none text-success">{`+${file.added}`}</span>}
        {file.removed > 0 && <span className="tc-diff-removed flex-none text-failure">{`−${file.removed}`}</span>}
      </div>
      {hunks.length > 0 && (
        <Diff viewType="unified" diffType={diffType[file.operation]} hunks={hunks}>
          {(shown) => shown.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
      {file.note !== null && <div className="tc-diff-note text-muted-foreground italic">{noteText[file.note]}</div>}
    </div>
  );
});

/**
 * A click opens the file; a right-click shows VS Code's context menu, whose items `package.json` contributes to
 * `webview/context`, reading the context below.
 */
function FileLink({ path, toolCallId, index, hasLines }: { path: string; toolCallId: string; index: number; hasLines: boolean }) {
  const dispatch = useDispatch();
  const context = { webviewSection: 'toolCallDiffFile', acpToolCallId: toolCallId, acpDiffFile: index, acpDiffFileHasLines: hasLines, preventDefaultContextMenuItems: true };
  return (
    <button
      type="button"
      className="tc-diff-link cursor-pointer text-left wrap-anywhere hover:text-link hover:underline focus-visible:text-link"
      title="Open the file; right-click for more"
      data-vscode-context={JSON.stringify(context)}
      onClick={() => dispatch({ type: 'diffFileClicked', toolCallId, file: index })}
    >
      {path}
    </button>
  );
}

/** The hunk with each line numbered in the file it belongs to, as `react-diff-view` takes it. */
function hunkData(hunk: DiffHunk): HunkData {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const changes = hunk.lines.map((line): ChangeData => {
    const content = line.slice(1);
    switch (line[0]) {
      case '+':
        return { type: 'insert', content, lineNumber: newLine++, isInsert: true };
      case '-':
        return { type: 'delete', content, lineNumber: oldLine++, isDelete: true };
      default:
        return { type: 'normal', content, isNormal: true, oldLineNumber: oldLine++, newLineNumber: newLine++ };
    }
  });
  return {
    content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    changes,
  };
}
