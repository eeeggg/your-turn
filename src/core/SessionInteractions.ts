import type { ElicitationInteraction, ElicitationResponse, ElicitationResponseResult, ElicitationValue, PermissionRequest } from '@/core/acp/AcpDriver';
import type { ElicitationInteractions, PermissionInteractions } from '@/core/ClientHandlers';
import type { SessionIdentity } from '@/core/SessionUpdateHandler';

export interface RetainedQuestion {
  readonly agentName: string;
  readonly agentId: string;
  readonly interaction: Extract<ElicitationInteraction, { mode: 'form' }>;
  readonly draft: Readonly<Record<string, ElicitationValue>> | null;
}

export interface SettledQuestion {
  readonly agentName: string;
  readonly interaction: Extract<ElicitationInteraction, { mode: 'form' }>;
  readonly response: ElicitationResponse;
}

type Target = (SessionIdentity & { readonly generation: number }) | null;
interface Source {
  readonly agentId: string;
  agentName: string;
  readonly elicitations: ElicitationInteractions;
  readonly permissions: PermissionInteractions | undefined;
  readonly stop: () => void;
}

/** Retains connection requests independently of their selected presentation. */
export class SessionInteractions {
  private readonly sources = new Map<string, Source>();
  private readonly questions = new Map<string, RetainedQuestion>();
  private readonly listeners = new Set<(created?: RetainedQuestion) => void>();

  constructor(
    private readonly owner: (identity: SessionIdentity, agentId: string) => number | undefined,
    private readonly settled: (identity: SessionIdentity, agentId: string, question: SettledQuestion) => void,
  ) {}

  observe(context: { agentName: string; agentId: string; elicitations: ElicitationInteractions; permissions: PermissionInteractions | undefined }): () => void {
    const { agentId, elicitations, permissions } = context;
    const stopForms = elicitations.subscribe((change) => {
      const { interaction } = change;
      if (interaction.mode === 'form') {
        if (change.kind === 'created') {
          const question: RetainedQuestion = { agentName: source.agentName, agentId, interaction, draft: null };
          this.questions.set(interaction.interactionId, question);
          this.publish(question);
          return;
        }
        if (change.kind === 'responded' && change.response && interaction.scope.sessionId !== undefined) {
          this.settled({ configuredName: source.agentName, sessionId: interaction.scope.sessionId }, agentId,
            { agentName: source.agentName, interaction, response: structuredClone(change.response) });
        }
        if (change.kind === 'responded' || change.kind === 'withdrawn' || change.kind === 'closed') {
          this.questions.delete(interaction.interactionId);
        }
      }
      this.publish();
    });
    const stopPermissions = permissions?.subscribe(() => this.publish());
    const source: Source = { ...context, stop: () => { stopForms(); stopPermissions?.(); } };
    this.sources.set(agentId, source);
    for (const interaction of elicitations.snapshot()) {
      if (interaction.mode === 'form' && interaction.status === 'pending') {
        this.questions.set(interaction.interactionId, { agentName: source.agentName, agentId, interaction, draft: null });
      }
    }
    this.publish();
    return () => {
      if (this.sources.get(agentId) !== source) { return; }
      source.stop();
      this.sources.delete(agentId);
      for (const [id, question] of this.questions) { if (question.agentId === agentId) { this.questions.delete(id); } }
      this.publish();
    };
  }

  snapshot(identity: SessionIdentity | null): readonly RetainedQuestion[] {
    return [...this.questions.values()].filter((question) => this.visible(question, identity));
  }

  pending(identity: SessionIdentity, agentId: string): { permissions: readonly Readonly<PermissionRequest>[]; elicitations: readonly ElicitationInteraction[] } {
    const source = this.sources.get(agentId);
    if (source?.agentName !== identity.configuredName) { return { permissions: [], elicitations: [] }; }
    return {
      permissions: source.permissions?.snapshot().filter((request) => request.sessionId === identity.sessionId) ?? [],
      elicitations: source.elicitations.snapshot().filter((interaction) => interaction.scope.sessionId === identity.sessionId),
    };
  }

  private visible(question: RetainedQuestion, identity: SessionIdentity | null): boolean {
    const sessionId = question.interaction.scope.sessionId;
    return sessionId === undefined || identity !== null && sessionId === identity.sessionId && question.agentName === identity.configuredName
      && this.owner(identity, question.agentId) !== undefined;
  }

  private captured(id: string, target: Target): RetainedQuestion | undefined {
    const question = this.questions.get(id);
    if (!question || !this.sources.has(question.agentId)) { return; }
    if (question.interaction.scope.sessionId === undefined) { return target === null ? question : undefined; }
    return target !== null && this.visible(question, target) && this.owner(target, question.agentId) === target.generation ? question : undefined;
  }

  edit(id: string, target: Target, draft: Readonly<Record<string, ElicitationValue>>): void {
    const question = this.captured(id, target);
    if (question) { this.questions.set(id, { ...question, draft: structuredClone(draft) }); }
  }

  respond(id: string, target: Target, response: unknown): ElicitationResponseResult {
    const question = this.captured(id, target);
    return question ? this.sources.get(question.agentId)?.elicitations.respond(id, response) ?? { kind: 'stale' } : { kind: 'stale' };
  }

  subscribe(listener: (created?: RetainedQuestion) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  rename(from: string, to: string): void {
    for (const source of this.sources.values()) { if (source.agentName === from) { source.agentName = to; } }
    for (const [id, question] of this.questions) { if (question.agentName === from) { this.questions.set(id, { ...question, agentName: to }); } }
  }

  retire(agentId: string): void {
    const source = this.sources.get(agentId);
    source?.stop();
    this.sources.delete(agentId);
    for (const [id, question] of this.questions) { if (question.agentId === agentId) { this.questions.delete(id); } }
    this.publish();
  }

  private publish(created?: RetainedQuestion): void {
    for (const listener of this.listeners) { listener(created); }
  }
}
