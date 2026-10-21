import * as Acp from '@agentclientprotocol/sdk/experimental/v2';

import type { ClientHandlers } from '@/core/ClientHandlers';
import { log } from '@/core/Log';
import type { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import {
  AuthRequired,
  type AcpDriver,
  type AgentDescription,
  type AuthMethod,
  type ConfigCategory,
  type ConfigOption,
  type ConfigValue,
  type ConfigValueGroup,
  type ListedSession,
  type NewSession,
  type PermissionOption,
  type PermissionOutcome,
  type PermissionRequest,
  type PlanStepStatus,
  type PromptPart,
  type SessionPage,
  type SessionState,
  type SessionUpdate,
  type SlashCommand,
  type ToolCallStatus,
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
    { permissions }: ClientHandlers,
  ): Promise<V2Driver> {
    const foreground = new Foreground();
    const translator = new Translator();
    // The connection must stay open for the agent's lifetime, so use connect()
    // rather than connectWith(), which closes when its callback returns.
    const app = Acp.client({ name: 'vscode-acp-client' })
      .onRequest(Acp.methods.client.session.requestPermission, async ({ params }) =>
        permissionResponse(await permissions.requestPermission(permissionRequest(params))))
      .onNotification(Acp.methods.client.session.update, ({ params }) => {
        log(`sessionUpdate: type=${params.update.sessionUpdate}, sessionId=${params.sessionId}`);
        if (Acp.SessionUpdate.isStateUpdate(params.update)) {
          foreground.report(params.sessionId, params.update);
          return;
        }
        const update = translator.translate(params.sessionId, params.update);
        if (update) {
          updates.handleUpdate(params.sessionId, update);
        }
      });
    const connection = app.connect(stream);
    connection.signal.addEventListener('abort', () => foreground.close(), { once: true });

    log(`V2Driver: initializing connection to agent ${agentName}`);
    const initResponse = await connection.agent.request(Acp.methods.agent.initialize, v2InitializeRequest(clientVersion));
    log(`V2Driver: initialized. Agent: ${initResponse.info.name} v${initResponse.info.version}`);

    return new V2Driver(connection, agentDescription(initResponse), foreground, translator);
  }

  private constructor(
    private readonly connection: Acp.ClientConnection,
    readonly agent: AgentDescription,
    private readonly foreground: Foreground,
    private readonly translator: Translator,
  ) {}

  get closed(): boolean {
    return this.connection.signal.aborted;
  }

  async newSession(cwd: string): Promise<NewSession> {
    const response = await authChecked(this.connection.agent.request(Acp.methods.agent.session.new, { cwd }));
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
  async loadSession(sessionId: string, cwd: string): Promise<SessionState> {
    return this.resume(sessionId, cwd, { type: 'start' });
  }

  async resumeSession(sessionId: string, cwd: string): Promise<SessionState> {
    return this.resume(sessionId, cwd, null);
  }

  private async resume(sessionId: string, cwd: string, replayFrom: Acp.ReplayFrom | null): Promise<SessionState> {
    const response = await sessionChecked(this.connection.agent.request(Acp.methods.agent.session.resume, {
      sessionId,
      cwd,
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
      log(`Prompt accepted: messageId=${response.messageId}`);
      const idle = await turn.end();
      if (Acp.IdleStateUpdate.isError(idle)) {
        throw turnFailure(idle.error);
      }
      log(`Turn ended: stopReason=${idle.stopReason ?? 'none'}`);
    } finally {
      this.translator.prompting.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(Acp.methods.agent.session.cancel, { sessionId });
  }

  /** A v2 session reports no modes, so none is ever chosen. */
  async setMode(): Promise<void> {
    throw new Error('ACP v2 sessions have no modes');
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[] | null> {
    const response = await authChecked(this.connection.agent.request(Acp.methods.agent.session.setConfigOption, { sessionId, configId, type: 'id', value }));
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
 * Translates v2's session updates, keeping what v2 leaves to the client: each tool call's texts, which chunks append
 * to and an upsert's content replaces, and the sessions running a prompt's turn, during which the agent reports the
 * prompt back as a user message the chat view already shows.
 */
class Translator {
  readonly prompting = new Set<string>();
  private readonly toolCallTexts = new Map<string, Map<string, string[]>>();

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
      const texts = update.content === undefined ? null : contentTexts(update.content ?? []);
      if (texts) {
        this.textsIn(sessionId).set(update.toolCallId, texts);
      }
      return {
        kind: 'toolCall',
        toolCallId: update.toolCallId,
        ...(update.title ? { title: update.title } : {}),
        ...(status ? { status } : {}),
        ...(texts ? { texts } : {}),
      };
    }
    if (updates.isToolCallContentChunk(update)) {
      const added = contentTexts([update.content]);
      if (added.length === 0) {
        return null;
      }
      const calls = this.textsIn(sessionId);
      const texts = [...calls.get(update.toolCallId) ?? [], ...added];
      calls.set(update.toolCallId, texts);
      return { kind: 'toolCall', toolCallId: update.toolCallId, texts };
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

  private textsIn(sessionId: string): Map<string, string[]> {
    let calls = this.toolCallTexts.get(sessionId);
    if (!calls) {
      calls = new Map();
      this.toolCallTexts.set(sessionId, calls);
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

/** The non-empty text blocks of a tool call's content; diffs and terminals have no place in the interface. */
function contentTexts(content: readonly Acp.ToolCallContent[]): string[] {
  return content.flatMap((item) => (Acp.ToolCallContent.isContent(item) && Acp.ContentBlock.isText(item.content) && item.content.text ? [item.content.text] : []));
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
  const hint = command.input && Acp.AvailableCommandInput.isText(command.input) ? command.input.hint : null;
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
  return outcome.kind === 'selected'
    ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function agentDescription(response: Acp.InitializeResponse): AgentDescription {
  // Session capabilities, even {}, promise the baseline session methods, `session/list` and `session/resume` among them.
  const sessions = !!response.capabilities?.session;
  return {
    displayName: response.info.title || response.info.name || null,
    capabilities: { list: sessions, load: sessions, resume: sessions },
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
