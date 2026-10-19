import * as vscode from 'vscode';
import type { AgentSessions, SessionList, SessionRow } from '@/core/SessionList';

/** Tier 1: a configured agent, expandable to its session list. */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly hasSession: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(agentName, collapsibleState);

    if (hasSession) {
      this.contextValue = 'agent-with-session';
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('testing.iconPassed'),
      );
      this.description = 'in session';
      this.command = { command: 'acp.openChat', title: 'Open Chat View' };
    } else {
      this.contextValue = 'agent-without-session';
      this.iconPath = new vscode.ThemeIcon('circle-outline');
      this.description = '';
    }

    this.tooltip = hasSession
      ? `${agentName} — in session\nClick to open the chat view`
      : `${agentName} — no session\nUse the plug icon to connect`;
  }
}

/**
 * Tier 2: a past session of an agent. Clicking it routes to
 * `acp.openSession`, which loads or resumes it.
 */
export class SessionTreeItem extends vscode.TreeItem {
  public readonly sessionId: string;

  constructor(
    public readonly agentName: string,
    row: SessionRow,
    source: 'agent' | 'history',
  ) {
    super(row.label, vscode.TreeItemCollapsibleState.None);
    this.sessionId = row.sessionId;
    this.contextValue = source === 'history' ? 'session-local' : 'session';
    if (row.age !== undefined) {
      this.description = row.age;
    }
    this.tooltip = row.tooltip;
    if (row.isActive) {
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('testing.iconPassed'),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon('comment-discussion');
    }
    this.command = {
      command: 'acp.openSession',
      title: 'Open Session',
      arguments: [{ agentName, sessionId: row.sessionId }],
    };
  }
}

/** A leaf under an agent that shows a status, a failure or a next step instead of a session. */
export class InfoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind:
      | 'loading'
      | 'empty'
      | 'unsupported'
      | 'error'
      | 'auth-required'
      | 'load-more',
    public readonly agentName: string,
    label: string,
    tooltip?: string,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    if (command) {
      this.command = command;
    }
    switch (kind) {
      case 'loading':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        this.contextValue = 'session-info-loading';
        break;
      case 'empty':
        this.iconPath = new vscode.ThemeIcon('inbox');
        this.contextValue = 'session-info-empty';
        break;
      case 'unsupported':
        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'session-info-unsupported';
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon('warning');
        this.contextValue = 'session-info-error';
        break;
      case 'auth-required':
        this.iconPath = new vscode.ThemeIcon('key');
        this.contextValue = 'session-info-auth';
        break;
      case 'load-more':
        this.iconPath = new vscode.ThemeIcon('chevron-down');
        this.contextValue = 'session-info-load-more';
        break;
    }
  }
}

type TreeNode = AgentTreeItem | SessionTreeItem | InfoTreeItem;

/** The ACP Agents view: configured agents, each with its session list. */
export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly redraw = () => this.changes.fire();

  constructor(private readonly sessionList: SessionList) {
    sessionList.on('changed', this.redraw);
  }

  refresh(): void {
    this.redraw();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.sessionList.agents().map((agent) => new AgentTreeItem(
        agent.name,
        agent.hasSession,
        agent.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      ));
    }
    if (element instanceof AgentTreeItem) {
      return childrenOf(element.agentName, await this.sessionList.sessionsOf(element.agentName));
    }
    return [];
  }

  dispose(): void {
    this.sessionList.off('changed', this.redraw);
    this.changes.dispose();
  }
}

function childrenOf(agentName: string, sessions: AgentSessions): (SessionTreeItem | InfoTreeItem)[] {
  switch (sessions.kind) {
    case 'loading':
      return [new InfoTreeItem('loading', agentName, 'Loading sessions…')];
    case 'auth-required':
      return [new InfoTreeItem('auth-required', agentName, 'Authentication required', 'Click to retry authentication.', {
        command: 'acp.refreshSessions',
        title: 'Retry authentication',
        arguments: [agentName],
      })];
    case 'failed':
      return [new InfoTreeItem('error', agentName, 'Failed to load sessions', sessions.message, {
        command: 'acp.refreshSessions',
        title: 'Retry',
        arguments: [agentName],
      })];
    case 'unsupported':
      return [new InfoTreeItem(
        'unsupported',
        agentName,
        'Session list not supported',
        'This agent does not advertise session/list, session/load, or session/resume.\n'
          + 'You can still start a new session from the agent row.',
      )];
    case 'listed':
      break;
  }

  const { rows, more, source } = sessions;
  if (rows.length === 0 && more.kind === 'none') {
    return [new InfoTreeItem(
      'empty',
      agentName,
      '(no previous sessions)',
      source === 'history' ? 'Sessions you start with this agent will appear here.' : undefined,
    )];
  }

  const items: (SessionTreeItem | InfoTreeItem)[] = rows.map((row) => new SessionTreeItem(agentName, row, source));
  const loadMore: vscode.Command = { command: 'acp.loadMoreSessions', title: 'Load more sessions', arguments: [agentName] };
  switch (more.kind) {
    case 'available':
      items.push(new InfoTreeItem('load-more', agentName, 'Load more…', undefined, loadMore));
      break;
    case 'loading':
      items.push(new InfoTreeItem('loading', agentName, 'Loading more sessions…'));
      break;
    case 'failed':
      items.push(new InfoTreeItem('error', agentName, 'Failed to load more sessions', more.message, loadMore));
      break;
    case 'none':
      break;
  }
  return items;
}
