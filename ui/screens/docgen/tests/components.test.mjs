import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadEntry, react, server } from "./helpers.mjs";

let E, h, html;
before(async () => {
  E = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const noop = () => {};
const tpl = (n, sections = ["Summary", "Decisions"], extra = {}) => ({ id: n, name: n, sections, rawContent: "", isBuiltin: false, folderName: n.toLowerCase(), isProjectTemplate: true, surface: "doc", ...extra });
const cmd = (n) => ({ id: n, name: n, instruction: "Do it", rawContent: "", isBuiltin: false, folderName: n, isProjectCommand: true, surface: "doc" });

function setupProps(over = {}) {
  return {
    surface: "doc", templates: [tpl("Decision Log"), tpl("Retro")], commands: [cmd("Summarize")], truncated: false, templateId: null, commandId: null, command: "", prompt: "",
    fit: null, sourceCount: 0, run: E.INITIAL_RUN, onTemplate: noop, onCommandPick: noop, onCommandText: noop, onPrompt: noop, onManage: noop, onGenerate: noop, onCancel: noop, ...over,
  };
}

test("SetupPanel: labelled controls, Generate disabled with the reason announced, enabled when valid", () => {
  const off = html(h(E.SetupPanel, setupProps()));
  assert.match(off, /<legend>Template<\/legend>/);
  assert.match(off, /<span class="dg-sr">Template<\/span>/);
  assert.match(off, /<button[^>]*disabled=""[^>]*aria-describedby="dg-missing"[^>]*>Generate document<\/button>/);
  assert.match(off, /id="dg-missing"[^>]*>Choose a template or write a command\./);
  const noSrc = html(h(E.SetupPanel, setupProps({ templateId: "Retro" })));
  assert.match(noSrc, /Select at least one source\./);
  const on = html(h(E.SetupPanel, setupProps({ templateId: "Retro", sourceCount: 2, fit: { whole: 2, shortened: 0, omitted: 0, packedChars: 400, tokens: 100 } })));
  assert.doesNotMatch(on, /<button[^>]*disabled=""[^>]*>Generate document/);
  assert.match(on, /about 100 input tokens/);
  assert.match(on, /Sections: Summary, Decisions/);
  const cmdOnly = html(h(E.SetupPanel, setupProps({ command: "Summarise", sourceCount: 1 })));
  assert.doesNotMatch(cmdOnly, /<button[^>]*disabled=""[^>]*>Generate document/);
  const noSections = html(h(E.SetupPanel, setupProps({ templates: [tpl("Empty", [])], templateId: "Empty", sourceCount: 1 })));
  assert.match(noSections, /a template needs at least one ## section/);
  assert.match(noSections, /<button[^>]*disabled=""[^>]*>Generate document/);
});

test("SetupPanel: visual wording; running shows Cancel, fields are disabled while busy; language note", () => {
  const v = html(h(E.SetupPanel, setupProps({ surface: "visual", templateId: "Retro", sourceCount: 1 })));
  assert.match(v, />Generate visual</);
  const busy = html(h(E.SetupPanel, setupProps({ run: { ...E.INITIAL_RUN, phase: "generating" } })));
  assert.match(busy, /<fieldset class="dg-group" disabled="">/);
  assert.match(busy, />Cancel</);
  assert.doesNotMatch(busy, />Generate document</);
  assert.match(busy, /Say here which language/);
  assert.match(busy, /maxLength="10000"|maxlength="10000"/i);
});

function resultProps(run, over = {}) {
  return { surface: "doc", run: { ...E.INITIAL_RUN, ...run }, onCancel: noop, onRetry: noop, onRefine: noop, onSave: noop, onSaveAsNew: noop, onOpenSaved: noop, onDiscard: noop, onOpenExternal: noop, onOpenSettings: noop, onSignIn: noop, initialSections: 99, ...over };
}

test("ResultPanel: every phase is announced and has a next step", () => {
  assert.match(html(h(E.ResultPanel, resultProps({}))), /appear here/);
  const reading = html(h(E.ResultPanel, resultProps({ phase: "reading", progress: { done: 12, total: 100 } })));
  assert.match(reading, /role="status"[^>]*aria-live="polite"/);
  assert.match(reading, /12 of 100 read/);
  assert.match(reading, /<progress[^>]*max="100"[^>]*value="12"/);
  assert.match(reading, />Cancel</);
  const gen = html(h(E.ResultPanel, resultProps({ phase: "generating", startedAt: 1 })));
  assert.match(gen, /Writing with the model/);
  assert.match(gen, /aria-busy="true"/);
  const err = html(h(E.ResultPanel, resultProps({ phase: "error", error: { message: "Too many requests <b>x</b>", retryable: true, action: "settings" }, skipped: ["a.bin"] })));
  assert.match(err, /role="alert"/);
  assert.match(err, /Too many requests &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(err, />Try again</);
  assert.match(err, />Open Settings</);
  assert.match(err, /Could not read: a\.bin/);
  const signIn = html(h(E.ResultPanel, resultProps({ phase: "error", error: { message: "x", retryable: false, action: "sign_in" } })));
  assert.match(signIn, />Sign in</);
  assert.doesNotMatch(signIn, />Try again</);
});

test("ResultPanel done: notices, save states, refine form, document rendered as text", () => {
  const done = { phase: "done", doc: "## Summary\nHello **world**", notice: "3 sources were left out (a, b, c).", skipped: ["x.png"] };
  const out = html(h(E.ResultPanel, resultProps(done)));
  assert.match(out, /3 sources were left out/);
  assert.match(out, /Could not read as text: x\.png/);
  assert.match(out, /<h3[^>]*>Summary<\/h3>/);
  assert.match(out, /<strong>world<\/strong>/);
  assert.match(out, />Save to llm-doc\/generated</);
  assert.match(out, /<label[^>]*>[\s\S]*Ask for a change/);
  assert.match(out, /<button type="submit"[^>]*disabled=""[^>]*>Revise/);
  const saved = html(h(E.ResultPanel, resultProps({ ...done, saved: { path: "llm-doc/generated/x-2.md", hash: "h", size: 1, stem: "x" }, dirty: false })));
  assert.match(saved, /Saved to <code>llm-doc\/generated\/x-2\.md<\/code>/);
  assert.match(saved, /<button[^>]*disabled=""[^>]*>Saved</);
  assert.match(saved, />Open in Explorer</);
  const exportable = html(h(E.ResultPanel, resultProps({ ...done, saved: { path: "p.md", hash: "h", size: 1, stem: "x" }, dirty: false }, { onExport: noop })));
  assert.match(exportable, />Export…</);
  assert.doesNotMatch(saved, />Export…</, "no export action without a desktop host");
  const dirty = html(h(E.ResultPanel, resultProps({ ...done, saved: { path: "p.md", hash: "h", size: 1, stem: "x" }, dirty: true })));
  assert.match(dirty, />Save changes</);
  const conflict = html(h(E.ResultPanel, resultProps({ ...done, saveConflict: true, saveError: { message: "changed outside", retryable: false, action: "none" } })));
  assert.match(conflict, />Save as new file</);
  assert.match(conflict, /role="alert"/);
  const revising = html(h(E.ResultPanel, resultProps({ ...done, phase: "generating", revising: true, startedAt: 1 })));
  assert.match(revising, /Revising/);
  assert.match(revising, /<textarea[^>]*disabled=""/);
  const edit = html(h(E.ResultPanel, resultProps({ ...done, editError: "This document is too long" })));
  assert.match(edit, /This document is too long/);
});

test("Visual result mentions diagram source only when a mermaid fence is present", () => {
  const withDiagram = html(h(E.ResultPanel, resultProps({ phase: "done", doc: "```mermaid\ngraph TD; A-->B\n```" }, { surface: "visual" })));
  assert.match(withDiagram, /contains a Mermaid diagram/);
  assert.doesNotMatch(html(h(E.ResultPanel, resultProps({ phase: "done", doc: "plain" }, { surface: "visual" }))), /Mermaid/);
  assert.doesNotMatch(html(h(E.ResultPanel, resultProps({ phase: "done", doc: "```mermaid\ngraph TD\n```" }))), /contains a Mermaid diagram/);
});

test("VirtualList: 50,000 rows mount a screenful, listbox semantics with set size", () => {
  const items = Array.from({ length: 50_000 }, (_, i) => i);
  const out = html(h(E.VirtualList, { items, rowHeight: 30, label: "Rows", height: 300, initialViewport: 300, keyOf: (i) => String(i), render: (i) => `row ${i}` }));
  assert.match(out, /role="listbox"[^>]*aria-label="Rows"/);
  const rows = out.match(/class="dg-vrow"/g) ?? [];
  assert.ok(rows.length > 5 && rows.length < 40, `rows ${rows.length}`);
  assert.match(out, /aria-setsize="50000"/);
  assert.match(out, /aria-posinset="1"/);
  assert.match(out, /height:1500000px/);
});

test("SourcePanel: tablist semantics; selection summary with token estimate; empty hint; windowed 10k selection", () => {
  const sel0 = new E.SourceSelection();
  const base = { env: { notes: null, fs: null }, selection: sel0, note: null, surface: "doc", onAdd: noop, onRemove: noop, onClear: noop, onPaste: () => true, initialViewport: 200 };
  const empty = html(h(E.SourcePanel, base));
  assert.match(empty, /role="tablist"[^>]*aria-label="Where sources come from"/);
  assert.match(empty, /role="tab"[^>]*aria-selected="true"[^>]*>Project files</);
  assert.match(empty, /role="tabpanel"[^>]*aria-labelledby="dg-tab-files"/);
  assert.match(empty, /Project files need the desktop app/);
  assert.match(empty, /No sources selected/);
  const items = Array.from({ length: 10_000 }, (_, i) => E.fileItem(`src/f${i}.ts`, 4000));
  const sel = sel0.add(items.slice(0, 5000)).selection;
  const out = html(h(E.SourcePanel, { ...base, selection: sel, note: "Selection is full" }));
  assert.match(out, /5,000 selected, 19 MB/);
  assert.match(out, /The model will read about [\d,]+ input tokens; [\d,]+ will be shortened to fit; [\d,]+ will be left out\./);
  assert.match(out, /role="status"[^>]*>Selection is full/);
  const rows = out.match(/class="dg-vrow"/g) ?? [];
  assert.ok(rows.length < 30, `selected list windowed (${rows.length})`);
  const vis = html(h(E.SourcePanel, { ...base, surface: "visual" }));
  assert.match(vis, /to describe or diagram/);
});

test("SourcePanel files are rooted at the Mac's source categories, never the project root", () => {
  const fs = { list: async () => ({ path: "", entries: [], total: 0, next_offset: null, skipped: 0 }) };
  const base = { env: { notes: null, fs }, selection: new E.SourceSelection(), note: null, surface: "doc", onAdd: noop, onRemove: noop, onClear: noop, onPaste: () => true, initialViewport: 0 };
  const doc = html(h(E.SourcePanel, base));
  for (const l of ["Code", "LLM Doc", "Data"]) assert.match(doc, new RegExp(`>${l}<`), `${l} category`);
  assert.doesNotMatch(doc, /Project root/, "no whole-project browsing");
  const vis = html(h(E.SourcePanel, { ...base, surface: "visual" }));
  assert.match(vis, />Data</);
  assert.match(vis, />Code</);
  assert.doesNotMatch(vis, />LLM Doc</, "Visual sources are data and code only");
});

test("TemplateManager: dialog semantics, built-ins are read-only, delete asks first, form validates", () => {
  const props = { templates: [tpl("Mine"), tpl("Kit", ["A"], { isProjectTemplate: false })], busy: false, error: null, onSave: async () => null, onDelete: async () => true, onClose: noop };
  const list = html(h(E.TemplateManager, props));
  assert.match(list, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby=/);
  assert.match(list, /aria-label="Edit Mine"/);
  assert.match(list, /aria-label="Delete Mine"/);
  assert.match(list, /built in/);
  assert.doesNotMatch(list, /aria-label="Edit Kit"/);
  const err = html(h(E.TemplateManager, { ...props, error: { message: "That name is reserved.", retryable: false, action: "none" } }));
  assert.match(err, /role="alert"/);
  const form = html(h(E.TemplateManager, { ...props, initialEditing: "new" }));
  assert.match(form, /Sections, one per line/);
  assert.match(form, /<button type="submit"[^>]*disabled=""[^>]*>Create template/);
  const edit = html(h(E.TemplateManager, { ...props, initialEditing: "Mine" }));
  assert.match(edit, /value="Mine"/);
  assert.match(edit, /Save changes/);
});

function fakeStoreDeps(surface = "doc") {
  const api = { register: async () => ({ id: 'p' }), templates: async () => ({ items: [], truncated: false }), commands: async () => ({ items: [], truncated: false }), seed: async () => ({ written: 0 }), generate: async () => ({}), putTemplate: async () => null, deleteTemplate: async () => true };
  return { surface, makeApi: () => api, run: { readers: { file: async () => ({ text: "", truncated: false }), note: async () => ({ text: "", truncated: false }) }, fs: { create: async () => "", write: async () => ({}) } }, idFor: async () => "p1" };
}

test("DocGenScreen server render: no project, ready states; landmarks and headings", async () => {
  const store = new E.DocGenStore(fakeStoreDeps());
  const env = { fs: null, notes: null };
  const none = html(h(E.DocGenScreen, { store, env, active: true, projectRoot: null, onOpenFile: noop, onOpenExternal: noop, onOpenSettings: noop }));
  assert.match(none, /<h1 class="dg-title">Doc Gen<\/h1>/);
  assert.match(none, /Open or create a project to use Doc Gen/);
  await store.setProject("/proj");
  const ready = html(h(E.DocGenScreen, { store, env, active: true, projectRoot: "/proj", onOpenFile: noop, onOpenExternal: noop, onOpenSettings: noop, initialViewport: 200 }));
  assert.match(ready, /<section class="dg-side-section dg-template" aria-label="Template and command"/);
  assert.match(ready, /<section class="dg-sources" aria-label="Sources"/);
  assert.match(ready, /<section class="dg-prompt" aria-label="Prompt"/);
  assert.match(ready, /role="tablist"[^>]*aria-label="Output"/);
  assert.match(ready, /No templates for this project yet/);
  const hist = html(h(E.DocGenScreen, { store, env, active: true, projectRoot: "/proj", onOpenFile: noop, onOpenExternal: noop, onOpenSettings: noop, initialView: "history" }));
  assert.match(hist, /History needs the desktop app/);
  const vstore = new E.DocGenStore(fakeStoreDeps("visual"));
  assert.match(html(h(E.DocGenScreen, { store: vstore, env, active: true, projectRoot: null, onOpenFile: noop, onOpenExternal: noop, onOpenSettings: noop })), /<h1 class="dg-title">Visual<\/h1>/);
  const failing = new E.DocGenStore({ ...fakeStoreDeps(), makeApi: () => ({ register: async () => { throw { status: 404, code: "feature_disabled" }; } }) });
  await failing.setProject("/proj");
  const bad = html(h(E.DocGenScreen, { store: failing, env, active: true, projectRoot: "/proj", onOpenFile: noop, onOpenExternal: noop, onOpenSettings: noop }));
  assert.match(bad, /role="alert"/);
  assert.match(bad, /turned off in this core/);
  assert.match(bad, />Open Settings</);
});

test("HistoryPanel: needs the host; loading state is announced", () => {
  assert.match(html(h(E.HistoryPanel, { fs: null, version: "", active: true, onOpen: noop })), /History needs the desktop app/);
  const loading = html(h(E.HistoryPanel, { fs: { list: async () => ({ entries: [], next_offset: null }) }, version: "", active: true, onOpen: noop }));
  assert.match(loading, /role="status"[^>]*aria-live="polite"[^>]*>Loading history/);
});

test("DocGenScreen parity: Setup delivery list is honest, no manual edit, and the inputs lock while a run is in flight", async () => {
  let release;
  const deps = fakeStoreDeps();
  const api = { ...deps.makeApi(), generate: () => new Promise((r) => { release = r; }) };
  const store = new E.DocGenStore({ ...deps, makeApi: () => api });
  await store.setProject("/proj");
  store.setCommandText("Summarize");
  store.addPaste("some pasted text");
  const env = { fs: null, notes: null };
  const props = { store, env, active: true, projectRoot: "/proj", onOpenFile: noop, onOpenExternal: noop, onOpenSettings: noop, initialViewport: 200 };
  const idle = html(h(E.DocGenScreen, props));
  for (const name of ["Box", "Slack", "Email"]) assert.match(idle, new RegExp(`<input type="radio"[^>]*disabled=""[^>]*/> ${name}<em class="dg-muted"> Coming soon</em>`));
  assert.match(idle, /<input type="radio"[^>]*checked=""[^>]*value="local"\/> Local folder/);
  assert.match(idle, /<fieldset class="dg-lock">/, "unlocked when idle");
  assert.doesNotMatch(idle, /<button[^>]*disabled=""[^>]*>Remove</);
  const p = store.generate();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.run.getSnapshot().phase, "generating");
  const busy = html(h(E.DocGenScreen, props));
  assert.match(busy, /<fieldset class="dg-lock" disabled="">/, "left panel locked");
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Remove</, "selected-source Remove locked");
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Clear</, "selected-source Clear locked");
  release({ content: "DOC", truncatedCount: 0, omittedCount: 0, sourceCount: 1 });
  await p;
  const done = html(h(E.ResultPanel, { surface: "doc", run: store.run.getSnapshot(), onCancel: noop, onRetry: noop, onRefine: () => false, onSave: noop, onSaveAsNew: noop, onOpenSaved: noop, onDiscard: noop, onOpenExternal: noop, onOpenSettings: noop, onSignIn: noop }));
  assert.doesNotMatch(done, />Edit</, "the Mac result is read-only: no manual edit");
  assert.doesNotMatch(done, /aria-label="Document markdown"/);
  assert.match(done, />Start another</);
});


test("Visual image strip excludes huge files and unsupported formats, keeps the current image", () => {
  const row = (name, size, kind = "file") => ({ name, path: `data/${name}`, kind, size });
  const rows = [
    row("current.png", 10), row("b.jpg", 20), row("a.webp", 30), row("huge.png", 6_000_000),
    row("boundary.png", 5_000_000), row("over.png", 5_000_001), row("UPPER.PNG", 10),
    row("vector.svg", 10), row("notes.md", 10), row("folder.png", 10, "dir"), row("zero.png", 0),
  ];
  const before = rows.map((r) => r.name).join(",");
  assert.deepEqual(E.siblingImages(rows, 12, "data/current.png").map((r) => r.name), ["a.webp", "b.jpg", "boundary.png", "current.png", "UPPER.PNG"]);
  assert.deepEqual(E.siblingImages(rows, 1, "data/current.png").map((r) => r.name), ["current.png"]);
  assert.deepEqual(E.siblingImages(rows, 0, "data/current.png"), []);
  assert.equal(rows.map((r) => r.name).join(","), before, "the input rows are not reordered");
});


test("a current image past the cap keeps its slot", () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ name: `img-${String(i).padStart(2, "0")}.png`, path: `data/img-${i}.png`, kind: "file", size: 10 }));
  const current = rows[14].path;
  const out = E.siblingImages(rows, 5, current).map((r) => r.path);
  assert.equal(out.length, 5);
  assert.equal(out.at(-1), current);
});

test("dataUrlToBlob decodes base64 without fetch (the app CSP blocks data: connect-src)", async () => {
  const blob = E.dataUrlToBlob("data:image/png;base64,AAECAw==");
  assert.equal(blob.type, "image/png");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 2, 3]);
});
