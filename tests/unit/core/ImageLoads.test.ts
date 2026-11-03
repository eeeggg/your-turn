import { describe, expect, it, vi } from 'vitest';
import { ImageLoads } from '@/core/ImageLoads';

describe('image load scheduling', () => {
  it('runs two jobs, queues eight, rejects overflow, and starts the next on completion', async () => {
    const loads = new ImageLoads(10000);
    const controllers = Array.from({ length: 11 }, () => new AbortController());
    const started: number[] = [];
    const finish: (() => void)[] = [];
    const jobs = controllers.map((controller, index) => loads.run(controller.signal, async () => {
      started.push(index);
      await new Promise<void>((resolve) => { finish.push(resolve); });
      return index;
    }).catch((error: unknown) => error));
    expect(started).toEqual([0, 1]);
    expect(await jobs[10]).toMatchObject({ message: 'Image loading queue is full' });
    finish.shift()?.();
    expect(await jobs[0]).toBe(0);
    expect(started).toEqual([0, 1, 2]);
    controllers.forEach((controller) => controller.abort());
    finish.forEach((resolve) => resolve());
    await Promise.all(jobs);
  });

  it('removes cancelled queued work without executing it', async () => {
    const loads = new ImageLoads(10000);
    const cancel = new AbortController();
    const blockers = [0, 1].map(() => loads.run(cancel.signal, (signal) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    })).catch((error: unknown) => error));
    const queued = new AbortController();
    let ran = false;
    const job = loads.run(queued.signal, async () => { ran = true; });
    queued.abort();
    await expect(job).rejects.toThrow();
    expect(ran).toBe(false);
    cancel.abort();
    await Promise.all(blockers);
    expect(ran).toBe(false);
  });

  it('enforces the total deadline and aborts the operation', async () => {
    vi.useFakeTimers();
    try {
      const loads = new ImageLoads(10000);
      let aborted = false;
      const job = loads.run(new AbortController().signal, (signal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      }));
      const outcome = job.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await outcome).toMatchObject({ message: 'Image loading timed out' });
      expect(aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
