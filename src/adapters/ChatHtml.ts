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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>ACP Chat</title>
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div class="session-banner" id="sessionBanner">
    <span class="dot"></span>
    <div class="info">
      <div class="agent" id="bannerAgent"></div>
      <div class="cwd" id="bannerCwd"></div>
    </div>
    <span class="status" id="status"></span>
  </div>

  <div class="messages" id="messages">
    <div class="empty-state" id="emptyState">
      <div class="icon">🤖</div>
      <div class="title">ACP Chat</div>
      <div class="subtitle">Connect to an AI coding agent to start chatting.</div>
      <div class="actions">
        <button class="action-btn primary" id="welcomeConnectAgent">
          🔌 Connect to Agent
        </button>
        <button class="action-btn secondary" id="welcomeAddAgent">
          ⚙ Add Agent
        </button>
      </div>
      <div class="hint">or press <kbd>Ctrl+Shift+A</kbd> anytime</div>
    </div>
  </div>

  <div class="input-area" id="inputArea">
    <div class="slash-popup" id="slashPopup">
      <div class="slash-popup-header">Commands</div>
    </div>
    <div class="input-resize-handle" id="resizeHandle"></div>
    <div class="input-toolbar">
      <!-- Dynamic config-options pickers (ACP "Session Config Options"). -->
      <div class="picker-row" id="configOptionsContainer"></div>
      <!-- Legacy mode picker — used only when the agent has not migrated to configOptions -->
      <div class="picker-wrap hidden" id="modePickerWrap">
        <button class="picker-btn" id="modePickerBtn" title="Select mode">
          <span class="picker-icon">⚡</span>
          <span class="picker-label" id="modePickerLabel">Mode</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modeDropdown"></div>
      </div>
      <span class="toolbar-spacer"></span>
    </div>
    <div class="input-editor-wrap">
      <textarea
        id="promptInput"
        placeholder="Type a message..."
        rows="2"
      ></textarea>
    </div>
    <div class="input-send-row">
      <button class="send-stop-btn send" id="sendStopBtn">Send</button>
    </div>
  </div>

  <!-- Shared hover tooltip for picker dropdown items -->
  <div class="picker-tooltip" id="pickerTooltip" role="tooltip"></div>

  <!-- Overlay shown during session/load history replay -->
  <div class="load-overlay" id="loadOverlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <div class="label">Loading transcript…</div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
