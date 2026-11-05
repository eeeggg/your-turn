export interface ChatHtmlParams {
  cspSource: string;
  nonce: string;
  styleUri: string;
  scriptUri: string;
}

/**
 * The chat webview's HTML document. Kept free of `vscode` imports so it can be
 * rendered outside the extension host.
 */
export function renderChatHtml({ cspSource, nonce, styleUri, scriptUri }: ChatHtmlParams): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Chat</title>
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div class="chat-view" id="chatView"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
