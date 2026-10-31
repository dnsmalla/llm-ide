process.env.TZ = "UTC";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadBundle, react, server } from "./write-helpers.mjs";

let L;
let h;
let html;
before(async () => {
  L = await loadBundle("library-write", "write-entry.ts");
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});
const count = (s, re) => (s.match(re) ?? []).length;
const noop = () => {};

const mkStore = async (n = 3) => {
  const host = new L.FakeHost();
  for (let i = 0; i < n; i++) host.add(`source/meetings/2026/10/n${i}.md`, L.meetingText(i));
  const store = new L.LibraryStore({ host, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await store.init();
  await L.settle(store);
  return { host, store, write: new L.FakeWriteHost(host) };
};

test("delete dialog (one note): alertdialog, labelled, names the note, says Trash and never permanent", () => {
  const out = html(h(L.DeleteDialog, { rels: ["a/b.md"], titles: new Map([["a/b.md", "Budget review"]]), progress: null, onConfirm: noop, onCancelRun: noop, onClose: noop }));
  assert.match(out, /role="alertdialog"[^>]*aria-modal="true"[^>]*aria-labelledby="lib-dlg-/);
  assert.match(out, /<h2 id="lib-dlg-[^"]+"[^>]*>Move this note to the Trash\?<\/h2>/);
  assert.match(out, /Budget review/);
  assert.match(out, /a\/b\.md/);
  assert.match(out, /Nothing is deleted permanently/);
  assert.match(out, />Move to Trash<\/button>/);
  assert.ok(!out.includes("Type <code>"), "no typed confirmation for a single note");
  assert.ok(!/<button[^>]*disabled[^>]*>Move to Trash/.test(out));
});

test("delete dialog (bulk): lists names and 'and N more', requires the typed phrase, confirm disabled until typed", () => {
  const rels = Array.from({ length: 37 }, (_, i) => `n${i}.md`);
  const out = html(h(L.DeleteDialog, { rels, titles: new Map(), progress: null, onConfirm: noop, onCancelRun: noop, onClose: noop }));
  assert.match(out, /Move 37 notes to the Trash\?/);
  assert.match(out, /aria-label="Notes to delete"/);
  assert.equal(count(out, /<li>/g) + count(out, /<li class="lib-muted">/g), 9, "8 names plus the 'and more' row");
  assert.match(out, /and 29 more/);
  assert.match(out, /Type <code>delete 37 notes<\/code> to confirm/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Move 37 notes to Trash<\/button>/);
  assert.match(out, /<input data-autofocus="true"/);
});

test("delete dialog progress: live status, stop while running, close when finished, errors worded", () => {
  const base = { rels: ["a.md", "b.md"], titles: new Map(), onConfirm: noop, onCancelRun: noop, onClose: noop };
  const running = html(h(L.DeleteDialog, { ...base, progress: { phase: "running", total: 2, done: 1, ok: 1, skipped: 0, failed: 0, errors: [] } }));
  assert.match(running, /role="status" aria-live="polite"/);
  assert.match(running, />Stop<\/button>/);
  assert.ok(!running.includes("Move 2 notes to Trash"));
  const done = html(h(L.DeleteDialog, { ...base, progress: { phase: "done", total: 2, done: 2, ok: 1, skipped: 0, failed: 1, errors: [{ rel: "b.md", code: "trash_unavailable" }] } }));
  assert.match(done, />Close<\/button>/);
  assert.match(done, /aria-label="Notes that could not be deleted"/);
  assert.match(done, /never deleted permanently/);
  assert.match(done, /1 done, 1 failed/);
});

test("new note, rename, tag, discard dialogs: labelled fields, validation messages, safe defaults", () => {
  const n = html(h(L.NewNoteDialog, { defaultFolder: "notes", onCreate: noop, onClose: noop, error: null, busy: false }));
  assert.match(n, /role="dialog"/);
  assert.match(n, /<span>Title<\/span>/);
  assert.match(n, /<span>Folder<\/span>/);
  assert.match(n, /<button type="submit"[^>]*disabled=""[^>]*>Create note<\/button>/);
  assert.match(n, /never overwritten/);
  const err = html(h(L.NewNoteDialog, { defaultFolder: "notes", onCreate: noop, onClose: noop, error: "A note with that name already exists. Nothing was overwritten.", busy: false }));
  assert.match(err, /role="alert"/);
  assert.equal(L.folderProblem("notes/2026"), null);
  assert.equal(L.folderProblem(""), null);
  for (const bad of ["../x", "/abs", "a//b", ".hidden", "a/.git", "a\\b", "a:b", "node_modules/x"]) assert.notEqual(L.folderProblem(bad), null, bad);
  const r = html(h(L.RenameDialog, { rel: "a/old.md", onRename: noop, onClose: noop, error: null, busy: false }));
  assert.match(r, /New file name/);
  assert.match(r, /value="old\.md"/);
  assert.match(r, /<button type="submit"[^>]*disabled=""[^>]*>Rename<\/button>/, "unchanged name cannot be submitted");
  const t = html(h(L.TagDialog, { count: 1000, progress: null, onApply: noop, onCancelRun: noop, onClose: noop }));
  assert.match(t, /Tag 1,000 notes/);
  assert.match(t, /<legend>Action<\/legend>/);
  assert.match(t, /byte for byte/);
  const d = html(h(L.DiscardDialog, { onDiscard: noop, onKeep: noop }));
  assert.match(d, /role="alertdialog"/);
  assert.match(d, /data-autofocus="true"[^>]*>Keep editing/);
});

test("editor view states: conflict offers three explicit choices; gone does not offer overwrite; errors are worded", () => {
  const snap = (over) => ({ phase: "clean", rel: "n.md", draft: "hello", error: null, crlf: false, mixedEol: false, justSaved: false, ...over });
  const view = (s, dirty = false, preview = false) => html(h(L.EditorView, { rel: "n.md", snap: s, dirty, preview, onTogglePreview: noop, onEdit: noop, onSave: noop, onKeepMine: noop, onTakeTheirs: noop, onSaveCopy: noop, onClose: noop }));
  const clean = view(snap({}));
  assert.match(clean, /role="toolbar" aria-label="Editor"/);
  assert.match(clean, /<textarea[^>]*aria-label="Edit n\.md"/);
  assert.match(clean, /<button[^>]*disabled=""[^>]*>Save<\/button>/);
  assert.match(clean, /No changes/);
  const dirty = view(snap({ phase: "dirty", draft: "hello!" }), true);
  assert.match(dirty, /Unsaved changes/);
  assert.ok(!/<button[^>]*disabled=""[^>]*>Save<\/button>/.test(dirty));
  assert.match(dirty, /Close without saving/);
  const conflict = view(snap({ phase: "conflict", error: "conflict" }), true);
  assert.match(conflict, /role="alert"/);
  assert.match(conflict, /Nothing was overwritten/);
  assert.match(conflict, />Save mine as a copy</);
  assert.match(conflict, />Use the disk version \(discard mine\)</);
  assert.match(conflict, />Overwrite with mine</);
  const gone = view(snap({ phase: "gone", error: "not_found" }), true);
  assert.match(gone, /saving does not recreate it/);
  assert.ok(!gone.includes("Overwrite with mine"));
  assert.match(gone, /readOnly=""|readonly=""/i);
  const bad = view(snap({ phase: "error", error: "not_utf8" }));
  assert.match(bad, /not valid UTF-8/);
  assert.ok(!bad.includes("<textarea"));
  const sav = view(snap({ phase: "dirty", error: "permission_denied", draft: "x" }), true);
  assert.match(sav, /refused access/);
  assert.match(view(snap({ phase: "dirty", mixedEol: true }), true), /mixes Windows and Unix/);
  const pv = view(snap({ draft: "---\ntitle: T\n---\n\n# Heading\n\n<script>alert(1)</script> <b>x</b>\n" }), false, true);
  assert.match(pv, /aria-label="Preview"/);
  assert.match(pv, /<h1|<h2|Heading/);
  assert.ok(!pv.includes("<script>alert") && !pv.includes("<b>x</b>"), "preview never injects raw HTML");
  assert.match(pv, /aria-pressed="true"/);
  assert.match(html(h(L.EditorView, { rel: "n.md", snap: snap({ phase: "loading" }), dirty: false, preview: false, onTogglePreview: noop, onEdit: noop, onSave: noop, onKeepMine: noop, onTakeTheirs: noop, onSaveCopy: noop, onClose: noop })), /role="status"[^>]*>Opening for editing/);
});

test("screen: read-only without write props; with them the list has labelled actions and the viewer gets a note toolbar", async () => {
  const { host, store, write } = await mkStore();
  store.select("source/meetings/2026/10/n1.md");
  const ro = html(h(L.LibraryScreen, { store, host }));
  assert.ok(!ro.includes("New note") && !ro.includes("Select notes") && !ro.includes('aria-label="Note actions"'));
  const rw = html(h(L.LibraryScreen, { store, host, write: { host: write, summarize: null } }));
  assert.match(rw, /role="toolbar" aria-label="Library actions"/);
  assert.match(rw, />New note<\/button>/);
  assert.match(rw, /aria-pressed="false"[^>]*>Select notes<\/button>/);
  assert.match(rw, /role="toolbar" aria-label="Note actions"/);
  for (const label of ["Edit", "Rename…", "Delete…"]) assert.match(rw, new RegExp(`>${label}</button>`));
  assert.ok(!rw.includes("Re-summarise"), "hidden without a core summariser");
  const withSum = html(h(L.LibraryScreen, { store, host, write: { host: write, summarize: { summarize: async () => ({ status: 200, body: {} }) } } }));
  assert.match(withSum, />Re-summarise<\/button>/);
  // The folder prompt tells the truth about writing.
  host.root = null;
  const s2 = new L.LibraryStore({ host });
  await s2.init();
  assert.match(html(h(L.LibraryScreen, { store: s2, host, write: { host: write, summarize: null } })), /changes a note only when you edit, rename, tag or delete it/);
  assert.match(html(h(L.LibraryScreen, { store: s2, host })), /It never changes them/);
});

test("list in selection mode: multiselectable listbox, aria-selected is membership, rows keep their names", async () => {
  const { store } = await mkStore(4);
  const state = store.getSnapshot();
  const rels = store.rows().flatMap((r) => (r.kind === "note" ? [r.rec.rel] : []));
  const bulk = { selected: new Set([rels[0], rels[2]]), onToggle: noop, onSelectAll: noop };
  const out = html(h(L.NoteList, { store, state, bulk }));
  assert.match(out, /role="listbox"[^>]*aria-multiselectable="true"/);
  assert.equal(count(out, /role="option"[^>]*aria-selected="true"/g), 2);
  assert.equal(count(out, /role="option"[^>]*aria-selected="false"/g), 2);
  const plain = html(h(L.NoteList, { store, state }));
  assert.ok(!plain.includes("aria-multiselectable"));
});

test("bulk bar: toolbar with a live count, select-all offers the view size, actions disabled with nothing selected", async () => {
  const { store, write } = await mkStore(5);
  const sel = L.selectAll(["a.md", "b.md", "c.md"]);
  const out = html(h(L.BulkBar, { store, write, selection: sel, viewCount: 5, onSelectAll: noop, onClear: noop, onDone: noop, onChanged: noop }));
  assert.match(out, /role="toolbar" aria-label="Selected notes"/);
  assert.match(out, /role="status" aria-live="polite">3 selected/);
  assert.match(out, />Select all 5<\/button>/);
  assert.ok(!/<button[^>]*disabled=""[^>]*>Delete…/.test(out));
  const none = html(h(L.BulkBar, { store, write, selection: L.EMPTY_SELECTION, viewCount: 5, onSelectAll: noop, onClear: noop, onDone: noop, onChanged: noop }));
  assert.match(none, /<button[^>]*disabled=""[^>]*>Delete…<\/button>/);
  assert.match(none, /<button[^>]*disabled=""[^>]*>Tag…<\/button>/);
});

test("store select guard: a dirty editor vetoes navigation until the user discards; proceed bypasses the guard once", async () => {
  const { store } = await mkStore(3);
  const [a, b] = ["source/meetings/2026/10/n0.md", "source/meetings/2026/10/n1.md"];
  store.select(a);
  let pending = null;
  let dirty = true;
  store.selectGuard = (_next, proceed) => {
    if (!dirty) return true;
    pending = proceed;
    return false;
  };
  store.hasUnsaved = () => dirty;
  store.select(b);
  assert.equal(store.getSnapshot().selectedRel, a, "vetoed");
  store.setSection("meeting");
  assert.equal(store.getSnapshot().selectedRel, a, "section change vetoed too");
  store.reveal(b);
  assert.equal(store.getSnapshot().selectedRel, a);
  pending();
  assert.equal(store.getSnapshot().selectedRel, b, "discard proceeds");
  assert.ok(store.selectGuard, "the guard is back after proceeding");
  // The open note is never deselected underneath unsaved edits (deleted on disk while editing).
  store.noteRemoved([b]);
  assert.equal(store.getSnapshot().selectedRel, b);
  dirty = false;
  store.select(a);
  assert.equal(store.getSnapshot().selectedRel, a);
});
