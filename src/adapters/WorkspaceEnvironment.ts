import * as vscode from 'vscode';
import type { SessionEnvironment } from '@/core/SessionManager';
import { getAgentConfigs } from './AgentConfig';

export const workspaceEnvironment: SessionEnvironment = {
  workspaceCwd() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd || process.cwd();
  },

  agentConfigs: getAgentConfigs,

  activeFileLink() {
    const cfg = vscode.workspace.getConfiguration('acp');
    if (!cfg.get<boolean>('includeActiveFile', true)) {
      return undefined;
    }
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor || !editor.document || editor.document.uri.scheme === 'output') {
      return undefined;
    }
    return {
      uri: editor.document.uri.toString(),
      name: editor.document.uri.fsPath,
      ...(editor.document.uri.scheme === 'untitled' ? { mimeType: 'text/plain' } : {}),
    };
  },
};
