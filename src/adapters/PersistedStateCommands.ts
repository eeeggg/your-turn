import * as vscode from 'vscode';
import type { SessionReferences, WorkspaceTarget } from '@/core/PersistedState';

const DOCUMENT = vscode.Uri.from({ scheme: 'acp-persisted-state', path: '/Persisted State.json' });
const RESET = 'Reset';

/**
 * The developer commands that show and reset what the extension keeps in VS Code's storage. That storage is on the
 * client, so in a remote window these are the only way to read it.
 */
export class PersistedStateCommands implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  private readonly provider: vscode.Disposable;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    /** The window's own instance, so it knows the reset's epoch and reads nothing from before it. */
    private readonly sessionReferences: Pick<SessionReferences, 'reset'>,
    private readonly workspaceTarget: () => WorkspaceTarget | undefined,
  ) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(DOCUMENT.scheme, {
      onDidChange: this.changes.event,
      provideTextDocumentContent: () => this.text(),
    });
  }

  /** Show every key the extension stores in each scope, and this window's workspace target, as a read-only document. */
  async show(): Promise<void> {
    await this.refresh();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(DOCUMENT), { preview: false });
  }

  /**
   * Once the user confirms, clear every key the extension stores in this workspace and reset the session references;
   * resolves to whether it did.
   */
  async reset(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage('Reset ACP persisted state?', {
      modal: true,
      detail: 'This clears the session references every window of this VS Code application shares, and what this workspace keeps. Agents keep their sessions.',
    }, RESET);
    if (choice !== RESET) {
      return false;
    }
    await Promise.all([
      ...this.workspaceState.keys().map((key) => this.workspaceState.update(key, undefined)),
      this.sessionReferences.reset(),
    ]);
    await this.refresh();
    return true;
  }

  dispose(): void {
    this.provider.dispose();
    this.changes.dispose();
  }

  /** Bring an open document up to date, as VS Code only asks for its content again when told it changed. */
  private async refresh(): Promise<void> {
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === DOCUMENT.toString());
    if (!open || open.getText() === this.text()) {
      return;
    }
    const updated = new Promise<void>((resolve) => {
      const subscription = vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (document === open) {
          subscription.dispose();
          resolve();
        }
      });
    });
    this.changes.fire(DOCUMENT);
    await updated;
  }

  private text(): string {
    const target = this.workspaceTarget();
    const state = {
      window: { workspaceTarget: target?.uri ?? null, host: target?.host ?? null },
      workspaceState: entriesOf(this.workspaceState),
      globalState: entriesOf(this.globalState),
    };
    return `${JSON.stringify(state, null, 2)}\n`;
  }
}

function entriesOf(memento: vscode.Memento): Record<string, unknown> {
  return Object.fromEntries([...memento.keys()].sort().map((key) => [key, memento.get(key)]));
}
