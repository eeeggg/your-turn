import type { SessionReference } from '@/core/PersistedState';
import { relativeTime, UNTITLED } from '@/core/SessionList';

/** A workspace other windows used sessions in, as the Agents view's Other Workspaces mode lists it. */
export interface OtherWorkspace {
  /** Its full serialized URI, as the client sees it, which opens it. */
  readonly uri: string;
  /** Scheme and authority, as the client sees them, of the machine its folders and agents are on. */
  readonly host: string;
  /** Its folder's name, or its `.code-workspace` file's, as Open Recent shows it. */
  readonly label: string;
  /** The machine its folders are on, unless that is this client. */
  readonly description?: string;
  readonly configurations: readonly WorkspaceConfiguration[];
}

/** A configuration sessions in a workspace were last used through. */
export interface WorkspaceConfiguration {
  readonly configuredName: string;
  readonly sessions: readonly OtherSession[];
}

/** A session in another workspace, as its row shows it. */
export interface OtherSession {
  readonly reference: SessionReference;
  /** Its cached title, as titles are never derived from what was said in it. */
  readonly label: string;
  readonly age?: string;
  readonly tooltip: string;
}

const LOCAL_HOST = 'file://';
const WORKSPACE_FILE = '.code-workspace';

/**
 * The workspaces of the references other than this window's, each with the configurations its sessions were used
 * through and their sessions; every level the most recently used first.
 */
export function otherWorkspaces(references: readonly SessionReference[], thisWorkspaceUri: string | undefined, now: number): OtherWorkspace[] {
  const recentFirst = [...references].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const workspaces = new Map<string, { host: string; configurations: Map<string, SessionReference[]> }>();
  for (const reference of recentFirst) {
    if (reference.workspaceUri === thisWorkspaceUri) {
      continue;
    }
    let workspace = workspaces.get(reference.workspaceUri);
    if (!workspace) {
      workspace = { host: reference.host, configurations: new Map() };
      workspaces.set(reference.workspaceUri, workspace);
    }
    const sessions = workspace.configurations.get(reference.configuredName) ?? [];
    workspace.configurations.set(reference.configuredName, [...sessions, reference]);
  }
  return [...workspaces].map(([uri, { host, configurations }]) => ({
    uri,
    host,
    label: labelOf(uri),
    ...(host === LOCAL_HOST ? {} : { description: host.slice(host.indexOf('://') + 3) }),
    configurations: [...configurations].map(([configuredName, sessions]) => ({
      configuredName,
      sessions: sessions.map((reference) => sessionOf(reference, now)),
    })),
  }));
}

function sessionOf(reference: SessionReference, now: number): OtherSession {
  const age = relativeTime(reference.lastActiveAt, now);
  return {
    reference,
    label: reference.title?.trim() || UNTITLED,
    ...(age ? { age } : {}),
    tooltip: [
      `Agent: ${reference.configuredName}`,
      `Session: ${reference.sessionId}`,
      `Workspace: ${reference.workspaceUri}`,
      `cwd: ${reference.cwd}`,
      `Last active: ${reference.lastActiveAt}`,
    ].join('\n'),
  };
}

function labelOf(uri: string): string {
  const encoded = uri.slice(uri.lastIndexOf('/') + 1);
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    name = encoded;
  }
  return name.endsWith(WORKSPACE_FILE) ? `${name.slice(0, -WORKSPACE_FILE.length)} (Workspace)` : name;
}
