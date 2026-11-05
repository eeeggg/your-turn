import {
  yourTurnContainerControl,
  agentsViewAction,
  agentsViewActionNames,
  agentsViewRow,
  agentsViewTitle,
  agentsViewWelcome,
} from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test('the Agents view toggles to other workspaces and back from its title bar', async ({ window }, testInfo) => {
  await yourTurnContainerControl(window).click();
  await expect(agentsViewRow(window, 'fake-v1')).toBeVisible();
  await expect(agentsViewTitle(window)).toHaveText('Agents');

  await agentsViewTitle(window).hover();
  await agentsViewAction(window, 'Your Turn: Show Other Workspaces').click();

  await expect(agentsViewAction(window, "Your Turn: Show This Workspace's Agents")).toBeVisible();
  expect(await agentsViewActionNames(window)).toEqual(["Your Turn: Show This Workspace's Agents"]);
  await expect(agentsViewTitle(window)).toHaveText('Other Workspaces');
  await expect(agentsViewWelcome(window)).toContainText('No sessions in other workspaces yet.');
  await window.screenshot({ path: testInfo.outputPath('other-workspaces.png') });

  await agentsViewAction(window, "Your Turn: Show This Workspace's Agents").click();

  await expect(agentsViewAction(window, 'Your Turn: Show Other Workspaces')).toBeVisible();
  expect(await agentsViewActionNames(window)).toEqual(['Your Turn: Show Other Workspaces', 'Your Turn: Add Agent Configuration']);
  await expect(agentsViewTitle(window)).toHaveText('Agents');
  await expect(agentsViewRow(window, 'fake-v1')).toBeVisible();
});
