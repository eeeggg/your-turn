import * as vscode from 'vscode';
import { SessionManager } from '@/core/sessions/Manager';

/**
 * Manages the status bar item showing the selected session's agent.
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(private readonly sessionManager: SessionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = 'your-turn.connectAgent';
    this.updateStatus();

    this.sessionManager.on('session-added', () => this.updateStatus());
    this.sessionManager.on('session-removed', () => this.updateStatus());
    this.sessionManager.on('active-session-changed', () => this.updateStatus());
    this.sessionManager.on('agent-closed', () => this.updateStatus());
  }

  private updateStatus(): void {
    const activeSession = this.sessionManager.getActiveSession();
    if (!activeSession) {
      this.statusBarItem.text = '$(hubot) Your Turn: No session';
      this.statusBarItem.tooltip = 'Click to connect to an agent';
    } else {
      const agentName = activeSession.agentDisplayName || activeSession.agentName;
      this.statusBarItem.text = `$(hubot) Your Turn: ${agentName}`;
      this.statusBarItem.tooltip = `In session with ${agentName}`;
    }

    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
