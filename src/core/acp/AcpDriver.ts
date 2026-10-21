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

/**
 * Something new or changed in a session; what has no place here is dropped by the driver. Discriminated by `kind`,
 * not the webview messages' `type`, so an update cannot be posted to the webview as it is.
 */
export type SessionUpdate =
  | { kind: 'agentText'; messageId: string | null; text: string }
  | { kind: 'thoughtText'; messageId: string | null; text: string }
  /** More of a prompt that a load replays. */
  | { kind: 'promptText'; text: string }
  /** A tool call, new or changed; what it leaves out stays as it was. */
  | { kind: 'toolCall'; toolCallId: string; title?: string; status?: ToolCallStatus; texts?: string[] }
  /** Replaces the turn's earlier plan. */
  | { kind: 'plan'; steps: PlanStep[] }
  | { kind: 'commands'; commands: SlashCommand[] }
  /** The full set, replacing the session's config options. */
  | { kind: 'configOptions'; options: ConfigOption[] }
  /** The agent switched the session's mode itself. */
  | { kind: 'currentMode'; modeId: string }
  /** A null title clears the session's title; a missing one leaves it unchanged. */
  | { kind: 'sessionInfo'; title?: string | null; updatedAt?: string | null };

type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  id: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequest {
  sessionId: string;
  /** Null when the agent gave none. */
  title: string | null;
  options: PermissionOption[];
}

export type PermissionOutcome = { kind: 'selected'; optionId: string } | { kind: 'cancelled' };

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
  newSession(cwd: string): Promise<NewSession>;
  listSessions(query: { cwd?: string | undefined; cursor?: string | undefined }): Promise<SessionPage>;
  /** The agent replays the session's transcript as session updates before this resolves. */
  loadSession(sessionId: string, cwd: string): Promise<SessionState>;
  resumeSession(sessionId: string, cwd: string): Promise<SessionState>;
  /** Resolves when the turn ends. */
  prompt(sessionId: string, prompt: PromptPart[]): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  /** The session's full set of config options after the change, or null when the agent returned none. */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[] | null>;
  authenticate(methodId: string): Promise<void>;
}
