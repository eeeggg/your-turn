import * as vscode from 'vscode';
import type { LogSink, TrafficDirection } from '@/core/Log';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

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

function appendLog(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

function appendError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

function appendTraffic(direction: TrafficDirection, data: unknown): void {
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
}

export const outputChannelSink: LogSink = {
  log: appendLog,
  error: appendError,
  traffic: appendTraffic,
};

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
