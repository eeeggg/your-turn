export type TrafficDirection = 'send' | 'recv';

export interface LogSink {
  log(message: string, ...args: unknown[]): void;
  error(message: string, error?: unknown): void;
  traffic(direction: TrafficDirection, data: unknown): void;
}

let sink: LogSink | undefined;

/** Until a sink is set, log lines and traffic are dropped. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

export function log(message: string, ...args: unknown[]): void {
  sink?.log(message, ...args);
}

export function logError(message: string, error?: unknown): void {
  sink?.error(message, error);
}

export function logTraffic(direction: TrafficDirection, data: unknown): void {
  sink?.traffic(direction, data);
}
