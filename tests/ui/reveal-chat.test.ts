import { chatWebview, yourTurnContainerControl, promptInput } from '@tests/ui/workbench';
import { expect, test } from '@tests/ui/window';

test('clicking Your Turn reveals its chat view in a fresh VS Code window', async ({ window }, testInfo) => {
  const webview = chatWebview(window);
  await expect(webview).toBeHidden();

  await yourTurnContainerControl(window).click();

  await expect(yourTurnContainerControl(window)).toHaveAttribute('aria-selected', 'true');
  await expect(webview).toBeVisible();
  const prompt = promptInput(window);
  await expect(prompt).toBeVisible();

  testInfo.annotations.push({
    type: 'prompt focus before connection',
    description: await prompt.isEnabled() ? 'enabled' : 'disabled',
  });
  await window.screenshot({ path: testInfo.outputPath('chat-revealed.png') });
});
