// A small in-memory IndexedDB factory for the keystore and sources-config tests (open, one store, get/put/delete).
export function fakeIdb() {
  const data = new Map(); let created = false;
  const request = (fn, after) => {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); after?.(); } catch (e) { r.error = e; r.onerror?.(); } });
    return r;
  };
  const db = {
    createObjectStore: () => { created = true; },
    transaction: () => {
      const t = { oncomplete: null, onerror: null, onabort: null, error: null };
      const done = () => queueMicrotask(() => t.oncomplete?.());
      t.objectStore = () => ({ get: (k) => request(() => data.get(k)), put: (v, k) => request(() => { data.set(k, v); }, done), delete: (k) => request(() => { data.delete(k); }, done) });
      return t;
    },
  };
  return { data, open: () => { const r = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db }; queueMicrotask(() => { if (!created) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
