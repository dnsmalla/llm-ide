// SyncStore: opaque encrypted files under validated relative paths (design 2.1). Adapters know nothing about keys or
// formats. Every adapter calls checkPath before any I/O.
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
