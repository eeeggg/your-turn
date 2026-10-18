import * as vscode from 'vscode';

import { AgentConfigurations } from '@/core/AgentConfigurations';
import { AgentManager } from '@/core/AgentManager';
import { ConnectionManager } from '@/core/ConnectionManager';
import { SessionCommands } from '@/core/SessionCommands';
import { SessionManager } from '@/core/SessionManager';
import { SessionHistoryStore } from '@/core/SessionHistoryStore';
import { SessionList } from '@/core/SessionList';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { ChatViewController } from '@/core/ChatViewController';
import { fetchRegistry } from '@/core/RegistryClient';
import { log, setLogSink } from '@/core/Log';
import { SessionTreeProvider } from '@/adapters/SessionTreeProvider';
import { StatusBarManager } from '@/adapters/StatusBarManager';
import { ChatWebviewProvider } from '@/adapters/ChatWebviewProvider';
import { PermissionRequests } from '@/core/PermissionRequests';
import { ProcessTerminals } from '@/core/ProcessTerminals';
import { FileSystemHandler } from '@/adapters/FileSystemHandler';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';
import { pseudoterminalDisplays } from '@/adapters/PseudoterminalDisplays';
import { workspaceEnvironment } from '@/adapters/WorkspaceEnvironment';
import { authMethodPicker } from '@/adapters/AuthMethodPicker';
import { getAgentNames } from '@/adapters/AgentConfig';
import { outputChannelSink, disposeChannels, getOutputChannel, getTrafficChannel } from '@/adapters/OutputChannels';

export function activate(context: vscode.ExtensionContext): void {
  setLogSink(outputChannelSink);
  log('ACP Client extension activating...');

  // --- Core services ---
  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  const connectionManager = new ConnectionManager(
    sessionUpdateHandler,
    context.extension.packageJSON.version,
    () => ({
      files: new FileSystemHandler(),
      terminals: new ProcessTerminals(pseudoterminalDisplays),
      permissions: new PermissionRequests(permissionQuickPick),
    }),
  );
  const sessionManager = new SessionManager(
    agentManager,
    connectionManager,
    workspaceEnvironment,
    authMethodPicker,
  );

  // Session history: the session list's source for agents that can load or
  // resume sessions but cannot list them.
  const historyStore = new SessionHistoryStore(context.workspaceState);
  sessionManager.setHistoryStore(historyStore);
  context.subscriptions.push({ dispose: () => historyStore.dispose() });

  // --- UI ---
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sessionList = new SessionList(sessionManager, historyStore, getAgentNames, workspaceCwd);
  const sessionTreeProvider = new SessionTreeProvider(sessionList);
  const treeView = vscode.window.createTreeView('acp-sessions', {
    treeDataProvider: sessionTreeProvider,
  });
  const agentsChanged = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('acp.agents')) {
      sessionTreeProvider.refresh();
    }
  });

  const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri);
  const chatViewController = new ChatViewController(sessionManager, chatWebviewProvider);
  const chatMessageSubscription = chatWebviewProvider.onDidReceiveMessage((message) => {
    void chatViewController.handleMessage(message);
  });
  sessionUpdateHandler.addListener((update) => chatViewController.handleSessionUpdate(update));
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatWebviewProvider.viewType,
    chatWebviewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const statusBarManager = new StatusBarManager(sessionManager);

  // Notify chat webview when active session changes
  sessionManager.on('active-session-changed', () => {
    chatViewController.notifyActiveSessionChanged();
  });

  // Clear chat when a new session is started
  sessionManager.on('clear-chat', () => {
    chatViewController.clearChat();
  });

  // Forward mode changes to webview
  sessionManager.on('mode-changed', (_sessionId: string, _modeId: string) => {
    const session = sessionManager.getActiveSession();
    if (session?.modes) {
      chatViewController.notifyModesUpdate(session.modes);
    }
  });

  // Session-load replay state — drive the webview overlay.
  sessionManager.on('session-load-start', () => {
    chatViewController.notifyLoadSessionStart();
  });
  sessionManager.on('session-load-end', (_sessionId: string, _agentName: string, ok: boolean) => {
    chatViewController.notifyLoadSessionEnd(ok);
    if (ok) {
      // The loadSession response carries modes/configOptions for the
      // restored session. Re-send the state so the pickers pick them up
      // (the original `active-session-changed` was emitted before the RPC
      // resolved, when those fields were still null).
      chatViewController.notifyActiveSessionChanged();
    }
  });

  // --- Commands ---
  const sessionCommands = new SessionCommands(sessionManager, chatViewController, vscode.window, vscode.commands, getAgentNames);
  const agentConfigurations = new AgentConfigurations(
    () => vscode.workspace.getConfiguration('acp'),
    sessionManager,
    vscode.window,
    fetchRegistry,
  );
  const focusChat = () => vscode.commands.executeCommand('acp-chat.focus');

  context.subscriptions.push(
    treeView,
    agentsChanged,
    chatViewRegistration,
    chatMessageSubscription,
    statusBarManager,
    vscode.commands.registerCommand('acp.connectAgent', (arg?: unknown) => sessionCommands.connect(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.newSession', () => sessionCommands.newSession()),
    vscode.commands.registerCommand('acp.disconnectAgent', (arg?: unknown) => sessionCommands.disconnect(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.restartAgent', (arg?: unknown) => sessionCommands.restart(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.cancelTurn', () => sessionCommands.cancelTurn()),
    vscode.commands.registerCommand('acp.setMode', (modeId?: string) => sessionCommands.setMode(modeId)),
    vscode.commands.registerCommand('acp.setModel', (modelId?: string) => sessionCommands.setModel(modelId)),
    vscode.commands.registerCommand('acp.openSession', (arg?: SessionArgument) => sessionCommands.open(arg?.agentName, arg?.sessionId)),
    vscode.commands.registerCommand('acp.openChat', focusChat),
    // Bound to a key: there is no prompt to send outside the chat view.
    vscode.commands.registerCommand('acp.sendPrompt', focusChat),
    vscode.commands.registerCommand('acp.showLog', () => getOutputChannel().show()),
    vscode.commands.registerCommand('acp.showTraffic', () => getTrafficChannel().show()),
    vscode.commands.registerCommand('acp.refreshAgents', () => sessionTreeProvider.refresh()),
    vscode.commands.registerCommand('acp.refreshSessions', (arg?: unknown) => sessionList.invalidate(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.loadMoreSessions', async (agentName?: string) => {
      if (agentName) {
        await sessionList.loadMore(agentName);
      }
    }),
    vscode.commands.registerCommand('acp.copySessionId', async (arg?: SessionArgument) => {
      if (!arg?.sessionId) { return; }
      await vscode.env.clipboard.writeText(arg.sessionId);
      void vscode.window.showInformationMessage(`Copied session ID: ${arg.sessionId}`);
    }),
    vscode.commands.registerCommand('acp.forgetSession', (arg?: SessionArgument) => {
      if (arg?.agentName && arg.sessionId) {
        historyStore.forget(arg.agentName, arg.sessionId);
      }
    }),
    vscode.commands.registerCommand('acp.addAgent', () => agentConfigurations.add()),
    vscode.commands.registerCommand('acp.removeAgent', (arg?: unknown) => agentConfigurations.remove(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.browseRegistry', () => agentConfigurations.browseRegistry()),
    vscode.commands.registerCommand('acp.attachFile', async () => {
      const [uri] = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Attach',
        title: 'Attach File to Chat',
      }) ?? [];
      if (uri) {
        chatWebviewProvider.attachFile(uri);
      }
    }),
    {
      dispose: () => {
        sessionManager.dispose();
        sessionUpdateHandler.dispose();
        chatWebviewProvider.dispose();
        sessionTreeProvider.dispose();
        sessionList.dispose();
        disposeChannels();
      },
    },
  );

  log('ACP Client extension activated.');
}

export function deactivate(): void {
  log('ACP Client extension deactivated.');
}

/** A session tree item, or the argument of its `acp.openSession` command. */
interface SessionArgument {
  agentName?: string;
  sessionId?: string;
}

/** Agent commands receive an agent name, a tree item carrying one, or nothing. */
function agentNameOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  const agentName = (arg as { agentName?: unknown } | undefined)?.agentName;
  return typeof agentName === 'string' ? agentName : undefined;
}
