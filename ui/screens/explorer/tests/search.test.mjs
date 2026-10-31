import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const model = await load("search/model.ts");
const { SearchController } = await load("search/controller.ts");
const { SearchPanel } = await load("search/SearchPanel.tsx");
const panels = await load("panels.ts");
const { PanelTabs } = await load("PanelTabs.tsx");

const hit = (line, preview = "let needle = 1;", ms = 4, me = 10) => ({ line, col: ms + 1, preview, ms, me });
const file = (path, n = 1) => ({ path, hits: Array.from({ length: n }, (_, i) => hit(i + 1)), more: false });
const done = (id, extra = {}) => ({ type: "done", id, files_scanned: 5, files_matched: 1, matches: 1, truncated: null, cancelled: false, skipped_binary: 0, skipped_large: 0, skipped_other: 0, ...extra });

// A fake host: `start` hands the test the event sink so it controls ordering.
function fakeApi() {
  const api = { starts: [], cancels: [], nextId: 1, failWith: null, early: null };
  api.start = async (req, onEvent) => {
    if (api.failWith) throw api.failWith;
    const id = api.nextId++;
    api.starts.push({ req, onEvent, id });
    if (api.early) for (const e of api.early(id)) onEvent(e);
    return { id };
  };
  api.cancel = async (id) => { api.cancels.push(id); };
  return api;
}
// Manual timers so the debounce is deterministic.
function timers() {
  const t = { pending: null, set: (fn, ms) => { t.pending = { fn, ms }; return t.pending; }, clear: (h) => { if (t.pending === h) t.pending = null; }, fire() { const p = t.pending; t.pending = null; p?.fn(); } };
  return t;
}
const mk = (extra = {}) => {
  const api = fakeApi(), tm = timers(), opened = [];
  const c = new SearchController({ api, debounceMs: 250, setTimer: tm.set, clearTimer: tm.clear, onOpen: (...a) => opened.push(a), openPaths: () => ["a.ts"], ...extra });
  return { api, tm, c, opened };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test("panels: switcher order, wrap-around, shortcuts per OS", () => {
  assert.deepEqual(panels.PANELS.map((p) => p.id), ["explorer", "search", "scm"]);
  assert.equal(panels.stepPanel("scm", 1), "explorer");
  assert.equal(panels.stepPanel("explorer", -1), "scm");
  assert.equal(panels.parsePanel("nope"), "explorer");
  const k = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...o });
  assert.equal(panels.panelForKey(k("F", { metaKey: true }), true), "search");
  assert.equal(panels.panelForKey(k("F", { ctrlKey: true }), true), null, "Ctrl+Shift+F is not Mod on a Mac");
  assert.equal(panels.panelForKey(k("f", { ctrlKey: true }), false), "search");
  assert.equal(panels.panelForKey(k("E", { metaKey: true }), true), "explorer");
  assert.equal(panels.panelForKey(k("G", { ctrlKey: true }), true), "scm");
  assert.equal(panels.panelForKey(k("f", { ctrlKey: true, shiftKey: false }), false), null);
  assert.equal(panels.isDockToggleKey({ key: "`", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), true);
  assert.equal(panels.isDockToggleKey({ key: "`", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }), false);
});

test("panel tabs: tablist ARIA, one tab stop, selected state, panel wiring", () => {
  const out = renderToStaticMarkup(h(PanelTabs, { active: "search", onChange() {} }));
  assert.match(out, /role="tablist"/);
  assert.equal((out.match(/role="tab"/g) ?? []).length, 3);
  assert.match(out, /id="ex-ptab-search"[^>]*aria-selected="true"[^>]*aria-controls="ex-panel-search"[^>]*tabindex="0"/);
  assert.match(out, /id="ex-ptab-scm"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
});

test("model: windowing renders only the visible slice and keeps total height", () => {
  const w = model.windowRows(10000, 22 * 500, 400, 22, 8);
  assert.equal(w.start, 492);
  assert.ok(w.end - w.start < 40);
  assert.equal(w.padTop + (w.end - w.start) * 22 + w.padBottom, 10000 * 22);
  assert.deepEqual(model.windowRows(0, 0, 400, 22), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  const tail = model.windowRows(100, 1e9, 400, 22);
  assert.ok(tail.end === 100 && tail.start <= 100);
  assert.equal(model.scrollToReveal(50, 0, 400, 22), 50 * 22 + 22 - 400);
  assert.equal(model.scrollToReveal(2, 0, 400, 22), null);
  assert.equal(model.scrollToReveal(1, 100, 400, 22), 22);
});

test("model: rows group by file, collapse hides hits, selection clamps", () => {
  const files = [file("a.ts", 2), file("b/c.ts", 1)];
  const rows = model.flattenRows(files, new Set());
  assert.deepEqual(rows.map((r) => r.kind), ["file", "hit", "hit", "file", "hit"]);
  const collapsed = model.flattenRows(files, new Set(["a.ts"]));
  assert.deepEqual(collapsed.map((r) => r.kind), ["file", "file", "hit"]);
  assert.equal(model.moveSelection(rows, -1, 1), 0);
  assert.equal(model.moveSelection(rows, -1, -1), 4);
  assert.equal(model.moveSelection(rows, 4, 1), 4);
  assert.equal(model.moveSelection(rows, 0, -1), 0);
  assert.equal(model.moveSelection([], 0, 1), -1);
});

test("model: decode is defensive (malformed chunks, offsets clamped, previews capped)", () => {
  assert.deepEqual(model.decodeFiles("x"), []);
  const f = model.decodeFiles([{ path: 1 }, { path: "a", hits: [{ line: "x" }, { line: 3, col: 2, preview: "abc", ms: -5, me: 99 }] }, { path: "b", hits: [] }]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].hits[0], { line: 3, col: 2, preview: "abc", ms: 0, me: 3 });
  assert.equal(model.decodeFiles([{ path: "a", hits: [{ line: 1, preview: "x".repeat(5000), ms: 0, me: 1 }] }])[0].hits[0].preview.length, 600);
  const d = model.decodeDone({ type: "done", id: 1, files_scanned: "x", truncated: "bogus", cancelled: 1 });
  assert.deepEqual([d.filesScanned, d.truncated, d.cancelled], [0, null, false]);
  assert.deepEqual(model.splitGlobs(" src/**, ,*.ts ,"), ["src/**", "*.ts"]);
  assert.equal(model.normalizedQuery("   "), null);
  assert.equal(model.normalizedQuery(" a b "), "a b");
});

test("controller: debounce collapses typing into one search; empty query clears without calling the host", async () => {
  const { api, tm, c } = mk();
  c.setQuery("n"); c.setQuery("ne"); c.setQuery("need");
  assert.equal(api.starts.length, 0);
  assert.equal(tm.pending.ms, 250);
  tm.fire(); await tick();
  assert.equal(api.starts.length, 1);
  assert.equal(api.starts[0].req.query, "need");
  assert.equal(api.starts[0].req.include_hidden, true);
  assert.equal(c.getSnapshot().phase, "searching");
  c.setQuery("   "); tm.fire(); await tick();
  assert.equal(api.starts.length, 1, "nothing to search for: no walk");
  assert.equal(c.getSnapshot().phase, "idle");
  assert.deepEqual(api.cancels, [1], "the running search was cancelled");
});

test("controller: results stream in, done closes, stale-run events are ignored", async () => {
  const { api, tm, c } = mk();
  c.setQuery("a"); tm.fire(); await tick();
  const first = api.starts[0];
  first.onEvent({ type: "chunk", id: first.id, files: [file("a.ts", 2)] });
  assert.equal(c.getSnapshot().matchCount, 2);
  c.setQuery("ab"); tm.fire(); await tick();
  assert.deepEqual(api.cancels, [first.id]);
  first.onEvent({ type: "chunk", id: first.id, files: [file("stale.ts")] });
  first.onEvent(done(first.id));
  assert.equal(c.getSnapshot().files.length, 0, "stale events dropped");
  const second = api.starts[1];
  second.onEvent({ type: "chunk", id: second.id, files: [file("b.ts")] });
  second.onEvent(done(second.id, { truncated: "matches" }));
  const s = c.getSnapshot();
  assert.deepEqual([s.phase, s.files.map((f) => f.path), s.done.truncated], ["done", ["b.ts"], "matches"]);
  assert.match(model.truncationNotice(s.done), /first results/);
});

test("controller: events that arrive before start resolves are buffered and replayed for the right id", async () => {
  const { api, tm, c } = mk();
  api.early = (id) => [{ type: "chunk", id, files: [file("early.ts")] }, { type: "chunk", id: 999, files: [file("other.ts")] }, done(id)];
  c.setQuery("x"); tm.fire(); await tick();
  const s = c.getSnapshot();
  assert.deepEqual(s.files.map((f) => f.path), ["early.ts"]);
  assert.equal(s.phase, "done");
});

test("controller: invalid regex and host failures become an error state", async () => {
  const { api, tm, c } = mk();
  api.failWith = { code: "invalid_query", message: "regex parse error: unclosed group" };
  c.setOptions({ regex: true }); c.setQuery("("); tm.fire(); await tick();
  assert.equal(c.getSnapshot().phase, "error");
  assert.match(c.getSnapshot().error, /unclosed group/);
  api.failWith = new Error("boom");
  c.runNow(); await tick();
  assert.match(c.getSnapshot().error, /Search failed: boom/);
});

test("controller: cancel keeps what arrived; Esc semantics; open-files scope; options map to the request", async () => {
  const { api, tm, c } = mk();
  c.setOptions({ caseSensitive: true, wholeWord: true, regex: true, include: "src/**, *.ts", exclude: "dist/", openFilesOnly: true, useIgnore: false });
  c.setQuery("q"); tm.fire(); await tick();
  const r = api.starts[0].req;
  assert.deepEqual([r.case_sensitive, r.whole_word, r.regex, r.include, r.exclude, r.only_paths, r.use_ignore], [true, true, true, ["src/**", "*.ts"], ["dist/"], ["a.ts"], false]);
  const st = api.starts[0];
  st.onEvent({ type: "chunk", id: st.id, files: [file("a.ts")] });
  c.cancel();
  assert.equal(c.getSnapshot().phase, "done");
  assert.equal(c.getSnapshot().done.cancelled, true);
  assert.equal(c.getSnapshot().files.length, 1);
  assert.deepEqual(api.cancels, [st.id]);
  st.onEvent({ type: "chunk", id: st.id, files: [file("late.ts")] });
  assert.equal(c.getSnapshot().files.length, 1, "nothing after cancel");
  // No open files: nothing to search, no host call.
  const m2 = mk({ openPaths: () => [] });
  m2.c.setOptions({ openFilesOnly: true }); m2.c.setQuery("q"); m2.tm.fire(); await tick();
  assert.equal(m2.api.starts.length, 0);
  assert.equal(m2.c.getSnapshot().phase, "done");
});

test("controller: the UI never holds more than its cap even if the host sends more", async () => {
  const { api, tm, c } = mk();
  c.setQuery("a"); tm.fire(); await tick();
  const st = api.starts[0];
  for (let i = 0; i < 20; i++) st.onEvent({ type: "chunk", id: st.id, files: [file(`f${i}.ts`, 400)] });
  assert.equal(c.getSnapshot().matchCount, 6000);
});

test("controller: activate opens a hit at line/col and toggles a file row; collapse/expand all", async () => {
  const { api, tm, c, opened } = mk();
  c.setQuery("a"); tm.fire(); await tick();
  const st = api.starts[0];
  st.onEvent({ type: "chunk", id: st.id, files: [{ path: "a.ts", hits: [hit(7, "x needle", 2, 8)], more: false }] });
  c.activate(1);
  assert.deepEqual(opened, [["a.ts", 7, 3]]);
  c.activate(0);
  assert.equal(c.rows().length, 1);
  c.collapseAll(false);
  assert.equal(c.rows().length, 2);
  c.dispose();
  st.onEvent({ type: "chunk", id: st.id, files: [file("z.ts")] });
  assert.equal(c.getSnapshot().files.length, 1, "disposed controllers ignore events");
});

test("panel: ARIA listbox, labelled toggles, windowed rows, live summary, text is never HTML", async () => {
  const { api, tm, c } = mk();
  c.setQuery("a"); tm.fire(); await tick();
  const st = api.starts[0];
  const evil = { line: 1, col: 1, preview: "<img src=x onerror=alert(1)> needle", ms: 26, me: 32 };
  st.onEvent({ type: "chunk", id: st.id, files: [{ path: "src/<b>.ts", hits: [evil], more: false }, ...Array.from({ length: 3000 }, (_, i) => file(`f${i}.ts`, 3))] });
  st.onEvent(done(st.id, { skipped_large: 2, skipped_binary: 1 }));
  const out = renderToStaticMarkup(h(SearchPanel, { controller: c, initialViewport: 440 }));
  assert.match(out, /role="searchbox"[^>]*aria-label="Search query"/);
  assert.match(out, /aria-label="Match case"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="Match case"/);
  assert.match(out, /role="listbox"[^>]*aria-label="Search results"/);
  assert.match(out, /role="status"[^>]*aria-live="polite"/);
  const rendered = (out.match(/role="option"/g) ?? []).length;
  assert.ok(rendered > 0 && rendered < 60, `rendered ${rendered}`);
  assert.match(out, /data-pad="bottom"/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<mark class="sx-mark">needle<\/mark>/);
  assert.match(out, /aria-posinset="1"[^>]*aria-setsize="\d+"/);
  assert.match(out, /Skipped 2 large files \(over 2 MB\) and 1 binary file\./);
});

test("panel: idle state has no result rows and no banners", () => {
  const { c } = mk();
  const out = renderToStaticMarkup(h(SearchPanel, { controller: c }));
  assert.equal((out.match(/role="option"/g) ?? []).length, 0);
  assert.doesNotMatch(out, /ui-banner/);
});
