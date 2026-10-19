import type {
  AvailableCommand,
  SessionConfigId,
  SessionConfigOption,
  SessionConfigValueId,
  SessionModeId,
  SessionModeState,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';

/** The active session as the chat view shows it. */
export interface SessionSnapshot {
  sessionId: string;
  agentName: string;
  title?: string;
  cwd: string;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[] | null;
  availableCommands: AvailableCommand[];
}

export type ExtensionToWebviewMessage =
  | { type: 'state'; activeSessionId: string | null; session: SessionSnapshot | null }
  | { type: 'clearTranscript' }
  | { type: 'promptStart' }
  | { type: 'promptEnd'; stopReason: StopReason | 'error' }
  | { type: 'error'; message: string }
  | { type: 'sessionUpdate'; sessionId: string; update: SessionUpdate }
  | { type: 'modesUpdate'; modes: SessionModeState | null }
  | { type: 'configOptionsUpdate'; configOptions: SessionConfigOption[] | null }
  /** The active session's title, null when it has none. */
  | { type: 'sessionInfoUpdate'; title: string | null }
  | { type: 'loadSessionStart' }
  | { type: 'loadSessionEnd'; ok: boolean }
  /** The webview has no handler for this yet, so the attachment is dropped. */
  | { type: 'file-attached'; path: string; name: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  | { type: 'setMode'; modeId: SessionModeId }
  | { type: 'setConfigOption'; configId: SessionConfigId; value: SessionConfigValueId }
  | { type: 'executeCommand'; command: string };
