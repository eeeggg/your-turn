import * as vscode from 'vscode';

import { AgentConfigurations } from '@/core/AgentConfigurations';
import { AgentManager, findOnPath } from '@/core/AgentManager';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { checkPackageRunner } from '@/core/PackageRunners';
import { SessionCommands } from '@/core/SessionCommands';
import { SessionStartup } from '@/core/SessionStartup';
import { SessionManager } from '@/core/SessionManager';
import { SessionReferences, StartupRequests, WorkspaceState } from '@/core/PersistedState';
import { SessionList, type AgentSessions } from '@/core/SessionList';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { AgentTerminals, type CommandSource } from '@/core/AgentTerminals';
import type { Change } from '@/core/review/Hunks';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';
import { Takeovers } from '@/core/review/Takeovers';
import { ChatViewController, type DiffFileChoice } from '@/core/ChatViewController';
import { fetchRegistry, registryPlatform } from '@/core/RegistryClient';
import { logError, logInfo, logWarning, setLogSink } from '@/core/Log';
import { createAgentsView } from '@/adapters/SessionTreeProvider';
import { StatusBarManager } from '@/adapters/StatusBarManager';
import { ChatWebviewProvider } from '@/adapters/ChatWebviewProvider';
import { ReportedFileEditor } from '@/adapters/ReportedFileEditor';
import { pseudoterminalDisplays } from '@/adapters/PseudoterminalDisplays';
import { workspaceFiles } from '@/adapters/review/WorkspaceFiles';
import { ReviewPresenters } from '@/adapters/review/ReviewPresenters';
import { ReviewSourceControl } from '@/adapters/review/ReviewSourceControl';
import { ReviewTakeovers } from '@/adapters/review/ReviewTakeovers';
import { DiffReviewPresentation } from '@/adapters/review/DiffReviewPresentation';
import { PermissionRequests } from '@/core/PermissionRequests';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';
import { attachUrlElicitations } from '@/core/UrlElicitations';
import { urlElicitationQuickPick } from '@/adapters/UrlElicitationQuickPick';
import { createWorkspaceEnvironment, openWorkspace, workspaceUnavailability } from '@/adapters/WorkspaceEnvironment';
import { WorkspaceOpening } from '@/core/WorkspaceOpening';
import { PersistedStateCommands } from '@/adapters/PersistedStateCommands';
import { authMethodPicker } from '@/adapters/AuthMethodPicker';
import { getAgentConfigs, getAgentNames } from '@/adapters/AgentConfig';
import { outputChannelSink, disposeChannels, getOutputChannel } from '@/adapters/OutputChannels';
import { registerTrafficAdapter } from '@/adapters/Traffic';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';

let shutdown: (() => Promise<void>) | undefined;

/**
 * What `activate` returns in extension tests, and only there. Each test bundles its own copies of `src/`, so it cannot
 * reach the extension's objects otherwise.
 */
export interface ExtensionTestApi {
  /** The messages the chat view's webview sends the extension. */
  readonly chatMessages: vscode.Event<WebviewToExtensionMessage>;
  /** The messages the extension delivers to the chat view's webview. */
  readonly chatPosts: vscode.Event<ExtensionToWebviewMessage>;
  /** Settles once the chat view's script has loaded, which it says once however often the view is shown. */
  readonly chatViewReady: Promise<void>;
  /** Handle a message as if the chat view's webview sent it, as a test cannot type into the webview. */
  sendChatMessage(message: WebviewToExtensionMessage): Promise<void>;
  /** The paths under review in the shown review, as its presenters show them but VS Code cannot read back. */
  reviewedFiles(): string[];
  /** Fires whenever the shown review or one of its files changes. */
  readonly reviewChanges: vscode.Event<void>;
  /** The original the review's source control gives quick diff for `uri`, as VS Code cannot be asked for it. */
  reviewOriginal(uri: vscode.Uri): vscode.Uri | undefined;
  /** The paths the review's source control lists, which VS Code cannot read back. */
  reviewListedFiles(): string[];
  /** Settles once the change shown as the last turn ended is, as it opens an editor some time after the turn ends. */
  turnEndShown(): Promise<void>;
  /** Settles once the latest quick-diff presentation caused by changing tabs does. */
  reviewPresentationSettled(): Promise<void>;
  /**
   * Settles once every write the extension started to its storage has, including those waiting for the workspace
   * target, as nothing it does waits for them.
   */
  persistedStateSettled(): Promise<void>;
  /** The extension's workspace storage, which only its own context reaches. */
  readonly storage: { readonly workspaceState: vscode.Memento };
  /**
   * The extension's own session references, the only way tests reach global state: VS Code can serve an earlier
   * global-state value after a write, which this instance reconciles, and another instance is in effect another window.
   */
  readonly sessionReferences: SessionReferences;
  /** What the Agents view shows under an agent, which VS Code cannot read back from a tree. */
  sessionsOf(agentName: string): Promise<AgentSessions>;
  /** Fires whenever what the Agents view would show under any agent changes. */
  readonly sessionsChanged: vscode.Event<void>;
}

export function activate(context: vscode.ExtensionContext): ExtensionTestApi | undefined {
  setLogSink(outputChannelSink);
  const unavailability = workspaceUnavailability(vscode.workspace);
  if (unavailability) {
    logInfo('ACP Client is unavailable in this window', { unavailability });
    void vscode.commands.executeCommand('setContext', 'acp.workspaceUnavailable', unavailability);
    // Only the Agents view's Other Workspaces mode, which opens a workspace where the extension is available.
    const opening = new WorkspaceOpening(new StartupRequests(context.globalState), openWorkspace, vscode.window);
    context.subscriptions.push(
      createAgentsView(undefined, new SessionReferences(context.globalState), () => undefined, opening).disposable,
      { dispose: disposeChannels },
    );
    return undefined;
  }
  registerTrafficAdapter(context.subscriptions);
  logInfo('ACP Client extension activating');

  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  const connectionManager: ConnectionManager = new ConnectionManager(
    sessionUpdateHandler,
    (context.extension.packageJSON as { version: string }).version,
    ({ agentName, agentId, elicitations }) => {
      const detachForms = chatViewController.attachElicitations(agentName, elicitations, agentId);
      const detachUrls = attachUrlElicitations(agentName, elicitations, urlElicitationQuickPick);
      return {
        permissions: new PermissionRequests(permissionQuickPick),
        close: () => { detachForms(); void detachUrls(); },
      };
    },
  );
  const sessionReferences = new SessionReferences(context.globalState);
  const workspaceState = new WorkspaceState(context.workspaceState);
  void workspaceState.discardRetired();
  const workspaceEnvironment = createWorkspaceEnvironment(workspaceState);
  const sessionManager = new SessionManager(
    agentManager,
    connectionManager,
    workspaceEnvironment,
    authMethodPicker,
  );
  sessionManager.setPersistedState(sessionReferences, workspaceState);

  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sessionList = new SessionList(sessionManager, sessionReferences, getAgentNames, workspaceCwd, () => workspaceEnvironment.workspaceTarget());
  const sessionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(sessionsChanged);
  sessionList.on('changed', () => sessionsChanged.fire());
  const startupRequests = new StartupRequests(context.globalState);
  void startupRequests.discardExpired();
  const agentsView = createAgentsView(
    sessionList,
    sessionReferences,
    () => workspaceEnvironment.workspaceTarget()?.uri,
    new WorkspaceOpening(startupRequests, openWorkspace, vscode.window),
  );
  const { provider: sessionTreeProvider, treeView } = agentsView;
  const persistedStateCommands = new PersistedStateCommands(
    context.workspaceState,
    context.globalState,
    sessionReferences,
    () => workspaceEnvironment.workspaceTarget(),
  );
  // Session ages count minutes, so the tree redraws each minute while it shows.
  let ageTicker: ReturnType<typeof setInterval> | undefined;
  const tickAges = (visible: boolean) => {
    clearInterval(ageTicker);
    ageTicker = visible ? setInterval(() => sessionTreeProvider.refresh(), 60_000) : undefined;
  };
  tickAges(treeView.visible);
  const treeVisibilityChanged = treeView.onDidChangeVisibility(({ visible }) => {
    if (visible) {
      void sessionList.refreshAll();
    }
    tickAges(visible);
  });
  const windowFocused = vscode.window.onDidChangeWindowState(({ focused }) => {
    if (focused) {
      void sessionList.refreshAll();
    }
  });
  // The Agents view's welcome is shown on this rather than on the tree being empty, which VS Code assumes until the
  // tree's first items arrive; `when` clauses cannot test the `acp.agents` object for emptiness themselves.
  const markNoAgentsConfigured = () => void vscode.commands.executeCommand('setContext', 'acp.noAgentsConfigured', getAgentNames().length === 0);
  markNoAgentsConfigured();
  // The change event carries no previous value, so renames are found against the map as it was last read.
  let agentConfigs = getAgentConfigs();
  const agentsChanged = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('acp.agents')) {
      const previous = agentConfigs;
      agentConfigs = getAgentConfigs();
      sessionManager.agentsChanged(previous, agentConfigs);
      markNoAgentsConfigured();
      sessionTreeProvider.refresh();
    }
  });

  const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, (webview) => workspaceEnvironment.useWebview(webview));
  const reportedFileEditor = new ReportedFileEditor();
  const agentTerminals = new AgentTerminals(pseudoterminalDisplays);
  const chatViewController = new ChatViewController(sessionManager, chatWebviewProvider, reportedFileEditor, agentTerminals);
  const chatMessageSubscription = chatWebviewProvider.onDidReceiveMessage((message) => {
    void chatViewController.handleMessage(message);
  });
  const chatViewReady = new Promise<void>((resolve) => {
    const readiness = chatWebviewProvider.onDidReceiveMessage((message) => {
      if (message.type === 'ready') {
        readiness.dispose();
        resolve();
      }
    });
  });
  sessionUpdateHandler.addListener((sessionId, update) => chatViewController.handleSessionUpdate(sessionId, update));
  sessionUpdateHandler.addListener((sessionId, update) => agentTerminals.handleSessionUpdate(sessionId, update));
  const reviews = new Reviews(workspaceFiles);
  let disposal: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (disposal) { return disposal; }
    sessionUpdateHandler.dispose();
    chatMessageSubscription.dispose();
    const output = chatViewController.dispose();
    const terminals = agentTerminals.dispose();
    reviewSourceControl.dispose();
    const takeovers = reviewTakeovers.dispose();
    const presenters = reviewPresenters.dispose();
    const diffs = reviewDiffs.dispose();
    const review = reviews.dispose();
    const sessions = sessionManager.dispose();
    disposal = Promise.allSettled([output, terminals, takeovers, presenters, diffs, review, sessions, turnEndShown]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to shut down ACP Client');
      }
    });
    return disposal;
  };
  shutdown = stop;
  const reviewChanges = new vscode.EventEmitter<void>();
  context.subscriptions.push(reviewChanges);
  reviews.addListener(() => reviewChanges.fire());
  sessionUpdateHandler.addListener((sessionId, update, schema) => { void reviews.handleSessionUpdate(sessionId, update, schema); });
  const reviewDiffs = new DiffReviewPresentation(reviews);
  const reviewControls = new ReviewControls(reviews, reviewDiffs);
  reviewDiffs.attach(reviewControls);
  const reviewPresenters = new ReviewPresenters(reviewControls, reviews);
  chatViewController.addTurnListener((inProgress) => reviewPresenters.turnInProgress(inProgress));
  const reviewSourceControl = new ReviewSourceControl(reviewControls, reviews);
  const reviewTakeovers = new ReviewTakeovers(new Takeovers(reviews), reviewControls);
  sessionManager.on('session-removed', (sessionId) => {
    agentTerminals.endSession(sessionId);
    reviews.sessionRemoved(sessionId);
    chatViewController.notifySessionRemoved(sessionId);
  });
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatWebviewProvider.viewType,
    chatWebviewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const statusBarManager = new StatusBarManager(sessionManager);

  sessionManager.on('active-session-changed', (sessionId) => {
    reviews.activeSessionChanged(sessionId);
    chatViewController.notifyActiveSessionChanged();
  });
  sessionManager.on('session-ended', (sessionId, reason) => {
    chatViewController.notifySessionEnded(sessionId, reason);
  });
  let turnEndShown = Promise.resolve();
  sessionManager.on('turn-ended', (sessionId) => {
    if (sessionId !== sessionManager.getActiveSessionId()) { return; }
    turnEndShown = reviewControls.turnEnded(sessionId).catch((e: unknown) => logError("Showing the turn's change failed", e));
  });
  sessionManager.on('clear-transcript', () => {
    chatViewController.clearTranscript();
  });
  sessionManager.on('mode-changed', () => {
    chatViewController.notifyPickersChanged();
  });
  sessionManager.on('session-load-start', (sessionId) => {
    // The load replays the terminals' updates, which would add their chunks to what is kept again.
    agentTerminals.forgetSession(sessionId);
    reviews.loadStarted(sessionId);
    chatViewController.notifyLoadSessionStart(sessionId);
  });
  sessionManager.on('session-load-end', (sessionId, _agentName, ok) => {
    reviews.loadEnded(sessionId);
    chatViewController.notifyLoadSessionEnd(ok);
    if (ok) {
      // The loadSession response carries modes/configOptions for the
      // restored session. Re-send the state so the pickers pick them up
      // (the original `active-session-changed` was emitted before the RPC
      // resolved, when those fields were still null).
      chatViewController.notifyActiveSessionChanged();
    }
  });

  const sessionStartup = new SessionStartup(sessionManager, workspaceState, workspaceEnvironment, startupRequests);
  const sessionCommands = new SessionCommands(
    sessionManager, chatViewController, reviewControls, vscode.window, vscode.commands, getAgentNames, sessionStartup,
  );
  void sessionCommands.revealRequested();
  void chatViewReady.then(() => sessionCommands.restoreLastSession());
  // Opening a workspace already open in a window brings that window to the front instead of starting a new one.
  const requestedOnFocus = vscode.window.onDidChangeWindowState(({ focused }) => {
    if (focused) {
      void sessionCommands.openRequested();
    }
  });
  const agentConfigurations = new AgentConfigurations(
    () => vscode.workspace.getConfiguration('acp'),
    sessionManager,
    vscode.window,
    {
      fetchRegistry,
      checkRunner: (runner) => checkPackageRunner(agentManager, runner, workspaceEnvironment.workspaceRoots().cwd),
      findOnPath,
      platform: registryPlatform(),
    },
  );
  const focusChatView = () => vscode.commands.executeCommand('acp-chat.focus');
  /**
   * The review's decisions wait for the agent's turn to end, so none acts on a file the agent is writing. Their
   * `enablement` disables their buttons and keys, but not `executeCommand`, which runs a command regardless.
   */
  const unlessTurnRuns = <A extends unknown[]>(run: (...args: A) => unknown) =>
    (...args: A) => (chatViewController.hasRunningTurn ? undefined : run(...args));
  const chooseDiffFile = (arg: unknown, open: DiffFileChoice['open']) => {
    const choice = diffFileChoiceOf(arg, open);
    return choice && chatViewController.chooseDiffFile(choice);
  };

  context.subscriptions.push(
    agentsView.disposable,
    treeVisibilityChanged,
    windowFocused,
    requestedOnFocus,
    { dispose: () => tickAges(false) },
    agentsChanged,
    chatViewRegistration,
    chatMessageSubscription,
    reportedFileEditor,
    statusBarManager,
    vscode.commands.registerCommand('acp.connectAgent', (arg?: unknown) => sessionCommands.connect(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.newSession', () => sessionCommands.newSession()),
    vscode.commands.registerCommand('acp.disconnectAgent', (arg?: unknown) => sessionCommands.disconnect(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.restartAgent', (arg?: unknown) => sessionCommands.restart(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.cancelTurn', () => sessionCommands.cancelTurn()),
    vscode.commands.registerCommand('acp.setMode', (modeId?: string) => sessionCommands.setMode(modeId)),
    vscode.commands.registerCommand('acp.setModel', (modelId?: string) => sessionCommands.setModel(modelId)),
    vscode.commands.registerCommand('acp.openSession', (arg?: SessionArgument) => sessionCommands.open(arg?.agentName, arg?.sessionId)),
    vscode.commands.registerCommand('acp.openChat', focusChatView),
    vscode.commands.registerCommand('acp.sendPrompt', focusChatView),
    vscode.commands.registerCommand('acp.showLog', () => getOutputChannel().show()),
    vscode.commands.registerCommand('acp.refreshSessions', async (arg?: unknown) => {
      const agentName = agentNameOf(arg);
      if (agentName) {
        await sessionList.startOver(agentName);
      }
    }),
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
    vscode.commands.registerCommand('acp.removeFromHistory', async (arg?: SessionArgument) => {
      if (arg?.agentName && arg.sessionId) {
        await sessionManager.removeFromHistory(arg.agentName, arg.sessionId);
      }
    }),
    persistedStateCommands,
    vscode.commands.registerCommand('acp.showPersistedState', () => persistedStateCommands.show()),
    vscode.commands.registerCommand('acp.resetPersistedState', async () => {
      if (await persistedStateCommands.reset()) {
        sessionTreeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('acp.addAgent', () => agentConfigurations.add()),
    vscode.commands.registerCommand('acp.detectAgents', () => agentConfigurations.detect()),
    vscode.commands.registerCommand('acp.removeAgent', (arg?: unknown) => agentConfigurations.remove(agentNameOf(arg))),
    vscode.commands.registerCommand('acp.openToolCallFile', (arg?: unknown) => chooseDiffFile(arg, 'file')),
    vscode.commands.registerCommand('acp.openToolCallChanges', (arg?: unknown) => chooseDiffFile(arg, 'changes')),
    vscode.commands.registerCommand('acp.openCommandOutput', (arg?: unknown) => {
      const output = commandOutputOf(arg);
      if (output && !agentTerminals.open(output.sessionId, output.source, output.name)) {
        logWarning('Command output is no longer retained', { outputName: output.name });
      }
    }),
    vscode.commands.registerCommand('acp.openReview', unlessTurnRuns(() => reviewControls.openReview())),
    vscode.commands.registerCommand('acp.previousReviewFile', async (arg?: unknown) => {
      await reviewControls.previous(reviewPathOf(arg, reviewDiffs));
      await reviewPresenters.navigated();
    }),
    vscode.commands.registerCommand('acp.nextReviewFile', async (arg?: unknown) => {
      await reviewControls.next(reviewPathOf(arg, reviewDiffs));
      await reviewPresenters.navigated();
    }),
    vscode.commands.registerCommand('acp.undoFile', unlessTurnRuns((arg?: unknown) => {
      const path = reviewPathOf(arg, reviewDiffs);
      if (arg instanceof vscode.Uri && path === undefined) { return; }
      return reviewControls.undoFile(path);
    })),
    vscode.commands.registerCommand('acp.keepFile', unlessTurnRuns((arg?: unknown) => {
      const path = reviewPathOf(arg, reviewDiffs);
      if (arg instanceof vscode.Uri && path === undefined) { return; }
      return reviewControls.keepFile(path);
    })),
    vscode.commands.registerCommand('acp.keepAllFiles', unlessTurnRuns(() => reviewControls.keepAll())),
    vscode.commands.registerCommand('acp.keepChange', unlessTurnRuns((...args: unknown[]) => {
      const change = quickDiffChangeOf(args);
      return change && reviewControls.keepChange(change.path, change.change);
    })),
    vscode.commands.registerCommand('acp.keepDiffChange', unlessTurnRuns((arg?: unknown) => reviewDiffs.decide('keep', arg))),
    vscode.commands.registerCommand('acp.undoDiffChange', unlessTurnRuns((arg?: unknown) => reviewDiffs.decide('undo', arg))),
    vscode.commands.registerCommand('acp.undoChange', unlessTurnRuns((...args: unknown[]) => {
      const change = quickDiffChangeOf(args);
      return change && reviewControls.undoChange(change.path, change.change);
    })),
    vscode.commands.registerCommand('acp.attachFile', async () => {
      const [uri] = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Attach',
        title: 'Attach File to Prompt',
      }) ?? [];
      if (uri) {
        chatWebviewProvider.attachFile(uri);
      }
    }),
    {
      dispose: () => {
        void stop().catch((error: unknown) => logError('Failed to shut down ACP Client', error));
        chatWebviewProvider.dispose();
        sessionList.dispose();
        disposeChannels();
      },
    },
  );

  logInfo('ACP Client extension activated');
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return {
    chatMessages: chatWebviewProvider.onDidReceiveMessage,
    chatPosts: chatWebviewProvider.onDidPost,
    chatViewReady,
    sendChatMessage: (message) => chatViewController.handleMessage(message),
    reviewedFiles: () => reviewControls.reviewedPaths(),
    reviewChanges: reviewChanges.event,
    reviewOriginal: (uri) => reviewSourceControl.originalResource(uri),
    reviewListedFiles: () => reviewSourceControl.listedFiles(),
    turnEndShown: () => turnEndShown,
    reviewPresentationSettled: async () => { await reviewPresenters.settled(); await reviewDiffs.settled(); },
    persistedStateSettled: async () => {
      await sessionManager.recordsSettled();
      await sessionReferences.settled();
      await workspaceState.settled();
    },
    storage: { workspaceState: context.workspaceState },
    sessionReferences,
    sessionsOf: (agentName) => sessionList.sessionsOf(agentName),
    sessionsChanged: sessionsChanged.event,
  };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  logInfo('ACP Client extension deactivated');
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

/** The context menu on a diff's file passes the `data-vscode-context` the chat view gave it. */
function diffFileChoiceOf(arg: unknown, open: DiffFileChoice['open']): DiffFileChoice | undefined {
  const context = arg as { acpToolCallId?: unknown; acpDiffFile?: unknown } | undefined;
  const toolCallId = context?.acpToolCallId;
  const file = context?.acpDiffFile;
  return typeof toolCallId === 'string' && typeof file === 'number' ? { toolCallId, file, open } : undefined;
}

/** The title area passes its editor's URI; the status bar passes nothing, and so means the active editor's file. */
function reviewPathOf(arg: unknown, presentation: DiffReviewPresentation): string | undefined {
  return arg instanceof vscode.Uri ? presentation.pathOf(arg) : undefined;
}

/**
 * The quick diff view's title passes its document's URI, its changes and the index of the one shown. A change's lines are
 * 1-based and inclusive, and a side with none has an end of 0 and a start of the line before.
 */
function quickDiffChangeOf([uri, changes, index]: unknown[]): { path: string; change: Change } | undefined {
  if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file' || !Array.isArray(changes) || typeof index !== 'number') { return undefined; }
  const change = changes[index] as Partial<Record<
    'originalStartLineNumber' | 'originalEndLineNumber' | 'modifiedStartLineNumber' | 'modifiedEndLineNumber', unknown
  >> | undefined;
  const lines = (start: unknown, end: unknown) =>
    typeof start === 'number' && typeof end === 'number' ? (end === 0 ? { start, end: start } : { start: start - 1, end }) : undefined;
  const original = lines(change?.originalStartLineNumber, change?.originalEndLineNumber);
  const modified = lines(change?.modifiedStartLineNumber, change?.modifiedEndLineNumber);
  return original && modified ? { path: uri.fsPath, change: { original, modified } } : undefined;
}

/** The context menu on a command's output passes the `data-vscode-context` the chat view gave it. */
function commandOutputOf(arg: unknown): { sessionId: string; source: CommandSource; name: string } | undefined {
  const context = arg as { acpSessionId?: unknown; acpToolCallId?: unknown; acpTerminalId?: unknown; acpTitle?: unknown } | undefined;
  const { acpSessionId: sessionId, acpToolCallId: toolCallId, acpTerminalId: terminalId, acpTitle: name } = context ?? {};
  if (typeof sessionId !== 'string' || typeof name !== 'string') { return undefined; }
  if (typeof terminalId === 'string') { return { sessionId, source: { kind: 'terminal', terminalId }, name }; }
  return typeof toolCallId === 'string' ? { sessionId, source: { kind: 'toolCall', toolCallId }, name } : undefined;
}
