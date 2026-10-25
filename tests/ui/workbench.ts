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
