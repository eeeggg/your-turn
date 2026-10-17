import * as vscode from 'vscode';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

export type TrafficListener = (direction: 'send' | 'recv', data: unknown) => void;
const _trafficListeners = new Set<TrafficListener>();

/**
 * Observe each message recorded by `logTraffic`. Output channel contents are
 * not readable through the VS Code API, so this is how tests see the traffic.
 */
export function onTraffic(listener: TrafficListener): vscode.Disposable {
  _trafficListeners.add(listener);
  return new vscode.Disposable(() => _trafficListeners.delete(listener));
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ACP Client');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic');
  }
  return _trafficChannel;
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', true)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type
  let label = '';
  if (typeof data === 'object' && data !== null) {
    if ('method' in data) {
      label = 'id' in data ? ` [REQUEST] ${data.method}` : ` [NOTIFICATION] ${data.method}`;
    } else if ('result' in data || 'error' in data) {
      label = ` [RESPONSE] id=${'id' in data ? data.id : undefined}`;
    }
  }

  getTrafficChannel().appendLine(
    `[${timestamp}] ${arrow}${label}\n${JSON.stringify(data, null, 2)}\n`
  );
  for (const listener of _trafficListeners) {
    listener(direction, data);
  }
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
