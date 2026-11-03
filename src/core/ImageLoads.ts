export class ImageLoads {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly deadline: number) {}

  run<T>(signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) { return Promise.reject(new Error('Image loading cancelled')); }
    if (this.active >= 2 && this.waiting.length >= 8) { return Promise.reject(new Error('Image loading queue is full')); }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let started = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      const abort = (reason: string) => {
        cleanup();
        if (!started) {
          const index = this.waiting.indexOf(start);
          if (index !== -1) { this.waiting.splice(index, 1); }
        }
        controller.abort();
        reject(new Error(reason));
      };
      const cancel = () => abort('Image loading cancelled');
      const timer = setTimeout(() => abort('Image loading timed out'), this.deadline);
      signal.addEventListener('abort', cancel, { once: true });
      const start = () => {
        started = true;
        this.active++;
        void load(controller.signal).then(resolve, reject).finally(() => {
          cleanup();
          this.active--;
          this.waiting.shift()?.();
        });
      };
      if (this.active < 2) { start(); } else { this.waiting.push(start); }
    });
  }
}
