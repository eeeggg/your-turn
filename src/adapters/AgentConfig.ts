import * as vscode from 'vscode';
import { activeAgents, sameAgentScope, type AgentConfigs, type AgentScope } from '@/core/AgentConfigScope';
import type { WorkspaceEnvironment } from '@/adapters/WorkspaceEnvironment';

/**
 * Read `scope`'s active agent configurations from VS Code settings: local entries, or the group for a known remote
 * authority. Empty, including for an authority not yet known, rather than falling back to another scope.
 */
export function getAgentConfigs(scope: AgentScope): AgentConfigs {
  return activeAgents(vscode.workspace.getConfiguration('your-turn').get<unknown>('agents'), scope);
}

/**
 * The names of `scope`'s active agent configurations.
 */
export function getAgentNames(scope: AgentScope): string[] {
  return Object.keys(getAgentConfigs(scope));
}

/** Compare lists for settings edits. Reset the comparison baseline when a webview changes the scope. */
export function watchAgentConfigs(
  environment: Pick<WorkspaceEnvironment, 'agentScope' | 'useWebview'>,
  refresh: (change?: { before: AgentConfigs; after: AgentConfigs }) => void,
) {
  let scope = environment.agentScope();
  let configs = getAgentConfigs(scope);
  const changed = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('your-turn.agents')) {
      const before = configs;
      configs = getAgentConfigs(scope);
      refresh({ before, after: configs });
    }
  });

  return {
    useWebview: (webview: Pick<vscode.Webview, 'asWebviewUri'> | undefined) => {
      environment.useWebview(webview);
      const current = environment.agentScope();
      if (sameAgentScope(scope, current)) { return; }
      scope = current;
      configs = getAgentConfigs(scope);
      refresh();
    },
    dispose: () => { changed.dispose(); },
  };
}
