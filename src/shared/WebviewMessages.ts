import type {
  AvailableCommand,
  SessionConfigId,
  SessionConfigOption,
  SessionConfigValueId,
  SessionModeId,
  SessionModeState,
  SessionUpdate,
  StopReason,
  Usage,
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

export interface MarkdownSource {
  /** Position of the agent message in the webview's transcript. */
  index: number;
  text: string;
}

export interface RenderedMarkdown {
  index: number;
  html: string;
}

export type ExtensionToWebviewMessage =
  | { type: 'state'; activeSessionId: string | null; session: SessionSnapshot | null }
  | { type: 'clearChat' }
  | { type: 'promptStart' }
  | { type: 'promptEnd'; stopReason: StopReason | 'error'; usage?: Usage | null }
  | { type: 'error'; message: string }
  | { type: 'sessionUpdate'; sessionId: string; update: SessionUpdate }
  | { type: 'modesUpdate'; modes: SessionModeState | null }
  | { type: 'configOptionsUpdate'; configOptions: SessionConfigOption[] | null }
  | { type: 'sessionInfoUpdate'; title: string | null }
  | { type: 'loadSessionStart' }
  | { type: 'loadSessionEnd'; ok: boolean }
  | { type: 'markdownRendered'; items: RenderedMarkdown[] }
  /** The webview has no handler for this yet, so the attachment is dropped (repo plan f.12). */
  | { type: 'file-attached'; path: string; name: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  | { type: 'setMode'; modeId: SessionModeId }
  | { type: 'setConfigOption'; configId: SessionConfigId; value: SessionConfigValueId }
  | { type: 'executeCommand'; command: string }
  | { type: 'renderMarkdown'; items: MarkdownSource[] };
