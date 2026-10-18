import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

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
  /** Release every terminal; called when the connection closes. */
  dispose(): void;
}

export interface Permissions {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/** What one connection's client requests are answered by; each connection gets its own. */
export interface ClientHandlers {
  files: FileAccess;
  terminals: Terminals;
  permissions: Permissions;
}
