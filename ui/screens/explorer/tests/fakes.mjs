// In-memory FsApi + EditorHost for controller tests.
import { createHash } from "node:crypto";

export const sha = (t) => createHash("sha256").update(t).digest("hex");
export class FsErr extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const parent = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const base = (p) => p.slice(p.lastIndexOf("/") + 1);

export function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial)); // path -> text
  const dirs = new Set([""]);
  for (const p of files.keys()) for (let d = parent(p); ; d = parent(d)) { dirs.add(d); if (d === "") break; }
  const calls = [];
  const state = { watchCb: null, watched: [], gitEntries: [], mtime: 1 };
  const kindOf = (p) => (dirs.has(p) ? "dir" : "file");
  const entry = (p) => ({ name: base(p), path: p, kind: kindOf(p), symlink: false, hidden: base(p).startsWith("."), ignored: false, size: files.get(p)?.length ?? 0, mtime_ms: state.mtime });
  const children = (dir) => {
    const out = [];
    for (const d of dirs) if (d !== "" && parent(d) === dir) out.push(d);
    for (const f of files.keys()) if (parent(f) === dir) out.push(f);
    return out.sort((a, b) => (kindOf(a) === kindOf(b) ? base(a).toLowerCase().localeCompare(base(b).toLowerCase()) : kindOf(a) === "dir" ? -1 : 1));
  };
  const api = {
    calls, files, dirs, state,
    async list(path, o = {}) {
      calls.push(["list", path, o.offset ?? 0]);
      if (!dirs.has(path)) throw new FsErr("not_found");
      let all = children(path);
      if (!o.show_hidden) all = all.filter((p) => !base(p).startsWith("."));
      const off = o.offset ?? 0, lim = o.limit ?? 1000;
      const page = all.slice(off, off + lim);
      return { path, entries: page.map(entry), total: all.length, next_offset: off + lim < all.length ? off + lim : null, skipped: 0 };
    },
    async read(path) {
      calls.push(["read", path]);
      if (!files.has(path)) throw new FsErr("not_found");
      const t = files.get(path);
      if (t.startsWith("BIN:")) return { path, status: "binary", size: t.length, mtime_ms: 1, hash: sha(t), text: null, encoding: "unknown", bom: false, eol: "none", read_only: true };
      if (t.length > 5000) return { path, status: "too_large", size: t.length, mtime_ms: 1, hash: null, text: null, encoding: "unknown", bom: false, eol: "none", read_only: true };
      return { path, status: "ok", size: t.length, mtime_ms: state.mtime, hash: sha(t), text: t, encoding: "utf-8", bom: false, eol: "lf", read_only: false };
    },
    async readRange(path, offset, length) {
      calls.push(["range", path, offset]);
      const t = files.get(path);
      const text = t.slice(offset, offset + length);
      return { path, offset, size: t.length, mtime_ms: 1, text, next_offset: offset + length < t.length ? offset + length : null, binary: false };
    },
    async write(path, text, o) {
      calls.push(["write", path, o.expected_hash]);
      const cur = files.get(path);
      if (cur === undefined) {
        if (o.expected_hash !== null && !o.force) throw new FsErr("conflict");
      } else if (!o.force) {
        if (o.expected_hash === null) throw new FsErr("exists");
        if (o.expected_hash !== sha(cur)) throw new FsErr("conflict");
      }
      files.set(path, text);
      return { path, size: text.length, mtime_ms: ++state.mtime, hash: sha(text) };
    },
    async create(path, kind) {
      calls.push(["create", path, kind]);
      if (files.has(path) || dirs.has(path)) throw new FsErr("exists");
      if (!dirs.has(parent(path))) throw new FsErr("not_found");
      if (kind === "dir") dirs.add(path); else files.set(path, "");
      return path;
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (files.has(to) || dirs.has(to)) throw new FsErr("exists");
      if (files.has(from)) { files.set(to, files.get(from)); files.delete(from); }
      else if (dirs.has(from)) {
        for (const d of [...dirs]) if (d === from || d.startsWith(from + "/")) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
        for (const f of [...files.keys()]) if (f.startsWith(from + "/")) { files.set(to + f.slice(from.length), files.get(f)); files.delete(f); }
      } else throw new FsErr("not_found");
      return to;
    },
    async remove(path) {
      calls.push(["remove", path]);
      if (state.trashFails) throw new FsErr("trash_unavailable", "no trash");
      files.delete(path);
      for (const f of [...files.keys()]) if (f.startsWith(path + "/")) files.delete(f);
      for (const d of [...dirs]) if (d === path || d.startsWith(path + "/")) dirs.delete(d);
    },
    async watchStart(cb) { state.watchCb = cb; return { mode: "native" }; },
    async watchSet(d) { state.watched = d; },
    async watchStop() { state.watchCb = null; },
    async gitStatus() {
      if (state.gitError) throw new FsErr(state.gitError);
      return { branch: "main", head: "abc", upstream: null, ahead: 0, behind: 0, entries: state.gitEntries, truncated: false };
    },
    async gitDiff() { return { text: "", truncated: false }; },
    async gitShow(path) { return { exists: true, text: "HEAD:" + path, truncated: false }; },
    async gitStage() {},
  };
  return api;
}

export function makeEditor() {
  const models = new Map(); // path -> {text, saved, readOnly}
  const reveals = [];
  const log = [];
  let cb = null;
  const ed = {
    models, log, current: null, diff: null,
    mount(_el, c) { cb = c; },
    open(d) { log.push(["open", d.path]); if (!models.has(d.path)) models.set(d.path, { text: d.text, saved: d.text, readOnly: d.readOnly, large: d.large, language: d.language }); ed.current = d.path; },
    show(p) { if (!models.has(p)) return false; ed.current = p; return true; },
    has: (p) => models.has(p),
    showNone() { ed.current = null; },
    getText: (p) => models.get(p)?.text ?? null,
    snapshot(p) { const m = models.get(p); if (!m) return null; m.ver ??= 0; m.hist ??= new Map(); m.hist.set(m.ver, m.text); return { text: m.text, versionId: m.ver }; },
    replace(p, t) { const m = models.get(p); m.text = t; m.saved = t; m.ver = (m.ver ?? 0) + 1; },
    append(p, t) { models.get(p).text += t; },
    markSaved(p, v) {
      const m = models.get(p);
      if (v === undefined || v === m.ver) m.saved = m.text; else m.saved = m.hist?.get(v) ?? m.saved;
      return m.text === m.saved;
    },
    versionOf(p) { return models.get(p)?.ver ?? 0; },
    close(p) { models.delete(p); if (ed.current === p) ed.current = null; },
    rename(a, b) { const m = models.get(a); models.delete(a); models.set(b, m); if (ed.current === a) ed.current = b; },
    showDiff(p, o) { ed.diff = [p, o]; },
    hideDiff() { ed.diff = null; },
    find() {}, reveal(path, line, col) { reveals.push([path, line, col]); }, reveals, focus() {}, layout() {}, retheme() {}, modelCount: () => models.size, dispose() {},
    // test helper: simulate typing
    type(p, text) { const m = models.get(p); m.ver = (m.ver ?? 0) + 1; m.text = text; cb.onDirty(p, m.text !== m.saved); },
    evict(p) { models.delete(p); cb.onEvict(p); },
  };
  return ed;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const settle = async () => { for (let i = 0; i < 6; i++) await tick(0); };
