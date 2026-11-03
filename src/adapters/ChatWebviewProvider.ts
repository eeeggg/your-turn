import * as vscode from 'vscode';
import type { ChatViewEnvironment } from '@/core/ChatViewController';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { renderChatHtml } from './ChatHtml';

/** The chat view's webview in the ACP sidebar; `ChatViewController` decides what it shows. */
export class ChatWebviewProvider implements vscode.WebviewViewProvider, ChatViewEnvironment, vscode.Disposable {
  public static readonly viewType = 'acp-chat';

  private view: vscode.WebviewView | undefined;
  private title = 'Chat';
  private ready: Promise<void> = Promise.resolve();
  private releaseReady: (() => void) | undefined;
  private readonly received = new vscode.EventEmitter<WebviewToExtensionMessage>();
  readonly onDidReceiveMessage = this.received.event;
  private readonly posted = new vscode.EventEmitter<ExtensionToWebviewMessage>();
  /** Each message delivered to the webview. */
  readonly onDidPost = this.posted.event;

  get visible(): boolean { return this.view?.visible ?? false; }

  imageRequestOrigin(): string {
    return vscode.env.remoteName ? `remote extension host (${vscode.env.remoteName})` : 'local extension host';
  }

  showInformationMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined> {
    return vscode.window.showInformationMessage(message, ...items);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('acp-chat.focus');
    await this.ready;
  }

  /** `webviewChanged` is given the view's webview when it resolves, and `undefined` once the view is disposed. */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly webviewChanged: (webview: vscode.Webview | undefined) => void,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.title = this.title;
    this.ready = new Promise((resolve) => { this.releaseReady = resolve; });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      this.received.fire(message);
      if (message.type === 'ready') { this.releaseReady?.(); }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.releaseReady?.();
      this.webviewChanged(undefined);
    });
    this.webviewChanged(webviewView.webview);
  }

  post(message: ExtensionToWebviewMessage): void {
    if (message.type === 'state') {
      this.title = message.session ? `Chat ${message.session.agentName}` : 'Chat';
      if (this.view) { this.view.title = this.title; }
    }
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
