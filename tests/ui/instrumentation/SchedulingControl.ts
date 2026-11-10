type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function observe<T>(operation: () => PromiseLike<T> | T): Promise<Outcome<T>> {
  try {
    return Promise.resolve(operation()).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
  } catch (error) { return Promise.resolve({ ok: false, error }); }
}

function deliver<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) { throw outcome.error; }
  return outcome.value;
}

/** One held boundary per cycle. Entry is not settlement, and settlement is not DOM readiness. */
export class SchedulingControl {
  private state: 'idle' | 'armed' | 'entered' | 'releasing' | 'closed' = 'idle';
  private entered = latch();
  private gate = latch();
  private closed = latch();
  private readonly closedError = new Error('Scheduling control closed');
  private detachAbort: (() => void) | undefined;
  private boundary: Promise<Outcome<unknown>> | undefined;
  private accepted: Promise<Outcome<unknown>>[] = [];

  arm(signal: AbortSignal): void {
    if (this.state === 'closed' || signal.aborted) { throw this.closedError; }
    if (this.state !== 'idle') { throw new Error('Scheduling control is already armed or releasing'); }
    this.state = 'armed';
    this.entered = latch();
    this.gate = latch();
    this.closed = latch();
    this.accepted = [];
    const aborted = () => this.close();
    signal.addEventListener('abort', aborted, { once: true });
    this.detachAbort = () => signal.removeEventListener('abort', aborted);
  }

  async waitForEntry(): Promise<void> {
    this.checkClosed();
    if (this.state === 'idle') { throw new Error('Scheduling control is not armed'); }
    await Promise.race([this.entered.promise, this.closed.promise]);
    this.checkClosed();
  }

  hold<T>(operation: () => PromiseLike<T> | T): Promise<T> {
    if (this.state !== 'armed') { return observe(operation).then(deliver); }
    this.state = 'entered';
    // Observe now, not in gate.then(): rejection must be handled while delivery is held.
    const outcome = observe(operation);
    const delivery = this.gate.promise.then(async () => deliver(await outcome));
    this.boundary = observe(() => delivery);
    this.entered.resolve();
    return delivery;
  }

  /** Entry means a call is waiting to execute; unlike hold, the operation has not started. */
  before<T>(operation: () => PromiseLike<T> | T): Promise<T> {
    if (this.state !== 'armed') { return observe(operation).then(deliver); }
    return this.hold(() => this.gate.promise.then(operation));
  }

  accept<T>(operation: () => Promise<T>): Promise<T> {
    const accepts = this.state === 'armed' || this.state === 'entered';
    const outcome = observe(operation);
    if (accepts) { this.accepted.push(outcome); }
    return outcome.then(deliver);
  }

  /** Drains the boundary and work accepted by release entry, not later unrelated operations. */
  async release(): Promise<void> {
    this.checkClosed();
    if (this.state !== 'entered' || !this.boundary) { throw new Error('Scheduling control has not entered'); }
    this.state = 'releasing';
    const draining = Promise.all([this.boundary, ...this.accepted]);
    this.gate.resolve();
    try {
      const outcomes = await Promise.race([draining, this.closed.promise.then(() => { throw this.closedError; })]);
      for (const outcome of outcomes) { deliver(outcome); }
    } finally {
      this.detachAbort?.();
      this.detachAbort = undefined;
      this.boundary = undefined;
      this.accepted = [];
      this.finishCycle();
    }
  }

  close(): void {
    if (this.state === 'closed') { return; }
    this.state = 'closed';
    this.detachAbort?.();
    this.detachAbort = undefined;
    this.gate.resolve();
    this.closed.resolve();
  }

  private checkClosed(): void {
    if (this.state === 'closed') { throw this.closedError; }
  }

  private finishCycle(): void {
    if (this.state !== 'closed') { this.state = 'idle'; }
  }
}
