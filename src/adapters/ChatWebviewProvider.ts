import * as vscode from 'vscode';
import type { ChatViewEnvironment } from '@/core/ChatViewController';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { renderChatHtml } from './ChatHtml';

/** The chat view's webview in the ACP sidebar; `ChatViewController` decides what it shows. */
export class ChatWebviewProvider implements vscode.WebviewViewProvider, ChatViewEnvironment, vscode.Disposable {
  public static readonly viewType = 'acp-chat';

  private view: vscode.WebviewView | undefined;
  private readonly received = new vscode.EventEmitter<WebviewToExtensionMessage>();
  readonly onDidReceiveMessage = this.received.event;
  private readonly posted = new vscode.EventEmitter<ExtensionToWebviewMessage>();
  /** Each message delivered to the webview. */
  readonly onDidPost = this.posted.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      this.received.fire(message);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  post(message: ExtensionToWebviewMessage): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
      this.posted.fire(message);
    }
  }

  showsToolCallDiffs(): boolean {
    return vscode.workspace.getConfiguration('acp').get<boolean>('showToolCallDiffs', false);
  }

  executeCommand(command: string, ...rest: unknown[]): Thenable<unknown> {
    return vscode.commands.executeCommand(command, ...rest);
  }

  /** Attach a file to the next prompt and reveal the chat view. */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.post({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show(true);
    }
  }

  dispose(): void {
    this.received.dispose();
    this.posted.dispose();
  }

  private getHtmlContent(webview: vscode.Webview): string {
    return renderChatHtml({
      cspSource: webview.cspSource,
      nonce: getNonce(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chat.css')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chat.js')).toString(),
    });
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
