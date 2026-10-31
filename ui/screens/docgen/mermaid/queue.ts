// A small job queue: at most `concurrency` jobs run at once, the rest wait in order. Used so many diagrams in one
// document never spawn many frames at once.
export class RenderQueue {
  private running = 0;
  private waiting: (() => void)[] = [];
  private readonly concurrency: number;
  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  get active(): number {
    return this.running;
  }

  get pending(): number {
    return this.waiting.length;
  }

  /** Runs `job` when a slot is free. `signal` aborts a job still waiting (it rejects without running). */
  run<T>(job: () => Promise<T>, signal?: { aborted: boolean }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (signal?.aborted) {
          this.release();
          reject(new Error("cancelled"));
          return;
        }
        job().then(resolve, reject).finally(() => this.release());
      };
      if (this.running < this.concurrency) {
        this.running += 1;
        start();
      } else {
        this.waiting.push(() => start());
      }
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

/** Rejects with `timeout` when `p` does not settle in `ms` (the caller disposes of whatever `p` was driving). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      reject(new Error("The diagram took too long to render."));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
