import { expect, it, vi } from 'vitest';
import { cleanup } from '@tests/integration/cleanup';

it('attempts all teardown actions in order and reports their failures together', async () => {
  const attempts: string[] = [];
  const failure = new Error('close failed');
  await expect(cleanup(undefined, [
    async () => { attempts.push('close'); throw failure; },
    () => { attempts.push('remove'); },
  ])).rejects.toMatchObject({ errors: [failure] });
  expect(attempts).toEqual(['close', 'remove']);
});

it('reports cleanup failures without replacing the original test failure', async () => {
  const failure = new Error('test failed');
  const closeFailure = new Error('close failed');
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(cleanup({ err: failure }, [() => { throw closeFailure; }])).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ errors: [closeFailure] }));
  } finally { report.mockRestore(); }
});
