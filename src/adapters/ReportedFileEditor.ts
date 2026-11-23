import * as vscode from 'vscode';
import { slug } from 'github-slugger';
import type { FileEditor } from '@/core/ReportedFiles';
import type { FileLanding } from '@/core/TranscriptFileLinks';

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
      const { type } = await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return (type & vscode.FileType.File) !== 0;
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
  async open(path: string, landing?: FileLanding): Promise<void> {
    const uri = vscode.Uri.file(path);
    const options = { preserveFocus: false, ...(landing ? { selection: fileSelection(landing) } : {}) };
    await vscode.commands.executeCommand('vscode.open', uri, options);
  }

  async transcriptLanding(path: string, fragment: string): Promise<FileLanding | undefined> {
    const uri = vscode.Uri.file(path);
    const document = await vscode.workspace.openTextDocument(uri).then((doc) => doc, () => undefined);
    if (!document) { return undefined; }
    const lines = /^L(\d+)(?:-L(\d+))?$/i.exec(fragment);
    if (lines) {
      const start = Number(lines[1]);
      const end = Number(lines[2] ?? lines[1]);
      return start >= 1 && end >= start && end <= document.lineCount
        ? { startLine: start - 1, ...(lines[2] ? { endLine: end - 1 } : {}) } : undefined;
    }
    if (document.languageId !== 'markdown') { return undefined; }
    // Opening a Markdown document starts activation but need not wait for provider registration.
    await vscode.extensions.getExtension('vscode.markdown-language-features')?.activate().then(undefined, () => undefined);
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider', uri,
    ).then((result) => result, () => undefined);
    const headings: { text: string; line: number }[] = [];
    const collect = (nodes: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => {
      for (const node of nodes) {
        const label = node.kind === vscode.SymbolKind.String && /^#{1,6} (.*)$/s.exec(node.name);
        if (label) {
          headings.push({ text: label[1] ?? '', line: ('selectionRange' in node ? node.selectionRange : node.location.range).start.line });
        }
        if ('children' in node) { collect(node.children); }
      }
    };
    collect(symbols ?? []);
    // Match VS Code 1.144.1's Markdown slug builder: generated suffixes do not reserve base slugs.
    // https://github.com/microsoft/vscode/blob/261c84cb1eddf11235f9e2c921425e9663fbe556/extensions/markdown-language-features/src/slugify.ts#L58-L88
    const counts = new Map<string, number>();
    const wanted = fragment.toLowerCase();
    for (const heading of headings.sort((a, b) => a.line - b.line)) {
      const base = slug(heading.text.trim());
      const count = counts.get(base) ?? 0;
      if ((count === 0 ? base : `${base}-${count}`) === wanted) { return { startLine: heading.line }; }
      counts.set(base, count + 1);
    }
    return undefined;
  }

  warnFileOpen(message: string): void {
    void vscode.window.showWarningMessage(message);
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

export function fileSelection({ startLine, endLine = startLine }: FileLanding): vscode.Range {
  return new vscode.Range(startLine, 0, endLine, 0);
}
