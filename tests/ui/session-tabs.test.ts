import {
  yourTurnContainerControl,
  agentMoreActions,
  agentsViewRow,
  chatTheme,
  chatTranscript,
  chatViewTitle,
  chooseAgentAction,
  promptInput,
  quickInput,
  quickInputRow,
  selectListedSession,
  sessionTabs
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ listsSessions: true, compaction: true });

test.describe('context-menu refresh boundary', () => {
  test.use({ controlledTreeRefresh: true });

  test('New Session retains its menu target while the Agents tree refresh is pending', async ({ window, treeRefresh }) => {
    if (!treeRefresh) { throw new Error('Controlled tree refresh is not enabled'); }
    await yourTurnContainerControl(window).click();
    const agent = agentsViewRow(window, 'fake-v1');
    await agent.click();
    await expect(agentsViewRow(window, 'Compaction session')).toBeVisible();
    await expect(promptInput(window)).toBeDisabled();
    await agent.click({ button: 'right' });
    const newSession = window.getByRole('menuitem', { name: 'Your Turn: New Session', exact: true });
    await newSession.focus();
    await newSession.press('Home');
    await expect(newSession).toBeFocused();
    await treeRefresh.hold();
    try {
      await newSession.press('Enter');
      await expect(newSession).toBeHidden();
      await expect(promptInput(window)).toBeEnabled();
      await expect(quickInput(window)).toBeHidden();
      await expect(sessionTabs(window).getByRole('tab')).toHaveCount(1);
      await expect(chatViewTitle(window)).toHaveText('Chat FakeAgent');
    } finally {
      await treeRefresh.release();
    }
    await expect(agentsViewRow(window, 'Compaction session')).toBeVisible();
  });
});

test('clicking listed sessions opens the intended tabs and returning selects the existing tab', async ({ window }) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, 'Compaction session');
  await expect(promptInput(window)).toBeEnabled();
  const tabs = sessionTabs(window).getByRole('tab');
  const first = sessionTabs(window).getByRole('tab', { name: 'Compaction session', exact: true });
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await selectListedSession(window, 'Another session with a deliberately long title for tab overflow');
  await expect(sessionTabs(window).getByRole('tab', { name: 'Another session with a deliberately long title for tab overflow', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await expect(promptInput(window)).toBeEnabled();
  await expect(tabs).toHaveCount(2);
  await selectListedSession(window, 'Compaction session');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(tabs).toHaveCount(2);
  await expect(promptInput(window)).toBeEnabled();
});

test('Refresh Sessions is offered in both menus only after the agent session list is fetched', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  const agent = agentsViewRow(window, 'fake-v1');
  await agent.hover();
  await agentMoreActions(window, 'fake-v1').click();
  await expect(quickInputRow(window, 'New Session')).toBeVisible();
  await expect(quickInputRow(window, 'Refresh Sessions')).toHaveCount(0);
  await quickInput(window).press('Escape');
  await expect(quickInput(window)).toBeHidden();

  await agent.click({ button: 'right' });
  await expect(window.getByRole('menuitem', { name: 'Your Turn: New Session', exact: true })).toBeVisible();
  const refresh = window.getByRole('menuitem', { name: 'Your Turn: Refresh Sessions', exact: true });
  await expect(refresh).toHaveCount(0);
  await window.keyboard.press('Escape');
  await agent.click();
  await expect(agentsViewRow(window, 'Compaction session')).toBeVisible();
  await agent.click();
  await expect(agentsViewRow(window, 'Compaction session')).toBeHidden();

  await chooseAgentAction(window, 'fake-v1', 'Disconnect Agent');
  await expect(agent).toHaveAttribute('aria-label', /fake-v1 — disconnected/);
  await agent.click({ button: 'right' });
  await expect(refresh).toBeVisible();
  await refresh.focus();
  await refresh.press('Home');
  await refresh.press('ArrowDown');
  await expect(refresh).toBeFocused();
  await refresh.press('Enter');
  await expect(refresh).toBeHidden();
  await expect(agent).toHaveAttribute('aria-label', /fake-v1 — connected/);

  await chooseAgentAction(window, 'fake-v1', 'Disconnect Agent');
  await expect(agent).toHaveAttribute('aria-label', /fake-v1 — disconnected/);
  await agent.hover();
  await agentMoreActions(window, 'fake-v1').click();
  await expect(quickInputRow(window, 'Refresh Sessions')).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath('agent-refresh-menu.png') });
  await quickInputRow(window, 'Refresh Sessions').click();
  await expect(agent).toHaveAttribute('aria-label', /fake-v1 — connected/);
  await expect(promptInput(window)).toBeDisabled();
});

test('window reload restores tab order and selection and preserves an explicitly empty strip', async ({ window }, testInfo) => {
  const first = 'Compaction session';
  const second = 'Another session with a deliberately long title for tab overflow';
  const strip = sessionTabs(window);
  const tabs = strip.getByRole('tab');
  const reload = async () => {
    await window.keyboard.press('F1');
    await quickInput(window).fill('>Developer: Reload Window');
    const command = quickInputRow(window, 'Developer: Reload Window');
    await expect(command).toBeVisible();
    await Promise.all([
      window.waitForEvent('framenavigated', (frame) => frame === window.mainFrame()),
      command.click(),
    ]);
    await expect(yourTurnContainerControl(window)).toBeVisible();
    await expect(promptInput(window)).toBeVisible();
  };

  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, first);
  await expect(promptInput(window)).toBeEnabled();
  await selectListedSession(window, second);
  await expect(promptInput(window)).toBeEnabled();
  await tabs.nth(0).click();
  await expect(tabs).toHaveText([first, second]);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(promptInput(window)).toBeEnabled();

  await reload();

  await expect(tabs).toHaveText([first, second]);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
  await expect(chatTranscript(window)).toContainText('Historical answer');
  await expect(promptInput(window)).toBeEnabled();
  await window.screenshot({ path: testInfo.outputPath('session-tabs-restored.png') });
  await strip.getByRole('button', { name: `Close ${second}`, exact: true }).click();
  await expect(tabs).toHaveText([first]);
  await strip.getByRole('button', { name: `Close ${first}`, exact: true }).click();
  await expect(strip).toBeHidden();
  await expect(promptInput(window)).toBeDisabled();

  await reload();

  await expect(tabs).toHaveCount(0);
  await expect(strip).toBeHidden();
  await expect(chatViewTitle(window)).toHaveText('Chat');
  await expect(promptInput(window)).toBeDisabled();
});

test('arrow navigation requires keyboard activation before switching the selected session', async ({ window }) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, 'Compaction session');
  await selectListedSession(window, 'Another session with a deliberately long title for tab overflow');
  const strip = sessionTabs(window);
  const first = strip.getByRole('tab', { name: 'Compaction session', exact: true });
  const second = strip.getByRole('tab', { name: 'Another session with a deliberately long title for tab overflow', exact: true });
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(promptInput(window)).toBeEnabled();
  await second.focus();
  await second.press('ArrowLeft');
  await expect(first).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await first.press('Space');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(second).toHaveAttribute('aria-selected', 'false');
  await expect(promptInput(window)).toBeEnabled();
  await first.focus();
  await first.press('ArrowRight');
  await expect(second).toBeFocused();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await second.press('Enter');
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await expect(strip.getByRole('tab')).toHaveCount(2);
  await expect(promptInput(window)).toBeEnabled();
});

test('selected tab remains distinct when focus leaves Chat in dark, light, and high-contrast themes', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, 'Compaction session');
  await selectListedSession(window, 'Another session with a deliberately long title for tab overflow');
  const tabs = sessionTabs(window).getByRole('tab');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  for (const [theme, kind] of [['Dark Modern', 'dark'], ['Light Modern', 'light'], ['Dark High Contrast', 'high-contrast']] as const) {
    await window.keyboard.press('F1');
    await quickInput(window).fill('>Preferences: Color Theme');
    await quickInputRow(window, 'Preferences: Color Theme').click();
    await quickInput(window).fill(theme);
    await quickInputRow(window, theme).click();
    await expect(quickInput(window)).toBeHidden();
    await expect(chatTheme(window)).toHaveClass(new RegExp(`\\bvscode-${kind}\\b`));
    await window.keyboard.press('F1');
    await expect(quickInput(window)).toBeFocused();
    const appearance = await tabs.evaluateAll((elements) => elements.map((tab) => {
      if (!tab.parentElement) { throw new Error('Missing tab container'); }
      const style = getComputedStyle(tab.parentElement);
      return { background: style.backgroundColor, border: style.borderTopColor, width: style.borderTopWidth, contrast: style.boxShadow };
    }));
    const [inactive, active] = appearance;
    if (!inactive || !active) { throw new Error('Missing tab appearance'); }
    expect(active.width).not.toBe('0px');
    expect(active.border).not.toBe(inactive.border);
    if (kind !== 'high-contrast') { expect(active.background).not.toBe(inactive.background); }
    else { expect(active.contrast).not.toBe(inactive.contrast); }
    await expect(tabs.nth(0)).toHaveAttribute('title', `Compaction session\nFakeAgent\n${workspace}`);
    await window.screenshot({ path: testInfo.outputPath(`session-tabs-${kind}.png`) });
    await window.keyboard.press('Escape');
    await expect(quickInput(window)).toBeHidden();
  }
});

test('session tabs wrap into rows with keyboard and close controls reachable in a narrow chat view', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await selectListedSession(window, 'Compaction session');
  await expect(promptInput(window)).toBeEnabled();
  await selectListedSession(window, 'Another session with a deliberately long title for tab overflow');
  const strip = sessionTabs(window);
  const tabs = strip.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('title', `Compaction session\nFakeAgent\n${workspace}`);
  await expect(chatViewTitle(window)).toHaveText('Chat FakeAgent');
  await tabs.nth(1).focus();
  await tabs.nth(1).press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(0).press('End');
  await expect(tabs.nth(1)).toBeFocused();
  await tabs.nth(1).press('Tab');
  const close = strip.getByRole('button', { name: 'Close Another session with a deliberately long title for tab overflow', exact: true });
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport();
  const geometry = await strip.evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    rows: Array.from(element.querySelectorAll('[role="tab"]'), (tab) => tab.getBoundingClientRect().top),
  }));
  const [firstRow, secondRow] = geometry.rows;
  if (firstRow === undefined || secondRow === undefined) { throw new Error('missing tab geometry'); }
  expect(secondRow).toBeGreaterThan(firstRow);
  expect(geometry.scroll).toBe(geometry.width);
  await expect(tabs.nth(0)).toBeInViewport();
  await expect(tabs.nth(1)).toBeInViewport();
  await window.screenshot({ path: testInfo.outputPath('session-tabs-wrapped.png') });
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(1).focus();
  await tabs.nth(1).press('Enter');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await close.press('Enter');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.nth(0)).toHaveText('Compaction session');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toBeFocused();
  await tabs.nth(0).press('Delete');
  await expect(strip).toBeHidden();
  await expect(chatViewTitle(window)).toHaveText('Chat');
  await expect(promptInput(window)).toBeDisabled();
  const agent = agentsViewRow(window, 'fake-v1');
  await expect(agent).toHaveAttribute('aria-label', /fake-v1 — connected/);
  await agent.click({ button: 'right' });
  const newSession = window.getByRole('menuitem', { name: 'Your Turn: New Session', exact: true });
  // Home selects the first action in VS Code's menu model, not just its DOM focus.
  await newSession.focus();
  await newSession.press('Home');
  await expect(newSession).toBeFocused();
  await newSession.press('Enter');
  await expect(newSession).toBeHidden();
  await expect(promptInput(window)).toBeEnabled();
  await expect(tabs).toHaveCount(1);
  await expect(chatViewTitle(window)).toHaveText('Chat FakeAgent');
});
