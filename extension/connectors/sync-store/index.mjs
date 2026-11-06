// SyncStore: opaque encrypted files under validated relative paths (design 2.1). Adapters know nothing about keys or
// formats. Every adapter calls checkPath before any I/O. Optional ensureDir(dir) (own server only) creates the folders a device will write into.
export const MAX_FILE_BYTES = 1048576 + 4096;
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

const err = (code, message) => Object.assign(new Error(message), { code });

export function checkPath(path) {
  const segs = typeof path === 'string' ? path.split('/') : [];
  if (segs.length < 1 || segs.length > 6 || segs.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) {
    throw err('SYNC_BAD_PATH', 'Invalid sync path');
  }
  return segs;
}

export function checkSize(bytes) {
  if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw err('SYNC_TOO_LARGE', 'Sync file too large');
}

export const STORE_OP_TIMEOUT_MS = 30_000;

/**
 * Every store call rejects with SYNC_TIMEOUT after `ms`, so a hung storage call cannot hold the per-user lock (and block
 * revoke) forever. shortcut: the underlying request is not cancelled and may still finish late; add cancellation if an
 * adapter exposes it.
 */
export function withTimeouts(store, ms = STORE_OP_TIMEOUT_MS) {
  const wrap = (fn) => (...args) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(err('SYNC_TIMEOUT', 'Sync storage did not answer in time')), ms); });
    return Promise.race([fn(...args), timeout]).finally(() => clearTimeout(timer));
  };
  const out = { ...store };
  for (const k of ['put', 'get', 'list', 'remove', 'removeTree', 'ensureDir']) if (typeof store[k] === 'function') out[k] = wrap(store[k].bind(store));
  return out;
}

/** In-memory adapter for tests. */
export function createMemoryStore() {
  const files = new Map(); // path -> { bytes, mtimeMs }
  return {
    async put(path, bytes) { checkPath(path); checkSize(bytes); files.set(path, { bytes: Buffer.from(bytes), mtimeMs: Date.now() }); },
    async get(path) { checkPath(path); const f = files.get(path); return f ? Buffer.from(f.bytes) : null; },
    async list(dir) {
      const prefix = `${checkPath(dir).join('/')}/`;
      const out = [];
      for (const [p, f] of files) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ name: p.slice(prefix.length), size: f.bytes.length, mtimeMs: f.mtimeMs });
      }
      return out;
    },
    async remove(path) { checkPath(path); files.delete(path); },
    async removeTree(dir) { const prefix = `${checkPath(dir).join('/')}/`; for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p); },
    describe() { return { kind: 'memory', root: '' }; },
    dump() { return new Map([...files].map(([p, f]) => [p, f.bytes])); },
  };
}

/** l***@example.com: enough to recognise an account, not enough to reuse it. */
export function maskEmail(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  return at > 0 ? `${s[0]}***${s.slice(at)}` : '***';
}
