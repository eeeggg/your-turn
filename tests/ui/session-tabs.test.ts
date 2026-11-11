import {
  yourTurnContainerControl,
  agentsViewRow,
  chatViewTitle,
  promptInput,
  quickInput,
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
  await expect(agent).toHaveAttribute('aria-label', /fake-v1 — no session/);
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
