// A storage provider that can read and rewrite anything (design 13, "malicious store"): wraps the memory store; a test
// substitutes, drops or replays any file on get and list, and can count reads.
import { createMemoryStore } from '../../connectors/sync-store/index.mjs';

export function createTamperStore() {
  const inner = createMemoryStore();
  const s = {
    inner, gets: new Map(), onGet: null, onList: null,
    async put(path, bytes) { await inner.put(path, bytes); },
    async get(path) { s.gets.set(path, (s.gets.get(path) ?? 0) + 1); const b = await inner.get(path); return s.onGet ? s.onGet(path, b) : b; },
    async list(dir) { const l = await inner.list(dir); return s.onList ? s.onList(dir, l) : l; },
    remove: (p) => inner.remove(p), removeTree: (d) => inner.removeTree(d), describe: () => inner.describe(), dump: () => inner.dump(),
  };
  return s;
}
