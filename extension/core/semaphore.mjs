// Minimal async semaphore — a long-lived, process-wide concurrency gate.
//
// Unlike `p-map.mjs` (which bounds concurrency *within a single batch*), a
// Semaphore bounds concurrency *across independent callers* over the whole
// process lifetime. Used to cap how many heavyweight CLI subprocesses can be
// in flight at once regardless of which code path spawned them — see
// `agents/providers.mjs` `spawnCli`.
//
// Single-threaded JS, so no locking: a slot is either taken (`active++` in
// acquire) or, on release, handed directly to the next waiter without ever
// being freed — which keeps `active` exact and avoids a decrement/increment
// race window.

export class Semaphore {
  /** @param {number} max maximum concurrent holders (clamped to >= 1) */
  constructor(max) {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.active = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
  }

  /** Resolves once a slot is held. Pair every acquire with exactly one release. */
  acquire() {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  /** Hand the slot to the next waiter, or free it if none are waiting. */
  release() {
    const next = this.queue.shift();
    if (next) {
      // Transfer this holder's slot straight to the next waiter: `active`
      // was counting us, now it counts them — net unchanged, so leave it.
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  /** Run `fn` while holding a slot; always releases, even on throw. */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Diagnostics: how many callers are currently waiting for a slot. */
  get waiting() {
    return this.queue.length;
  }
}
