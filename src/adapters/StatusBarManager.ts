import * as vscode from 'vscode';
import { SessionManager } from '@/core/SessionManager';

/**
 * Manages the status bar item showing which agent has a session, if any.
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(private readonly sessionManager: SessionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = 'acp.connectAgent';
    this.updateStatus();

    this.sessionManager.on('session-added', () => this.updateStatus());
    this.sessionManager.on('session-removed', () => this.updateStatus());
    this.sessionManager.on('active-session-changed', () => this.updateStatus());
    this.sessionManager.on('agent-closed', () => this.updateStatus());
  }

  private updateStatus(): void {
    const activeSession = this.sessionManager.getActiveSession();
    const agentsWithSessions = this.sessionManager.getAgentNamesWithSessions();

    const firstAgent = agentsWithSessions[0];
    if (firstAgent === undefined) {
      this.statusBarItem.text = '$(hubot) ACP: No session';
      this.statusBarItem.tooltip = 'Click to connect to an agent';
    } else {
      const agentName = activeSession?.agentDisplayName || firstAgent;
      this.statusBarItem.text = `$(hubot) ACP: ${agentName}`;
      this.statusBarItem.tooltip = `In session with ${agentName}`;
    }

    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
