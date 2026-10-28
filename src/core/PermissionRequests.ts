import type { PermissionOption, PermissionOutcome, PermissionRequest } from '@/core/acp/AcpDriver';
import type { Permissions } from './ClientHandlers';
import { log, logError } from './Log';

/** The `acp.autoApprovePermissions` setting. */
export type AutoApprove = 'ask' | 'allowAll';

/** What the user is asked: the request's title, and what it is about and why, when the agent says. */
export interface PermissionPrompt {
  title: string;
  detail: string | null;
}

export interface PermissionChooser {
  /** Read for every permission request, so a changed setting applies to the next one. */
  autoApprove(): AutoApprove;
  /** Ask the user to choose one of the options; undefined when they dismiss the choice. */
  choose(prompt: PermissionPrompt, options: readonly PermissionOption[], signal: AbortSignal): Promise<string | undefined>;
}

const CANCELLED: PermissionOutcome = { kind: 'cancelled' };
const REQUEST_CANCELLED: PermissionOutcome = { kind: 'requestCancelled' };

interface PendingPermission {
  request: PermissionRequest;
  resolve(outcome: PermissionOutcome): void;
  cancelled: Promise<void>;
  cancelWait(): void;
  signal?: AbortSignal;
  signalAbort?: () => void;
  chooserController?: AbortController;
  settled: boolean;
}

/**
 * Answers the agent's permission requests one at a time, so concurrent requests
 * wait their turn instead of competing for the user's attention.
 */
export class PermissionRequests implements Permissions {
  private readonly queue: PendingPermission[] = [];
  private readonly pending = new Set<PendingPermission>();
  private processing = false;

  constructor(private readonly chooser: PermissionChooser) {}

  requestPermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionOutcome> {
    let resolve!: (outcome: PermissionOutcome) => void;
    const answer = new Promise<PermissionOutcome>((done) => { resolve = done; });
    let cancelWait!: () => void;
    const cancelled = new Promise<void>((done) => { cancelWait = done; });
    const pending: PendingPermission = {
      request, resolve, cancelled, cancelWait, settled: false,
      ...(signal ? { signal } : {}),
    };
    this.pending.add(pending);

    if (signal) {
      pending.signalAbort = () => this.cancel(pending, REQUEST_CANCELLED);
      if (signal.aborted) {
        pending.signalAbort();
      } else {
        signal.addEventListener('abort', pending.signalAbort, { once: true });
      }
    }
    this.queue.push(pending);
    void this.processQueue();
    if (signal?.aborted) { pending.signalAbort?.(); }
    return answer;
  }

  /** Resolve every unanswered permission request for this session as required by session/cancel. */
  cancelSession(sessionId: string): void {
    for (const pending of this.pending) {
      if (pending.request.sessionId === sessionId) {
        this.cancel(pending, CANCELLED);
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) { return; }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const pending = this.queue.shift();
        if (!pending || pending.settled) { continue; }
        await this.answer(pending);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) { void this.processQueue(); }
    }
  }

  private async answer(pending: PendingPermission): Promise<void> {
    const { request } = pending;
    try {
      const title = request.title || 'Permission Request';
      const autoApprove = this.chooser.autoApprove();
      log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

      if (autoApprove === 'allowAll') {
        const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
        if (allow) {
          this.finish(pending, { kind: 'selected', optionId: allow.id });
          return;
        }
      }

      const detail = [request.subject, request.description].filter((part) => !!part).join(' — ');
      const controller = new AbortController();
      pending.chooserController = controller;
      const choice = await Promise.race([
        this.chooser.choose({ title, detail: detail || null }, request.options, controller.signal)
          .then((optionId) => ({ optionId })),
        pending.cancelled.then(() => ({ cancelled: true as const })),
      ]);
      if (pending.settled) { return; }
      if ('cancelled' in choice) { return; }
      if (choice.optionId === undefined) {
        const rejectOnce = request.options.find((option) => option.kind === 'reject_once');
        if (rejectOnce) {
          log(`Permission dismissed; selecting reject-once: ${rejectOnce.id}`);
          this.finish(pending, { kind: 'selected', optionId: rejectOnce.id });
        } else {
          log('Permission dismissed without reject-once option; cancelling request');
          this.finish(pending, REQUEST_CANCELLED);
        }
        return;
      }
      log(`Permission selected: ${choice.optionId}`);
      this.finish(pending, { kind: 'selected', optionId: choice.optionId });
    } catch (error) {
      logError('Permission request failed', error);
      this.finish(pending, CANCELLED);
    }
  }

  private cancel(pending: PendingPermission, outcome: PermissionOutcome): void {
    if (pending.settled) { return; }
    this.finish(pending, outcome);
    pending.chooserController?.abort();
    pending.cancelWait();
  }

  private finish(pending: PendingPermission, outcome: PermissionOutcome): void {
    if (pending.settled) { return; }
    pending.settled = true;
    this.pending.delete(pending);
    if (pending.signalAbort) {
      pending.signal?.removeEventListener('abort', pending.signalAbort);
    }
    pending.resolve(outcome);
  }
}
