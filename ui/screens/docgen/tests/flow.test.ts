import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationRun, REVISION_SOURCE_NAME, type RunDeps } from "../run.ts";
import { collectSources, fileItem, noteItem, SourceSelection, sendOrder, MAX_PASTE_CHARS } from "../sources.ts";
import { walkFolder } from "../project-files.ts";
import { loadHistory } from "../history.ts";
import { saveNewDocument, saveRevision } from "../save.ts";
import { MAX_BODY_CHARS, MAX_SELECTED_SOURCES, MAX_SOURCE_CONTENT, type DocTemplate } from "../model.ts";
import { controllableApi, FsErr, MemFs, okResult, readersFrom, tick } from "./fakes.ts";

const tpl: DocTemplate = { id: "t", name: "Decision Log", sections: ["Context", "Decision"], rawContent: "", isBuiltin: false, folderName: "decision-log", isProjectTemplate: true, surface: "doc" };
const sel = { template: tpl, command: "", prompt: "" };

function setup(files: Record<string, string | null> = { "a.md": "alpha", "b.md": "beta" }) {
  const fs = new MemFs();
  const c = controllableApi();
  const deps: RunDeps = { api: c.api, readers: readersFrom(files), fs, today: () => new Date(2026, 9, 31) };
  return { fs, c, run: new GenerationRun(deps), items: Object.keys(files).map((p) => fileItem(p, 10)) };
}

test("generate: reading -> generating -> done; request shape; document and dirty flag", async () => {
  const { run, c, items } = setup();
  const phases: string[] = [];
  run.subscribe(() => phases.push(run.getSnapshot().phase));
  const p = run.generate(sel, items);
  await tick();
  assert.equal(run.getSnapshot().phase, "generating");
  assert.deepEqual(c.calls[0]!.body, { templateName: "Decision Log", sections: ["Context", "Decision"], sources: [{ name: "a.md", content: "alpha" }, { name: "b.md", content: "beta" }] });
  c.calls[0]!.resolve(okResult("## Context\nx"));
  await p;
  const s = run.getSnapshot();
  assert.equal(s.phase, "done");
  assert.equal(s.doc, "## Context\nx");
  assert.equal(s.dirty, true);
  assert.ok(phases.includes("reading") && phases.includes("generating"));
});

test("cancel a fresh run -> idle; the late answer is ignored", async () => {
  const { run, c, items } = setup();
  const p = run.generate(sel, items);
  await tick();
  run.cancel();
  assert.equal(run.getSnapshot().phase, "idle");
  assert.ok(c.calls[0]!.signal.aborted);
  c.calls[0]!.resolve(okResult("late"));
  await p;
  assert.equal(run.getSnapshot().phase, "idle");
  assert.equal(run.getSnapshot().doc, "");
});

test("errors map to wording and keep nothing half-done; unreadable-only selection explains itself", async () => {
  const { run, c, items } = setup();
  const p = run.generate(sel, items);
  await tick();
  c.calls[0]!.reject({ status: 429, code: "RATE_LIMITED", message: "Too many requests" });
  await p;
  assert.equal(run.getSnapshot().phase, "error");
  assert.equal(run.getSnapshot().error?.retryable, true);
  const bin = setup({ "x.bin": null });
  await bin.run.generate(sel, bin.items);
  assert.equal(bin.run.getSnapshot().phase, "error");
  assert.match(bin.run.getSnapshot().error!.message, /could be read as text/);
  assert.equal(bin.c.calls.length, 0, "no model call without readable sources");
  const bad = setup();
  await bad.run.generate({ template: null, command: "", prompt: "" }, bad.items);
  assert.match(bad.run.getSnapshot().error!.message, /template or write a command/);
});

test("refine: sends the document as the only source; failure and cancel keep the document; truncation refuses", async () => {
  const { run, c, items } = setup();
  let p = run.generate(sel, items);
  await tick();
  c.calls[0]!.resolve(okResult("DOC1"));
  await p;
  p = run.refine("shorter");
  await tick();
  const body = c.calls[1]!.body;
  assert.equal(body.sources.length, 1);
  assert.equal(body.sources[0]!.name, REVISION_SOURCE_NAME);
  assert.equal(body.sources[0]!.content, "DOC1");
  assert.match(body.prompt!, /Instruction: shorter/);
  assert.equal(body.templateName, "Decision Log", "keeps the template shape");
  c.calls[1]!.reject({ status: 500, code: "INTERNAL_ERROR" });
  await p;
  assert.equal(run.getSnapshot().doc, "DOC1");
  assert.equal(run.getSnapshot().phase, "done");
  assert.match(run.getSnapshot().editError!, /internal error/);
  // cancel restores
  p = run.refine("again");
  await tick();
  run.cancel();
  await p;
  assert.equal(run.getSnapshot().phase, "done");
  assert.equal(run.getSnapshot().doc, "DOC1");
  assert.equal(run.getSnapshot().revising, false);
  // server reports it truncated the document: refuse to replace
  p = run.refine("expand");
  await tick();
  c.calls[3]!.resolve(okResult("SHORT", { truncatedCount: 1, truncated: ["x"] }));
  await p;
  assert.equal(run.getSnapshot().doc, "DOC1");
  assert.match(run.getSnapshot().editError!, /only read part/);
  // success replaces
  p = run.refine("ok");
  await tick();
  c.calls[4]!.resolve(okResult("DOC2"));
  await p;
  assert.equal(run.getSnapshot().doc, "DOC2");
  assert.equal(run.getSnapshot().editError, null);
});

test("refine refuses a document over the per-source limit, and a command-less revision still validates", async () => {
  const { run, c, items } = setup();
  const p = run.generate({ template: null, command: "c", prompt: "" }, items);
  await tick();
  c.calls[0]!.resolve(okResult("x".repeat(MAX_SOURCE_CONTENT + 1)));
  await p;
  await run.refine("anything");
  assert.match(run.getSnapshot().editError!, /over the 50,000-character limit/);
  assert.equal(c.calls.length, 1);
  const n = setup();
  const g = n.run.generate({ template: null, command: "c", prompt: "" }, n.items);
  await tick();
  n.c.calls[0]!.resolve(okResult("d"));
  await g;
  n.run["lastSelection"] = null; // a run restored without its selection
  const r = n.run.refine("fix");
  await tick();
  assert.equal(n.c.calls[1]!.body.command, "Revise the document as instructed.");
  n.c.calls[1]!.resolve(okResult("d2"));
  await r;
});

test("save: new file under llm-doc/generated, never overwrites (-2, -3), then CAS revision, conflict keeps text", async () => {
  const { run, c, items, fs } = setup();
  fs.addFile("llm-doc/generated/decision-log-20261031.md", "mine\n");
  const p = run.generate(sel, items);
  await tick();
  c.calls[0]!.resolve(okResult("DOC"));
  await p;
  await run.save();
  let s = run.getSnapshot();
  assert.equal(s.saved?.path, "llm-doc/generated/decision-log-20261031-2.md");
  assert.equal(fs.files.get("llm-doc/generated/decision-log-20261031.md")!.text, "mine\n", "existing file untouched");
  assert.equal(fs.files.get(s.saved!.path)!.text, "DOC\n");
  assert.equal(s.dirty, false);
  await run.save(); // nothing to do
  assert.equal(fs.writes.length, 1);
  run.setDocument("DOC edited");
  await run.save();
  assert.equal(fs.files.get(s.saved!.path)!.text, "DOC edited\n");
  // someone else changes the file: our next save must not clobber it
  fs.files.set(run.getSnapshot().saved!.path, { text: "theirs", hash: "other", mtime: 1, size: 6 });
  run.setDocument("DOC again");
  await run.save();
  s = run.getSnapshot();
  assert.equal(s.saveConflict, true);
  assert.equal(fs.files.get(s.saved!.path)!.text, "theirs");
  assert.equal(s.doc, "DOC again");
  await run.save({ asNew: true });
  assert.equal(run.getSnapshot().saveConflict, false);
  assert.match(run.getSnapshot().saved!.path, /decision-log-20261031-3\.md$/);
});

test("saveNewDocument: creates missing folders, normalises line endings, gives up after many collisions", async () => {
  const fs = new MemFs();
  const r = await saveNewDocument(fs, "x", "a\r\nb\r\n\r\n");
  assert.equal(fs.files.get(r.path)!.text, "a\nb\n");
  assert.ok(fs.dirs.has("llm-doc") && fs.dirs.has("llm-doc/generated"));
  await assert.rejects(() => saveNewDocument({ create: fs.create.bind(fs), write: async () => { throw new FsErr("exists"); } }, "y", "t"), (e: { code: string }) => e.code === "exists");
  await assert.rejects(() => saveNewDocument({ create: fs.create.bind(fs), write: async () => { throw new FsErr("permission_denied"); } }, "y", "t"), (e: { code: string }) => e.code === "permission_denied");
  await assert.rejects(() => saveRevision(fs, r.path, "z", "wrong"), (e: { code: string }) => e.code === "conflict");
});

test("SourceSelection: set semantics, caps, paste rules, deterministic send order, totals", () => {
  let s = new SourceSelection();
  s = s.add([fileItem("b.ts", 5), fileItem("a.ts", 7), noteItem("source/x.md", 3, "Standup")]).selection;
  assert.equal(s.size, 3);
  assert.deepEqual(s.totals(), { count: 3, bytes: 15 });
  assert.deepEqual(sendOrder(s.items()).map((i) => i.key), ["note:source/x.md", "file:a.ts", "file:b.ts"]);
  assert.equal(s.add([fileItem("a.ts", 7)]).selection.size, 3, "no duplicates");
  assert.equal(s.addPaste("   ").reason, "empty");
  assert.equal(s.addPaste("x".repeat(MAX_PASTE_CHARS + 1)).reason, "too_long");
  const p = s.addPaste("hello");
  assert.equal(p.item?.name, "Pasted text 1");
  assert.equal(p.selection.addPaste("again").item?.name, "Pasted text 2");
  assert.equal(sendOrder(p.selection.items())[0]!.kind, "paste");
  const big = Array.from({ length: MAX_SELECTED_SOURCES + 10 }, (_, i) => fileItem(`f${i}.ts`, 1));
  const r = new SourceSelection().add(big);
  assert.equal(r.selection.size, MAX_SELECTED_SOURCES);
  assert.equal(r.refused, 10);
  assert.equal(s.remove(["file:a.ts"]).size, 2);
  assert.equal(s.clear().size, 0);
});

test("collectSources: 100 sources / 50 MB selected reads a bounded amount, in order, and reports what it left", async () => {
  const log: string[] = [];
  const files: Record<string, string> = {};
  for (let i = 0; i < 100; i++) files[`src/f${String(i).padStart(3, "0")}.ts`] = "x".repeat(500_000);
  const items = Object.keys(files).map((p) => fileItem(p, 500_000));
  const ctl = new AbortController();
  const res = await collectSources(items, readersFrom(files, {}, log), ctl.signal);
  assert.ok(res.chars <= MAX_BODY_CHARS, "50 MB of selection becomes at most one bounded request body");
  assert.ok(res.chars < 6_000_000);
  assert.ok(res.sources.length > 0 && res.sources.length <= 100);
  assert.equal(res.sources.length + res.notRead + res.skipped.length, 100);
  assert.ok(res.clipped === res.sources.length, "every source clipped to the per-source cap");
  assert.ok(res.sources.every((s) => s.content.length === MAX_SOURCE_CONTENT));
  assert.ok(log.length <= 100);
  assert.deepEqual(res.sources.map((s) => s.name), [...res.sources.map((s) => s.name)].sort(), "send order is by path");
  // tiny files: all are read, none left
  const tiny: Record<string, string> = {};
  for (let i = 0; i < 100; i++) tiny[`t${i}.md`] = "hello";
  const t = await collectSources(Object.keys(tiny).map((p) => fileItem(p, 5)), readersFrom(tiny), ctl.signal);
  assert.equal(t.sources.length, 100);
  assert.equal(t.notRead, 0);
});

test("collectSources: unreadable and binary are skipped by name; abort stops reading", async () => {
  const files = { "a.md": "alpha", "gone.md": "__missing__" as string | null, "b.bin": null };
  const readers = readersFrom({ "a.md": "alpha", "b.bin": null });
  const ctl = new AbortController();
  const r = await collectSources([fileItem("a.md", 5), fileItem("gone.md", 5), fileItem("b.bin", 5)], readers, ctl.signal);
  assert.deepEqual(r.sources.map((s) => s.name), ["a.md"]);
  assert.deepEqual(r.skipped.sort(), ["b.bin", "gone.md"]);
  void files;
  const many = Array.from({ length: 40 }, (_, i) => fileItem(`f${i}`, 1));
  const ctl2 = new AbortController();
  let reads = 0;
  const slow = { async file() { reads++; if (reads === 4) ctl2.abort(); return { text: "t", truncated: false }; }, async note() { return { text: "t", truncated: false }; } };
  await assert.rejects(() => collectSources(many, slow, ctl2.signal), (e: { code: string }) => e.code === "ABORTED");
  assert.ok(reads < 40);
});

test("walkFolder: skips hidden/ignored/binary/large/symlinks, honours limits, is cancellable", async () => {
  const fs = new MemFs();
  for (let i = 0; i < 30; i++) fs.addFile(`proj/src/f${i}.ts`, "x");
  fs.addFile("proj/logo.png", "x");
  fs.addFile("proj/huge.txt", "x", 9 * 1024 * 1024);
  fs.addFile("proj/deep/a/b/c.md", "x");
  const ctl = new AbortController();
  const r = await walkFolder(fs, "proj", ctl.signal);
  assert.equal(r.items.length, 31);
  assert.equal(r.skippedBinary, 1);
  assert.equal(r.skippedLarge, 1);
  assert.equal(r.capped, false);
  const capped = await walkFolder(fs, "proj", ctl.signal, undefined, { maxFiles: 5 });
  assert.equal(capped.items.length, 5);
  assert.equal(capped.capped, true);
  const shallow = await walkFolder(fs, "proj", ctl.signal, undefined, { maxDepth: 1 });
  assert.equal(shallow.capped, true);
  assert.ok(!shallow.items.some((i) => i.rel.endsWith("c.md")));
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(() => walkFolder(fs, "proj", stop.signal), (e: { code: string }) => e.code === "ABORTED");
});

test("loadHistory: 5,000 documents load in pages, newest first, quickly; missing folder is empty, not an error", async () => {
  const fs = new MemFs();
  for (let i = 0; i < 5000; i++) fs.addFile(`llm-doc/generated/doc-${i}.md`, "x");
  fs.addFile("llm-doc/generated/notes.json", "{}");
  const pages: number[] = [];
  const t0 = performance.now();
  const r = await loadHistory(fs, new AbortController().signal, (items) => pages.push(items.length));
  assert.equal(r.items.length, 5000);
  assert.ok(performance.now() - t0 < 1500);
  assert.equal(r.items[0]!.name, "doc-4999.md");
  assert.ok(pages.length >= 5);
  assert.equal(fs.listCalls, 6);
  const none = await loadHistory(new MemFs(), new AbortController().signal);
  assert.deepEqual(none, { items: [], capped: false, missing: true });
  const boom = { list: async () => { throw new FsErr("permission_denied"); } };
  await assert.rejects(() => loadHistory(boom, new AbortController().signal), (e: { code: string }) => e.code === "permission_denied");
});
