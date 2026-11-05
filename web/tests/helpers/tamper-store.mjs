// A store the "storage provider" controls: every get and list can be rewritten by a test hook.
import { createMemoryStore } from '../../../extension/connectors/sync-store/index.mjs';

export function createTamperStore(inner = createMemoryStore()) {
  const t = {
    inner, onGet: null, onList: null,
    async get(p) { const b = await inner.get(p); return t.onGet ? t.onGet(p, b) : b; },
    async list(d) { const items = await inner.list(d); return t.onList ? t.onList(d, items) : items; },
    put: (p, b, m) => inner.put(p, b, m),
    remove: (p) => inner.remove(p),
    removeTree: (d) => inner.removeTree(d),
    describe: () => inner.describe(),
    dump: () => inner.dump(),
  };
  return t;
}
