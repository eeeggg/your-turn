import * as vscode from 'vscode';
import type { AuthPrompt } from '@/core/SessionManager';
import type { AuthMethod } from '@/core/acp/AcpDriver';

/** Creates the authentication prompt, optionally reporting the method active in its quick pick. */
export function createAuthMethodPicker(active: (method: AuthMethod) => void = () => {}): AuthPrompt {
  return {
    async chooseAuthMethod(agentName, methods) {
      const [only] = methods;
      const single = methods.length === 1 ? only : undefined;
      const items: (vscode.QuickPickItem & { method?: AuthMethod })[] = methods.map(m => ({
        label: single ? 'Authenticate' : m.name,
        description: single ? m.name : m.description || '',
        detail: single ? m.description || `ID: ${m.id}` : `ID: ${m.id}`,
        method: m,
      }));
      if (single) { items.push({ label: 'Cancel' }); }
      const picked = await vscode.window.showQuickPick(
        items,
        {
          placeHolder: single ? `Authenticate via "${single.name}"?` : 'Select an authentication method',
          title: `${agentName} requires authentication`,
          onDidSelectItem: (item) => {
            const selected = items.find((candidate) => candidate === item);
            if (selected?.method) { active(selected.method); }
          },
        },
      );
      return picked?.method;
    },
  };
}

export const authMethodPicker = createAuthMethodPicker();
