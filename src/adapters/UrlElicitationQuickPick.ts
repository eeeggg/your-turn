import * as vscode from 'vscode';
import type { UrlElicitationPrompt } from '@/core/UrlElicitations';

let previous: Promise<unknown> = Promise.resolve();

export const urlElicitationQuickPick: UrlElicitationPrompt = {
  choose(agentName, interaction, signal) {
    const selection = previous.then(async (): Promise<'accept' | 'decline' | 'cancel'> => {
      if (signal.aborted) { return 'cancel'; }
      const cancellation = new vscode.CancellationTokenSource();
      const abort = () => cancellation.cancel();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const target = new URL(interaction.url);
        const items: (vscode.QuickPickItem & { action: 'accept' | 'decline' })[] = [
          { label: 'Open URL', description: target.host, detail: interaction.url, action: 'accept' },
          { label: 'Decline', action: 'decline' },
        ];
        const choice = await vscode.window.showQuickPick(items, {
          title: `${agentName} — Open external URL`,
          placeHolder: interaction.message,
          ignoreFocusOut: true,
        }, cancellation.token);
        return choice?.action ?? 'cancel';
      } finally {
        signal.removeEventListener('abort', abort);
        cancellation.dispose();
      }
    });
    previous = selection.catch(() => {});
    return selection;
  },
  open: (url) => vscode.env.openExternal(vscode.Uri.parse(url, true)),
  failed(agentName) {
    void vscode.window.showWarningMessage(`Could not open the URL requested by ${agentName}. Your consent was sent, but this does not mean the external interaction completed.`);
  },
};
