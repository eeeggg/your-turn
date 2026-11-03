import { acpContainerControl, agentsViewRow, chatTranscript, promptInput } from './workbench';
import { expect, test } from './window';

for (const agentVersion of ['v1', 'v2'] as const) {
  test.describe(agentVersion, () => {
    test.use({ agentVersion });

    test('embedded images decode within transcript bounds while blocked sources and broken images remain readable', async ({ window }, testInfo) => {
      const requests: string[] = [];
      window.on('request', (request) => {
        if (request.url().includes('example.invalid') || request.url().includes('not-read')) { requests.push(request.url()); }
      });
      await acpContainerControl(window).click();
      await agentsViewRow(window, `fake-${agentVersion}`).hover();
      await window.getByRole('button', { name: 'Connect to Agent' }).click();
      const prompt = promptInput(window);
      await expect(prompt).toBeEnabled();
      await prompt.fill('images');
      await prompt.press('Enter');
      const transcript = chatTranscript(window);
      await expect(transcript).toContainText('Image not displayed: browser could not render it');
      const image = transcript.locator('img[alt="Image from agent"]');
      await expect(image).toBeVisible();
      await image.evaluate(async (element) => { await (element as HTMLImageElement).decode(); });
      const dimensions = await image.evaluate((element) => {
        const image = element as HTMLImageElement;
        const bounds = image.getBoundingClientRect();
        const container = image.closest('.turn')?.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, available: container?.width ?? 0, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
      });
      expect(dimensions.naturalWidth).toBe(1000);
      expect(dimensions.naturalHeight).toBe(2000);
      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.width).toBeLessThanOrEqual(dimensions.available);
      expect(dimensions.height).toBeLessThanOrEqual(384);
      expect(dimensions.width / dimensions.height).toBeCloseTo(0.5, 1);
      await expect(transcript).toContainText('Before image.');
      await expect(transcript).toContainText('After image.');
      await expect(transcript).toContainText('Blocked picture — image not displayed');
      await expect(transcript).toContainText('Image not displayed: browser could not render it');
      await expect(transcript).toContainText('Image reference not displayed');
      await transcript.locator('#tc-image-tool > summary').click();
      const tool = transcript.locator('img[alt="Image in tool output"]');
      await expect(tool).toBeVisible();
      await tool.evaluate(async (element) => { await (element as HTMLImageElement).decode(); });
      expect(requests).toEqual([]);
      await window.screenshot({ path: testInfo.outputPath(`transcript-images-${agentVersion}.png`) });
    });
  });
}
