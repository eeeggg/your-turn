import type * as vscode from 'vscode';

/**
 * `webview` as it behaves in a window on the remote `authority`, whose `file:` URIs are on that remote: VS Code's own
 * encoder, given the URI such a window makes of a `file:` URI.
 */
export function remoteWebview(webview: vscode.Webview, authority: string): Pick<vscode.Webview, 'asWebviewUri'> {
  return { asWebviewUri: (uri) => webview.asWebviewUri(uri.scheme === 'file' ? uri.with({ scheme: 'vscode-remote', authority }) : uri) };
}
