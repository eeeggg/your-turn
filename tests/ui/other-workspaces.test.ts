import {
  acpContainerControl, agentsViewAction, agentsViewActionNames, agentsViewRow, agentsViewTitle, agentsViewWelcome,
} from './workbench';
import { expect, test } from './window';

test('the Agents view toggles to other workspaces and back from its title bar', async ({ window }, testInfo) => {
  await acpContainerControl(window).click();
  await expect(agentsViewRow(window, 'fake-v1')).toBeVisible();
  await expect(agentsViewTitle(window)).toHaveText('Agents');

  await agentsViewTitle(window).hover();
  await agentsViewAction(window, 'ACP: Show Other Workspaces').click();

  await expect(agentsViewAction(window, "ACP: Show This Workspace's Agents")).toBeVisible();
  expect(await agentsViewActionNames(window)).toEqual(["ACP: Show This Workspace's Agents"]);
  await expect(agentsViewTitle(window)).toHaveText('Other Workspaces');
  await expect(agentsViewWelcome(window)).toContainText('No sessions in other workspaces yet.');
  await window.screenshot({ path: testInfo.outputPath('other-workspaces.png') });

  await agentsViewAction(window, "ACP: Show This Workspace's Agents").click();

  await expect(agentsViewAction(window, 'ACP: Show Other Workspaces')).toBeVisible();
  expect(await agentsViewActionNames(window)).toEqual(['ACP: Show Other Workspaces', 'ACP: Add Agent Configuration']);
  await expect(agentsViewTitle(window)).toHaveText('Agents');
  await expect(agentsViewRow(window, 'fake-v1')).toBeVisible();
});
