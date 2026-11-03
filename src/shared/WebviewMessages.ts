/**
 * The chat view's contract: what the extension tells the webview and what the webview asks of it, in the chat view's
 * own vocabulary. `ChatViewController` translates ACP into it, so a change to ACP's schema never reaches the webview;
 * the contract changes only for the chat view's own sake.
 */

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

type MessageContent = { kind: 'text'; text: string } | ({ kind: 'image' } & ImagePresentation);

export interface ImagePresentation {
  src: string | null;
  reference?: true;
  fallback?: string;
}

/** A tool call's content, in the order the agent reported it; diffs only while `acp.showToolCallDiffs` is on. */
export type ToolCallContent =
  | { kind: 'text'; text: string }
  | ({ kind: 'image' } & ImagePresentation)
  /** A diff's files, each shown whole or cut to the tool call's line limit across its diffs. */
  | { kind: 'diff'; files: DiffFile[] }
  /** A command's output the agent sent as text, cleaned as a terminal shows it; `truncated` when earlier output is not in it. */
  | { kind: 'commandOutput'; text: string; truncated: boolean }
  /** Where an agent's terminal shows, by ID; `terminal` messages carry it, before or after this. */
  | { kind: 'terminal'; terminalId: string };

/** How a terminal's command ended; either may be unknown. */
export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

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
  operation: 'add' | 'delete' | 'modify' | 'move' | 'copy';
  /** Relative to the session's working directory when inside it. */
  path: string;
  /** Where a moved or copied file came from, shown as `path` is. */
  oldPath: string | null;
  /** The file's, whatever the line limit cuts. */
  added: number;
  removed: number;
  hunks: DiffHunk[];
  note: DiffNote | null;
  /** What the editor opens of it: null for a directory; Open Changes too only when the agent reported its lines. */
  opens: 'file' | 'fileAndChanges' | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line with its marker: `+` added, `-` removed, ` ` unchanged. */
  lines: string[];
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

/** The latest agent-reported context and cumulative session cost, replacing the previous snapshot. */
export interface SessionUsage {
  /** Tokens currently in context. */
  used: number;
  /** The current effective context-window limit in tokens. */
  size: number;
  /** Null when no cost was reported in this snapshot. */
  cost: { amount: number; currency: string } | null;
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

/** A navigation reference, not a retained transcript or a live connection. */
interface SessionTab {
  tabId: string;
  title: string | null;
  agentName: string;
  cwd: string;
  additionalDirectories: readonly string[];
  running: boolean;
}

export interface SessionTabsSnapshot {
  tabs: readonly SessionTab[];
  selectedTabId: string | null;
}

/** Reported summary content retained for presentation, including blocks the view does not yet support. */
type CompactionContent = null | boolean | number | string | CompactionContent[] | { [key: string]: CompactionContent };

export type ExtensionToWebviewMessage =
  | ({ type: 'sessionTabs' } & SessionTabsSnapshot)
  | { type: 'questionOpen'; interactionId: string }
  | { type: 'questionSettled'; record: QuestionRecord }
  | { type: 'questions'; questions: Question[] }
  | { type: 'questionErrors'; interactionId: string; errors: Readonly<Record<string, string>> }
  | { type: 'state'; activeSessionId: string | null; session: SessionSnapshot | null }
  | { type: 'clearTranscript' }
  | { type: 'promptStart' }
  | { type: 'promptEnd' }
  | { type: 'foregroundActivity'; running: boolean }
  | { type: 'error'; message: string }
  /** The shown session's agent exited on its own; the message says so. A sessionless `state` follows. */
  | { type: 'sessionEnded'; message: string }
  /** More of the agent's answer; text with another `messageId` is another message. */
  | { type: 'agentText'; messageId: string | null; text: string }
  | ({ type: 'agentImage'; messageId: string | null } & ImagePresentation)
  | ({ type: 'thoughtImage'; messageId: string | null } & ImagePresentation)
  | ({ type: 'promptImage'; messageId: string | null } & ImagePresentation)
  /** More of the agent's thinking, as for `agentText`. */
  | { type: 'thoughtText'; messageId: string | null; text: string }
  /** More of a prompt that a load replays, as for `agentText`. */
  | { type: 'promptText'; messageId: string | null; text: string }
  /** The whole text of the agent's answer with this `messageId`, replacing what the latest one had; without one, a new answer. */
  | { type: 'agentMessage'; messageId: string; text: string }
  | { type: 'agentRichMessage'; messageId: string; content: MessageContent[] }
  | { type: 'thoughtRichMessage'; messageId: string; content: MessageContent[] }
  | { type: 'promptRichMessage'; messageId: string; content: MessageContent[] }
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
  | { type: 'usage'; usage: SessionUsage }
  /** Omitted patches retain stored values; null and an empty summary clear them. Status is an open string. */
  | {
    type: 'compactionUpdate';
    compactionId: string;
    status: string;
    summary: { present: false } | { present: true; value: CompactionContent[] | null };
    error: { present: false } | { present: true; value: string | null };
  }
  /** Append this content to the summary at the compaction's original timeline position. */
  | { type: 'compactionSummaryChunk'; compactionId: string; content: CompactionContent }
  /** The active session's title, null when it has none. */
  | { type: 'sessionInfoUpdate'; title: string | null }
  | { type: 'loadSessionStart' }
  | { type: 'loadSessionEnd'; ok: boolean }
  /** The webview has no handler for this yet, so the attachment is dropped. */
  | { type: 'file-attached'; path: string; name: string };

export type WebviewToExtensionMessage =
  | { type: 'selectSessionTab'; tabId: string }
  | { type: 'closeSessionTab'; tabId: string }
  | { type: 'questionDraft'; interactionId: string; draft: Readonly<Record<string, QuestionValue>> }
  | { type: 'questionResponse'; interactionId: string; action: 'accept' | 'decline' | 'cancel'; content?: Readonly<Record<string, QuestionValue>> }
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  /** How many prompts the chat view holds until the turn ends, each time that changes; only the chat view holds them. */
  | { type: 'queuedPrompts'; count: number }
  | { type: 'pickerValueChosen'; pickerId: string; value: string }
  /** The `file`th file across the tool call's diffs in the shown session, as their `diff` contents list them. */
  | { type: 'openFile'; toolCallId: string; file: number }
  /** As for `openFile`; only for a file the agent reported lines of. */
  | { type: 'openChanges'; toolCallId: string; file: number };

type QuestionValue = string | number | boolean | readonly string[];

interface QuestionField {
  name: string;
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'multiple';
  title: string | null;
  description: string | null;
  required: boolean;
  choices: { value: string; title: string; description: string | null }[] | null;
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  minItems: number | null;
  maxItems: number | null;
  pattern: string | null;
  format: string | null;
  default?: QuestionValue;
}

interface Question {
  interactionId: string;
  agentName: string;
  sessionId: string | null;
  message: string;
  title: string | null;
  description: string | null;
  fields: QuestionField[];
  /** Null before any edit; an empty object is a saved draft with every field omitted. */
  draft: Readonly<Record<string, QuestionValue>> | null;
}

/** Core-confirmed form response, not a pending draft or a replayable prompt. */
export interface QuestionRecord {
  interactionId: string;
  sessionId: string;
  agentName: string;
  message: string;
  title: string | null;
  description: string | null;
  fields: QuestionField[];
  response: { action: 'accept'; content: Readonly<Record<string, QuestionValue>> } | { action: 'decline' | 'cancel' };
}
