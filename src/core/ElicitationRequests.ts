import { normalizeForm, validateAnswers } from '@/core/ElicitationForm';
import { 
  ElicitationError,
  type ElicitationRequest,
  type ElicitationInteraction,
  type ElicitationResponse,
  type ElicitationChange,
  type ElicitationResponseResult
} from '@/core/acp/AcpDriver';
import type { Elicitations } from '@/core/ClientHandlers';
import { logError } from '@/core/Log';

interface Pending {
  interaction: ElicitationInteraction;
  resolve(response: ElicitationResponse): void;
  reject(error: ElicitationError): void;
  detach(): void;
}

let nextInteraction = 0;

export class ElicitationRequests implements Elicitations {
  private readonly active = new Map<string, Pending>();
  private readonly urls = new Map<string, Pending>();
  private readonly listeners = new Set<(change: ElicitationChange) => void>();
  private closed = false;

  constructor(private readonly parentPending: (id: string | number) => boolean = () => true) {}

  create(request: ElicitationRequest, signal?: AbortSignal): Promise<ElicitationResponse> {
    try {
      if (this.closed) { throw new ElicitationError('closed', 'Connection closed'); }
      if (signal?.aborted) { throw new ElicitationError('cancelled', 'Request cancelled'); }
      const { sessionId, requestId, toolCallId } = request.scope;
      if ((sessionId != null) === (requestId != null)
        || (sessionId != null && typeof sessionId !== 'string')
        || (requestId != null && (typeof requestId !== 'string' && typeof requestId !== 'number'))
        || (requestId != null && (toolCallId != null || !this.parentPending(requestId)))
        || (toolCallId != null && typeof toolCallId !== 'string')
        || typeof request.message !== 'string') {
        throw new ElicitationError('invalid', 'Invalid elicitation scope');
      }
      if (request.mode === 'url' && (typeof request.elicitationId !== 'string' || typeof request.url !== 'string' || this.urls.has(request.elicitationId))) {
        throw new ElicitationError('invalid', 'Invalid or duplicate URL elicitation');
      }
      if (request.mode === 'url') {
        let target: URL;
        try { target = new URL(request.url); }
        catch { throw new ElicitationError('invalid', 'Invalid URL elicitation target'); }
        const loopback = target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '[::1]';
        if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback))
          || !target.hostname || target.username || target.password || !/^https?:\/\//iu.test(request.url)
          || /[\u0000-\u0020\u007f\\]/u.test(request.url)) {
          throw new ElicitationError('invalid', 'URL elicitation requires HTTPS or loopback HTTP without embedded credentials');
        }
      }
      const interaction: ElicitationInteraction = Object.freeze({
        rpcId: request.rpcId, message: request.message,
        scope: Object.freeze({ ...request.scope }), interactionId: `elicitation-${++nextInteraction}`, status: 'pending', completed: false,
        ...(request.mode === 'form' ? { mode: 'form' as const, form: normalizeForm(request.requestedSchema) }
          : { mode: 'url' as const, elicitationId: request.elicitationId, url: request.url }),
      });
      return new Promise<ElicitationResponse>((resolve, reject) => {
        const abort = () => this.withdraw(pending, 'cancelled');
        const pending: Pending = { interaction, resolve, reject, detach: () => signal?.removeEventListener('abort', abort) };
        this.active.set(interaction.interactionId, pending);
        if (interaction.mode === 'url') { this.urls.set(interaction.elicitationId, pending); }
        signal?.addEventListener('abort', abort, { once: true });
        this.publish({ kind: 'created', interaction });
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
  }

  respond(id: string, response: unknown): ElicitationResponseResult {
    const pending = this.active.get(id);
    if (pending?.interaction.status !== 'pending') { return { kind: 'stale' }; }
    if (typeof response !== 'object' || response === null || !('action' in response)
      || (response.action !== 'accept' && response.action !== 'decline' && response.action !== 'cancel')) {
      return { kind: 'invalid', errors: { '': 'Invalid action' } };
    }
    const content = 'content' in response ? response.content : undefined;
    let answer: ElicitationResponse;
    if (response.action === 'accept' && pending.interaction.mode === 'form') {
      const validated = validateAnswers(pending.interaction.form, content);
      if ('errors' in validated) { return { kind: 'invalid', errors: validated.errors }; }
      answer = Object.freeze({ action: 'accept', content: validated.content });
    } else {
      if (content !== undefined) { return { kind: 'invalid', errors: { '': 'Unexpected content' } }; }
      answer = Object.freeze({ action: response.action });
    }
    pending.detach();
    if (pending.interaction.mode === 'url' && answer.action === 'accept' && !pending.interaction.completed) {
      pending.interaction = Object.freeze({ ...pending.interaction, status: 'awaitingCompletion' });
    } else { this.remove(pending); }
    pending.resolve(answer);
    this.publish({ kind: 'responded', interaction: pending.interaction, response: answer });
    return { kind: 'settled' };
  }

  snapshot(): readonly ElicitationInteraction[] { return Object.freeze([...this.active.values()].map((pending) => pending.interaction)); }

  subscribe(listener: (change: ElicitationChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  complete(id: string): void {
    const pending = this.urls.get(id);
    if (!pending || pending.interaction.completed) { return; }
    pending.interaction = Object.freeze({ ...pending.interaction, completed: true });
    if (pending.interaction.status === 'awaitingCompletion') { this.remove(pending); }
    this.publish({ kind: 'completed', interaction: pending.interaction });
  }

  close(): void {
    if (this.closed) { return; }
    this.closed = true;
    for (const pending of [...this.active.values()]) { this.withdraw(pending, 'closed'); }
    this.listeners.clear();
  }

  private withdraw(pending: Pending, kind: 'cancelled' | 'closed'): void {
    if (!this.active.has(pending.interaction.interactionId)) { return; }
    this.remove(pending);
    if (pending.interaction.status === 'pending') { pending.reject(new ElicitationError(kind, kind === 'closed' ? 'Connection closed' : 'Request cancelled')); }
    this.publish({ kind: kind === 'closed' ? 'closed' : 'withdrawn', interaction: pending.interaction });
  }

  private remove(pending: Pending): void {
    pending.detach();
    this.active.delete(pending.interaction.interactionId);
    if (pending.interaction.mode === 'url') { this.urls.delete(pending.interaction.elicitationId); }
  }

  private publish(change: ElicitationChange): void {
    for (const listener of this.listeners) {
      try { listener(Object.freeze(change)); }
      catch { logError('Elicitation observer failed'); }
    }
  }
}
