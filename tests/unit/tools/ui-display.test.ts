import { access } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({ test: { extend: (fixtures: unknown) => fixtures }, expect: {}, _electron: {} }));

interface DisplayFixture {
  display(input: object, use: (display: string | undefined) => Promise<void>): Promise<void>;
}

async function fixture() {
  const { test } = await import('@tests/ui/window');
  return test as unknown as DisplayFixture;
}

it('owns a separate ready X display per test and closes both servers before returning', async () => {
  const fixtures = await fixture();
  if (process.platform !== 'linux') {
    await fixtures.display({}, async (display) => { expect(display).toBe(process.env['DISPLAY']); });
    return;
  }
  const displays: string[] = [];
  await fixtures.display({}, async (first) => {
    expect(first).toMatch(/^:\d+$/);
    displays.push(first ?? '');
    await access(`/tmp/.X11-unix/X${(first ?? '').slice(1)}`);
    await fixtures.display({}, async (second) => {
      expect(second).toMatch(/^:\d+$/);
      expect(second).not.toBe(first);
      displays.push(second ?? '');
      await access(`/tmp/.X11-unix/X${(second ?? '').slice(1)}`);
    });
  });
  for (const display of displays) { await expect(access(`/tmp/.X11-unix/X${display.slice(1)}`)).rejects.toThrow(); }
});

it('closes the display after a test failure without replacing the failure', async () => {
  const fixtures = await fixture();
  const failure = new Error('test failed');
  let display: string | undefined;
  await expect(fixtures.display({}, async (owned) => { display = owned; throw failure; })).rejects.toBe(failure);
  if (process.platform !== 'linux') { expect(display).toBe(process.env['DISPLAY']); return; }
  expect(display).toMatch(/^:\d+$/);
  await expect(access(`/tmp/.X11-unix/X${(display ?? '').slice(1)}`)).rejects.toThrow();
});
