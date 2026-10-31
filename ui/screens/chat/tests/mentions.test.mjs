import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("mentions"); });

/** An in-memory project: dirs -> entries, paged like the host. `calls` records every list. */
function fakeFs(tree) {
  const calls = [];
  const fs = {
    calls,
    async list(path, offset, limit, signal) {
      calls.push([path, offset, limit]);
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const all = tree.get(path);
      if (!all) throw Object.assign(new Error("nf"), { code: "not_found" });
      const page = all.slice(offset, offset + limit);
      return { entries: page, nextOffset: offset + limit < all.length ? offset + limit : null };
    },
    async readHead() { return { text: "x", truncated: false, binary: false }; },
    async ensureDir() {}, async writeText() {},
  };
  return fs;
}
const file = (dir, name) => ({ name, path: dir ? `${dir}/${name}` : name, kind: "file", size: 1 });
const dir = (parent, name) => ({ name, path: parent ? `${parent}/${name}` : name, kind: "dir", size: 0 });
const sig = () => new AbortController().signal;

test("safeMentionPath: confined to the project, no escape spelling survives", () => {
  assert.equal(c.safeMentionPath("src/ui/a.ts"), "src/ui/a.ts");
  assert.equal(c.safeMentionPath("./src//ui/"), "src/ui");
  for (const bad of ["../etc/passwd", "a/../../b", "/etc/passwd", "~/x", "C:\\Windows", "C:/x", "a\\b", "..", "a/..", "a\u0000b", "a\u202Eb", "", "x".repeat(1100), `${"d/".repeat(3)}${"y".repeat(300)}`, "//server/share"]) {
    assert.equal(c.safeMentionPath(bad), null, JSON.stringify(bad.slice(0, 30)));
  }
  assert.equal(c.safeMentionPath(42), null);
  assert.deepEqual(c.splitQuery("src/ui/ch"), { dir: "src/ui", prefix: "ch" });
  assert.deepEqual(c.splitQuery("a"), { dir: null, prefix: "a" });
  assert.equal(c.safeMentionPath(c.splitQuery("/etc/pa").dir), null, "an absolute-looking query is refused before it reaches the host");
});

test("browse: a typed folder path lists that folder only (any depth), dirs first, prefix filtered", async () => {
  const tree = new Map([
    ["", [dir("", "src"), file("", "README.md")]],
    ["src", [file("src", "b.ts"), dir("src", "ui"), file("src", "a.ts")]],
    ["src/ui", [file("src/ui", "chat.tsx"), file("src/ui", "chip.tsx"), file("src/ui", "other.css")]],
  ]);
  const fs = fakeFs(tree);
  const ms = c.createMentionSearch({ fs });
  const root = await ms.search("", sig());
  assert.deepEqual(root.items.map((i) => i.label), ["src/", "README.md"]);
  assert.ok(root.items[0].isDir);
  const r = await ms.search("src/ui/ch", sig());
  assert.deepEqual(r.items.map((i) => i.label), ["chat.tsx", "chip.tsx"]);
  assert.deepEqual(r.items.map((i) => i.path), ["src/ui/chat.tsx", "src/ui/chip.tsx"]);
  const src = await ms.search("src/", sig());
  assert.deepEqual(src.items.map((i) => i.label), ["ui/", "a.ts", "b.ts"]);
  const missing = await ms.search("nope/x", sig());
  assert.equal(missing.items.length, 0);
  assert.match(missing.note, /No such folder/);
  const escape = await ms.search("../../etc/pa", sig());
  assert.equal(escape.items.length, 0, "a .. query never reaches the host");
  assert.ok(!fs.calls.some(([p]) => p.includes("..")));
  const abs = await ms.search("/etc/pa", sig());
  assert.equal(abs.items.length, 0);
  assert.ok(!fs.calls.some(([p]) => p.startsWith("/")), "an absolute path never reaches the host");
});

test("accepting rows: a folder keeps browsing, a file attaches and removes the @token", () => {
  const folder = c.item("file", "dir:src/ui", "ui/", "folder", { path: "src/ui", isDir: true });
  assert.deepEqual(c.acceptOf(folder, "look at @src/u", 8), { type: "replaceDraft", text: "look at @src/ui/", keepOpen: true });
  const f = c.item("file", "file:src/a.ts", "a.ts", "src", { path: "src/a.ts" });
  assert.deepEqual(c.acceptOf(f, "look at @a", 8), { type: "attachFile", path: "src/a.ts", newDraft: "look at " });
  const n = c.item("note", "note:k1", "Design", "snip", { path: "k1", insert: "Design\nsnip" });
  assert.deepEqual(c.acceptOf(n, "x @des", 2), { type: "attachNote", id: "k1", label: "Design", content: "Design\nsnip", newDraft: "x " });
});

test("flat index: bounded walk skips vendored dirs, ranks name before path, searchable while scanning", async () => {
  const tree = new Map([
    ["", [dir("", "src"), dir("", "node_modules"), dir("", ".git"), file("", "package.json")]],
    ["src", [file("src", "index.ts"), dir("src", "lib"), file("src", "Readme.md")]],
    ["src/lib", [file("src/lib", "indexer.ts"), file("src/lib", "util.ts")]],
    ["node_modules", [file("node_modules", "index.js")]],
  ]);
  const fs = fakeFs(tree);
  const idx = new c.FileIndex(fs);
  await idx.ensure();
  assert.equal(idx.scanState, "done");
  assert.equal(idx.size, 5);
  assert.ok(!fs.calls.some(([p]) => p === "node_modules" || p === ".git"), "vendored directories are never walked");
  assert.deepEqual(idx.search("index").map((i) => i.path), ["src/index.ts", "src/lib/indexer.ts"]);
  assert.deepEqual(idx.search("util").map((i) => i.path), ["src/lib/util.ts"]);
  assert.deepEqual(idx.search("rdm").map((i) => i.path), ["src/Readme.md"], "subsequence");
  assert.deepEqual(idx.search("lib/ut").map((i) => i.path), ["src/lib/util.ts"], "path contains");
  assert.deepEqual(idx.search(""), []);
});

test("100k-file project: walk is capped, typing stays fast, deeper files stay reachable by path", async () => {
  // 2,000 dirs x 50 files = 100,000 files.
  const tree = new Map([["", Array.from({ length: 2000 }, (_, i) => dir("", `d${i}`))]]);
  for (let i = 0; i < 2000; i++) tree.set(`d${i}`, Array.from({ length: 50 }, (_, j) => file(`d${i}`, `file-${i}-${j}.ts`)));
  const fs = fakeFs(tree);
  const idx = new c.FileIndex(fs, Date.now, { files: 30_000, dirs: 6_000 });
  await idx.ensure();
  assert.equal(idx.scanState, "truncated");
  assert.equal(idx.size, 30_000, "the index is bounded");
  const t0 = performance.now();
  let n = 0;
  for (const q of ["file", "file-1", "f-9-4", "zzzz", "d19", "ts"]) { n += idx.search(q).length; }
  const per = (performance.now() - t0) / 6;
  assert.ok(per < 30, `search took ${per.toFixed(1)} ms per query over 30k entries`);
  assert.ok(n > 0);
  assert.ok(idx.search("file").length <= c.RESULT_LIMIT, "results are windowed");
  // A file beyond the index is still reachable: type its folder.
  const ms = c.createMentionSearch({ fs });
  const r = await ms.search("d1999/file-1999-4", sig());
  assert.ok(r.items.length > 0 && r.items.every((i) => i.path.startsWith("d1999/file-1999-4")));
  assert.ok(r.items.some((i) => i.path === "d1999/file-1999-4.ts"));
  const flat = await ms.search("file-1999-4", sig());
  assert.match(flat.note ?? "", /Large project|indexing/);
});

test("browse is bounded by pages and honours cancellation", async () => {
  const many = Array.from({ length: 12_000 }, (_, i) => file("big", `f${String(i).padStart(5, "0")}.txt`));
  const fs = fakeFs(new Map([["", [dir("", "big")]], ["big", many]]));
  const ms = c.createMentionSearch({ fs });
  const r = await ms.search("big/f0", sig());
  assert.ok(fs.calls.length <= c.MAX_BROWSE_PAGES, `${fs.calls.length} pages listed`);
  assert.ok(r.items.length <= c.RESULT_LIMIT);
  const ac = new AbortController();
  ac.abort();
  const before = fs.calls.length;
  await ms.search("big/f0", ac.signal);
  assert.equal(fs.calls.length, before, "an aborted search lists nothing");
});

test("notes: results are sanitised, bounded, shown as notes; short queries skip the call", async () => {
  const seen = [];
  const core = { async json(_m, path) { seen.push(path); return { results: [{ noteKey: "n1", title: "Plan\u202E review", snippet: "x\ny", date: "d", kind: "meeting", projectId: "p" }, { noteKey: 5 }, null] }; } };
  const ms = c.createMentionSearch({ fs: null, core });
  const r = await ms.search("review", sig());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, "note");
  assert.equal(r.items[0].label, "Plan review");
  assert.equal(r.items[0].detail, "x y");
  assert.match(seen[0], /^\/kb\/index\/search\?q=review&limit=5$/);
  seen.length = 0;
  await ms.search("a", sig());
  assert.equal(seen.length, 0, "a one-letter query has no searchable word");
});

test("composer model: @ is debounced and cancels stale searches; late files appear while indexing", async () => {
  const timers = [];
  const searches = [];
  const mentions = { reset() {}, async search(q, signal) {
    searches.push(q);
    await new Promise((r) => setTimeout(r, 5));
    if (signal.aborted) throw new Error("aborted");
    return { items: [c.item("file", `file:${q}`, `${q}.ts`, "src", { path: `src/${q}.ts` })], scan: q === "slow" ? "scanning" : "done", note: null };
  } };
  const attached = [];
  const attachments = { addProjectFile: async (p) => { attached.push(p); }, addNote() {}, consume: () => [], isBusy: () => false, dispose() {} };
  const log = { draft: null };
  const m = new c.ComposerModel({
    catalog: { snapshot: () => ({ commands: [], skills: [], subagents: [], library: [], hooks: [], mcp: [], complete: true }), ensure: async () => ({}), invalidate() {}, subscribe: () => () => {} },
    sources: { modes: () => [], models: () => [] }, actions: { setDraft: (t) => { log.draft = t; }, setMode() {}, setModel() {}, navigate() {} },
    attachments, mentions, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: (hd) => { timers[hd - 1].fn = null; },
  });
  m.update("see @a");
  m.update("see @ab");
  m.update("see @abc");
  assert.equal(searches.length, 0, "nothing runs before the debounce");
  assert.equal(m.getState().loading, true);
  assert.equal(timers.filter((t) => t.fn).length, 1, "each keystroke cancels the previous timer");
  timers.find((t) => t.fn).fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(searches, ["abc"]);
  assert.equal(m.getState().open, true);
  assert.equal(m.getState().view.items[0].path, "src/abc.ts");
  assert.equal(m.accept(), true);
  assert.deepEqual(attached, ["src/abc.ts"]);
  assert.equal(log.draft, "see ");
  // A search superseded while running never lands.
  m.update("x @one"); timers.filter((t) => t.fn).at(-1).fn();
  m.update("x @two");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.getState().view.items.length === 0 || m.getState().view.items[0].path !== "src/one.ts", true);
});

test("composer model: an escaping path from a (hostile) item is refused before attaching", () => {
  const attached = [];
  const m = new c.ComposerModel({
    catalog: { snapshot: () => ({ commands: [], skills: [], subagents: [], library: [], hooks: [], mcp: [], complete: true }), ensure: async () => ({}), invalidate() {}, subscribe: () => () => {} },
    sources: { modes: () => [], models: () => [] }, actions: { setDraft() {}, setMode() {}, setModel() {}, navigate() {} },
    attachments: { addProjectFile: async (p) => { attached.push(p); }, addNote() {}, consume: () => [], isBusy: () => false, dispose() {} }, mentions: null,
  });
  m.update("@x");
  assert.equal(m.getState().open, false, "no mention source: nothing opens");
  const bad = c.item("file", "file:evil", "evil", "", { path: "../../etc/passwd" });
  const a = c.acceptOf(bad, "@e", 0);
  assert.equal(a.type, "attachFile");
  assert.equal(c.safeMentionPath(a.path), null, "the model re-validates before reading");
});

test("mention menu renders as an accessible listbox with files grouped without headers", () => {
  const items = [c.item("file", "file:a", "a.ts", "src", { path: "src/a.ts" }), c.item("note", "note:n", "Design", "snippet", { path: "n" })];
  const view = c.buildMentionView(items);
  const out = html(h(c.CompletionMenu, { id: "mm", view, loading: false, note: "Large project: only part of it is indexed.", label: "Files and notes", onPick() {}, onHover() {} }));
  assert.match(out, /role="listbox"[^>]*aria-label="Files and notes"/);
  assert.match(out, /aria-label="a\.ts, Files, src"/);
  assert.match(out, /Large project/);
});
