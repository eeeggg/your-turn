import * as vscode from 'vscode';
import {
  otherWorkspaces,
  type OtherSession,
  type OtherWorkspace,
  type WorkspaceConfiguration
} from '@/core/OtherWorkspaces';
import type { SessionAddress, SessionReferences } from '@/core/PersistedState';
import type { WorkspaceOpening } from '@/core/WorkspaceOpening';
import type { AgentSessions, SessionList, SessionRow } from '@/core/SessionList';

/** Tier 1: a configured agent, expandable to its session list. */
class AgentTreeItem extends vscode.TreeItem {
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
      this.command = { command: 'your-turn.openChat', title: 'Open Chat View' };
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
 * `your-turn.openSession`, which loads or resumes it.
 */
class SessionTreeItem extends vscode.TreeItem {
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
      command: 'your-turn.openSession',
      title: 'Open Session',
      arguments: [{ agentName, sessionId: row.sessionId }],
    };
  }
}

/** A leaf under an agent that shows a status, a failure or a next step instead of a session. */
class InfoTreeItem extends vscode.TreeItem {
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

/** Other Workspaces mode, tier 1: a workspace sessions were used in, expandable to its configurations. */
class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(public readonly workspace: OtherWorkspace) {
    super(workspace.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'other-workspace';
    this.iconPath = new vscode.ThemeIcon('folder');
    if (workspace.description !== undefined) {
      this.description = workspace.description;
    }
    this.tooltip = workspace.uri;
  }
}

/** Other Workspaces mode, tier 2: a configuration sessions in the workspace were used through. */
class ConfigurationTreeItem extends vscode.TreeItem {
  constructor(public readonly configuration: WorkspaceConfiguration) {
    super(configuration.configuredName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'other-workspace-agent';
    this.iconPath = new vscode.ThemeIcon('hubot');
  }
}

/** Other Workspaces mode, tier 3: a session used through the configuration in the workspace. */
class OtherSessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: OtherSession) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'other-session';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    if (session.age !== undefined) {
      this.description = session.age;
    }
    this.tooltip = session.tooltip;
    this.command = { command: 'your-turn.openSessionInWorkspace', title: 'Open Session in Its Workspace', arguments: [session.reference] };
  }
}

type TreeNode = AgentTreeItem | SessionTreeItem | InfoTreeItem | WorkspaceTreeItem | ConfigurationTreeItem | OtherSessionTreeItem;

/** This workspace's agents, or the sessions of other workspaces. */
export type AgentsViewMode = 'agents' | 'otherWorkspaces';

/**
 * The Agents view: configured agents, each with its session list, or in Other Workspaces mode, the workspaces in
 * the session references other than this window's. A window where the extension is unavailable has no agents.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly redraw = () => this.changes.fire();
  private readonly agentsChanged = () => { if (this.mode === 'agents') { this.redraw(); } };
  private readonly referencesChanged = () => { if (this.mode === 'otherWorkspaces') { this.redraw(); } };
  private mode: AgentsViewMode = 'agents';

  constructor(
    private readonly sessionList: SessionList | undefined,
    private readonly references: Pick<SessionReferences, 'all' | 'on' | 'off'>,
    private readonly thisWorkspaceUri: () => string | undefined,
  ) {
    sessionList?.on('changed', this.agentsChanged);
    references.on('changed', this.referencesChanged);
  }

  show(mode: AgentsViewMode): void {
    this.mode = mode;
    this.redraw();
  }

  refresh(): void {
    this.redraw();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.mode === 'otherWorkspaces' ? this.otherWorkspaces() : this.agents();
    }
    if (element instanceof AgentTreeItem && this.sessionList) {
      return childrenOf(element.agentName, await this.sessionList.sessionsOf(element.agentName));
    }
    if (element instanceof WorkspaceTreeItem) {
      return element.workspace.configurations.map((configuration) => new ConfigurationTreeItem(configuration));
    }
    if (element instanceof ConfigurationTreeItem) {
      return element.configuration.sessions.map((session) => new OtherSessionTreeItem(session));
    }
    return [];
  }

  dispose(): void {
    this.sessionList?.off('changed', this.agentsChanged);
    this.references.off('changed', this.referencesChanged);
    this.changes.dispose();
  }

  private agents(): AgentTreeItem[] {
    return (this.sessionList?.agents() ?? []).map((agent) => new AgentTreeItem(
      agent.name,
      agent.hasSession,
      agent.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    ));
  }

  /** Read from the references each time, as other windows change them and no event says so. */
  private otherWorkspaces(): WorkspaceTreeItem[] {
    return otherWorkspaces(this.references.all(), this.thisWorkspaceUri(), Date.now()).map((workspace) => new WorkspaceTreeItem(workspace));
  }
}

/**
 * The Agents view, starting in this workspace's agents mode, with the commands switching it to other workspaces and
 * back, and opening another workspace's session there. It redraws when shown and when the window regains focus, as
 * other windows may have used sessions meanwhile.
 */
export function createAgentsView(
  sessionList: SessionList | undefined,
  references: Pick<SessionReferences, 'all' | 'on' | 'off'>,
  thisWorkspaceUri: () => string | undefined,
  opening: Pick<WorkspaceOpening, 'open'>,
): { provider: SessionTreeProvider; treeView: vscode.TreeView<TreeNode>; disposable: vscode.Disposable } {
  const provider = new SessionTreeProvider(sessionList, references, thisWorkspaceUri);
  const treeView = vscode.window.createTreeView('your-turn-sessions', { treeDataProvider: provider });
  const show = (mode: AgentsViewMode) => {
    provider.show(mode);
    treeView.title = mode === 'otherWorkspaces' ? 'Other Workspaces' : 'Agents';
    return vscode.commands.executeCommand('setContext', 'your-turn.showingOtherWorkspaces', mode === 'otherWorkspaces');
  };
  const disposable = vscode.Disposable.from(
    treeView,
    vscode.commands.registerCommand('your-turn.showOtherWorkspaces', () => show('otherWorkspaces')),
    vscode.commands.registerCommand('your-turn.showAgents', () => show('agents')),
    vscode.commands.registerCommand('your-turn.openSessionInWorkspace', (address?: SessionAddress) => address && opening.open(address)),
    treeView.onDidChangeVisibility(({ visible }) => {
      if (visible) {
        provider.refresh();
      }
    }),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (focused) {
        provider.refresh();
      }
    }),
    { dispose: () => provider.dispose() },
  );
  return { provider, treeView, disposable };
}

function childrenOf(agentName: string, sessions: AgentSessions): (SessionTreeItem | InfoTreeItem)[] {
  switch (sessions.kind) {
    case 'loading':
      return [new InfoTreeItem('loading', agentName, 'Loading sessions…')];
    case 'auth-required':
      return [new InfoTreeItem('auth-required', agentName, 'Authentication required', 'Click to retry authentication.', {
        command: 'your-turn.refreshSessions',
        title: 'Retry authentication',
        arguments: [agentName],
      })];
    case 'failed':
      return [new InfoTreeItem('error', agentName, 'Failed to load sessions', sessions.message, {
        command: 'your-turn.refreshSessions',
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
  const loadMore: vscode.Command = { command: 'your-turn.loadMoreSessions', title: 'Load more sessions', arguments: [agentName] };
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
