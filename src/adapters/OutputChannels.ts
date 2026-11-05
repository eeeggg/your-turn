import * as vscode from 'vscode';
import type { LogSink } from '@/core/Log';

let _outputChannel: vscode.LogOutputChannel | undefined;

export function getOutputChannel(): vscode.LogOutputChannel {
  _outputChannel ??= vscode.window.createOutputChannel('Your Turn', { log: true });
  return _outputChannel;
}

export const outputChannelSink: LogSink = {
  trace: (message, context) => getOutputChannel().trace(message, ...(context === undefined ? [] : [context])),
  debug: (message, context) => getOutputChannel().debug(message, ...(context === undefined ? [] : [context])),
  info: (message, context) => getOutputChannel().info(message, ...(context === undefined ? [] : [context])),
  warn: (message, context) => getOutputChannel().warn(message, ...(context === undefined ? [] : [context])),
  error: (message, error, context) => {
    const args = [
      ...(error === undefined ? [] : [error]),
      ...(context === undefined ? [] : [context]),
    ];
    getOutputChannel().error(message, ...args);
  },
};

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _outputChannel = undefined;
}
