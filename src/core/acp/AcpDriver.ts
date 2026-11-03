/**
 * The ACP driver interface: what core asks of a connection to an agent, and what the agent tells core, in the
 * extension's own vocabulary. Each ACP version has a driver meeting it, and only drivers import the ACP SDK, so a
 * change to ACP's schema lands in one driver. Session updates come up through `SessionUpdateHandler`, and the agent's
 * requests through `ClientHandlers`.
 */

/** Which past sessions the agent can work with. */
export interface AgentCapabilities {
  list: boolean;
  load: boolean;
  resume: boolean;
  /** Whether a session can be given directories beyond its `cwd` when it is created, loaded or resumed. */
  additionalDirectories: boolean;
}

/** The directories a session works in: `cwd`, the base for relative paths, and any others it may use. */
export interface SessionRoots {
  cwd: string;
  /** Sent only to an agent that supports them. */
  additionalDirectories: readonly string[];
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string | null;
}

/** The agent as it described itself when the connection was established. */
export interface AgentDescription {
  /** Null when the agent gave no name. */
  displayName: string | null;
  capabilities: AgentCapabilities;
  authMethods: AuthMethod[];
}

interface Mode {
  id: string;
  name: string;
  description: string | null;
}

export interface Modes {
  /** The ID of the session's mode. */
  current: string;
  available: Mode[];
}

export type ConfigCategory = 'mode' | 'model' | 'thought_level' | 'other';

export interface ConfigValue {
  id: string;
  name: string;
  description: string | null;
}

/** A run of a config option's values, under a header when the agent grouped them. */
export interface ConfigValueGroup {
  header: string | null;
  values: ConfigValue[];
}

interface ConfigOptionBase {
  id: string;
  name: string;
  description: string | null;
  category: ConfigCategory;
}

export type ConfigOption =
  | (ConfigOptionBase & { kind: 'select'; current: string; groups: ConfigValueGroup[] })
  | (ConfigOptionBase & { kind: 'boolean'; current: boolean });

/** A session's controls as the agent reports them on opening it; null where it reports none. */
export interface SessionState {
  modes: Modes | null;
  configOptions: ConfigOption[] | null;
  commands: SlashCommand[] | null;
}

export interface NewSession extends SessionState {
  sessionId: string;
}

export interface ListedSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

export interface SessionPage {
  sessions: ListedSession[];
  /** Absent on the last page. */
  nextCursor?: string;
}

export interface FileLink {
  uri: string;
  name: string;
  mimeType?: string;
}

export type PromptPart = { kind: 'text'; text: string } | ({ kind: 'fileLink' } & FileLink);

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

/** What a tool call does, as ACP names it; `other` is a kind ACP added after this was written, or one an agent added. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type MessageContent = { kind: 'text'; text: string } | { kind: 'image'; data: string; mimeType: string; reference?: true };

/** A tool call's content, in the order the agent reported it. */
export type ToolCallContent =
  | { kind: 'text'; text: string }
  | Extract<MessageContent, { kind: 'image' }>
  | { kind: 'diff'; diff: FileDiff }
  /** Where an agent-owned terminal shows; its state comes in its own updates, before or after this. */
  | { kind: 'terminal'; terminalId: string };

/** How an agent-owned terminal's command ended; either may be unknown. */
export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/** What a tool call reports it changed, in the form its ACP version holds it: neither form can be made the other without reading the disk. */
export type FileDiff =
  /** A file's whole content before and after; `oldText` is null for a new file. */
  | { kind: 'wholeFile'; path: string; oldText: string | null; newText: string }
  /**
   * Which files changed and how, with patch text for some or all of them, or none. `other` is a patch format ACP added
   * after this was written, or one an agent added.
   */
  | { kind: 'changes'; changes: FileChange[]; patch: { format: 'git_patch' | 'other'; text: string } | null };

/** A change to one file; a custom or future operation has no place here, as ACP defines none of its fields, not even a path. */
export interface FileChange {
  operation: 'add' | 'delete' | 'modify' | 'move' | 'copy';
  path: string;
  /** Where a moved or copied file came from. */
  oldPath?: string;
  /** Null when the agent does not say; `other` is a file type ACP added after this was written, or one an agent added. */
  fileType: 'text' | 'binary' | 'directory' | 'symlink' | 'other' | null;
  mimeType: string | null;
}

export type PlanStepStatus = 'pending' | 'running' | 'completed';

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** The rest of the prompt is the command's input. */
  takesInput: boolean;
  /** Null when the agent gives none. */
  hint: string | null;
}

/** ACP content retained without importing ACP SDK types into the shared core contract. */
export type CompactionContent = null | boolean | number | string | CompactionContent[] | { [key: string]: CompactionContent };

/** An update field where omission retains the prior value and null or an empty array clears it. */
type CompactionSummaryPatch = { present: false } | { present: true; value: CompactionContent[] | null };

/** An update field where omission retains the prior value and null clears it. */
type CompactionErrorPatch = { present: false } | { present: true; value: string | null };

/** An ID-addressed compaction upsert; patch presence is preserved for the transcript reducer. */
interface CompactionUpdate {
  compactionId: string;
  status: string;
  summary: CompactionSummaryPatch;
  error: CompactionErrorPatch;
}

/** One content block appended to an ID-addressed compaction summary. */
interface CompactionSummaryChunk {
  compactionId: string;
  content: CompactionContent;
}

/** The agent's latest context and cumulative session-cost snapshot; successive reports replace it, not add to it. */
interface SessionUsage {
  /** Tokens currently in context. */
  used: number;
  /** The current effective context-window limit in tokens. */
  size: number;
  /** Null when the agent reports no cost. */
  cost: { amount: number; currency: string } | null;
}

/** The ACP schema a driver speaks, which names the driver, as each speaks one; its session updates are tagged with it. */
export type AcpSchema = 'v1' | 'v2';

export type ForegroundState = 'idle' | 'running' | 'requiresAction';

/**
 * Something new or changed in a session; what has no place here is dropped by the driver. Discriminated by `kind`,
 * not the webview messages' `type`, so an update cannot be posted to the webview as it is.
 */
export type SessionUpdate =
  | { kind: 'foreground'; state: ForegroundState }
  | { kind: 'agentText'; messageId: string | null; text: string }
  | { kind: 'agentImage'; messageId: string | null; data: string; mimeType: string; reference?: true }
  | { kind: 'thoughtImage'; messageId: string | null; data: string; mimeType: string; reference?: true }
  | { kind: 'promptImage'; messageId: string | null; data: string; mimeType: string; reference?: true }
  | { kind: 'thoughtText'; messageId: string | null; text: string }
  /** More of a prompt that a load replays. */
  | { kind: 'promptText'; messageId: string | null; text: string }
  /** The whole text of the agent message with this ID, replacing what it had. */
  | { kind: 'agentMessage'; messageId: string; text: string }
  | { kind: 'agentRichMessage'; messageId: string; content: MessageContent[] }
  | { kind: 'thoughtRichMessage'; messageId: string; content: MessageContent[] }
  | { kind: 'promptRichMessage'; messageId: string; content: MessageContent[] }
  /** As for an agent message. */
  | { kind: 'thoughtMessage'; messageId: string; text: string }
  /** The whole text of a prompt that a load replays, replacing what the prompt with this ID had. */
  | { kind: 'promptMessage'; messageId: string; text: string }
  /** A tool call, new or changed; what it leaves out stays as it was. */
  | { kind: 'toolCall'; toolCallId: string; title?: string; toolKind?: ToolKind; status?: ToolCallStatus; content?: ToolCallContent[] }
  /**
   * An agent-owned terminal, new or changed: a field left out stays as it was, and null clears it. `output` replaces
   * every byte the terminal had; an exit status, even of two nulls, means its command ended.
   */
  | {
    kind: 'terminal';
    terminalId: string;
    command?: string | null;
    cwd?: string | null;
    output?: Uint8Array | null;
    exitStatus?: TerminalExitStatus | null;
  }
  /** Bytes added to the end of an agent-owned terminal's output. */
  | { kind: 'terminalOutput'; terminalId: string; data: Uint8Array }
  /** Replaces the turn's earlier plan. */
  | { kind: 'plan'; steps: PlanStep[] }
  | { kind: 'commands'; commands: SlashCommand[] }
  /** The full set, replacing the session's config options. */
  | { kind: 'configOptions'; options: ConfigOption[] }
  /** The agent switched the session's mode itself. */
  | { kind: 'currentMode'; modeId: string }
  | ({ kind: 'usage' } & SessionUsage)
  | ({ kind: 'compactionUpdate' } & CompactionUpdate)
  | ({ kind: 'compactionSummaryChunk' } & CompactionSummaryChunk)
  /** A null title clears the session's title; a missing one leaves it unchanged. */
  | { kind: 'sessionInfo'; title?: string | null; updatedAt?: string | null };

/** `other` is a kind the agent added, which neither allows nor rejects as far as the extension knows. */
type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other';

export interface PermissionOption {
  id: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequest {
  sessionId: string;
  /** Null when the agent gave none. */
  title: string | null;
  /** Why the agent asks; null when it gave no reason. */
  description: string | null;
  /** What the request is about, in one line: the tool call's title, or a command and its directory; null when the agent named nothing the interface can show. */
  subject: string | null;
  options: PermissionOption[];
}

export type PermissionOutcome = { kind: 'selected'; optionId: string } | { kind: 'cancelled' } | { kind: 'requestCancelled' };

export type ElicitationValue = string | number | boolean | readonly string[];

interface ElicitationChoice {
  readonly value: string;
  readonly title: string;
  readonly description: string | null;
}

interface ElicitationOption {
  readonly const: string;
  readonly title: string;
  readonly description?: string | null;
}

interface ElicitationPropertyBase {
  readonly title?: string | null;
  readonly description?: string | null;
}

/** SDK-independent field definitions; unknown optional field types have no controls. */
export type ElicitationProperty = ElicitationPropertyBase & (
  | { readonly type: 'string'; readonly minLength?: number | null; readonly maxLength?: number | null;
    readonly pattern?: string | null; readonly format?: string | null; readonly enum?: readonly string[] | null;
    readonly oneOf?: readonly ElicitationOption[] | null; readonly default?: string | null }
  | { readonly type: 'number' | 'integer'; readonly minimum?: number | null; readonly maximum?: number | null; readonly default?: number | null }
  | { readonly type: 'boolean'; readonly default?: boolean | null }
  | { readonly type: 'array'; readonly minItems?: number | null; readonly maxItems?: number | null;
    readonly items: { readonly type: 'string'; readonly enum: readonly string[] } | { readonly anyOf: readonly ElicitationOption[] } | { readonly type: 'other' };
    readonly default?: readonly string[] | null }
  | { readonly type: 'other' }
);

export interface ElicitationSchema {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly properties?: Readonly<Record<string, ElicitationProperty>>;
  readonly required?: readonly string[] | null;
}

interface ElicitationField {
  readonly name: string;
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  readonly title: string | null;
  readonly description: string | null;
  readonly required: boolean;
  readonly choices: readonly ElicitationChoice[] | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minItems: number | null;
  readonly maxItems: number | null;
  readonly pattern: string | null;
  readonly format: string | null;
  readonly default?: ElicitationValue;
}

/** Renderable fields with validated defaults; answers still require validation. */
export interface ElicitationForm {
  readonly title: string | null;
  readonly description: string | null;
  readonly fields: readonly ElicitationField[];
}

export interface ElicitationScope {
  readonly sessionId?: string;
  readonly toolCallId?: string | null;
  readonly requestId?: string | number;
}

interface ElicitationRequestBase {
  /** The incoming create request's JSON-RPC ID, not its parent request or URL ID. */
  readonly rpcId: string | number | null;
  readonly scope: ElicitationScope;
  readonly message: string;
}

export type ElicitationRequest = ElicitationRequestBase & (
  | { readonly mode: 'form'; readonly requestedSchema: ElicitationSchema }
  | { readonly mode: 'url'; readonly elicitationId: string; readonly url: string }
);

export type ElicitationInteraction = ElicitationRequestBase & {
  readonly interactionId: string;
  readonly status: 'pending' | 'awaitingCompletion';
  readonly completed: boolean;
} & (
  | { readonly mode: 'form'; readonly form: ElicitationForm }
  | { readonly mode: 'url'; readonly elicitationId: string; readonly url: string }
);

export interface ElicitationResponse {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: Readonly<Record<string, ElicitationValue>>;
}

export interface ElicitationChange {
  readonly kind: 'created' | 'responded' | 'withdrawn' | 'closed' | 'completed';
  readonly interaction: ElicitationInteraction;
  readonly response?: ElicitationResponse;
}

export type ElicitationResponseResult = { kind: 'settled' | 'stale' } | { kind: 'invalid'; errors: Readonly<Record<string, string>> };

/** Request withdrawal and connection loss are not user responses. */
export class ElicitationError extends Error {
  constructor(readonly kind: 'invalid' | 'cancelled' | 'closed', message: string) { super(message); }
}

/** The agent refuses the request until the user authenticates. */
export class AuthRequired extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthRequired';
  }
}

/** The agent does not know the session it was asked to load or resume. */
export class UnknownSession extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnknownSession';
  }
}

export interface AcpDriver {
  readonly agent: AgentDescription;
  /** The connection can close before the agent's exit is reported. */
  readonly closed: boolean;
  newSession(roots: SessionRoots): Promise<NewSession>;
  listSessions(query: { cwd?: string | undefined; cursor?: string | undefined }): Promise<SessionPage>;
  /** The agent replays the session's transcript as session updates before this resolves. */
  loadSession(sessionId: string, roots: SessionRoots): Promise<SessionState>;
  resumeSession(sessionId: string, roots: SessionRoots): Promise<SessionState>;
  /** Resolves when the turn ends. */
  prompt(sessionId: string, prompt: PromptPart[]): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  /** The session's full set of config options after the change, or null when the agent returned none. */
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<ConfigOption[] | null>;
  authenticate(methodId: string): Promise<void>;
}
