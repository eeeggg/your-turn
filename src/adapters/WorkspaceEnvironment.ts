import * as vscode from 'vscode';
import type { WorkspaceState, WorkspaceTarget } from '@/core/PersistedState';
import { logInfo } from '@/core/Log';
import type { SessionEnvironment } from '@/core/SessionManager';
import { getAgentConfigs } from './AgentConfig';

/** The scheme and authority of `uri`, as VS Code parses them. */
export function hostOf(uri: string): string {
  const { scheme, authority } = vscode.Uri.parse(uri);
  return `${scheme}://${authority}`;
}

/** The window's workspace as its extension host sees it. */
export type WorkspaceView = Pick<typeof vscode.workspace, 'workspaceFile' | 'workspaceFolders'>;

/** Why the extension is unavailable in a window: no folder, an unsaved workspace, or a first folder not on disk. */
export type WorkspaceUnavailability = 'empty' | 'untitled' | 'virtual';

/**
 * Agents run in the first folder, which must be a path on the extension host, and sessions are found again by a
 * workspace the window can reopen, which an unsaved workspace's `untitled:` file is not. VS Code restarts extensions
 * when the first folder changes or the window enters a saved workspace, so this holds for the whole activation.
 */
export function workspaceUnavailability({ workspaceFile, workspaceFolders = [] }: WorkspaceView): WorkspaceUnavailability | undefined {
  const [first] = workspaceFolders;
  if (!first) { return 'empty'; }
  if (first.uri.scheme !== 'file') { return 'virtual'; }
  const unsaved = workspaceFile ? workspaceFile.scheme === 'untitled' : workspaceFolders.length > 1;
  return unsaved ? 'untitled' : undefined;
}

/**
 * The workspace URI as the window holds it, which for a remote workspace carries the authority its extension host
 * never receives: the host is given `file:` URIs. `asWebviewUri` encodes the window's scheme and authority into the
 * host of the URI it makes, as `<scheme>+<escaped authority>.<domain>`. The decoded URI is accepted only when the same
 * webview encodes it back to that host, so VS Code's own encoder, not a copy of its rules, confirms it; anything else
 * gives `undefined` rather than a wrong authority.
 */
export function windowWorkspaceUri(extensionHostUri: vscode.Uri, webview: Pick<vscode.Webview, 'asWebviewUri'>): vscode.Uri | undefined {
  const made = webview.asWebviewUri(extensionHostUri);
  const separator = made.authority.indexOf('+');
  const end = made.authority.indexOf('.', separator);
  if (separator < 1 || end < 0) { return undefined; }
  let decoded: vscode.Uri;
  try {
    decoded = extensionHostUri.with({
      scheme: made.authority.slice(0, separator),
      authority: made.authority.slice(separator + 1, end).replace(/-([0-9a-f]{4})/g, (_, code: string) => String.fromCharCode(parseInt(code, 16))),
    });
  } catch {
    return undefined;
  }
  const remade = webview.asWebviewUri(decoded);
  return remade.scheme === made.scheme && remade.authority === made.authority ? decoded : undefined;
}

/** What sessions need from the window's workspace, with the webview a remote window learns its workspace URI from. */
export interface WorkspaceEnvironment extends SessionEnvironment {
  /** A webview of this window while one exists, and `undefined` once it is gone. */
  useWebview(webview: Pick<vscode.Webview, 'asWebviewUri'> | undefined): void;
}

/** The document in the active editor, as a resource link for a prompt, unless the user turned that off. */
export function activeFileLink(): ReturnType<SessionEnvironment['activeFileLink']> {
  const cfg = vscode.workspace.getConfiguration('acp');
  if (!cfg.get<boolean>('includeActiveFile', true)) {
    return undefined;
  }
  const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
  if (!editor || editor.document.uri.scheme === 'output') {
    return undefined;
  }
  return {
    uri: editor.document.uri.toString(),
    name: editor.document.uri.fsPath,
    ...(editor.document.uri.scheme === 'untitled' ? { mimeType: 'text/plain' } : {}),
  };
}

/**
 * `remoteName` is `env.remoteName`, which is `undefined` when there is no remote extension host; then nothing
 * transforms URIs between window and extension host, and the extension host's workspace URI is the window's. A
 * remote window stores the target it learns from a webview in `workspaceState`, so later startups have it before any
 * webview exists. The host is always the first folder's, as a remote window has its folders on one machine while its
 * workspace file may be saved on the client.
 */
export function createWorkspaceEnvironment(
  workspaceState: Pick<WorkspaceState, 'workspaceTarget' | 'setWorkspaceTarget'>,
  remoteName: string | undefined = vscode.env.remoteName,
  workspace: WorkspaceView = vscode.workspace,
): WorkspaceEnvironment {
  let webview: Pick<vscode.Webview, 'asWebviewUri'> | undefined;

  /** The workspace and its first folder as the extension host sees them, when it is one the window can open again. */
  const extensionHostTarget = () => {
    const { workspaceFile, workspaceFolders = [] } = workspace;
    const folder = workspaceFolders[0]?.uri;
    // An untitled multi-root workspace has a file URI that cannot be opened again.
    const uri = !folder ? undefined : workspaceFile
      ? (workspaceFile.scheme === 'untitled' ? undefined : workspaceFile)
      : (workspaceFolders.length === 1 ? folder : undefined);
    return uri && folder ? { uri, folder } : undefined;
  };

  /** A remote window's target as the client sees it: a client file arrives as `vscode-local:`, the rest as `file:`. */
  const learnedFrom = ({ uri, folder }: { uri: vscode.Uri; folder: vscode.Uri }, shown: Pick<vscode.Webview, 'asWebviewUri'>) => {
    const host = windowWorkspaceUri(folder, shown);
    const windowUri = uri.scheme === 'vscode-local' ? uri.with({ scheme: 'file' }) : windowWorkspaceUri(uri, shown);
    return host && windowUri ? { uri: windowUri.toString(), host: hostOf(host.toString()) } : undefined;
  };

  /** A stored target is used only for the workspace it names, as the window and its extension host share paths. */
  const storedFor = ({ uri }: { uri: vscode.Uri }) => {
    const stored = workspaceState.workspaceTarget();
    return stored && vscode.Uri.parse(stored.uri).path === uri.path ? stored : undefined;
  };

  const workspaceTarget = (): WorkspaceTarget | undefined => {
    const target = extensionHostTarget();
    if (!target) {
      return undefined;
    }
    if (remoteName === undefined) {
      return { uri: target.uri.toString(), host: hostOf(target.folder.toString()) };
    }
    return webview ? learnedFrom(target, webview) : storedFor(target);
  };

  /** Waiting for a remote window to learn its workspace URI; a webview settles them, whether or not it gives one. */
  const waiting: ((target: ReturnType<typeof workspaceTarget>) => void)[] = [];

  return {
    useWebview(shown) {
      webview = shown;
      const target = remoteName === undefined ? undefined : extensionHostTarget();
      const learned = shown && target && learnedFrom(target, shown);
      if (learned) {
        void workspaceState.setWorkspaceTarget(learned);
      }
      if (shown) {
        const known = workspaceTarget();
        for (const settle of waiting.splice(0)) {
          settle(known);
        }
      }
    },

    workspaceRoots() {
      const [first, ...others] = workspace.workspaceFolders ?? [];
      if (first?.uri.scheme !== 'file') {
        throw new Error('Agent sessions need a first workspace folder on disk');
      }
      const elsewhere = others.filter(({ uri }) => uri.scheme !== 'file');
      if (elsewhere.length > 0) {
        logInfo('Leaving workspace folders that are not on disk out of agent sessions', { folders: elsewhere.map(({ uri }) => uri.toString()) });
      }
      return {
        cwd: first.uri.fsPath,
        additionalDirectories: others.filter(({ uri }) => uri.scheme === 'file').map(({ uri }) => uri.fsPath),
      };
    },

    workspaceTarget,

    workspaceTargetKnown() {
      const target = workspaceTarget();
      if (target || remoteName === undefined || !extensionHostTarget()) {
        return Promise.resolve(target);
      }
      return new Promise((settle) => waiting.push(settle));
    },

    agentConfigs: getAgentConfigs,
    activeFileLink,
  };
}
