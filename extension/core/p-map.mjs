// Lightweight bounded-concurrency map utility used by the dispatcher and
// outcome watcher.  Kept in core/ so it can be imported without pulling in
// any domain logic.
//
// Processes `items` with at most `concurrency` in-flight Promises at once.
// Returns a results array in the same order as `items`.
//
// Error handling is deliberately left to callers: `fn` should catch and
// return an error-shaped result rather than throwing, so one item's failure
// doesn't abort the rest.  The dispatcher adapters follow this contract.

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {number} [concurrency=4]
 * @returns {Promise<R[]>}
 */
export async function pMap(items, fn, concurrency = 4) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  // Spawn min(concurrency, items.length) workers; each drains the shared
  // cursor so the total number of in-flight Promises is bounded.
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
