import type { FrameLocator, Locator, Page } from '@playwright/test';

const extensionId = 'formulahendry.acp-client';

/** The extension-owned workbench control, wherever VS Code places its view container. */
export function acpContainerControl(window: Page): Locator {
  return window.getByRole('tab', { name: 'ACP Client', exact: true });
}

/** VS Code's Explorer control in the activity bar, whose accessible name continues with its shortcut. */
export function explorerControl(window: Page): Locator {
  return window.getByRole('tab', { name: /^Explorer\b/ });
}

/** A row of the Agents view, an agent or one of its sessions, by the label it shows; its accessible name is its tooltip. */
export function agentsViewRow(window: Page, label: string): Locator {
  return window.getByRole('tree', { name: 'Agents', exact: true }).getByRole('treeitem').filter({ hasText: label });
}

/**
 * VS Code's private pane DOM holds a view's header, with its title and title actions, and its body, with its
 * tree or welcome content. The view's icon in the header identifies the Agents pane under either of its titles.
 */
function agentsPane(window: Page): Locator {
  return window.locator('.pane').filter({ has: window.locator('.pane-header > .codicon-hubot') });
}

export function agentsViewTitle(window: Page): Locator {
  return agentsPane(window).locator('.pane-header > .title');
}

/** VS Code displays a pane's title actions only while the pane is hovered or focused. */
export function agentsViewAction(window: Page, name: string): Locator {
  return agentsPane(window).locator('.pane-header .actions').getByRole('button', { name, exact: true });
}

/** The names of the Agents view's title actions, which VS Code renders together, whether or not it displays them. */
export function agentsViewActionNames(window: Page): Promise<string[]> {
  return agentsPane(window).locator('.pane-header .actions .action-label')
    .evaluateAll((labels) => labels.map((label) => label.getAttribute('aria-label') ?? ''));
}

export function agentsViewWelcome(window: Page): Locator {
  return agentsPane(window).locator('.welcome-view-content');
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

/** VS Code's private pane DOM identifies the chat view by its header icon; its webview is in an overlay outside it. */
export function chatStop(window: Page): Locator {
  return window.locator('.pane').filter({ has: window.locator('.pane-header > .codicon-comment-discussion') })
    .locator('.pane-header .actions').getByRole('button', { name: 'ACP: Cancel Current Turn', exact: true });
}

export function promptInput(window: Page): Locator {
  return acpChatFrame(window).locator('#promptInput');
}

export function questionSurface(window: Page): Locator {
  return acpChatFrame(window).getByRole('region', { name: 'Elicitations', exact: true });
}

export function questionNotification(window: Page): Locator {
  return acpChatFrame(window).getByRole('button', { name: /elicitation.*awaiting your response$/ });
}

export function pendingQuestions(window: Page): Locator {
  return acpChatFrame(window).getByLabel('Pending elicitations', { exact: true });
}

export function queuedPrompts(window: Page): Locator {
  return acpChatFrame(window).locator('#queuedPrompts');
}

/** VS Code's private notification-list DOM groups a native message with its action buttons. */
export function nativeQuestionNotification(window: Page): Locator {
  return window.locator('.notifications-list-container .monaco-list-row').filter({ hasText: 'has a question' });
}

export function questionRecords(window: Page): Locator {
  return acpChatFrame(window).locator('.question-record');
}

export function sessionUsage(window: Page): Locator {
  return acpChatFrame(window).getByRole('button', { name: 'Session usage', exact: true });
}

export function sessionUsageDetails(window: Page): Locator {
  return acpChatFrame(window).getByRole('region', { name: 'Session usage details', exact: true });
}

/** The prompts ACP Chat's transcript shows, by the webview's own classes. */
export function chatUserMessages(window: Page): Locator {
  return acpChatFrame(window).locator('.message.user');
}

export function chatTranscript(window: Page): Locator {
  return acpChatFrame(window).locator('#messages');
}

export function chatCompactions(window: Page): Locator {
  return acpChatFrame(window).locator('.compaction-block');
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

export function plainFileTab(window: Page, name: string): Locator {
  return editorTab(window, name).filter({ hasNotText: '— ACP Review' });
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

export function reviewChangeStatus(window: Page): Locator {
  return window.locator('[id="formulahendry.acp-client.acp.review.change"]');
}

/** VS Code's native selection status reports the cursor without reading editor internals. */
export function editorSelection(window: Page): Locator {
  return window.locator('[id="status.editor.selection"]');
}

/** VS Code's native diff editor container; its private DOM is the rendered split editor boundary. */
export function reviewDiffEditor(window: Page): Locator {
  return window.locator('.monaco-diff-editor:visible').filter({
    has: window.locator('.monaco-editor[data-uri^="acp-review-diff:"]'),
  });
}

/** VS Code renders extension CodeLens commands as links inside its private codelens widget. */
export function reviewLens(window: Page, action: 'Keep Change' | 'Undo Change', position?: string): Locator {
  const rows = reviewDiffEditor(window).locator('.modified-in-monaco-diff-editor .codelens-decoration');
  return (position ? rows.filter({ hasText: position }) : rows).locator('a').filter({ hasText: action });
}

/** Editor title action labels are provided by the extension's command contributions. */
export function reviewTitleAction(window: Page, action: string): Locator {
  return window.locator('.editor-actions').getByRole('button', { name: action, exact: true });
}

/** Native diff navigation includes its keyboard shortcut in the accessible label. */
export async function navigateDiff(window: Page, direction: 'Previous' | 'Next'): Promise<void> {
  const name = new RegExp(`^${direction} Change(?: \\(|$)`);
  const button = window.locator('.editor-actions').getByRole('button', { name });
  if (await button.isVisible()) { await button.click(); }
  else {
    await window.locator('.editor-actions').getByRole('button', { name: 'More Actions...', exact: true }).click();
    await window.getByRole('menuitem', { name: new RegExp(`^${direction} Change(?:\\s|$)`) }).click();
  }
}

export function hideSecondarySideBar(window: Page): Locator {
  return window.getByRole('button', { name: /^Hide Secondary Side Bar/ });
}

export function gitOpenChanges(window: Page): Locator {
  return window.locator('.editor-actions').getByRole('button', { name: 'Open Changes', exact: true });
}

export function gitOpenFile(window: Page): Locator {
  return window.locator('.editor-actions').getByRole('button', { name: 'Open File', exact: true });
}

export function sourceControl(window: Page): Locator {
  return window.getByRole('tab', { name: /^Source Control \(/ });
}

export function gitWorkingTreeChange(window: Page, name: string): Locator {
  return window.getByRole('treeitem', { name: `${name}, Modified`, exact: true });
}

/** SCM's private repository DOM groups resource rows under its provider, separating ACP from Git. */
export function reviewedFile(window: Page, name: string): Locator {
  return window.locator('.scm-view .monaco-list-row').filter({ hasText: name });
}

/** Native diff deletion highlights are Monaco's rendered removed-line presentation, not plain baseline text. */
export function removedReviewLines(window: Page): Locator {
  return reviewDiffEditor(window).locator('.original-in-monaco-diff-editor .line-delete');
}

/** A plain file editor excludes VS Code's native diff editor containers. */
export function plainFileEditor(window: Page): Locator {
  return window.locator('.editor-instance').filter({ hasNot: window.locator('.monaco-diff-editor') })
    .locator('.monaco-editor[data-uri^="file:"]');
}

/** A native Git comparison must retain Git's original URI, distinct from ACP's baseline. */
export function gitDiffEditor(window: Page): Locator {
  return window.locator('.monaco-diff-editor:visible').filter({
    has: window.locator('.monaco-editor[data-uri^="git:"]'),
  });
}

export function modifiedReviewEditor(window: Page): Locator {
  return reviewDiffEditor(window).locator('.modified-in-monaco-diff-editor');
}

export function modifiedReviewLine(window: Page, text: string): Locator {
  return modifiedReviewEditor(window).getByText(text, { exact: true });
}
