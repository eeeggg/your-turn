import { getEventListeners } from 'node:events';
import { expect, it } from 'vitest';
import { SchedulingControl } from '@tests/ui/instrumentation/SchedulingControl';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('holds a call before execution and drains its real result and accepted cleanup', async () => {
  const control = new SchedulingControl();
  const lifetime = new AbortController();
  const real = deferred<object>();
  const cleanup = deferred<undefined>();
  let calls = 0;
  control.arm(lifetime.signal);
  const result = control.accept(async () => {
    const value = await control.before(() => { calls++; return real.promise; });
    await cleanup.promise;
    return value;
  });
  await control.waitForEntry();
  expect(calls).toBe(0);
  let settled = false;
  const released = control.release().then(() => { settled = true; });
  const value = {};
  real.resolve(value);
  await real.promise;
  expect(settled).toBe(false);
  cleanup.resolve(undefined);
  await expect(result).resolves.toBe(value);
  await released;
  expect(calls).toBe(1);
  expect(settled).toBe(true);
  expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
});

it('reports a released before-call failure, then permits a new cycle without changing hold semantics', async () => {
  const control = new SchedulingControl();
  const lifetime = new AbortController();
  control.arm(lifetime.signal);
  const failure = new Error('real opening failed');
  const rejected = expect(control.before(() => Promise.reject(failure))).rejects.toBe(failure);
  await control.waitForEntry();
  await expect(control.release()).rejects.toBe(failure);
  await rejected;
  control.arm(lifetime.signal);
  let called = false;
  const held = control.hold(() => { called = true; return 42; });
  await control.waitForEntry();
  expect(called).toBe(true);
  await control.release();
  await expect(held).resolves.toBe(42);
});

it('releases a before-call gate on abort and preserves the real failure', async () => {
  const control = new SchedulingControl();
  const lifetime = new AbortController();
  const failure = new Error('before-call failure');
  let called = false;
  control.arm(lifetime.signal);
  const result = expect(control.before(() => { called = true; throw failure; })).rejects.toBe(failure);
  await control.waitForEntry();
  expect(called).toBe(false);
  lifetime.abort();
  await result;
  expect(called).toBe(true);
  expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
  await expect(control.release()).rejects.toThrow(/closed/);
});

it('rejects invalid transitions without consuming the armed operation', async () => {
  const control = new SchedulingControl();
  const lifetime = new AbortController();
  await expect(control.waitForEntry()).rejects.toThrow(/not armed/);
  await expect(control.release()).rejects.toThrow(/not entered/);
  control.arm(lifetime.signal);
  expect(() => control.arm(lifetime.signal)).toThrow(/already/);
  await expect(control.release()).rejects.toThrow(/not entered/);
  const value = {};
  const delivery = control.hold(() => value);
  await control.waitForEntry();
  let delivered = false;
  const result = delivery.then((received) => { delivered = true; expect(received).toBe(value); });
  expect(delivered).toBe(false);
  await control.release();
  await result;
  await expect(control.waitForEntry()).rejects.toThrow(/not armed/);
});

it('observes real rejection while held and delivers the identical failure after release', async () => {
  const control = new SchedulingControl();
  control.arm(new AbortController().signal);
  const real = deferred<never>();
  const failure = new Error('real operation failed');
  const delivery = control.hold(() => real.promise);
  let delivered = false;
  const result = expect(delivery.finally(() => { delivered = true; })).rejects.toBe(failure);
  await control.waitForEntry();
  real.reject(failure);
  // A complete event-loop turn exposes an unobserved underlying rejection to Vitest.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  expect(delivered).toBe(false);
  await expect(control.release()).rejects.toBe(failure);
  await result;
  control.arm(new AbortController().signal);
  const next = control.hold(() => 42);
  await control.release();
  await expect(next).resolves.toBe(42);
});

it.each(['before', 'after'] as const)('aborts out of band %s entry without replacing the real result', async (when) => {
  const lifetime = new AbortController();
  const control = new SchedulingControl();
  control.arm(lifetime.signal);
  const entry = control.waitForEntry();
  const rejected = when === 'before' ? expect(entry).rejects.toThrow(/closed/) : undefined;
  const result = when === 'after' ? control.hold(() => 17) : undefined;
  if (when === 'after') { await entry; }
  lifetime.abort();
  await rejected;
  if (result) { await expect(result).resolves.toBe(17); }
  expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
  expect(() => control.arm(lifetime.signal)).toThrow(/closed/);
  await expect(control.release()).rejects.toThrow(/closed/);
  await expect(control.hold(() => 23)).resolves.toBe(23);
  control.close();
});

it('removes abort listeners on every successful and failed cycle', async () => {
  const lifetime = new AbortController();
  const control = new SchedulingControl();
  for (let cycle = 0; cycle < 12; cycle += 1) {
    control.arm(lifetime.signal);
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(1);
    const error = new Error(`cycle ${cycle}`);
    const result = control.hold(() => cycle % 2 === 0 ? Promise.resolve(cycle) : Promise.reject(error));
    const checked = cycle % 2 === 0 ? expect(result).resolves.toBe(cycle) : expect(result).rejects.toBe(error);
    if (cycle % 2 === 0) { await control.release(); }
    else { await expect(control.release()).rejects.toBe(error); }
    await checked;
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
  }
});

it('drains exactly accepted work through release and rejects overlap until that work settles', async () => {
  const control = new SchedulingControl();
  const lifetime = new AbortController();
  control.arm(lifetime.signal);
  const continuation = deferred<undefined>();
  const accepted = control.accept(async () => { await control.hold(() => 1); await continuation.promise; });
  await control.waitForEntry();
  let settled = false;
  const release = control.release().then(() => { settled = true; });
  const late = deferred<undefined>();
  const lateResult = control.accept(() => late.promise);
  expect(() => control.arm(lifetime.signal)).toThrow(/already/);
  expect(settled).toBe(false);
  continuation.resolve(undefined);
  await release;
  await accepted;
  expect(settled).toBe(true);
  late.resolve(undefined);
  await lateResult;
});

it('aborts a release awaiting accepted work without waiting behind it', async () => {
  const control = new SchedulingControl();
  control.arm(new AbortController().signal);
  const continuation = deferred<undefined>();
  const accepted = control.accept(async () => { await control.hold(() => 1); await continuation.promise; });
  await control.waitForEntry();
  const released = expect(control.release()).rejects.toThrow(/closed/);
  control.close();
  await released;
  continuation.resolve(undefined);
  await accepted;
});

it('does not arm an already aborted lifetime', () => {
  const lifetime = new AbortController();
  lifetime.abort();
  const control = new SchedulingControl();
  expect(() => control.arm(lifetime.signal)).toThrow(/closed/);
  expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(0);
});

it('waits for every accepted operation before reporting the original continuation failure', async () => {
  const control = new SchedulingControl();
  control.arm(new AbortController().signal);
  const failure = new Error('accepted continuation failed');
  const remaining = deferred<undefined>();
  const failed = control.accept(async () => { await control.hold(() => 1); throw failure; });
  const checked = expect(failed).rejects.toBe(failure);
  const other = control.accept(() => remaining.promise);
  await control.waitForEntry();
  let settled = false;
  const release = expect(control.release().finally(() => { settled = true; })).rejects.toBe(failure);
  await checked;
  expect(settled).toBe(false);
  remaining.resolve(undefined);
  await other;
  await release;
});

it('preserves a synchronous operation throw through held delivery and settlement', async () => {
  const control = new SchedulingControl();
  control.arm(new AbortController().signal);
  const error = new Error('synchronous operation');
  const delivery = expect(control.hold(() => { throw error; })).rejects.toBe(error);
  await control.waitForEntry();
  await expect(control.release()).rejects.toBe(error);
  await delivery;
});
