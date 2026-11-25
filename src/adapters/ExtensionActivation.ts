import * as vscode from 'vscode';

import { AgentConfigurations } from '@/core/AgentConfigurations';
import { AgentManager, findOnPath } from '@/core/AgentManager';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { checkPackageRunner, type PackageRunner } from '@/core/PackageRunners';
import { SessionCommands } from '@/core/sessions/Commands';
import { SessionStartup } from '@/core/sessions/Startup';
import { SessionManager } from '@/core/sessions/Manager';
import { SessionReferences, StartupRequests, WorkspaceState } from '@/core/PersistedState';
import { SessionList, type AgentSessions } from '@/core/sessions/List';
import { SessionTabs } from '@/core/sessions/Tabs';
import { SessionUpdateHandler } from '@/core/sessions/UpdateHandler';
import type { CommandSource } from '@/core/AgentTerminals';
import type { Change } from '@/core/review/Hunks';
import { ReviewControls } from '@/core/review/ReviewControls';
import { Reviews } from '@/core/review/Reviews';
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
import {
  createWorkspaceEnvironment,
  openWorkspace,
  workspaceUnavailability
} from '@/adapters/WorkspaceEnvironment';
import { WorkspaceOpening } from '@/core/WorkspaceOpening';
import { PersistedStateCommands } from '@/adapters/PersistedStateCommands';
import { authMethodPicker } from '@/adapters/AuthMethodPicker';
import { getAgentNames, watchAgentConfigs } from '@/adapters/AgentConfig';
import { outputChannelSink, disposeChannels, getOutputChannel } from '@/adapters/OutputChannels';
import { registerTrafficAdapter } from '@/adapters/Traffic';
import type { ExtensionToWebviewMessage, PresentationTarget, WebviewToExtensionMessage } from '@/shared/WebviewMessages';

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

interface ActivationFactories {
  createAgentsView?: typeof createAgentsView;
  createReviewPresentation?: (reviews: Reviews) => DiffReviewPresentation;
}

export function activate(context: vscode.ExtensionContext, factories: ActivationFactories = {}): ExtensionTestApi | undefined {
  const agentsViewFactory = factories.createAgentsView ?? createAgentsView;
  setLogSink(outputChannelSink);
  const unavailability = workspaceUnavailability(vscode.workspace);
  if (unavailability) {
    logInfo('Your Turn is unavailable in this window', { unavailability });
    void vscode.commands.executeCommand('setContext', 'your-turn.workspaceUnavailable', unavailability);
    // Only the Agents view's Other Workspaces mode, which opens a workspace where the extension is available.
    const opening = new WorkspaceOpening(new StartupRequests(context.globalState), openWorkspace, vscode.window);
    context.subscriptions.push(
      agentsViewFactory(undefined, new SessionReferences(context.globalState), () => undefined, opening).disposable,
      { dispose: disposeChannels },
    );
    return undefined;
  }
  registerTrafficAdapter(context.subscriptions);
  logInfo('Your Turn extension activating');

  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  const connectionManager: ConnectionManager = new ConnectionManager(
    (context.extension.packageJSON as { version: string }).version,
    ({ agentName, elicitations }) => {
      const detachUrls = attachUrlElicitations(agentName, elicitations, urlElicitationQuickPick);
      const permissions = new PermissionRequests(permissionQuickPick);
      return {
        permissions, permissionInteractions: permissions,
        close: () => { void detachUrls(); },
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
    sessionUpdateHandler,
    pseudoterminalDisplays,
  );
  sessionManager.setPersistedState(sessionReferences, workspaceState);

  const sessionTabs = new SessionTabs({ workspace: workspaceState, references: sessionReferences, environment: workspaceEnvironment });
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const agentNames = () => getAgentNames(workspaceEnvironment.agentScope());
  const sessionList = new SessionList(
    sessionManager, sessionReferences, agentNames, workspaceCwd, () => workspaceEnvironment.workspaceTarget(), Date.now, sessionTabs,
  );
  const sessionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(sessionsChanged);
  sessionList.on('changed', () => sessionsChanged.fire());
  const startupRequests = new StartupRequests(context.globalState);
  void startupRequests.discardExpired();
  const agentsView = agentsViewFactory(
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
  // tree's first items arrive; `when` clauses cannot test the `your-turn.agents` object for emptiness themselves.
  const markNoAgentsConfigured = () => void vscode.commands.executeCommand('setContext', 'your-turn.noAgentsConfigured', agentNames().length === 0);
  markNoAgentsConfigured();
  const agentConfigWatcher = watchAgentConfigs(workspaceEnvironment, (change) => {
    if (change) {
      sessionManager.agentsChanged(change.before, change.after);
      sessionTabs.agentsChanged(change.before, change.after);
    }
    chatViewController.notifyTabsChanged();
    markNoAgentsConfigured();
    sessionTreeProvider.refresh();
  });

  const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, agentConfigWatcher.useWebview);
  const reportedFileEditor = new ReportedFileEditor();
  const chatViewController = new ChatViewController(
    sessionManager, chatWebviewProvider, reportedFileEditor, workspaceEnvironment, undefined, sessionTabs,
  );
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
  sessionUpdateHandler.addListener((delivery) => chatViewController.handleSessionUpdate(delivery));
  const reviews = new Reviews(workspaceFiles, sessionManager);
  chatViewController.setTabReviews(reviews);
  const showReviewAdmission = () => {
    void vscode.commands.executeCommand('setContext', 'your-turn.reviewResolutionBlocked', reviews.resolutionBlocked());
  };
  reviews.addListener(showReviewAdmission);
  showReviewAdmission();
  sessionManager.on('configuration-renamed', (from, to) => reviews.configurationRenamed(from, to));
  sessionManager.on('source-retired', (sourceId) => reviews.sourceRetired(sourceId));
  let disposal: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (disposal) { return disposal; }
    sessionUpdateHandler.dispose();
    chatMessageSubscription.dispose();
    const output = chatViewController.dispose();
    reviewSourceControl.dispose();
    const takeovers = reviewTakeovers.dispose();
    const presenters = reviewPresenters.dispose();
    const diffs = reviewDiffs.dispose();
    const review = reviews.dispose();
    const tabState = sessionTabs.dispose();
    const sessions = sessionManager.dispose();
    disposal = Promise.allSettled([output, takeovers, presenters, diffs, review, tabState, sessions]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to shut down Your Turn');
      }
    });
    return disposal;
  };
  shutdown = stop;
  const reviewChanges = new vscode.EventEmitter<void>();
  context.subscriptions.push(reviewChanges);
  reviews.addListener(() => reviewChanges.fire());
  sessionUpdateHandler.addListener(({ input }) => { void reviews.handleSessionUpdate(input); });
  const reviewDiffs = factories.createReviewPresentation?.(reviews) ?? new DiffReviewPresentation(reviews);
  const reviewControls = new ReviewControls(reviews, reviewDiffs,
    () => vscode.workspace.getConfiguration('your-turn').get<string>('review.presentation', 'diffEditor') === 'diffEditor');
  chatViewController.setReviewOpening(reviewControls);
  reviewDiffs.attach(reviewControls);
  const reviewPresenters = new ReviewPresenters(reviewControls, reviews);
  chatViewController.addTurnListener((inProgress) => reviewPresenters.turnInProgress(inProgress));
  const reviewSourceControl = new ReviewSourceControl(reviewControls, reviews);
  const reviewTakeovers = new ReviewTakeovers(reviews, reviewControls);
  sessionManager.on('session-removed', (registration) => {
    sessionManager.endSessionOutput(registration);
    reviews.sessionRemoved(registration);
    chatViewController.notifySessionRemoved(registration);
  });
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatWebviewProvider.viewType,
    chatWebviewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const statusBarManager = new StatusBarManager(sessionManager);

  sessionManager.on('active-session-changed', (registration) => {
    reviews.activeSessionChanged(registration);
    chatViewController.notifyActiveSessionChanged();
  });
  sessionManager.on('session-opened', (registration) => {
    chatViewController.notifySessionOpened(registration);
  });
  sessionManager.on('session-ended', (registration, reason) => {
    chatViewController.notifySessionEnded(registration, reason);
  });
  sessionManager.on('turn-ended', (registration) => {
    chatViewController.notifyTurnEnded(registration);
  });
  sessionManager.on('clear-transcript', () => {
    chatViewController.clearTranscript();
  });
  sessionManager.on('mode-changed', () => {
    chatViewController.notifyPickersChanged();
  });
  sessionManager.on('session-load-start', (load) => {
    // The runtime stages replacement output until the replay commits.
    reviews.loadStarted(load);
    chatViewController.notifyLoadSessionStart(load);
  });
  sessionManager.on('session-load-end', (load, ok) => {
    reviews.loadEnded(load);
    const shown = chatViewController.notifyLoadSessionEnd(load, ok);
    if (ok && shown) {
      // The loadSession response carries modes/configOptions for the
      // restored session. Re-send the state so the pickers pick them up
      // (the original `active-session-changed` was emitted before the RPC
      // resolved, when those fields were still null).
      chatViewController.notifyActiveSessionChanged();
    }
  });

  const sessionStartup = new SessionStartup(sessionManager, workspaceState, workspaceEnvironment, startupRequests, sessionTabs);
  const sessionCommands = new SessionCommands(
    sessionManager, chatViewController, reviewControls, vscode.window, vscode.commands, agentNames, sessionStartup,
  );
  chatViewController.setTabNavigation(sessionCommands);
  void sessionCommands.revealRequested();
  void chatViewReady.then(() => sessionCommands.restoreLastSession());
  // Opening a workspace already open in a window brings that window to the front instead of starting a new one.
  const requestedOnFocus = vscode.window.onDidChangeWindowState(({ focused }) => {
    if (focused) {
      void sessionCommands.openRequested();
    }
  });
  const agentConfigurations = new AgentConfigurations(
    () => vscode.workspace.getConfiguration('your-turn'),
    () => workspaceEnvironment.agentScope(),
    sessionManager,
    vscode.window,
    {
      fetchRegistry,
      checkRunner: (runner: PackageRunner) => checkPackageRunner(agentManager, runner, workspaceEnvironment.workspaceRoots().cwd),
      findOnPath,
      platform: registryPlatform(),
    },
  );
  const focusChatView = () => vscode.commands.executeCommand('your-turn-chat.focus');
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
    agentConfigWatcher,
    chatViewRegistration,
    chatMessageSubscription,
    reportedFileEditor,
    statusBarManager,
    vscode.commands.registerCommand('your-turn.connectAgent', (arg?: unknown) => sessionCommands.connect(agentNameOf(arg))),
    vscode.commands.registerCommand('your-turn.newSession', (arg?: unknown) => sessionCommands.newSession(agentNameOf(arg))),
    vscode.commands.registerCommand('your-turn.agentActions', (arg?: unknown) => {
      const agentName = agentNameOf(arg);
      const canRefresh = sessionList.agents().some((agent) => agent.name === agentName && agent.canRefreshSessions);
      return sessionCommands.agentActions(agentName, canRefresh);
    }),
    vscode.commands.registerCommand('your-turn.disconnectAgent', (arg?: unknown) => sessionCommands.disconnect(agentNameOf(arg))),
    vscode.commands.registerCommand('your-turn.restartAgent', (arg?: unknown) => sessionCommands.restart(agentNameOf(arg))),
    vscode.commands.registerCommand('your-turn.cancelTurn', () => sessionCommands.cancelTurn()),
    vscode.commands.registerCommand('your-turn.setMode', (modeId?: string) => sessionCommands.setMode(modeId)),
    vscode.commands.registerCommand('your-turn.setModel', (modelId?: string) => sessionCommands.setModel(modelId)),
    vscode.commands.registerCommand('your-turn.openSession', (arg?: SessionArgument) => sessionCommands.open(arg?.agentName, arg?.sessionId)),
    vscode.commands.registerCommand('your-turn.openChat', focusChatView),
    vscode.commands.registerCommand('your-turn.sendPrompt', focusChatView),
    vscode.commands.registerCommand('your-turn.showLog', () => getOutputChannel().show()),
    vscode.commands.registerCommand('your-turn.refreshSessions', async (arg?: unknown) => {
      const agentName = agentNameOf(arg);
      if (agentName) {
        await sessionList.startOver(agentName);
      }
    }),
    vscode.commands.registerCommand('your-turn.loadMoreSessions', async (agentName?: string) => {
      if (agentName) {
        await sessionList.loadMore(agentName);
      }
    }),
    vscode.commands.registerCommand('your-turn.copySessionId', async (arg?: SessionArgument) => {
      if (!arg?.sessionId) { return; }
      await vscode.env.clipboard.writeText(arg.sessionId);
      void vscode.window.showInformationMessage(`Copied session ID: ${arg.sessionId}`);
    }),
    vscode.commands.registerCommand('your-turn.removeFromHistory', async (arg?: SessionArgument) => {
      if (arg?.agentName && arg.sessionId) {
        await sessionManager.removeFromHistory(arg.agentName, arg.sessionId);
      }
    }),
    persistedStateCommands,
    vscode.commands.registerCommand('your-turn.showPersistedState', () => persistedStateCommands.show()),
    vscode.commands.registerCommand('your-turn.resetPersistedState', async () => {
      if (await persistedStateCommands.reset()) {
        sessionTreeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('your-turn.addAgent', () => agentConfigurations.add()),
    vscode.commands.registerCommand('your-turn.detectAgents', () => agentConfigurations.detect()),
    vscode.commands.registerCommand('your-turn.removeAgent', (arg?: unknown) => agentConfigurations.remove(agentNameOf(arg))),
    vscode.commands.registerCommand('your-turn.openToolCallFile', (arg?: unknown) => chooseDiffFile(arg, 'file')),
    vscode.commands.registerCommand('your-turn.openToolCallChanges', (arg?: unknown) => chooseDiffFile(arg, 'changes')),
    vscode.commands.registerCommand('your-turn.openCommandOutput', (arg?: unknown) => {
      const output = commandOutputOf(arg);
      if (output && !chatViewController.openCommandOutput(output.target, output.source, output.name)) {
        logWarning('Command output is no longer retained', { outputName: output.name });
      }
    }),
    vscode.commands.registerCommand('your-turn.openReview', () => reviewControls.openReview()),
    vscode.commands.registerCommand('your-turn.previousReviewFile', async (arg?: unknown) => {
      await reviewControls.previous(reviewPathOf(arg, reviewDiffs));
      await reviewPresenters.navigated();
    }),
    vscode.commands.registerCommand('your-turn.nextReviewFile', async (arg?: unknown) => {
      await reviewControls.next(reviewPathOf(arg, reviewDiffs));
      await reviewPresenters.navigated();
    }),
    vscode.commands.registerCommand('your-turn.undoFile', (arg?: unknown) => {
      const path = reviewPathOf(arg, reviewDiffs);
      if (arg !== undefined && path === undefined) { return; }
      return reviewControls.undoFile(path);
    }),
    vscode.commands.registerCommand('your-turn.keepFile', (arg?: unknown) => {
      const path = reviewPathOf(arg, reviewDiffs);
      if (arg !== undefined && path === undefined) { return; }
      return reviewControls.keepFile(path);
    }),
    vscode.commands.registerCommand('your-turn.keepAllFiles', () => reviewControls.keepAll()),
    vscode.commands.registerCommand('your-turn.keepChange', (...args: unknown[]) => {
      const change = quickDiffChangeOf(args);
      if (!change) { return; }
      const captured = reviewSourceControl.captureChange('keep', change.path, change.changes, change.index);
      return captured && reviewControls.keepChange(change.path, change.change, captured);
    }),
    vscode.commands.registerCommand('your-turn.keepDiffChange', (arg?: unknown) => reviewDiffs.decide('keep', arg)),
    vscode.commands.registerCommand('your-turn.undoDiffChange', (arg?: unknown) => reviewDiffs.decide('undo', arg)),
    vscode.commands.registerCommand('your-turn.undoChange', (...args: unknown[]) => {
      const change = quickDiffChangeOf(args);
      if (!change) { return; }
      const captured = reviewSourceControl.captureChange('undo', change.path, change.changes, change.index);
      return captured && reviewControls.undoChange(change.path, change.change, captured);
    }),
    {
      dispose: () => {
        void stop().catch((error: unknown) => logError('Failed to shut down Your Turn', error));
        chatWebviewProvider.dispose();
        sessionList.dispose();
        disposeChannels();
      },
    },
  );

  logInfo('Your Turn extension activated');
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
    turnEndShown: () => chatViewController.reviewOpeningSettled(),
    reviewPresentationSettled: async () => { await reviewPresenters.settled(); await reviewDiffs.settled(); },
    persistedStateSettled: async () => {
      await sessionManager.recordsSettled();
      await sessionTabs.settled();
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
  logInfo('Your Turn extension deactivated');
}

/** A session tree item, or the argument of its `your-turn.openSession` command. */
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
  const context = arg as { yourTurnTarget?: unknown; yourTurnToolCallId?: unknown; yourTurnDiffFile?: unknown } | undefined;
  const target = presentationTargetOf(context?.yourTurnTarget);
  const toolCallId = context?.yourTurnToolCallId;
  const file = context?.yourTurnDiffFile;
  return target && typeof toolCallId === 'string' && typeof file === 'number' && Number.isSafeInteger(file) && file >= 0
    ? { target, toolCallId, file, open } : undefined;
}

function presentationTargetOf(value: unknown): PresentationTarget | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const target = value as Partial<PresentationTarget>;
  return typeof target.configuredName === 'string' && typeof target.sessionId === 'string'
    && typeof target.generation === 'number' && Number.isSafeInteger(target.generation) && target.generation > 0
    && typeof target.projection === 'number' && Number.isSafeInteger(target.projection) && target.projection > 0
    ? { configuredName: target.configuredName, sessionId: target.sessionId, generation: target.generation, projection: target.projection }
    : undefined;
}

/** The title area passes its editor's URI; the status bar passes nothing, and so means the active editor's file. */
function reviewPathOf(arg: unknown, presentation: DiffReviewPresentation): string | undefined {
  return arg instanceof vscode.Uri ? presentation.pathOf(arg) : undefined;
}

/**
 * The quick diff view's title passes its document's URI, its changes and the index of the one shown. A change's lines are
 * 1-based and inclusive, and a side with none has an end of 0 and a start of the line before.
 */
function quickDiffChangeOf([uri, changes, index]: unknown[]): { path: string; change: Change; changes: readonly Change[]; index: number } | undefined {
  if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file' || !Array.isArray(changes)
    || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= changes.length) { return undefined; }
  const decoded: Change[] = [];
  for (const value of changes) {
    if (!value || typeof value !== 'object') { return undefined; }
    const change = value as Partial<Record<
      'originalStartLineNumber' | 'originalEndLineNumber' | 'modifiedStartLineNumber' | 'modifiedEndLineNumber', unknown
    >>;
    const lines = (start: unknown, end: unknown) =>
      typeof start === 'number' && typeof end === 'number' && Number.isInteger(start) && Number.isInteger(end)
        && start >= 0 && end >= 0 && (end === 0 || (start >= 1 && end >= start))
        ? (end === 0 ? { start, end: start } : { start: start - 1, end }) : undefined;
    const original = lines(change.originalStartLineNumber, change.originalEndLineNumber);
    const modified = lines(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
    if (!original || !modified) { return undefined; }
    decoded.push({ original, modified });
  }
  const change = decoded[index];
  return change && { path: uri.fsPath, change, changes: decoded, index };
}

/** The context menu on a command's output passes the `data-vscode-context` the chat view gave it. */
function commandOutputOf(arg: unknown): { target: PresentationTarget; source: CommandSource; name: string } | undefined {
  const context = arg as { yourTurnTarget?: unknown; yourTurnToolCallId?: unknown; yourTurnTerminalId?: unknown; yourTurnTitle?: unknown } | undefined;
  const { yourTurnToolCallId: toolCallId, yourTurnTerminalId: terminalId, yourTurnTitle: name } = context ?? {};
  const target = presentationTargetOf(context?.yourTurnTarget);
  if (!target || typeof name !== 'string') { return undefined; }
  if (typeof terminalId === 'string') { return { target, source: { kind: 'terminal', terminalId }, name }; }
  return typeof toolCallId === 'string' ? { target, source: { kind: 'toolCall', toolCallId }, name } : undefined;
}
