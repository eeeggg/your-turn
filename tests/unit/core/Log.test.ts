import { afterEach, describe, expect, it } from 'vitest';
import { logDebug, logError, logInfo, logTrace, logWarning, setLogSink } from '@/core/Log';

afterEach(() => { setLogSink(undefined); });

describe('levelled log facade', () => {
  it('routes each severity with structured context and preserves error identity', () => {
    const calls: unknown[][] = [];
    const context = { sessionId: 's1', nested: { count: 2 } };
    const error = new Error('failed');
    setLogSink({
      trace: (...args) => calls.push(['trace', ...args]),
      debug: (...args) => calls.push(['debug', ...args]),
      info: (...args) => calls.push(['info', ...args]),
      warn: (...args) => calls.push(['warn', ...args]),
      error: (...args) => calls.push(['error', ...args]),
    });

    logTrace('trace message', context);
    logDebug('debug message', context);
    logInfo('info message', context);
    logWarning('warning message', context);
    logError('error message', error, context);

    expect(calls.map(([severity, message]) => [severity, message])).toEqual([
      ['trace', 'trace message'],
      ['debug', 'debug message'],
      ['info', 'info message'],
      ['warn', 'warning message'],
      ['error', 'error message'],
    ]);
    expect(calls.slice(0, 4).map((call) => call[2])).toEqual([
      context, context, context, context,
    ]);
    expect(calls[4]?.[2]).toBe(error);
    expect(calls[4]?.[3]).toBe(context);
  });

});
