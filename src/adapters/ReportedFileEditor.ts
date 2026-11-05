import * as vscode from 'vscode';
import type { FileEditor } from '@/core/ReportedFiles';

const scheme = 'your-turn-reported';

/**
 * Opens a tool call's files in VS Code's editors. Open Changes's two sides are documents it serves itself, which VS
 * Code keeps read-only; each is kept for the window's life, as VS Code can reopen a closed diff editor at any time.
 */
export class ReportedFileEditor implements FileEditor, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly sides = new Map<string, string>();
  private nextChange = 0;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this);

  async exists(path: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return true;
    } catch (e) {
      if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
        return false;
      }
      throw e;
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)));
    } catch (e) {
      if (e instanceof vscode.FileSystemError && (e.code === 'FileNotFound' || e.code === 'FileIsADirectory')) {
        return null;
      }
      throw e;
    }
  }

  /**
   * With options, `vscode.open` opens the file as one the user picked; without, as code navigation from the focused
   * editor, which pins that editor's preview so the file does not replace it.
   */
  async open(path: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path), { preserveFocus: false });
  }

  async showChanges(path: string, before: string, after: string): Promise<void> {
    const change = this.nextChange++;
    const side = (name: string, text: string) => {
      const uri = vscode.Uri.file(path).with({ scheme, query: `${change}-${name}` });
      this.sides.set(uri.query, text);
      return uri;
    };
    const title = `${path.split(/[\\/]/).pop() ?? path} (Agent's Change)`;
    await vscode.commands.executeCommand('vscode.diff', side('before', before), side('after', after), title);
  }

  showInformationMessage(message: string): Thenable<string | undefined> {
    return vscode.window.showInformationMessage(message);
  }

  /** Nothing for a side it never served, as after a reload, rather than an empty document. */
  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    return this.sides.get(uri.query);
  }

  dispose(): void {
    this.registration.dispose();
  }
}
