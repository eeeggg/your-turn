import * as Acp from '@agentclientprotocol/sdk/experimental/v2';

import type { ClientHandlers } from '@/core/ClientHandlers';
import { logDebug, logInfo, logTrace } from '@/core/Log';
import type { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { logDeviation } from '@/core/StandardDeviations';
import {
  AuthRequired,
  type AcpDriver,
  type AgentDescription,
  type AuthMethod,
  type ConfigCategory,
  type ConfigOption,
  type ConfigValue,
  type ConfigValueGroup,
  type FileChange,
  type FileDiff,
  type ListedSession,
  type NewSession,
  type PermissionOption,
  type PermissionOutcome,
  type PermissionRequest,
  type PlanStepStatus,
  type PromptPart,
  type SessionPage,
  type SessionRoots,
  type SessionState,
  type SessionUpdate,
  type SlashCommand,
  type TerminalExitStatus,
  type ToolCallContent,
  type ToolCallStatus,
  type ToolKind,
} from './AcpDriver';
import { authChecked, isAuthRequired, sessionChecked } from './RequestErrors';

/** The `initialize` request the v2 client sends, which the negotiation sends to the agent for it. */
export function v2InitializeRequest(clientVersion: string): Acp.InitializeRequest {
  return {
    protocolVersion: Acp.PROTOCOL_VERSION,
    info: { name: 'vscode-acp-client', version: clientVersion },
    // Without auth.terminal, agents advertise only the auth methods they handle themselves.
    capabilities: {},
  };
}

/** Speaks ACP v2 over a connection, through the SDK's stable v2 client. */
export class V2Driver implements AcpDriver {
  /** Connect the SDK's v2 client to the stream and initialize the connection. */
  static async connect(
    agentName: string,
    stream: Acp.Stream,
    clientVersion: string,
    updates: SessionUpdateHandler,
    handlers: ClientHandlers,
  ): Promise<V2Driver> {
    const { permissions } = handlers;
    const foreground = new Foreground();
    const translator = new Translator();
    // The connection must stay open for the agent's lifetime, so use connect()
    // rather than connectWith(), which closes when its callback returns.
    const app = Acp.client({ name: 'vscode-acp-client' })
      .onRequest(Acp.methods.client.session.requestPermission, async ({ params, signal }) =>
        permissionResponse(await permissions.requestPermission(permissionRequest(params), signal)))
      .onNotification(Acp.methods.client.session.update, ({ params }) => {
        logTrace('Received session update', { type: params.update.sessionUpdate, sessionId: params.sessionId });
        if (Acp.SessionUpdate.isStateUpdate(params.update)) {
          foreground.report(params.sessionId, params.update);
          return;
        }
        const update = translator.translate(params.sessionId, params.update);
        if (update) {
          updates.handleUpdate(params.sessionId, update, 'v2');
        }
      });
    const connection = app.connect(stream);
    connection.signal.addEventListener('abort', () => foreground.close(), { once: true });

    logDebug('Initializing ACP v2 connection', { agentName });
    const initResponse = await connection.agent.request(Acp.methods.agent.initialize, v2InitializeRequest(clientVersion));
    logInfo('Initialized ACP v2 agent', { agentName: initResponse.info.name, version: initResponse.info.version });

    return new V2Driver(connection, permissions, agentDescription(initResponse), foreground, translator);
  }

  private constructor(
    private readonly connection: Acp.ClientConnection,
    private readonly permissions: ClientHandlers['permissions'],
    readonly agent: AgentDescription,
    private readonly foreground: Foreground,
    private readonly translator: Translator,
  ) {}

  get closed(): boolean {
    return this.connection.signal.aborted;
  }

  /** The directories beyond `cwd` that a session setup request carries. */
  private additionalDirectories({ additionalDirectories }: SessionRoots): { additionalDirectories?: string[] } {
    if (additionalDirectories.length === 0) { return {}; }
    if (!this.agent.capabilities.additionalDirectories) {
      logInfo('Agent does not support additional directories; sending only the cwd', { additionalDirectories });
      return {};
    }
    return { additionalDirectories: [...additionalDirectories] };
  }

  async newSession(roots: SessionRoots): Promise<NewSession> {
    const request: Acp.NewSessionRequest = { cwd: roots.cwd, ...this.additionalDirectories(roots) };
    const response = await authChecked(this.connection.agent.request(Acp.methods.agent.session.new, request));
    return { sessionId: response.sessionId, ...sessionState(response) };
  }

  async listSessions(query: { cwd?: string | undefined; cursor?: string | undefined }): Promise<SessionPage> {
    const response = await authChecked(this.connection.agent.request(Acp.methods.agent.session.list, {
      ...(query.cwd ? { cwd: query.cwd } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    }));
    return {
      sessions: response.sessions.map(listedSession),
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  /** ACP v2 has no `session/load`; a resume replaying from the start is one. */
  async loadSession(sessionId: string, roots: SessionRoots): Promise<SessionState> {
    return this.resume(sessionId, roots, { type: 'start' });
  }

  async resumeSession(sessionId: string, roots: SessionRoots): Promise<SessionState> {
    return this.resume(sessionId, roots, null);
  }

  private async resume(sessionId: string, roots: SessionRoots, replayFrom: Acp.ReplayFrom | null): Promise<SessionState> {
    const response = await sessionChecked(sessionId, this.connection.agent.request(Acp.methods.agent.session.resume, {
      sessionId,
      cwd: roots.cwd,
      ...this.additionalDirectories(roots),
      ...(replayFrom ? { replayFrom } : {}),
    }));
    return sessionState(response);
  }

  /** The agent answers once it has taken the prompt in, and reports the end of the turn it starts as the session going idle. */
  async prompt(sessionId: string, prompt: PromptPart[]): Promise<void> {
    const turn = this.foreground.begin(sessionId);
    this.translator.prompting.add(sessionId);
    try {
      const response = await authChecked(this.connection.agent.request(Acp.methods.agent.session.prompt, {
        sessionId,
        prompt: prompt.map(contentBlock),
      }));
      logDebug('Prompt accepted', { messageId: response.messageId });
      const idle = await turn.end();
      if (Acp.IdleStateUpdate.isError(idle)) {
        throw turnFailure(idle.error);
      }
      logInfo('Prompt turn ended', { stopReason: idle.stopReason ?? 'none' });
    } finally {
      this.translator.prompting.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(Acp.methods.agent.session.cancel, { sessionId });
    this.permissions.cancelSession(sessionId);
  }

  /** A v2 session reports no modes, so none is ever chosen. */
  async setMode(): Promise<void> {
    throw new Error('ACP v2 sessions have no modes');
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    const request: Acp.SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean', value }
      : { sessionId, configId, type: 'id', value };
    const response = await authChecked(this.connection.agent.request(Acp.methods.agent.session.setConfigOption, request));
    return configOptions(response.configOptions);
  }

  async authenticate(methodId: string): Promise<void> {
    await authChecked(this.connection.agent.request(Acp.methods.agent.auth.login, { methodId }));
  }
}

/**
 * Each session's foreground work as the agent reports it, and the turn a prompt waits on. A turn ends when the session
 * goes from working to idle after the agent accepted the prompt; as the agent may report the turn before it answers the
 * prompt, an end reported while the prompt was pending counts if the session is still idle once it is accepted. A
 * repeated idle report ends nothing.
 */
class Foreground {
  private readonly working = new Set<string>();
  /** The latest per session: the extension holds a prompt sent mid-turn until the turn ends. */
  private readonly turns = new Map<string, Turn>();

  report(sessionId: string, update: Acp.StateUpdate): void {
    if (Acp.StateUpdate.isIdle(update)) {
      if (this.working.delete(sessionId)) {
        this.turns.get(sessionId)?.ended(update);
      }
    } else if (Acp.StateUpdate.isRunning(update) || Acp.StateUpdate.isRequiresAction(update)) {
      this.working.add(sessionId);
    }
  }

  begin(sessionId: string): Turn {
    const turn = new Turn(() => this.working.has(sessionId));
    this.turns.set(sessionId, turn);
    return turn;
  }

  close(): void {
    for (const turn of this.turns.values()) {
      turn.close();
    }
  }
}

class Turn {
  private accepted = false;
  private endedEarly: Acp.IdleStateUpdate | null = null;
  private settle: (idle: Acp.IdleStateUpdate) => void = () => {};
  private fail: (e: Error) => void = () => {};
  private readonly done = new Promise<Acp.IdleStateUpdate>((resolve, reject) => {
    this.settle = resolve;
    this.fail = reject;
  });

  constructor(private readonly working: () => boolean) {
    // A turn whose prompt the agent refuses is never waited on, whatever then becomes of the connection.
    this.done.catch(() => {});
  }

  ended(idle: Acp.IdleStateUpdate): void {
    if (this.accepted) {
      this.settle(idle);
    } else {
      this.endedEarly = idle;
    }
  }

  /** Once the agent accepted the prompt: the idle report that ends the turn. */
  end(): Promise<Acp.IdleStateUpdate> {
    this.accepted = true;
    if (this.endedEarly && !this.working()) {
      this.settle(this.endedEarly);
    }
    return this.done;
  }

  close(): void {
    this.fail(new Error('The connection to the agent closed before the turn ended'));
  }
}

/** The failure an idle report carries; -32000 asks the user to authenticate, as it does in a rejected request. */
function turnFailure(error: Acp.Error | null | undefined): Error {
  const message = error?.message || 'The agent stopped with an error';
  return isAuthRequired(error) ? new AuthRequired(message) : new Error(message);
}

/**
 * Translates v2's session updates, keeping what v2 leaves to the client: each tool call's content, which chunks append
 * to and an upsert's content replaces, and the sessions running a prompt's turn, during which the agent reports the
 * prompt back as a user message the chat view already shows.
 */
class Translator {
  readonly prompting = new Set<string>();
  private readonly toolCallContents = new Map<string, Map<string, ToolCallContent[]>>();

  /** The session update for v2's, or null when the interface has no place for it. */
  translate(sessionId: string, update: Acp.SessionUpdate): SessionUpdate | null {
    const updates = Acp.SessionUpdate;
    if (updates.isAgentMessageChunk(update)) {
      const text = textForUser(update.content);
      return text ? { kind: 'agentText', messageId: update.messageId, text } : null;
    }
    if (updates.isAgentThoughtChunk(update)) {
      const text = textForUser(update.content);
      return text === null ? null : { kind: 'thoughtText', messageId: update.messageId, text };
    }
    if (updates.isUserMessageChunk(update)) {
      const text = this.prompting.has(sessionId) ? null : textForUser(update.content);
      return text === null ? null : { kind: 'promptText', messageId: update.messageId, text };
    }
    if (updates.isAgentMessage(update)) {
      return update.content === undefined ? null : { kind: 'agentMessage', messageId: update.messageId, text: messageText(update.content) };
    }
    if (updates.isAgentThought(update)) {
      return update.content === undefined ? null : { kind: 'thoughtMessage', messageId: update.messageId, text: messageText(update.content) };
    }
    if (updates.isUserMessage(update)) {
      return update.content === undefined || this.prompting.has(sessionId)
        ? null
        : { kind: 'promptMessage', messageId: update.messageId, text: messageText(update.content) };
    }
    if (updates.isToolCallUpdate(update)) {
      const status = update.status ? toolCallStatus(update.status) : null;
      const content = update.content === undefined ? null : toolCallContent(update.content ?? [], update.toolCallId);
      if (content) {
        this.contentsIn(sessionId).set(update.toolCallId, content);
      }
      return {
        kind: 'toolCall',
        toolCallId: update.toolCallId,
        ...(update.title ? { title: update.title } : {}),
        ...(update.kind !== undefined ? { toolKind: toolKind(update.kind) } : {}),
        ...(status ? { status } : {}),
        ...(content ? { content } : {}),
      };
    }
    if (updates.isToolCallContentChunk(update)) {
      const added = toolCallContent([update.content], update.toolCallId);
      if (added.length === 0) {
        return null;
      }
      const calls = this.contentsIn(sessionId);
      const content = [...calls.get(update.toolCallId) ?? [], ...added];
      calls.set(update.toolCallId, content);
      return { kind: 'toolCall', toolCallId: update.toolCallId, content };
    }
    if (updates.isTerminalUpdate(update)) {
      return {
        kind: 'terminal',
        terminalId: update.terminalId,
        ...(update.command !== undefined ? { command: update.command } : {}),
        ...(update.cwd !== undefined ? { cwd: update.cwd } : {}),
        ...(update.output !== undefined ? { output: update.output === null ? null : bytes(update.output.data) } : {}),
        ...(update.exitStatus !== undefined ? { exitStatus: update.exitStatus === null ? null : exitStatus(update.exitStatus) } : {}),
      };
    }
    if (updates.isTerminalOutputChunk(update)) {
      return { kind: 'terminalOutput', terminalId: update.terminalId, data: bytes(update.data) };
    }
    if (updates.isPlanUpdate(update)) {
      return Acp.PlanUpdateContent.isItems(update.plan)
        ? { kind: 'plan', steps: update.plan.entries.map((entry) => ({ text: entry.content, status: planStepStatus(entry.status) })) }
        : null;
    }
    if (updates.isAvailableCommandsUpdate(update)) {
      return { kind: 'commands', commands: update.availableCommands.map(slashCommand) };
    }
    if (updates.isConfigOptionUpdate(update)) {
      return { kind: 'configOptions', options: configOptions(update.configOptions) };
    }
    if (updates.isSessionInfoUpdate(update)) {
      return {
        kind: 'sessionInfo',
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
      };
    }
    return null;
  }

  private contentsIn(sessionId: string): Map<string, ToolCallContent[]> {
    let calls = this.toolCallContents.get(sessionId);
    if (!calls) {
      calls = new Map();
      this.toolCallContents.set(sessionId, calls);
    }
    return calls;
  }
}

/** A block's text, unless its `audience` leaves out the user, as an agent marks what it adds for the model alone. */
function textForUser(block: Acp.ContentBlock): string | null {
  if (!Acp.ContentBlock.isText(block)) {
    return null;
  }
  const audience = block.annotations?.audience;
  return audience && !audience.includes('user') ? null : block.text;
}

/** A whole message's text; null content clears it. */
function messageText(content: Acp.ContentBlock[] | null): string {
  return (content ?? []).flatMap((block) => textForUser(block) ?? []).join('');
}

/**
 * A tool call's non-empty text blocks, its diffs and its terminals, but not a diff with no change the interface can
 * hold, which says nothing about any file.
 */
function toolCallContent(content: readonly Acp.ToolCallContent[], toolCallId: string): ToolCallContent[] {
  return content.flatMap((item): ToolCallContent[] => {
    if (Acp.ToolCallContent.isContent(item)) {
      return Acp.ContentBlock.isText(item.content) && item.content.text ? [{ kind: 'text', text: item.content.text }] : [];
    }
    if (Acp.ToolCallContent.isTerminal(item)) {
      return [{ kind: 'terminal', terminalId: item.terminalId }];
    }
    if (Acp.ToolCallContent.isDiff(item)) {
      const changes = item.changes.flatMap(fileChange);
      return changes.length > 0 ? [{ kind: 'diff', diff: { kind: 'changes', changes, patch: diffPatch(item.patch, toolCallId) } }] : [];
    }
    return [];
  });
}

function diffPatch(patch: Acp.DiffPatch | null | undefined, toolCallId: string): Extract<FileDiff, { kind: 'changes' }>['patch'] {
  if (!patch) {
    return null;
  }
  if (patch.format !== 'git_patch') {
    return { format: 'other', text: patch.text };
  }
  const repaired = withoutGitPrefixes(patch.text);
  if (repaired !== null) {
    logDeviation('ACP-DEV-001', `tool call ${toolCallId}'s patch`);
  }
  return { format: 'git_patch', text: repaired ?? patch.text };
}

/**
 * ACP-DEV-001: the patch with Git's `a/` and `b/` prefixes taken off its file names, or null when it has none. Names
 * are only outside hunks, so each hunk's lines are counted past, as a hunk's line can read like a name.
 */
function withoutGitPrefixes(text: string): string | null {
  let oldLeft = 0;
  let newLeft = 0;
  const lines = text.split('\n').map((line) => {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-')) {
        oldLeft--;
      } else if (line.startsWith('+')) {
        newLeft--;
      } else if (!line.startsWith('\\')) {
        oldLeft--;
        newLeft--;
      }
      return line;
    }
    const counts = hunkLineCounts(line);
    if (counts) {
      [oldLeft, newLeft] = counts;
      return line;
    }
    return nameLineWithoutGitPrefixes(line);
  });
  const repaired = lines.join('\n');
  return repaired === text ? null : repaired;
}

/** How many old and new lines a hunk header such as `@@ -29,3 +34,3 @@` says follow; a count left out is 1. */
function hunkLineCounts(line: string): [number, number] | null {
  if (!line.startsWith('@@ -')) {
    return null;
  }
  const [oldRange = '', newRange = ''] = line.split(' ').slice(1, 3);
  const count = (range: string) => Number(range.split(',')[1] ?? 1);
  return [count(oldRange), count(newRange)];
}

/** Whether the name starts with the prefix, quoted as Git quotes it or not. */
function hasPrefix(name: string, prefix: 'a/' | 'b/'): boolean {
  return name.startsWith(prefix) || name.startsWith(`"${prefix}`);
}

/** The name without the prefix, quoted as Git quotes it or not: `a/home/x` is `/home/x`. */
function withoutPrefix(name: string, prefix: 'a/' | 'b/'): string {
  if (name.startsWith(prefix)) {
    return `/${name.slice(prefix.length)}`;
  }
  if (name.startsWith(`"${prefix}`)) {
    return `"/${name.slice(prefix.length + 1)}`;
  }
  return name;
}

function nameLineWithoutGitPrefixes(line: string): string {
  if (line.startsWith('--- ')) {
    return `--- ${withoutPrefix(line.slice(4), 'a/')}`;
  }
  if (line.startsWith('+++ ')) {
    return `+++ ${withoutPrefix(line.slice(4), 'b/')}`;
  }
  const gitLine = 'diff --git ';
  if (!line.startsWith(gitLine)) {
    return line;
  }
  const names = line.slice(gitLine.length);
  if (!hasPrefix(names, 'a/')) {
    return line;
  }
  // A name may hold " b/" itself, so the split is taken only where it is the one possible, or leaves two equal names.
  const splits = spacesBeforeNewName(names).map((at) => ({
    old: withoutPrefix(names.slice(0, at), 'a/'),
    next: withoutPrefix(names.slice(at + 1), 'b/'),
  }));
  const split = splits.length === 1 ? splits[0] : splits.find(({ old, next }) => old === next);
  return split ? `${gitLine}${split.old} ${split.next}` : line;
}

/** Where a space could end the old name in `diff --git a/old b/new`: each space followed by `b/` or `"b/`. */
function spacesBeforeNewName(names: string): number[] {
  const spaces: number[] = [];
  for (let at = names.indexOf(' '); at !== -1; at = names.indexOf(' ', at + 1)) {
    if (hasPrefix(names.slice(at + 1), 'b/')) {
      spaces.push(at);
    }
  }
  return spaces;
}

/** None for a custom or future operation, as ACP defines none of its fields, not even a path. */
function fileChange(change: Acp.DiffChange): FileChange[] {
  const described = { fileType: fileType(change.fileType), mimeType: change.mimeType ?? null };
  if (Acp.DiffChange.isAdd(change) || Acp.DiffChange.isDelete(change) || Acp.DiffChange.isModify(change)) {
    return [{ operation: change.operation, path: change.path, ...described }];
  }
  if (Acp.DiffChange.isMove(change) || Acp.DiffChange.isCopy(change)) {
    return [{ operation: change.operation, path: change.path, oldPath: change.oldPath, ...described }];
  }
  return [];
}

function fileType(type: Acp.DiffFileType | null | undefined): FileChange['fileType'] {
  switch (type) {
    case 'text':
    case 'binary':
    case 'directory':
    case 'symlink':
      return type;
    case null:
    case undefined:
      return null;
    default:
      return 'other';
  }
}

/** Terminal bytes, which ACP sends in base64, as a plain Uint8Array: a Buffer's slice shares its bytes rather than copying them. */
function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function exitStatus(status: Acp.TerminalExitStatus): TerminalExitStatus {
  return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
}

/** A custom or future kind is `other`, as is a kind cleared with null, which leaves ACP's default. */
function toolKind(kind: Acp.ToolKind | null): ToolKind {
  switch (kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'think':
    case 'fetch':
    case 'switch_mode':
      return kind;
    default:
      return 'other';
  }
}

/** A cancelled call shows as failed, as v1 agents report one; an unknown status leaves the call's as it was. */
function toolCallStatus(status: Acp.ToolCallStatus): ToolCallStatus | null {
  switch (status) {
    case 'pending':
    case 'completed':
    case 'failed':
      return status;
    case 'in_progress':
      return 'running';
    case 'cancelled':
      return 'failed';
    default:
      return null;
  }
}

/** A cancelled or unknown step shows as not done. */
function planStepStatus(status: Acp.PlanEntryStatus): PlanStepStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'running';
    default:
      return 'pending';
  }
}

function slashCommand(command: Acp.AvailableCommand): SlashCommand {
  const input = command.input;
  const hint = input && typeof input === 'object' && 'type' in input && input.type === 'text'
    && 'hint' in input && typeof input.hint === 'string' ? input.hint : null;
  return { name: command.name, description: command.description, takesInput: !!command.input, hint: hint || null };
}

function permissionRequest(params: Acp.RequestPermissionRequest): PermissionRequest {
  return {
    sessionId: params.sessionId,
    title: params.title || null,
    description: params.description || null,
    subject: params.subject ? permissionSubject(params.subject) : null,
    options: params.options.map(permissionOption),
  };
}

/** A tool call's subject is a patch of the call, so it may leave out the title the transcript shows. */
function permissionSubject(subject: Acp.RequestPermissionSubject): string | null {
  if (Acp.RequestPermissionSubject.isToolCall(subject)) {
    return subject.toolCall.title || null;
  }
  if (Acp.RequestPermissionSubject.isCommand(subject)) {
    return `${subject.command} in ${subject.cwd}`;
  }
  return null;
}

function permissionOption(option: Acp.PermissionOption): PermissionOption {
  switch (option.kind) {
    case 'allow_once':
    case 'allow_always':
    case 'reject_once':
    case 'reject_always':
      return { id: option.optionId, name: option.name, kind: option.kind };
    default:
      return { id: option.optionId, name: option.name, kind: 'other' };
  }
}

function permissionResponse(outcome: PermissionOutcome): Acp.RequestPermissionResponse {
  if (outcome.kind === 'requestCancelled') {
    throw Acp.RequestError.requestCancelled();
  }
  return outcome.kind === 'selected'
    ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function agentDescription(response: Acp.InitializeResponse): AgentDescription {
  // Session capabilities, even {}, promise the baseline session methods, `session/list` and `session/resume` among them.
  const sessions = !!response.capabilities?.session;
  return {
    displayName: response.info.title || response.info.name || null,
    capabilities: { list: sessions, load: sessions, resume: sessions, additionalDirectories: !!response.capabilities?.session?.additionalDirectories },
    authMethods: (response.authMethods ?? []).flatMap(authMethod),
  };
}

/** Only a method the agent handles itself goes through `auth/login`. */
function authMethod(method: Acp.AuthMethod): AuthMethod[] {
  return Acp.AuthMethod.isAgent(method) ? [{ id: method.methodId, name: method.name, description: method.description ?? null }] : [];
}

function sessionState(response: { configOptions?: Acp.SessionConfigOption[]; availableCommands?: Acp.AvailableCommand[] }): SessionState {
  return {
    modes: null,
    configOptions: response.configOptions ? configOptions(response.configOptions) : null,
    commands: response.availableCommands ? response.availableCommands.map(slashCommand) : null,
  };
}

/** An option of a type the interface has no place for is dropped. */
function configOptions(options: Acp.SessionConfigOption[]): ConfigOption[] {
  return options.flatMap((option): ConfigOption[] => {
    const base = { id: option.configId, name: option.name, description: option.description ?? null, category: configCategory(option.category) };
    if (Acp.SessionConfigOption.isSelect(option)) {
      return [{ ...base, kind: 'select', current: option.currentValue, groups: valueGroups(option.options) }];
    }
    if (Acp.SessionConfigOption.isBoolean(option)) {
      return [{ ...base, kind: 'boolean', current: option.currentValue }];
    }
    return [];
  });
}

function configCategory(category: string | null | undefined): ConfigCategory {
  switch (category) {
    case 'mode':
    case 'model':
    case 'thought_level':
      return category;
    default:
      return 'other';
  }
}

/** Values the agent left ungrouped form one group without a header. */
function valueGroups(options: Acp.SessionConfigSelectOptions): ConfigValueGroup[] {
  const ungrouped: ConfigValue[] = [];
  const grouped: ConfigValueGroup[] = [];
  for (const entry of options) {
    if ('groupId' in entry) {
      grouped.push({ header: entry.name || entry.groupId, values: entry.options.map(configValue) });
    } else {
      ungrouped.push(configValue(entry));
    }
  }
  return ungrouped.length > 0 ? [{ header: null, values: ungrouped }, ...grouped] : grouped;
}

function configValue(value: Acp.SessionConfigSelectOption): ConfigValue {
  return { id: value.value, name: value.name, description: value.description ?? null };
}

function listedSession(session: Acp.SessionInfo): ListedSession {
  return { sessionId: session.sessionId, cwd: session.cwd, title: session.title ?? null, updatedAt: session.updatedAt ?? null };
}

function contentBlock(part: PromptPart): Acp.ContentBlock {
  switch (part.kind) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'fileLink':
      return { type: 'resource_link', uri: part.uri, name: part.name, ...(part.mimeType ? { mimeType: part.mimeType } : {}) };
  }
}
