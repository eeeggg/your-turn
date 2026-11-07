import {
  yourTurnContainerControl,
  agentsViewRow,
  chatViewTitle,
  promptInput,
  sessionTabs
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test.use({ listsSessions: true, compaction: true });

test('session tabs wrap into rows with keyboard and close controls reachable in a narrow chat view', async ({ window, workspace }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await window.keyboard.press('Escape');
  await agentsViewRow(window, 'Compaction session').click();
  await expect(promptInput(window)).toBeEnabled();
  await agentsViewRow(window, 'Another session with a deliberately long title for tab overflow').click();
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
