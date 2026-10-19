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

/** The message of a thrown value, which need not be an `Error`; empty for an object without one. */
export function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    return 'message' in e && typeof e.message === 'string' ? e.message : '';
  }
  return String(e);
}

export function logTraffic(direction: TrafficDirection, data: unknown): void {
  sink?.traffic(direction, data);
}
