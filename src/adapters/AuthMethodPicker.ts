import * as vscode from 'vscode';
import type { AuthPrompt } from '@/core/SessionManager';
import type { AuthMethod } from '@/core/acp/AcpDriver';

/** Creates the authentication prompt, optionally reporting the method active in its quick pick. */
export function createAuthMethodPicker(active: (method: AuthMethod) => void = () => {}): AuthPrompt {
  return {
    async chooseAuthMethod(agentName, methods) {
      const [only] = methods;
      if (methods.length === 1 && only) {
        const confirm = await vscode.window.showInformationMessage(
          `${agentName} requires authentication via "${only.name}".`,
          { modal: true, ...(only.description ? { detail: only.description } : {}) },
          'Authenticate',
        );
        return confirm === 'Authenticate' ? only : undefined;
      }

      const items = methods.map(m => ({
        label: m.name,
        description: m.description || '',
        detail: `ID: ${m.id}`,
        method: m,
      }));
      const picked = await vscode.window.showQuickPick(
        items,
        {
          placeHolder: 'Select an authentication method',
          title: `${agentName} requires authentication`,
          onDidSelectItem: (item) => {
            const selected = items.find((candidate) => candidate === item);
            if (selected) { active(selected.method); }
          },
        },
      );
      return picked?.method;
    },
  };
}

export const authMethodPicker = createAuthMethodPicker();
