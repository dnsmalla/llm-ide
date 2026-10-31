process.env.TZ = "UTC";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadEntry, react, server } from "./helpers.mjs";

let L;
let h;
let html;
before(async () => {
  L = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const mkStore = async (setup) => {
  const host = new L.FakeHost();
  setup?.(host);
  const store = new L.LibraryStore({ host, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await store.init();
  await L.settle(store);
  return { host, store };
};

const screen = (store, host, props = {}) => h(L.LibraryScreen, { store, host, ...props });
const count = (s, re) => (s.match(re) ?? []).length;

test("no notes folder: an explanation, a labelled button, no list", async () => {
  const host = new L.FakeHost();
  host.root = null;
  const store = new L.LibraryStore({ host });
  await store.init();
  const out = html(screen(store, host));
  assert.match(out, /role="region"[^>]*aria-label="Choose a notes folder"/);
  assert.match(out, /<button[^>]*>Choose folder…<\/button>/);
  assert.ok(!out.includes('role="listbox"'));
});

test("outside the desktop app the folder dialog is replaced by an explanation", () => {
  const out = html(h(L.NoFolder, { onChoose() {}, error: null, hostAvailable: false }));
  assert.ok(!out.includes("Choose folder…"));
  assert.match(out, /only be read inside the desktop app/);
  const bad = html(h(L.NoFolder, { onChoose() {}, error: "invalid_root", hostAvailable: true }));
  assert.match(bad, /role="alert"/);
  assert.match(bad, /too broad/);
  assert.match(html(h(L.LoadError, { code: "io", onRetry() {} })), /role="alert"[\s\S]*Try again/);
});

test("loaded: navigation landmark, sections with counts, aria-current, Unsorted, Extensions placeholders", async () => {
  const { host, store } = await mkStore((hh) => {
    hh.add("source/meetings/2026/10/a.md", L.meetingText(1));
    hh.add("source/meetings/2026/10/b.md", L.meetingText(2, "slack"));
    hh.add("x.md", "---\ntitle: No platform\n---\n");
    hh.add("llm-doc/emails/n.md", "# Generated");
  });
  store.setSection("slack");
  const out = html(screen(store, host));
  assert.match(out, /<nav[^>]*aria-label="Library sections"/);
  assert.match(out, /aria-current="page"[^>]*data-selected="true"[^>]*><span class="lib-nav-label">Slack</);
  assert.match(out, /<span class="lib-nav-label">Meetings<\/span><span class="lib-count" aria-label="1 notes">1</);
  assert.match(out, /<span class="lib-nav-label">Unsorted<\/span>/);
  assert.match(out, /<span class="lib-nav-label">Emails?<\/span>|<span class="lib-nav-label">Emails<\/span>/);
  for (const label of ["Plugins", "LLM Sources", "MCP Plugins", "Extensions"]) assert.match(out, new RegExp(`<span class="lib-nav-label">${label}</span>`));
  assert.match(out, /aria-label="Refresh notes"/);
  assert.match(out, /Change notes folder/);
  assert.ok(!out.includes("Rebuild search index"), "no rebuild button without a runner");
  const withRebuild = html(screen(store, host, { runRebuild: async () => ({}) }));
  assert.match(withRebuild, /Rebuild search index/);
});

test("the list is a keyboard listbox that mounts only the visible rows (5,000 notes)", async () => {
  const { host, store } = await mkStore((hh) => {
    for (let i = 0; i < 5000; i++) hh.add(`source/meetings/2026/10/n${String(i).padStart(5, "0")}.md`, L.meetingText(i));
  });
  store.setSection("meeting");
  store.select(store.rows().find((r) => r.kind === "note").rec.rel);
  const out = html(screen(store, host, { initialHeight: 600 }));
  assert.match(out, /role="listbox"[^>]*tabindex="0"/);
  assert.match(out, /aria-label="Meetings, 5000 notes"/);
  const options = count(out, /role="option"/g);
  assert.ok(options > 5 && options < 60, `${options} options mounted for 5000 notes`);
  assert.equal(count(out, /aria-selected="true"/g), 1);
  assert.match(out, /aria-activedescendant="lib-opt-/);
  assert.match(out, /<div class="lib-canvas" style="height:\d+/);
  assert.ok(out.length < 60_000, `markup ${out.length} chars`);
  assert.match(out, /5,000 notes/);
});

test("row heights: mixed header and note rows are windowed exactly", async () => {
  const rows = [{ kind: "header" }, { kind: "note" }, { kind: "note" }, { kind: "header" }, { kind: "note" }];
  const o = L.rowOffsets(rows);
  assert.deepEqual([...o], [0, 28, 80, 132, 160, 212]);
  assert.equal(L.rowAt(o, 0), 0);
  assert.equal(L.rowAt(o, 27), 0);
  assert.equal(L.rowAt(o, 28), 1);
  assert.equal(L.rowAt(o, 131), 2);
  assert.equal(L.rowAt(o, 160), 4);
  assert.equal(L.rowAt(o, 9999), 4);
  assert.equal(L.rowAt(L.rowOffsets([]), 10), 0);
});

test("hostile titles and frontmatter are text: no markup survives in the list or the viewer", async () => {
  const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
  const { host, store } = await mkStore((hh) => {
    hh.add("source/meetings/a.md", L.meetingText(1).replace("title: Meeting 1", `title: '${evil.replaceAll("'", "''")}'`));
  });
  store.setSection("meeting");
  const out = html(screen(store, host));
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("<img"));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("search box and filters have names; reset appears only when filters are active", async () => {
  const { host, store } = await mkStore((hh) => hh.add("a.md", L.meetingText(1)));
  let out = html(screen(store, host));
  assert.match(out, /<input type="search"[^>]*aria-label="Filter and search notes"/);
  assert.match(out, /placeholder="Filter notes"/, "no full-text search without a search runner");
  assert.match(out, /role="group"[^>]*aria-label="Filters"/);
  assert.match(out, /aria-pressed="false"[^>]*>[\s\S]*With summary/);
  for (const name of ["Date range", "Sort", "Group"]) assert.match(out, new RegExp(`<span class="lib-sr">${name}</span>`));
  assert.ok(!out.includes(">Reset<"));
  store.setFilters({ hasSummary: true });
  out = html(screen(store, host));
  assert.match(out, /aria-pressed="true"/);
  assert.match(out, />Reset</);
  assert.match(out, /No notes match the filters/);
});

test("empty folder and listing states are announced politely", async () => {
  const { host, store } = await mkStore();
  const out = html(screen(store, host));
  assert.match(out, /role="status"[\s\S]*No notes in this folder/);
});

test("Extensions entries: a supplied render replaces the placeholder (S-J seam)", async () => {
  const { host, store } = await mkStore((hh) => hh.add("a.md", L.meetingText(1)));
  const custom = [...L.EXTENSION_PLACEHOLDERS.slice(0, 1), { id: "extensions", label: "Extensions", render: () => h("div", { id: "ext-pane" }, "pane") }];
  const nav = html(screen(store, host, { extensions: custom }));
  assert.ok(!nav.includes("lib-ext"), "the pane shows only when its entry is selected");
  assert.match(nav, /<span class="lib-nav-label">Extensions<\/span>/);
});

test("meeting detail: gist, TL;DR, action lists with task state, transcript with speakers and counts", () => {
  const text = L.meetingText(7, "meet", "gist: Raise the budget\nduration_seconds: 600\n")
    .replace("tldr: []", "tldr:\n- decided A\n- decided B")
    .replace("## Transcript", "Summary body.\n\n## Actions\n- [ ] **Alice** — send deck\n- [x] done\n\n## Decisions\n- Ship\n\n## Transcript")
    .replace("[10:00:01] **Alice**: hello 7", "[10:00:01] **Alice**: hello 7\n[10:00:05] **Bob**: reply <b>bold?</b>");
  const view = L.describeNote(undefined, { rel: "source/meetings/a.md", text, size: text.length, mtimeMs: 0, truncated: false });
  const out = html(h(L.MeetingDetail, { view, baseRel: "source/meetings/a.md", handlers: {} }));
  assert.match(out, /<section[^>]*aria-label="Gist"/);
  assert.match(out, /<section[^>]*aria-label="TL;DR"/);
  assert.match(out, /aria-label="Actions \(2\)"/);
  assert.match(out, /aria-label="Not done"/);
  assert.match(out, /aria-label="Done"/);
  assert.match(out, /aria-label="Decisions \(1\)"/);
  assert.match(out, /aria-label="Transcript"/);
  assert.match(out, /aria-label="Filter by speaker"/);
  assert.match(out, /<strong class="lib-speaker">Bob<\/strong>/);
  assert.ok(!out.includes("<b>bold?</b>"));
  assert.match(out, /&lt;b&gt;bold\?&lt;\/b&gt;/);
});

test("a 20,000-line transcript mounts one page of lines, not all of them", () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => `[10:00:00] **S${i % 3}**: line ${i}`).join("\n");
  const m = L.parseMeetingBody(`## Transcript\n${lines}`);
  const out = html(h(L.Transcript, { meeting: m }));
  const mounted = count(out, /class="lib-utterance"/g);
  assert.equal(mounted, 200);
  assert.match(out, /Show 1000 more lines \(19800 left\)/);
});

test("markdown view: untrusted content is escaped, links go through callbacks, images are inert", () => {
  const md = [
    "# Title",
    "<script>alert(1)</script>",
    "[ok](https://example.com/x) [bad](javascript:alert(1)) [note](../b.md) ![pic](https://tracker.example/p.png)",
    "- [x] done\n- [ ] todo",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "```js\nlet x = '<b>';\n```",
  ].join("\n\n");
  const out = html(h(L.MarkdownView, { text: md, baseRel: "a/c.md", onOpenExternal() {}, onOpenNote() {}, initialSections: 99 }));
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("javascript:"));
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /<a href="https:\/\/example\.com\/x" rel="noopener noreferrer"/);
  assert.match(out, /<button type="button" class="lib-link-btn" title="Open b\.md">note<\/button>/);
  assert.match(out, /\[image: pic\]/);
  assert.match(out, /<input type="checkbox" readOnly="" disabled="" aria-label="Done" checked=""/);
  assert.match(out, /<table>[\s\S]*<th scope="col"/);
  assert.match(out, /<h2 id="md-title">Title<\/h2>/);
  assert.match(out, /<pre tabindex="0"><code>let x = &#x27;&lt;b&gt;&#x27;;/);
  // Without handlers, links render as plain text (inert).
  const inert = html(h(L.MarkdownView, { text: "[ok](https://example.com/x)", baseRel: null, initialSections: 99 }));
  assert.ok(!inert.includes("<a "));
});

test("a long document renders in sections: the first ones now, a labelled control for the rest", () => {
  const md = Array.from({ length: 1000 }, (_, i) => `Paragraph ${i}`).join("\n\n");
  const out = html(h(L.MarkdownView, { text: md, baseRel: null }));
  assert.equal(count(out, /<p>/g), 240);
  assert.match(out, /Show more \(\d+ sections left\)/);
});
