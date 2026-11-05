import * as assert from 'assert';
import { suite, suiteSetup, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { PersistedStateCommands } from '@/adapters/PersistedStateCommands';
import { createWorkspaceEnvironment, hostOf, windowWorkspaceUri, workspaceUnavailability, type WorkspaceView } from '@/adapters/WorkspaceEnvironment';
import { SessionReferences, WorkspaceState, type SessionAddress } from '@/core/PersistedState';
import type { ExtensionTestApi } from '@/extension';
import { cleanup } from '@tests/integration/cleanup';
import { remoteWebview } from '@tests/integration/webviews';

const REMOTE_FOLDER = 'vscode-remote://ssh-remote%2Bdevenv/home/me/work';
const REMOTE_WORKSPACE_FILE = 'vscode-remote://ssh-remote%2Bdevenv/home/me/work.code-workspace';
const DEVENV = 'vscode-remote://ssh-remote+devenv';
const DOCUMENT_SCHEME = 'your-turn-persisted-state';

const address = (sessionId: string): SessionAddress =>
  ({ configuredName: 'persisted-state-agent', sessionId, cwd: '/home/me/work', host: DEVENV, workspaceUri: REMOTE_FOLDER });

/** A workspace as an extension host sees it, which in a remote window has its folders on the remote as `file:` URIs. */
function workspaceView(folders: (string | vscode.Uri)[], workspaceFile?: vscode.Uri): WorkspaceView {
  return {
    workspaceFolders: folders.length
      ? folders.map((folder, index) => ({ uri: typeof folder === 'string' ? vscode.Uri.file(folder) : folder, name: folder.toString(), index }))
      : undefined,
    workspaceFile,
  };
}

const onDevenv = (path: string) => vscode.Uri.file(path).with({ scheme: 'vscode-remote', authority: 'ssh-remote+devenv' }).toString();
const onClient = (path: string) => vscode.Uri.from({ scheme: 'vscode-local', path });

/** Storage in VS Code's shape, which can serve the value a key held before its last write, as global state can. */
function memento(): vscode.Memento & { serveEarlier: (key: string) => void } {
  const values = new Map<string, unknown>();
  const earlier = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => (values.has(key) ? values.get(key) : defaultValue) as T,
    update: async (key, value) => {
      earlier.set(key, values.get(key));
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
    serveEarlier: (key) => {
      const value = earlier.get(key);
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

suite('Persisted state', () => {
  let api: ExtensionTestApi;
  let storage: ExtensionTestApi['storage'];
  const panels: vscode.WebviewPanel[] = [];
  /** What a test made that teardown disposes first. */
  const owned: (() => unknown)[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('eeeggg.your-turn');
    const activated = await extension?.activate();
    assert.ok(activated, 'the extension returns its test API in extension tests');
    api = activated;
    storage = activated.storage;
    await api.persistedStateSettled();
  });

  teardown(async function () {
    await api.persistedStateSettled();
    await cleanup(this.currentTest, [
      ...owned.splice(0),
      ...panels.splice(0).map((panel) => () => { panel.dispose(); }),
      ...storage.workspaceState.keys().map((key) => () => storage.workspaceState.update(key, undefined)),
      () => api.sessionReferences.reset(),
      ...vscode.window.tabGroups.all.flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === DOCUMENT_SCHEME)
        .map((tab) => () => vscode.window.tabGroups.close(tab)),
    ]);
  });

  /** Show the persisted state, and read the document it shows. */
  async function shown(): Promise<unknown> {
    await vscode.commands.executeCommand('your-turn.showPersistedState');
    const document = vscode.window.activeTextEditor?.document;
    assert.strictEqual(document?.uri.scheme, DOCUMENT_SCHEME);
    assert.strictEqual(document.languageId, 'json');
    return JSON.parse(document.getText());
  }

  /** Answer a confirmation `act` asks for with `answer`, recording what it asked. */
  async function answering(answer: string | undefined, act: () => Thenable<unknown>): Promise<unknown[][]> {
    const asked: unknown[][] = [];
    const window = vscode.window as { showWarningMessage: unknown };
    const original = window.showWarningMessage;
    window.showWarningMessage = async (...args: unknown[]) => {
      asked.push(args);
      return answer;
    };
    try {
      await act();
    } finally {
      window.showWarningMessage = original;
    }
    return asked;
  }

  const reset = (answer: string | undefined) => answering(answer, () => vscode.commands.executeCommand('your-turn.resetPersistedState'));

  test('derives the host of a workspace URI from the scheme and authority VS Code parses', () => {
    assert.strictEqual(hostOf(vscode.Uri.file('/home/me/work').toString()), 'file://');
    assert.strictEqual(hostOf(REMOTE_FOLDER), DEVENV);
    assert.strictEqual(hostOf(REMOTE_WORKSPACE_FILE), hostOf(REMOTE_FOLDER));
    assert.notStrictEqual(hostOf('vscode-remote://ssh-remote%2Bother/home/me/work'), hostOf(REMOTE_FOLDER));
  });

  function webview(): vscode.Webview {
    const panel = vscode.window.createWebviewPanel('your-turn-persisted-state-test', 'Workspace URI', { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
    panels.push(panel);
    return panel.webview;
  }

  const webviewOn = (authority: string) => remoteWebview(webview(), authority);

  /** A webview that gives a `file:` URI the host `made`, and encodes any other URI as VS Code does. */
  function webviewMaking(made: string, scheme = 'https'): Pick<vscode.Webview, 'asWebviewUri'> {
    const real = webview();
    return { asWebviewUri: (uri) => (uri.scheme === 'file' ? vscode.Uri.from({ scheme, authority: made, path: uri.path }) : real.asWebviewUri(uri)) };
  }

  test("takes a remote workspace's scheme and authority from the host asWebviewUri encodes them in", () => {
    const folder = vscode.Uri.file('/home/me/work');
    const remote = (authority: string) => folder.with({ scheme: 'vscode-remote', authority }).toString();
    const devenv = windowWorkspaceUri(folder, webviewOn('ssh-remote+devenv'));
    assert.strictEqual(devenv?.toString(), remote('ssh-remote+devenv'));
    assert.ok(devenv);
    assert.strictEqual(hostOf(devenv.toString()), DEVENV);
    // VS Code's own cases for asWebviewUri.
    for (const authority of ['remote', 'ssh-remote+localhost=foo/bar', 'localhost:8080']) {
      assert.strictEqual(windowWorkspaceUri(folder, webviewOn(authority))?.toString(), remote(authority));
    }
  });

  test("keeps a local workspace's URI as it is, through a real webview", () => {
    const folder = vscode.Uri.file('/home/me/work');
    assert.strictEqual(windowWorkspaceUri(folder, webview())?.toString(), folder.toString());
  });

  test('gives no workspace URI for a webview URI VS Code would not make for it', () => {
    const folder = vscode.Uri.file('/home/me/work');
    for (const made of [
      'example.com',
      'vscode-remote.vscode-resource.vscode-cdn.net',
      '+devenv.vscode-resource.vscode-cdn.net',
      'vs!code+devenv.vscode-resource.vscode-cdn.net',
      'vscode-remote+devenv.example.net',
      'vscode-remote+ssh-remote.vscode-resource.vscode-cdn.net',
      'vscode-remote+ssh-002Bdevenv.vscode-resource.vscode-cdn.net',
    ]) {
      assert.strictEqual(windowWorkspaceUri(folder, webviewMaking(made)), undefined, made);
    }
    assert.strictEqual(windowWorkspaceUri(folder, webviewMaking('vscode-remote+devenv.vscode-resource.vscode-cdn.net', 'http')), undefined);
  });

  /** The target a remote window on `view` learns from a webview of a window on `devenv`. */
  function learned(view: WorkspaceView, state = new WorkspaceState(storage.workspaceState)) {
    const environment = createWorkspaceEnvironment(state, 'ssh-remote', view);
    environment.useWebview(webviewOn('ssh-remote+devenv'));
    return environment.workspaceTarget();
  }

  test('in a remote window, has its single folder on the remote as its workspace target, on the remote host', () => {
    assert.deepStrictEqual(learned(workspaceView(['/home/me/work'])), { uri: onDevenv('/home/me/work'), host: DEVENV });
  });

  test('in a remote window, has a workspace file on the remote as its workspace target, on the host of its folders', () => {
    const view = workspaceView(['/home/me/work', '/home/me/other'], vscode.Uri.file('/home/me/both.code-workspace'));
    assert.deepStrictEqual(learned(view), { uri: onDevenv('/home/me/both.code-workspace'), host: DEVENV });
  });

  test("in a remote window, has a workspace file on the client as its workspace target by the client's own URI, on the host of its folders", () => {
    const view = workspaceView(['/home/me/work'], onClient('/Users/me/Desktop/both.code-workspace'));
    assert.deepStrictEqual(learned(view), { uri: vscode.Uri.file('/Users/me/Desktop/both.code-workspace').toString(), host: DEVENV });
  });

  test('has no workspace target for a workspace file with no folders, in a remote or a local window, nor waits for one', async () => {
    const view = workspaceView([], vscode.Uri.file('/home/me/empty.code-workspace'));
    assert.strictEqual(learned(view), undefined);
    const remote = createWorkspaceEnvironment(new WorkspaceState(storage.workspaceState), 'ssh-remote', view);
    assert.strictEqual(await Promise.race([remote.workspaceTargetKnown(), Promise.resolve('pending')]), undefined);
    assert.strictEqual(createWorkspaceEnvironment(new WorkspaceState(storage.workspaceState), undefined, view).workspaceTarget(), undefined);
  });

  test('in a local window, has its single folder or workspace file as its workspace target as it is, on the host of its folders', () => {
    const local = (view: WorkspaceView) => createWorkspaceEnvironment(new WorkspaceState(storage.workspaceState), undefined, view).workspaceTarget();
    const workspaceFile = vscode.Uri.file('/home/me/both.code-workspace');
    assert.deepStrictEqual(local(workspaceView(['/home/me/work'])), { uri: vscode.Uri.file('/home/me/work').toString(), host: 'file://' });
    assert.deepStrictEqual(local(workspaceView(['/home/me/work', '/home/me/other'], workspaceFile)), { uri: workspaceFile.toString(), host: 'file://' });
  });

  test('gives sessions the first folder as their cwd and the other folders on disk as their additional directories', () => {
    const roots = (view: WorkspaceView) => createWorkspaceEnvironment(new WorkspaceState(storage.workspaceState), undefined, view).workspaceRoots();
    const virtual = vscode.Uri.from({ scheme: 'vscode-vfs', authority: 'github', path: '/me/repo' });
    const workspaceFile = vscode.Uri.file('/home/me/all.code-workspace');

    assert.deepStrictEqual(roots(workspaceView(['/home/me/work'])), { cwd: vscode.Uri.file('/home/me/work').fsPath, additionalDirectories: [] });
    assert.deepStrictEqual(roots(workspaceView(['/home/me/work', virtual, '/home/me/other'], workspaceFile)), {
      cwd: vscode.Uri.file('/home/me/work').fsPath,
      additionalDirectories: [vscode.Uri.file('/home/me/other').fsPath],
    });
    assert.throws(() => roots(workspaceView([])), /first workspace folder on disk/);
    assert.throws(() => roots(workspaceView([virtual, '/home/me/work'], workspaceFile)), /first workspace folder on disk/);
  });

  test('is unavailable with no folder, in an unsaved workspace, or when the first folder is not on disk', () => {
    const virtual = vscode.Uri.from({ scheme: 'vscode-vfs', authority: 'github', path: '/me/repo' });
    const saved = vscode.Uri.file('/home/me/all.code-workspace');
    const untitled = vscode.Uri.from({ scheme: 'untitled', path: 'Untitled-1' });
    assert.deepStrictEqual([
      workspaceView([]),
      workspaceView([], saved),
      workspaceView(['/home/me/work', '/home/me/other']),
      workspaceView(['/home/me/work', '/home/me/other'], untitled),
      workspaceView(['/home/me/work'], untitled),
      workspaceView([virtual]),
      workspaceView([virtual, '/home/me/work'], saved),
      workspaceView([virtual, '/home/me/work'], untitled),
    ].map((view) => workspaceUnavailability(view)), ['empty', 'empty', 'untitled', 'untitled', 'untitled', 'virtual', 'virtual', 'virtual']);
  });

  test('is available in a single folder or a saved workspace whose first folder is on disk, as this window is', () => {
    const virtual = vscode.Uri.from({ scheme: 'vscode-vfs', authority: 'github', path: '/me/repo' });
    const saved = vscode.Uri.file('/home/me/all.code-workspace');
    assert.deepStrictEqual([
      workspaceView(['/home/me/work']),
      workspaceView(['/home/me/work'], saved),
      workspaceView(['/home/me/work', virtual], saved),
      vscode.workspace,
    ].map((view) => workspaceUnavailability(view)), [undefined, undefined, undefined, undefined]);
  });

  test('in a remote window, starts with the workspace target an earlier startup learned, only for the same workspace', async () => {
    const view = workspaceView(['/home/me/work'], onClient('/Users/me/Desktop/both.code-workspace'));
    const earlier = new WorkspaceState(storage.workspaceState);
    const target = learned(view, earlier);
    await earlier.settled();

    const later = (startedOn: WorkspaceView) => createWorkspaceEnvironment(new WorkspaceState(storage.workspaceState), 'ssh-remote', startedOn).workspaceTarget();
    assert.deepStrictEqual(later(view), target);
    assert.strictEqual(later(workspaceView(['/home/me/work'], onClient('/Users/me/Desktop/other.code-workspace'))), undefined);
  });

  const idOf = (sessionId: string) => ({ host: DEVENV, configuredName: 'persisted-state-agent', sessionId });
  const listed = () => api.sessionReferences.list(DEVENV, 'persisted-state-agent', '/home/me/work').map((r) => r.sessionId);

  test("keeps session references through the extension's own instance, and the last active session through VS Code storage", async () => {
    await api.sessionReferences.setTitle(address('kept'), 'Kept title');
    await new WorkspaceState(storage.workspaceState).setLastActiveSession(address('kept'));

    const reference = api.sessionReferences.get(idOf('kept'));
    assert.deepStrictEqual({ ...reference, lastActiveAt: undefined }, {
      ...address('kept'), lastActiveAt: undefined, title: 'Kept title', selections: { options: {} },
    });
    assert.deepStrictEqual(new WorkspaceState(storage.workspaceState).lastActiveSession(), address('kept'));
  });

  test("shows every stored key in each scope and the window's target, kept up to date when shown again", async () => {
    await storage.workspaceState.update('example.extra', { entries: [] });
    await new WorkspaceState(storage.workspaceState).setLastActiveSession(address('shown'));

    // Global state is shown as VS Code's copy holds it, which may briefly be an earlier value, so only its shape is fixed.
    const first = await shown() as Record<string, unknown>;
    assert.deepStrictEqual([first['window'], first['workspaceState']], [
      { workspaceTarget: vscode.workspace.workspaceFolders?.[0]?.uri.toString(), host: 'file://' },
      {
        'example.extra': { entries: [] },
        'your-turn.workspace': { schemaVersion: 2, lastActiveSession: address('shown') },
      },
    ]);
    const global = first['globalState'] as Record<string, { schemaVersion?: unknown }>;
    assert.ok(Object.keys(global).every((key) => key === 'your-turn.sessionReferences'), Object.keys(global).join());
    assert.ok(global['your-turn.sessionReferences'] === undefined || global['your-turn.sessionReferences'].schemaVersion === 3);

    await new WorkspaceState(storage.workspaceState).setLastActiveSession(address('shown again'));
    const again = await shown() as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(again['workspaceState']?.['your-turn.workspace'], { schemaVersion: 2, lastActiveSession: address('shown again') });
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === DOCUMENT_SCHEME).length, 1);
  });

  test('resets the session references through the instance given, so the value from before stays reset when served again', async () => {
    const workspaceState = memento();
    const globalState = memento();
    const references = new SessionReferences(globalState);
    await references.used(address('before'));
    await workspaceState.update('your-turn.workspace', { schemaVersion: 2, lastActiveSession: address('before') });
    const commands = new PersistedStateCommands(workspaceState, globalState, references, () => undefined);
    owned.push(() => { commands.dispose(); });

    await answering(undefined, async () => assert.strictEqual(await commands.reset(), false));
    assert.deepStrictEqual(workspaceState.keys(), ['your-turn.workspace']);
    assert.strictEqual(references.get(idOf('before'))?.sessionId, 'before');

    await answering('Reset', async () => assert.strictEqual(await commands.reset(), true));
    assert.deepStrictEqual(workspaceState.keys(), []);
    assert.deepStrictEqual(globalState.get('your-turn.sessionReferences'), { schemaVersion: 3, epoch: 1, references: [], removed: [] });

    globalState.serveEarlier('your-turn.sessionReferences');
    assert.deepStrictEqual(references.list(DEVENV, 'persisted-state-agent', '/home/me/work'), []);
  });

  test('resets persisted state only once the user confirms', async () => {
    await api.sessionReferences.used(address('reset'));
    await new WorkspaceState(storage.workspaceState).setLastActiveSession(address('reset'));
    await shown();

    const declined = await reset(undefined);
    assert.deepStrictEqual(declined.map(([message, options, ...items]) => [message, (options as vscode.MessageOptions).modal, items]), [
      ['Reset Your Turn persisted state?', true, ['Reset']],
    ]);
    assert.deepStrictEqual([storage.workspaceState.keys(), listed()], [['your-turn.workspace'], ['reset']]);

    await reset('Reset');
    assert.deepStrictEqual([storage.workspaceState.keys(), listed()], [[], []]);
    const state = JSON.parse(vscode.window.activeTextEditor?.document.getText() ?? '') as Record<string, unknown>;
    assert.deepStrictEqual([state['window'], state['workspaceState']], [
      { workspaceTarget: vscode.workspace.workspaceFolders?.[0]?.uri.toString(), host: 'file://' },
      {},
    ]);
  });
});
