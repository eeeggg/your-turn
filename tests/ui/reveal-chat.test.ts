import { acpChatWebview, acpContainerControl, promptInput } from './workbench';
import { expect, test } from './window';

test('clicking ACP Client reveals ACP Chat in a fresh VS Code window', async ({ window }, testInfo) => {
  const chatWebview = acpChatWebview(window);
  await expect(chatWebview).toBeHidden();

  await acpContainerControl(window).click();

  await expect(acpContainerControl(window)).toHaveAttribute('aria-selected', 'true');
  await expect(chatWebview).toBeVisible();
  const prompt = promptInput(window);
  await expect(prompt).toBeVisible();

  testInfo.annotations.push({
    type: 'prompt focus before connection',
    description: await prompt.isEnabled() ? 'enabled' : 'disabled',
  });
  await window.screenshot({ path: testInfo.outputPath('acp-chat-revealed.png') });
});
