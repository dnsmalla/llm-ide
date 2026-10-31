// Serialises writes per note. Two saves of the same note must never overlap (the second one would carry
// a stale hash and fail with `conflict` against our OWN first write), so each key has a promise chain;
// different notes run independently. A failed task does not poison the chain.

export class WriteQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs `task` after every earlier task for `key` has settled. Resolves/rejects with the task's result. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Notes with writes in flight or queued. */
  get pending(): number {
    return this.tails.size;
  }

  /** Resolves when everything queued so far has settled. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}
