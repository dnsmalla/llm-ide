// In-memory stand-in for the host FsApi subset the Factory uses. It mirrors the host's error codes:
// reading a missing file -> not_found; writing with a stale expected_hash -> conflict; writing with
// expected_hash null over an existing file -> exists; creating an existing folder -> exists.
export function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const hashes = new Map();
  const dirs = new Set();
  let seq = 0;
  for (const p of files.keys()) hashes.set(p, `h${seq++}`);
  const fail = (code) => Object.assign(new Error(code), { code });
  const fs = {
    files,
    dirs,
    /** Runs once before the next write (simulates a concurrent writer), then clears itself. */
    beforeWrite: null,
    async read(path) {
      if (!files.has(path)) throw fail("not_found");
      const text = files.get(path);
      return { path, status: "ok", text, hash: hashes.get(path), size: text.length };
    },
    async write(path, text, opts) {
      const hook = fs.beforeWrite;
      fs.beforeWrite = null;
      if (hook) hook();
      const current = hashes.get(path) ?? null;
      if (!opts.force) {
        if (opts.expected_hash === null && current !== null) throw fail("exists");
        if (opts.expected_hash !== null && opts.expected_hash !== current) throw fail("conflict");
      }
      files.set(path, text);
      const hash = `h${seq++}`;
      hashes.set(path, hash);
      return { path, size: text.length, mtime_ms: 0, hash };
    },
    async create(path, kind) {
      if (dirs.has(path) || files.has(path)) throw fail("exists");
      if (kind === "dir") dirs.add(path);
      else { files.set(path, ""); hashes.set(path, `h${seq++}`); }
      return path;
    },
    async list(path) {
      const prefix = path ? `${path}/` : "";
      const names = new Map();
      for (const p of [...files.keys(), ...dirs]) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest) continue;
        const [head, ...more] = rest.split("/");
        names.set(head, more.length > 0 || dirs.has(prefix + head) ? "dir" : "file");
      }
      if (names.size === 0 && !dirs.has(path)) throw fail("not_found");
      const entries = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, kind]) => ({ name, path: prefix + name, kind, symlink: false, hidden: name.startsWith("."), ignored: false, size: 0, mtime_ms: 0 }));
      return { path, entries, total: entries.length, next_offset: null, skipped: 0 };
    },
    /** Replace a file as another writer would (new hash). */
    put(path, text) { files.set(path, text); hashes.set(path, `h${seq++}`); },
  };
  return fs;
}
