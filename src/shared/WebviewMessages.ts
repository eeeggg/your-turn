/**
 * The chat view's contract: what the extension tells the webview and what the webview asks of it, in the chat view's
 * own vocabulary. `ChatViewController` translates ACP into it, so a change to ACP's schema never reaches the webview;
 * the contract changes only for the chat view's own sake.
 */

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

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

export type PickerCategory = 'mode' | 'model' | 'thought_level' | 'other';

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
  category: PickerCategory;
  name: string;
  description: string | null;
  /** The ID of the chosen value. */
  current: string;
  groups: PickerValueGroup[];
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

export type ExtensionToWebviewMessage =
  | { type: 'state'; activeSessionId: string | null; session: SessionSnapshot | null }
  | { type: 'clearTranscript' }
  | { type: 'promptStart' }
  | { type: 'promptEnd' }
  | { type: 'error'; message: string }
  /** The shown session's agent exited on its own; the message says so. A sessionless `state` follows. */
  | { type: 'sessionEnded'; message: string }
  /** More of the agent's answer; text with another `messageId` is another message. */
  | { type: 'agentText'; messageId: string | null; text: string }
  /** More of the agent's thinking, as for `agentText`. */
  | { type: 'thoughtText'; messageId: string | null; text: string }
  /** More of a prompt that a load replays, as for `agentText`. */
  | { type: 'promptText'; messageId: string | null; text: string }
  /** The whole text of the agent's answer with this `messageId`, replacing what the latest one had; without one, a new answer. */
  | { type: 'agentMessage'; messageId: string; text: string }
  /** The whole text of the agent's thinking, as for `agentMessage`. */
  | { type: 'thoughtMessage'; messageId: string; text: string }
  /** The whole text of a prompt that a load replays, as for `agentMessage`. */
  | { type: 'promptMessage'; messageId: string; text: string }
  /** A tool call, new or changed; what it leaves out stays as it was. */
  | { type: 'toolCall'; toolCallId: string; title?: string; status?: ToolCallStatus; texts?: string[] }
  /** The agent's plan, replacing the turn's earlier one. */
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'commands'; commands: SlashCommand[] }
  | { type: 'pickers'; pickers: Picker[] }
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
  | { type: 'pickerValueChosen'; pickerId: string; value: string };
