import type { FrameLocator, Locator, Page } from '@playwright/test';

const extensionId = 'formulahendry.acp-client';

/** The extension-owned workbench control, wherever VS Code places its view container. */
export function acpContainerControl(window: Page): Locator {
  return window.getByRole('tab', { name: 'ACP Client', exact: true });
}

/**
 * VS Code hosts extension webviews in an outer workbench iframe and an
 * `#active-frame` iframe. The extension ID distinguishes ACP Chat from the
 * built-in Chat webview, which may be visible at the same time.
 */
function acpChatFrame(window: Page): FrameLocator {
  return window
    .locator(`iframe.webview[src*="extensionId=${extensionId}"]`)
    .contentFrame()
    .locator('iframe#active-frame')
    .contentFrame();
}

export function acpChatWebview(window: Page): Locator {
  return window.locator(`iframe.webview[src*="extensionId=${extensionId}"]`);
}

export function promptInput(window: Page): Locator {
  return acpChatFrame(window).locator('#promptInput');
}

export function sendPromptButton(window: Page): Locator {
  return acpChatFrame(window).locator('#sendStopBtn');
}

/** VS Code's quick-input control, used by the command palette and file picker. */
export function quickInput(window: Page): Locator {
  return window.locator('.quick-input-widget:visible input');
}

/** A visible row in VS Code's quick-input list. */
export function quickInputRow(window: Page, text: string): Locator {
  return window.locator('.quick-input-widget:visible .quick-input-list .monaco-list-row').filter({ hasText: text });
}

/** A text editor tab, excluding similarly named controls elsewhere in the workbench. */
export function editorTab(window: Page, name: string): Locator {
  return window.locator('.tabs-container .tab').filter({ hasText: name });
}

/**
 * VS Code's private peek-view DOM represents the visible quick-diff widget.
 * Requiring the extension-owned Keep Change action distinguishes it from
 * references, definitions and other peek views.
 */
export function reviewQuickDiff(window: Page, fileName: string): Locator {
  return window.locator('.peekview-widget').filter({
    has: window.locator('[aria-label^="Keep Change"]'),
  }).filter({
    has: window.locator(`.peekview-title .filename[title="${fileName}"]`),
  });
}

/** The extension-owned review status item in VS Code's workbench status bar. */
export function reviewStatus(window: Page): Locator {
  return window.locator('[id="formulahendry.acp-client.acp.review"]');
}
