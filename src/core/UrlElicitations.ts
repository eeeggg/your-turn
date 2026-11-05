import type { ElicitationInteractions } from '@/core/ClientHandlers';
import type { ElicitationInteraction } from '@/core/acp/AcpDriver';
import { logError } from '@/core/Log';

type UrlInteraction = Extract<ElicitationInteraction, { mode: 'url' }>;

export interface UrlElicitationPrompt {
  choose(agentName: string, interaction: UrlInteraction, signal: AbortSignal): Promise<'accept' | 'decline' | 'cancel'>;
  open(url: string): PromiseLike<boolean>;
  failed(agentName: string): void;
}

export function attachUrlElicitations(agentName: string, requests: ElicitationInteractions, prompt: UrlElicitationPrompt): () => Promise<void> {
  const pending = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const present = async (interaction: UrlInteraction, controller: AbortController) => {
    try {
      const action = await prompt.choose(agentName, interaction, controller.signal);
      if (controller.signal.aborted) { return; }
      const result = requests.respond(interaction.interactionId, { action });
      pending.delete(interaction.interactionId);
      if (result.kind !== 'settled' || action !== 'accept') { return; }
      try {
        if (!await prompt.open(interaction.url)) { prompt.failed(agentName); }
      } catch { prompt.failed(agentName); }
    } catch (error) {
      if (!controller.signal.aborted) {
        requests.respond(interaction.interactionId, { action: 'cancel' });
        logError('Failed to present URL elicitation', error);
      }
    } finally { pending.delete(interaction.interactionId); }
  };
  const created = (interaction: ElicitationInteraction) => {
    if (interaction.mode !== 'url' || interaction.status !== 'pending') { return; }
    const controller = new AbortController();
    pending.set(interaction.interactionId, controller);
    const task = present(interaction, controller);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };
  const unsubscribe = requests.subscribe((change) => {
    if (change.kind === 'created') { created(change.interaction); }
    else if (change.kind === 'withdrawn' || change.kind === 'closed') {
      pending.get(change.interaction.interactionId)?.abort();
    }
  });
  for (const interaction of requests.snapshot()) { created(interaction); }
  return async () => {
    unsubscribe();
    for (const controller of pending.values()) { controller.abort(); }
    await Promise.all(tasks);
  };
}
