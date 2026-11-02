import { client as createClientApp, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type * as Acp from '@agentclientprotocol/sdk';

import type { ClientHandlers } from '@/core/ClientHandlers';
import { logDebug, logInfo, logTrace } from '@/core/Log';
import type { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type {
  AcpDriver,
  AgentDescription,
  ConfigCategory,
  ConfigOption,
  ConfigValue,
  ConfigValueGroup,
  ListedSession,
  Modes,
  NewSession,
  PermissionOutcome,
  PermissionRequest,
  PlanStepStatus,
  PromptPart,
  SessionPage,
  SessionRoots,
  SessionState,
  SessionUpdate,
  SlashCommand,
  ToolCallContent,
  ToolCallStatus,
} from './AcpDriver';
import { authChecked, sessionChecked } from './RequestErrors';
import { compactionContent } from './Compaction';
import { v1Elicitation } from './Elicitation';

/** The `initialize` request the v1 client sends, which the negotiation sends to the agent for it. */
export function v1InitializeRequest(clientVersion: string): Acp.InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'vscode-acp-client', version: clientVersion },
    // Agents read and write files and run commands themselves; ACP v2 drops these client capabilities. Boolean config
    // options, which every v2 client supports, a v1 client must offer.
    clientCapabilities: { elicitation: { form: {}, url: {} }, session: { compaction: {}, configOptions: { boolean: {} } } },
  };
}

/** Speaks ACP v1 over a connection, through the SDK's stable v1 client. */
export class V1Driver implements AcpDriver {
  /** Connect the SDK's v1 client to the stream and initialize the connection. */
  static async connect(
    agentName: string,
    stream: Acp.Stream,
    clientVersion: string,
    updates: SessionUpdateHandler,
    handlers: ClientHandlers,
  ): Promise<V1Driver> {
    const { permissions } = handlers;
    // The connection must stay open for the agent's lifetime, so use connect()
    // rather than connectWith(), which closes when its callback returns.
    const app = createClientApp({ name: 'vscode-acp-client' })
      .onRequest(methods.client.elicitation.create, ({ params, requestId, signal }) => {
        const capabilities = v1InitializeRequest(clientVersion).clientCapabilities?.elicitation;
        if (!handlers.elicitations || (params.mode !== 'form' && params.mode !== 'url') || !capabilities?.[params.mode]) {
          throw new RequestError(-32602, 'Elicitation mode is not advertised');
        }
        return v1Elicitation(params, requestId, signal, handlers.elicitations);
      })
      .onNotification(methods.client.elicitation.complete, ({ params }) => handlers.elicitations?.complete(params.elicitationId))
      .onRequest(methods.client.session.requestPermission, async ({ params, signal }) =>
        permissionResponse(await permissions.requestPermission(permissionRequest(params), signal)))
      .onNotification(methods.client.session.update, ({ params }) => {
        logTrace('Received session update', { type: params.update.sessionUpdate, sessionId: params.sessionId });
        const update = sessionUpdate(params.update);
        if (update) {
          updates.handleUpdate(params.sessionId, update, 'v1');
        }
      });
    const connection = app.connect(stream);
    connection.signal.addEventListener('abort', () => {
      handlers.elicitations?.close();
      handlers.close?.();
    }, { once: true });

    logDebug('Initializing ACP v1 connection', { agentName });
    const initResponse = await connection.agent.request(methods.agent.initialize, v1InitializeRequest(clientVersion));
    logInfo('Initialized ACP v1 agent', { agentName: initResponse.agentInfo?.name || 'unknown', version: initResponse.agentInfo?.version || '?' });

    return new V1Driver(connection, permissions, agentDescription(initResponse));
  }

  private constructor(
    private readonly connection: Acp.ClientConnection,
    private readonly permissions: ClientHandlers['permissions'],
    readonly agent: AgentDescription,
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
    const request: Acp.NewSessionRequest = { cwd: roots.cwd, ...this.additionalDirectories(roots), mcpServers: [] };
    const response = await authChecked(this.connection.agent.request(methods.agent.session.new, request));
    return { sessionId: response.sessionId, ...sessionState(response) };
  }

  async listSessions(query: { cwd?: string | undefined; cursor?: string | undefined }): Promise<SessionPage> {
    const response = await authChecked(this.connection.agent.request(methods.agent.session.list, {
      ...(query.cwd ? { cwd: query.cwd } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    }));
    return {
      sessions: response.sessions.map(listedSession),
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  async loadSession(sessionId: string, roots: SessionRoots): Promise<SessionState> {
    const request: Acp.LoadSessionRequest = { sessionId, cwd: roots.cwd, ...this.additionalDirectories(roots), mcpServers: [] };
    const response = await sessionChecked(sessionId, this.connection.agent.request(methods.agent.session.load, request));
    return sessionState(response);
  }

  async resumeSession(sessionId: string, roots: SessionRoots): Promise<SessionState> {
    const request: Acp.ResumeSessionRequest = { sessionId, cwd: roots.cwd, ...this.additionalDirectories(roots), mcpServers: [] };
    const response = await sessionChecked(sessionId, this.connection.agent.request(methods.agent.session.resume, request));
    return sessionState(response);
  }

  async prompt(sessionId: string, prompt: PromptPart[]): Promise<void> {
    const response = await authChecked(this.connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: prompt.map(contentBlock),
    }));
    logInfo('Prompt turn ended', { stopReason: response.stopReason });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    this.permissions.cancelSession(sessionId);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await authChecked(this.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId }));
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    const request: Acp.SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean', value }
      : { sessionId, configId, value };
    const response = await authChecked(this.connection.agent.request(methods.agent.session.setConfigOption, request));
    // The SDK validates an agent's requests and notifications but not its
    // responses, so this arrives as the agent sent it, whatever its type says.
    return Array.isArray(response.configOptions) ? response.configOptions.map(configOption) : null;
  }

  async authenticate(methodId: string): Promise<void> {
    await authChecked(this.connection.agent.request(methods.agent.authenticate, { methodId }));
  }
}

function agentDescription(response: Acp.InitializeResponse): AgentDescription {
  const caps = response.agentCapabilities;
  return {
    displayName: response.agentInfo?.title || response.agentInfo?.name || null,
    capabilities: {
      list: !!caps?.sessionCapabilities?.list,
      load: !!caps?.loadSession,
      resume: !!caps?.sessionCapabilities?.resume,
      additionalDirectories: !!caps?.sessionCapabilities?.additionalDirectories,
    },
    authMethods: (response.authMethods ?? []).map((method) => ({ id: method.id, name: method.name, description: method.description ?? null })),
  };
}

function sessionState(response: { modes?: Acp.SessionModeState | null; configOptions?: Acp.SessionConfigOption[] | null }): SessionState {
  return {
    modes: response.modes ? modes(response.modes) : null,
    configOptions: response.configOptions ? response.configOptions.map(configOption) : null,
    commands: null,
  };
}

function modes(state: Acp.SessionModeState): Modes {
  return {
    current: state.currentModeId,
    available: state.availableModes.map((mode) => ({ id: mode.id, name: mode.name, description: mode.description ?? null })),
  };
}

function configOption(option: Acp.SessionConfigOption): ConfigOption {
  const base = { id: option.id, name: option.name, description: option.description ?? null, category: configCategory(option.category) };
  return option.type === 'select'
    ? { ...base, kind: 'select', current: option.currentValue, groups: valueGroups(option.options) }
    : { ...base, kind: 'boolean', current: option.currentValue };
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
  const ungrouped = options.flatMap((entry) => ('group' in entry ? [] : [configValue(entry)]));
  const grouped = options.flatMap((entry) => ('group' in entry ? [{ header: entry.name || entry.group, values: entry.options.map(configValue) }] : []));
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

function permissionRequest(params: Acp.RequestPermissionRequest): PermissionRequest {
  return {
    sessionId: params.sessionId,
    title: params.toolCall.title ?? null,
    description: null,
    subject: null,
    options: params.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
  };
}

function permissionResponse(outcome: PermissionOutcome): Acp.RequestPermissionResponse {
  if (outcome.kind === 'requestCancelled') {
    throw RequestError.requestCancelled();
  }
  return outcome.kind === 'selected'
    ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** The session update for ACP's, or null when the interface has no place for it. */
function sessionUpdate(update: Acp.SessionUpdate): SessionUpdate | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textForUser(update.content);
      return text ? { kind: 'agentText', messageId: update.messageId ?? null, text } : null;
    }
    case 'agent_thought_chunk': {
      const text = textForUser(update.content);
      return text === null ? null : { kind: 'thoughtText', messageId: update.messageId ?? null, text };
    }
    case 'user_message_chunk': {
      const text = textForUser(update.content);
      return text === null ? null : { kind: 'promptText', messageId: update.messageId ?? null, text };
    }
    case 'tool_call':
    case 'tool_call_update': {
      const status = update.status ? toolCallStatus(update.status) : null;
      return {
        kind: 'toolCall',
        toolCallId: update.toolCallId,
        ...(update.title ? { title: update.title } : {}),
        ...(update.kind ? { toolKind: update.kind } : {}),
        ...(status ? { status } : {}),
        ...(update.content ? { content: toolCallContent(update.content) } : {}),
      };
    }
    case 'plan':
      return { kind: 'plan', steps: update.entries.map((entry) => ({ text: entry.content, status: planStepStatus(entry.status) })) };
    case 'available_commands_update':
      return { kind: 'commands', commands: update.availableCommands.map(slashCommand) };
    case 'config_option_update':
      return { kind: 'configOptions', options: update.configOptions.map(configOption) };
    case 'current_mode_update':
      return { kind: 'currentMode', modeId: update.currentModeId };
    case 'compaction_update':
      return {
        kind: 'compactionUpdate',
        compactionId: update.compactionId,
        status: update.status,
        summary: update.summary === undefined
          ? { present: false }
          : { present: true, value: update.summary === null ? null : update.summary.map(compactionContent) },
        error: update.error === undefined
          ? { present: false }
          : { present: true, value: update.error },
      };
    case 'compaction_summary_chunk':
      return { kind: 'compactionSummaryChunk', compactionId: update.compactionId, content: compactionContent(update.content) };
    case 'usage_update':
      return {
        kind: 'usage',
        used: update.used,
        size: update.size,
        cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null,
      };
    case 'session_info_update':
      return {
        kind: 'sessionInfo',
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
      };
    default:
      return null;
  }
}

/** A chunk's text, unless its `audience` leaves out the user, as an agent marks what it adds for the model alone. */
function textForUser(content: Acp.ContentBlock): string | null {
  if (content.type !== 'text') {
    return null;
  }
  const audience = content.annotations?.audience;
  return audience && !audience.includes('user') ? null : content.text;
}

/** A tool call's non-empty text blocks and its diffs; a v1 terminal is one the client creates, and the extension offers none. */
function toolCallContent(content: readonly Acp.ToolCallContent[]): ToolCallContent[] {
  return content.flatMap((block): ToolCallContent[] => {
    switch (block.type) {
      case 'content':
        return block.content.type === 'text' && block.content.text ? [{ kind: 'text', text: block.content.text }] : [];
      case 'diff':
        return [{ kind: 'diff', diff: { kind: 'wholeFile', path: block.path, oldText: block.oldText ?? null, newText: block.newText } }];
      default:
        return [];
    }
  });
}

function toolCallStatus(status: Acp.ToolCallStatus): ToolCallStatus | null {
  switch (status) {
    case 'pending':
    case 'completed':
    case 'failed':
      return status;
    case 'in_progress':
      return 'running';
    default:
      return null;
  }
}

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
  return { name: command.name, description: command.description, takesInput: !!command.input, hint: command.input?.hint || null };
}
