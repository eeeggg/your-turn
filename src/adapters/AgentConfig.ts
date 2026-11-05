import * as vscode from 'vscode';
import type { AgentConfigEntry } from '@/core/AgentManager';

/**
 * Read agent configurations from VS Code settings.
 * Returns a map of agent name → config.
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('your-turn');
  const agents = config.get<Record<string, AgentConfigEntry>>('agents', {});
  return agents;
}

/**
 * Get the list of agent names available.
 */
export function getAgentNames(): string[] {
  return Object.keys(getAgentConfigs());
}
