/**
 * The chat view's contract: what the extension tells the webview and what the webview asks of it, in the chat view's
 * own vocabulary. `ChatViewController` translates ACP into it, so a change to ACP's schema never reaches the webview;
 * the contract changes only for the chat view's own sake.
 */

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A tool call's content, in the order the agent reported it; diffs only while `acp.showToolCallDiffs` is on. */
export type ToolCallContent =
  | { kind: 'text'; text: string }
  | { kind: 'diff'; diff: ToolCallDiff }
  /** A command's output the agent sent as text, cleaned as a terminal shows it; `truncated` when earlier output is not in it. */
  | { kind: 'commandOutput'; text: string; truncated: boolean }
  /** Where an agent's terminal shows, by ID; `terminal` messages carry it, before or after this. */
  | { kind: 'terminal'; terminalId: string };

/** How a terminal's command ended; either may be unknown. */
export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/** What a tool call reported it changed, in the form the agent's ACP version holds it. */
export type ToolCallDiff =
  /** A file's whole content before and after; `oldText` is null for a new file. */
  | { kind: 'wholeFile'; path: string; oldText: string | null; newText: string }
  /** Which files changed and how, with patch text for some or all of them, or none. */
  | { kind: 'changes'; changes: FileChange[]; patch: { format: 'git_patch' | 'other'; text: string } | null };

export interface FileChange {
  operation: 'add' | 'delete' | 'modify' | 'move' | 'copy';
  path: string;
  /** Where a moved or copied file came from. */
  oldPath?: string;
  /** Null when the agent does not say. */
  fileType: 'text' | 'binary' | 'directory' | 'symlink' | 'other' | null;
  mimeType: string | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line with its marker: `+` added, `-` removed, ` ` unchanged, `\` Git's "no newline at end of file". */
  lines: string[];
}

/** One file of a tool call's diff as the agent reported it, for the editor to open. */
export interface ReportedFile {
  /** As the agent reported it. */
  path: string;
  operation: FileChange['operation'];
  /** The lines it reported; null when it reported none. */
  lines: { kind: 'wholeFile'; oldText: string | null; newText: string } | { kind: 'hunks'; hunks: DiffHunk[] } | null;
}

/** The user chose to open a file of a tool call's diffs: the `file`th across them, in the order they were reported. */
export interface DiffFileChoice {
  toolCallId: string;
  file: number;
  /** Open File, or Open Changes in VS Code's diff editor. */
  open: 'file' | 'changes';
}

export type PlanStepStatus = 'pending' | 'running' | 'completed';

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Choosing it puts `/name ` in the prompt box for the rest of the prompt, instead of sending it at once. */
  takesInput: boolean;
  /** What the rest of the prompt should be, shown beside the name; null when the agent gives none. */
  hint: string | null;
}

export type PickerCategory = 'mode' | 'model' | 'thought_level' | 'other';

export interface PickerValue {
  id: string;
  name: string;
  description: string | null;
}

/** A run of a picker's values, under a header when the agent grouped them. */
export interface PickerValueGroup {
  header: string | null;
  values: PickerValue[];
}

/** One of the session's settings the user can choose a value for, shown above the prompt box. */
export interface Picker {
  /** Unique among the session's pickers; the extension knows what it stands for. */
  id: string;
  category: PickerCategory;
  name: string;
  description: string | null;
  /** The ID of the chosen value. */
  current: string;
  groups: PickerValueGroup[];
}

/** The active session as the chat view shows it. */
export interface SessionSnapshot {
  sessionId: string;
  agentName: string;
  title?: string;
  cwd: string;
  pickers: Picker[];
  commands: SlashCommand[];
}

export type ExtensionToWebviewMessage =
  | { type: 'state'; activeSessionId: string | null; session: SessionSnapshot | null }
  | { type: 'clearTranscript' }
  | { type: 'promptStart' }
  | { type: 'promptEnd' }
  | { type: 'error'; message: string }
  /** The shown session's agent exited on its own; the message says so. A sessionless `state` follows. */
  | { type: 'sessionEnded'; message: string }
  /** More of the agent's answer; text with another `messageId` is another message. */
  | { type: 'agentText'; messageId: string | null; text: string }
  /** More of the agent's thinking, as for `agentText`. */
  | { type: 'thoughtText'; messageId: string | null; text: string }
  /** More of a prompt that a load replays, as for `agentText`. */
  | { type: 'promptText'; messageId: string | null; text: string }
  /** The whole text of the agent's answer with this `messageId`, replacing what the latest one had; without one, a new answer. */
  | { type: 'agentMessage'; messageId: string; text: string }
  /** The whole text of the agent's thinking, as for `agentMessage`. */
  | { type: 'thoughtMessage'; messageId: string; text: string }
  /** The whole text of a prompt that a load replays, as for `agentMessage`. */
  | { type: 'promptMessage'; messageId: string; text: string }
  /** A tool call, new or changed; what it leaves out stays as it was. */
  | { type: 'toolCall'; toolCallId: string; title?: string; status?: ToolCallStatus; content?: ToolCallContent[] }
  /**
   * An agent's terminal, new or changed, whole: the end of its output, cleaned as a terminal shows it, `truncated` when
   * earlier output is not in it; its command runs while `exitStatus` is null.
   */
  | { type: 'terminal'; terminalId: string; text: string; truncated: boolean; exitStatus: ExitStatus | null }
  /** The agent's plan, replacing the turn's earlier one. */
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'commands'; commands: SlashCommand[] }
  | { type: 'pickers'; pickers: Picker[] }
  /** The active session's title, null when it has none. */
  | { type: 'sessionInfoUpdate'; title: string | null }
  | { type: 'loadSessionStart' }
  | { type: 'loadSessionEnd'; ok: boolean }
  /** Chosen from the chat view's context menu, which VS Code shows; the webview answers with `openFile` or `openChanges`. */
  | ({ type: 'diffFileChosen' } & DiffFileChoice)
  /** The webview has no handler for this yet, so the attachment is dropped. */
  | { type: 'file-attached'; path: string; name: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  /** How many prompts the chat view holds until the turn ends, each time that changes; only the chat view holds them. */
  | { type: 'queuedPrompts'; count: number }
  | { type: 'pickerValueChosen'; pickerId: string; value: string }
  | { type: 'openFile'; file: ReportedFile }
  /** Only for a file with lines. */
  | { type: 'openChanges'; file: ReportedFile };
