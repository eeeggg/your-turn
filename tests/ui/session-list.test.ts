import { acpContainerControl, agentsViewRow, explorerControl } from './workbench';
import { expect, test } from './window';

test.use({ listsSessions: true });

test("showing the Agents view again shows what a running agent lists now", async ({ window }, testInfo) => {
  await acpContainerControl(window).click();
  await agentsViewRow(window, 'fake-v1').click();
  await expect(agentsViewRow(window, 'Listed 1')).toBeVisible();

  await explorerControl(window).click();
  await expect(agentsViewRow(window, 'Listed 1')).toBeHidden();
  await acpContainerControl(window).click();

  await expect(agentsViewRow(window, 'Listed 2')).toBeVisible();
  await expect(agentsViewRow(window, 'Listed 1')).toBeHidden();
  await window.screenshot({ path: testInfo.outputPath('agents-view-refreshed.png') });
});
