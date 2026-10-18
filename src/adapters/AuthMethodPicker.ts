import * as vscode from 'vscode';
import type { AuthPrompt } from '@/core/SessionManager';

export const authMethodPicker: AuthPrompt = {
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

    const picked = await vscode.window.showQuickPick(
      methods.map(m => ({
        label: m.name,
        description: m.description || '',
        detail: `ID: ${m.id}`,
        method: m,
      })),
      {
        placeHolder: 'Select an authentication method',
        title: `${agentName} requires authentication`,
      },
    );
    return picked?.method;
  },
};
