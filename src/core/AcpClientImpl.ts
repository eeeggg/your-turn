import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

import { SessionUpdateHandler } from './SessionUpdateHandler';
import { log } from './Log';

export interface FileAccess {
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

export interface Terminals {
  createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse>;
  releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
}

export interface PermissionPrompt {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/** What one connection's client delegates to; each connection gets its own. */
export interface ClientHandlers {
  files: FileAccess;
  terminals: Terminals;
  permissions: PermissionPrompt;
}

/**
 * ACP Client implementation.
 * Delegates to individual handlers for each capability.
 *
 * ConnectionManager registers each method as an ACP handler on a
 * `client()` app, e.g. `.onRequest(methods.client.fs.readTextFile, ...)`.
 */
export class AcpClientImpl implements Client {
  constructor(
    private readonly fsHandler: FileAccess,
    private readonly terminalHandler: Terminals,
    private readonly permissionHandler: PermissionPrompt,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {}

  // --- Required methods ---

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

  // --- File system methods ---

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    log(`Client.writeTextFile: ${params.path}`);
    return this.fsHandler.writeTextFile(params);
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    log(`Client.readTextFile: ${params.path}`);
    return this.fsHandler.readTextFile(params);
  }

  // --- Terminal methods ---

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }
}
