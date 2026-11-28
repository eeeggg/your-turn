/**
 * The chat view's contract: what the extension tells the webview and what the webview asks of it, in the chat view's
 * own vocabulary. `ChatViewController` translates ACP into it, so a change to ACP's schema never reaches the webview;
 * the contract changes only for the chat view's own sake.
 */

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ImagePresentation {
  src: string | null;
  reference?: true;
  fallback?: string;
}

/** A tool call's content, in the order the agent reported it; diffs only while `your-turn.showToolCallDiffs` is on. */
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
  category: 'mode' | 'model' | 'thought_level' | 'other';
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

/** Presentation of an open tab, without its transcript or live connection. */
interface SessionTab {
  tabId: string;
  title: string | null;
  agentName: string;
  cwd: string;
  additionalDirectories: readonly string[];
  status: 'quiet' | 'working' | 'needsInput' | 'failed' | 'completed';
  review: { readonly modified: boolean; readonly created: boolean; readonly deleted: boolean };
}

export interface SessionTabsSnapshot {
  tabs: readonly SessionTab[];
  selectedTabId: string | null;
}

/** Reported summary content retained for presentation, including blocks the view does not yet support. */
type CompactionContent = null | boolean | number | string | CompactionContent[] | { [key: string]: CompactionContent };

export interface PresentationTarget {
  readonly configuredName: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly projection: number;
}

interface PresentedCompaction {
  readonly kind: 'compaction';
  readonly compactionId: string;
  readonly status: string;
  readonly summary: readonly CompactionContent[];
  readonly error: string | null;
  readonly open: boolean;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly timingAllowed: boolean;
}

interface PresentedToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly status: ToolCallStatus;
  readonly content: readonly ToolCallContent[];
  readonly open: boolean;
  readonly markdownRevision?: number;
}

interface PresentedChildCompletion {
  readonly kind: 'childCompletion';
  readonly id: number;
  readonly childId: string;
  readonly stopReason: string | null;
  readonly descendantsActive?: true;
}

interface PresentedChildAssignment {
  readonly kind: 'childAssignment';
  readonly id: number;
  readonly childId: string;
  readonly text: string | null;
}

type PresentedPart =
  | { readonly kind: 'message'; readonly messageId: string | null; readonly text: string; readonly markdownRevision?: number }
  | ({ readonly kind: 'image'; readonly messageId: string | null } & Readonly<ImagePresentation>)
  | { readonly kind: 'thought'; readonly messageId: string | null; readonly text: string; readonly startedAt: number; readonly endedAt: number | null;
    readonly open: boolean; readonly markdownRevision?: number; readonly imageSrc?: string | null; readonly imageReference?: true; readonly imageFallback?: string }
  | { readonly kind: 'toolCalls'; readonly toolCalls: readonly PresentedToolCall[]; readonly collapsed: boolean }
  | { readonly kind: 'plan'; readonly steps: readonly PlanStep[] }
  | PresentedCompaction | PresentedChildCompletion | PresentedChildAssignment
  | { readonly kind: 'question'; readonly record: QuestionRecord; readonly open: boolean };

type PresentedEntry =
  | PresentedChildCompletion | PresentedChildAssignment
  | { readonly kind: 'prompt'; readonly id: number; readonly messageId?: string; readonly text: string }
  | ({ readonly kind: 'promptImage'; readonly id: number; readonly messageId: string | null; readonly text: '' } & Readonly<ImagePresentation>)
  | { readonly kind: 'turn'; readonly id: number; readonly parts: readonly PresentedPart[] }
  | { readonly kind: 'error'; readonly id: number; readonly text: string }
  | ((PresentedCompaction | Extract<PresentedPart, { kind: 'question' }>) & { readonly id: number });

type ContentPatch =
  | { readonly kind: 'spliceEntries'; readonly index: number; readonly remove: number; readonly entries: readonly PresentedEntry[] }
  | { readonly kind: 'insert'; readonly index: number; readonly entries: readonly PresentedEntry[] }
  | { readonly kind: 'replace'; readonly id: number; readonly entry: PresentedEntry }
  | { readonly kind: 'spliceParts'; readonly turnId: number; readonly index: number; readonly remove: number; readonly parts: readonly PresentedPart[] }
  | { readonly kind: 'appendText'; readonly turnId: number; readonly part: number; readonly text: string }
  | { readonly kind: 'toolCall'; readonly turnId: number; readonly part: number; readonly call: PresentedToolCall }
  | { readonly kind: 'terminal'; readonly terminalId: string; readonly text: string; readonly truncated: boolean; readonly exitStatus: ExitStatus | null }
  | { readonly kind: 'removeTerminal'; readonly terminalId: string };

export interface ContentVersions {
  readonly entries: readonly (readonly [id: number, revision: number])[];
  readonly terminals: readonly (readonly [id: string, revision: number])[];
}

interface ContentSnapshot {
  readonly children?: readonly { readonly id: string; readonly parentId: string; readonly label: string;
    readonly held?: { readonly entryId: number; readonly status: 'running' | 'requiresAction' };
    readonly descendants?: { readonly running: number; readonly requiresAction: number } }[];
  readonly versions?: ContentVersions;
  readonly target: PresentationTarget;
  /** Changes when image consent and pending reads are invalidated, not on every snapshot. */
  readonly markdownImageEpoch?: number;
  readonly revision: number;
  readonly entries: readonly PresentedEntry[];
  readonly currentTurn: number | null;
  readonly nextId: number;
  readonly usage: SessionUsage | null;
  readonly terminals: readonly { readonly terminalId: string; readonly text: string; readonly truncated: boolean; readonly exitStatus: ExitStatus | null }[];
}

interface SelectedSnapshot extends ContentSnapshot {
  readonly readingRequest?: never;
  readonly queue: readonly { readonly id: number; readonly text: string; readonly draft: string | null; readonly revision?: number }[];
  readonly composer: { readonly text: string; readonly revision: number };
}

interface InspectionSnapshot extends ContentSnapshot {
  readonly readingRequest: number;
  readonly queue?: never;
  readonly composer?: never;
}

export type ExtensionToWebviewMessage =
  | { type: 'viewSnapshot'; state: { activeSessionId: string | null; session: SessionSnapshot | null };
    tabs: SessionTabsSnapshot; running: boolean; loading: boolean; questions: Question[]; content: SelectedSnapshot | null }
  | ({ type: 'contentSnapshot' } & (SelectedSnapshot | InspectionSnapshot))
  | { type: 'contentPatch'; target: PresentationTarget; base: number; revision: number; patches: readonly ContentPatch[];
      currentTurn: number | null; nextId: number; usage: SessionUsage | null; running?: boolean; composer?: { readonly text: string; readonly revision: number };
     queue?: SelectedSnapshot['queue']; children?: ContentSnapshot['children']; versions?: ContentVersions; baseTarget?: PresentationTarget }
  | { type: 'contentManifestRequested'; target: PresentationTarget }
  | { type: 'markdownImageContext'; target: PresentationTarget; context: number; origin?: string }
  | ({ type: 'markdownImage'; context: number; occurrence: number; status?: 'consent' | 'loading' | 'retry' } & ImagePresentation)
  | ({ type: 'sessionTabs' } & SessionTabsSnapshot)
  | { type: 'sessionTabAnnouncement'; revision: number; text: string }
  | { type: 'questionOpen'; interactionId: string }
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
  | { type: 'commands'; commands: SlashCommand[] }
  | { type: 'pickers'; pickers: Picker[] }
  /** The active session's title, null when it has none. */
  | { type: 'sessionInfoUpdate'; title: string | null }
  | { type: 'loadSessionStart' }
  | { type: 'loadSessionEnd'; ok: boolean };

export type WebviewToExtensionMessage =
  | { type: 'readTranscript'; target: PresentationTarget; sessionId: string | null; request: number }
  | { type: 'queueChanged'; target: PresentationTarget; change:
    | { kind: 'cancelled' | 'steer' | 'stop'; id: number }
    | { kind: 'editStarted' | 'editSaved' | 'editDiscarded'; id: number; revision: number }
    | { kind: 'edited'; id: number; text: string; revision: number } }
  | { type: 'composerEdited'; target: PresentationTarget; revision: number; text: string }
  | { type: 'contentApplied'; target: PresentationTarget; revision: number }
  | { type: 'contentManifest'; target: PresentationTarget; baseTarget?: PresentationTarget; revision: number; versions: ContentVersions; invalidBase?: true }
  | { type: 'contentSnapshotRequested'; target: PresentationTarget }
  | { type: 'markdownImageContext'; target: PresentationTarget }
  | { type: 'openTranscriptFile'; target: PresentationTarget; destination: string }
  | { type: 'resolveMarkdownImage'; context: number; occurrence: number; source: string }
  | { type: 'loadMarkdownImage'; context: number; occurrence: number }
  | { type: 'releaseMarkdownImage'; context: number; occurrence: number }
  | { type: 'selectSessionTab'; tabId: string }
  | { type: 'closeSessionTab'; tabId: string }
  | { type: 'questionDraft'; target: PresentationTarget | null; interactionId: string; draft: Readonly<Record<string, QuestionValue>> }
  | { type: 'questionResponse'; target: PresentationTarget | null; interactionId: string; action: 'accept' | 'decline' | 'cancel'; content?: Readonly<Record<string, QuestionValue>> }
  | { type: 'ready' }
  | { type: 'sendPrompt'; target: PresentationTarget; text: string }
  | { type: 'cancelTurn'; target: PresentationTarget }
  | { type: 'pickerValueChosen'; target: PresentationTarget; pickerId: string; value: string }
  /** The `file`th file across the tool call's diffs in the shown session, as their `diff` contents list them. */
  | { type: 'openFile'; target: PresentationTarget; toolCallId: string; file: number }
  /** As for `openFile`; only for a file the agent reported lines of. */
  | { type: 'openChanges'; target: PresentationTarget; toolCallId: string; file: number };

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
