export type LogContext = Readonly<Record<string, unknown>>;

export interface LogSink {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
}

let sink: LogSink | undefined;

/** Until a sink is set, diagnostic records are dropped. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

export function logTrace(message: string, context?: LogContext): void {
  sink?.trace(message, ...(context === undefined ? [] : [context]));
}

export function logDebug(message: string, context?: LogContext): void {
  sink?.debug(message, ...(context === undefined ? [] : [context]));
}

export function logInfo(message: string, context?: LogContext): void {
  sink?.info(message, ...(context === undefined ? [] : [context]));
}

export function logWarning(message: string, context?: LogContext): void {
  sink?.warn(message, ...(context === undefined ? [] : [context]));
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  sink?.error(message, error, ...(context === undefined ? [] : [context]));
}

/** The message of a thrown value, which need not be an `Error`; empty for an object without one. */
export function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    return 'message' in e && typeof e.message === 'string' ? e.message : '';
  }
  return String(e);
}
