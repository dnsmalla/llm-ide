import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost, meetingText } from "./fake-host.ts";
import { FakeWriteHost } from "./fake-write-host.ts";
import { EditorSession, detectEol, toFileEol } from "../write/editor-session.ts";
import { WriteQueue } from "../write/write-queue.ts";
import { WriteError, type SavedNote } from "../write/write-host.ts";
import { baseOf, conflictCopyRel, dateStamp, initialNoteText, nameProblem, newNoteRel, renamedRel, slugify, uniqueRel, withExtension } from "../write/note-ops.ts";
import { applySummary, applySummaryDetailed, buildRequest, decodeSummary, extractTranscript, renderSummarySection, resummarize, SummarizeError, summarizeErrorText } from "../write/resummarize.ts";
import { readKey } from "../write/frontmatter-edit.ts";
import { parseNote } from "../frontmatter.ts";

const REL = "notes/a.md";
const mk = (text: string) => {
  const fake = new FakeHost();
  fake.add(REL, text);
  const host = new FakeWriteHost(fake);
  const written: { saved: SavedNote; text: string }[] = [];
  const ed = new EditorSession(REL, { host, queue: new WriteQueue(), onWritten: (saved, text) => written.push({ saved, text }), taken: (r) => fake.files.has(r) });
  return { fake, host, ed, written };
};

test("open, edit, save: dirty tracks the draft, a no-op save writes nothing, undo returns to clean", async () => {
  const { fake, host, ed, written } = mk("---\ntitle: T\n---\n\nbody\n");
  await ed.load();
  assert.equal(ed.getSnapshot().phase, "clean");
  assert.equal(await ed.save(), true);
  assert.equal(host.calls.save, 0, "opening and saving without a change never rewrites the file");
  ed.edit("---\ntitle: T\n---\n\nbody!\n");
  assert.equal(ed.getSnapshot().phase, "dirty");
  assert.equal(ed.dirty, true);
  ed.edit("---\ntitle: T\n---\n\nbody\n");
  assert.equal(ed.getSnapshot().phase, "clean");
  ed.edit("---\ntitle: T\n---\n\nbody!\n");
  assert.equal(await ed.save(), true);
  assert.equal(fake.files.get(REL)!.text, "---\ntitle: T\n---\n\nbody!\n");
  assert.equal(written.length, 1);
  assert.equal(ed.getSnapshot().justSaved, true);
  ed.edit("x");
  assert.equal(ed.getSnapshot().justSaved, false);
  // The second save uses the first save's hash: no self-conflict.
  assert.equal(await ed.save(), true);
  assert.equal(fake.files.get(REL)!.text, "x");
});

test("CRLF notes stay CRLF; mixed endings are flagged", async () => {
  const { fake, ed } = mk("a\r\nb\r\n");
  await ed.load();
  assert.equal(ed.getSnapshot().crlf, true);
  assert.equal(ed.getSnapshot().draft, "a\nb\n");
  ed.edit("a\nb\nc\n");
  await ed.save();
  assert.equal(fake.files.get(REL)!.text, "a\r\nb\r\nc\r\n");
  assert.deepEqual(detectEol("a\r\nb\nc\n"), { crlf: false, mixed: true });
  assert.equal(toFileEol("a\nb", true), "a\r\nb");
});

test("conflict: nothing is overwritten; keep mine, take theirs and save-as-copy each behave", async () => {
  const { fake, host, ed, written } = mk("one\n");
  await ed.load();
  ed.edit("mine\n");
  fake.files.set(REL, { text: "theirs\n", mtimeMs: 5 });
  assert.equal(await ed.save(), false);
  assert.equal(ed.getSnapshot().phase, "conflict");
  assert.equal(ed.getSnapshot().error, "conflict");
  assert.equal(fake.files.get(REL)!.text, "theirs\n");
  assert.equal(ed.getSnapshot().draft, "mine\n", "the draft survives the conflict");
  ed.edit("mine, edited again\n");
  assert.equal(ed.getSnapshot().phase, "conflict", "editing does not hide the conflict");
  // save as copy
  const copy = await ed.saveAsCopy();
  assert.equal(copy, "notes/a (conflict copy).md");
  assert.equal(fake.files.get(copy!)!.text, "mine, edited again\n");
  assert.equal(fake.files.get(REL)!.text, "theirs\n");
  assert.equal(written.length, 1);
  // a second copy gets a new name
  assert.equal(await ed.saveAsCopy(), "notes/a (conflict copy)-2.md");
  // keep mine
  assert.equal(await ed.keepMine(), true);
  assert.equal(fake.files.get(REL)!.text, "mine, edited again\n");
  assert.equal(ed.getSnapshot().phase, "clean");
  // take theirs
  fake.files.set(REL, { text: "newer\n", mtimeMs: 9 });
  ed.edit("zzz\n");
  await host.save(REL, "sneaky\n", false, "0".repeat(64), true);
  await ed.save();
  assert.equal(ed.getSnapshot().phase, "conflict");
  await ed.takeTheirs();
  assert.equal(ed.getSnapshot().draft, "sneaky\n");
  assert.equal(ed.getSnapshot().phase, "clean");
});

test("external change: a clean editor reloads silently, a dirty one is flagged before saving, a deleted note is 'gone'", async () => {
  const { fake, ed } = mk("one\n");
  await ed.load();
  fake.files.set(REL, { text: "two\n", mtimeMs: 7 });
  await ed.checkExternal();
  assert.equal(ed.getSnapshot().draft, "two\n");
  assert.equal(ed.getSnapshot().phase, "clean");
  ed.edit("mine\n");
  fake.files.set(REL, { text: "three\n", mtimeMs: 8 });
  await ed.checkExternal();
  assert.equal(ed.getSnapshot().phase, "conflict");
  assert.equal(ed.getSnapshot().draft, "mine\n");
  fake.files.delete(REL);
  await ed.checkExternal();
  assert.equal(ed.getSnapshot().phase, "gone");
  // Saving a deleted note does not recreate it.
  assert.equal(await ed.save(), false);
  assert.equal(fake.files.has(REL), false);
});

test("save errors keep the draft and the dirty state; typing during a save is not lost", async () => {
  const { fake, host, ed } = mk("one\n");
  await ed.load();
  ed.edit("two\n");
  host.failSave.set(REL, new WriteError("permission_denied"));
  assert.equal(await ed.save(), false);
  assert.equal(ed.getSnapshot().phase, "dirty");
  assert.equal(ed.getSnapshot().error, "permission_denied");
  assert.equal(ed.getSnapshot().draft, "two\n");
  // typing while the save is in flight
  const orig = host.save.bind(host);
  host.save = async (...a) => {
    ed.edit("two and more\n");
    return orig(...a);
  };
  assert.equal(await ed.save(), false);
  assert.equal(fake.files.get(REL)!.text, "two\n");
  assert.equal(ed.getSnapshot().phase, "dirty");
  assert.equal(ed.getSnapshot().draft, "two and more\n");
  host.save = orig;
  assert.equal(await ed.save(), true);
  assert.equal(fake.files.get(REL)!.text, "two and more\n");
});

test("open errors are mapped, not thrown", async () => {
  const fake = new FakeHost();
  const host = new FakeWriteHost(fake);
  host.open = async () => {
    throw new WriteError("not_utf8");
  };
  const ed = new EditorSession("x.md", { host, queue: new WriteQueue(), onWritten: () => {}, taken: () => false });
  await ed.load();
  assert.deepEqual([ed.getSnapshot().phase, ed.getSnapshot().error], ["error", "not_utf8"]);
  host.open = async () => {
    throw new WriteError("not_found");
  };
  await ed.load();
  assert.equal(ed.getSnapshot().phase, "gone");
  ed.edit("typing into a gone note is ignored");
  assert.equal(ed.getSnapshot().draft, "");
});

test("names: slugs, validation, never-overwrite candidates", () => {
  assert.equal(slugify("Q4 Budget: Review!"), "q4-budget-review");
  assert.equal(slugify("日本語のメモ"), "日本語のメモ");
  assert.equal(slugify("  ../../etc/passwd "), "etc-passwd");
  assert.equal(slugify("!!!"), "note");
  assert.equal(slugify("x".repeat(200)).length, 60);
  for (const bad of ["", " a.md", "a/b.md", "a\\b.md", "a:b.md", ".hidden.md", "a.exe", "noext", "con.md", "a.md.", "a\u0000.md", "x.partial.md", "q?.md", "a".repeat(130) + ".md"]) assert.notEqual(nameProblem(bad), null, JSON.stringify(bad));
  for (const ok of ["a.md", "Meeting notes 2026.markdown", "日本語.txt", "a (conflict copy).md"]) assert.equal(nameProblem(ok), null, ok);
  assert.equal(withExtension("idea"), "idea.md");
  assert.equal(withExtension("idea.txt"), "idea.txt");
  const taken = new Set(["notes/2026-10-31-x.md", "notes/2026-10-31-x-2.md"]);
  const t = Date.parse("2026-10-31T12:00:00");
  assert.equal(dateStamp(t), "2026-10-31");
  assert.equal(newNoteRel("notes", "X", t, (r) => taken.has(r)), "notes/2026-10-31-x-3.md");
  assert.equal(newNoteRel("", "X", t, () => false), "2026-10-31-x.md");
  assert.equal(uniqueRel("a/b/", "n", "md", () => false), "a/b/n.md");
  assert.equal(renamedRel("a/b/c.md", "d.md"), "a/b/d.md");
  assert.equal(renamedRel("c.md", "d.md"), "d.md");
  assert.equal(baseOf("a/b/c.md"), "c.md");
  assert.equal(conflictCopyRel("a/b.md", () => false), "a/b (conflict copy).md");
  const init = initialNoteText("Plan: Q4", t);
  assert.equal(parseNote(init).data.title, "Plan: Q4");
  assert.equal(init, `---\ntitle: 'Plan: Q4'\ncreated_at: '${new Date(t).toISOString()}'\n---\n\n# Plan: Q4\n\n`, "exactly one header, no stray fence");
  assert.equal(parseNote(init).body, "# Plan: Q4\n\n");
  assert.throws(() => uniqueRel("", "n", "md", () => true), RangeError);
});

const MEETING = "---\nid: m1\ntitle: Weekly\nstarted_at: '2026-10-01T10:00:00Z'\nduration_seconds: 600\nparticipants:\n- Alice\n- Bob\nplatform: meet\nlanguage: ja\ngist: old gist\ntldr:\n- old\nx-custom: keep\n---\n\nOld summary text\n\n## Actions\n- [ ] old\n\n## Transcript\n\n[10:00:01] **Alice**: hello\n[10:00:05] **Bob**: hi\n";
const REPLY = { gist: "New gist", tldr: ["a", "b: c"], full: "New summary.", actions: [{ owner: "Alice", text: "Ship", due: "2026-11-01" }, { owner: null, text: "Plan", due: null }], decisions: [{ text: "Go" }], blockers: [], model: "m-1", generated_at: Date.parse("2026-10-31T00:00:00Z") };

test("summary: transcript extraction, request body, section and header rewrite leave the transcript and unknown keys byte-identical", () => {
  const tr = extractTranscript(MEETING)!;
  assert.equal(tr, "[10:00:01] **Alice**: hello\n[10:00:05] **Bob**: hi");
  assert.equal(extractTranscript("---\ntitle: x\n---\nno transcript here\n"), null);
  assert.equal(extractTranscript("---\ntitle: x\n---\n## Transcript\n\n"), null);
  const req = buildRequest(MEETING, tr);
  assert.deepEqual(req.body, { transcript: tr, title: "Weekly", language: "ja", started_at: "2026-10-01T10:00:00Z", duration_seconds: 600, participants: ["Alice", "Bob"] });
  const s = decodeSummary(REPLY)!;
  const out = applySummary(MEETING, s)!;
  assert.ok(out.endsWith("## Transcript\n\n[10:00:01] **Alice**: hello\n[10:00:05] **Bob**: hi\n"));
  assert.ok(out.includes("x-custom: keep\n") && out.includes("participants:\n- Alice\n- Bob\n") && out.includes("platform: meet\n"));
  assert.equal(readKey(out, "gist"), "New gist");
  assert.deepEqual(readKey(out, "tldr"), ["a", "b: c"]);
  assert.equal(readKey(out, "summary_model"), "m-1");
  assert.equal(readKey(out, "summary_generated_at"), "2026-10-31T00:00:00.000Z");
  assert.ok(out.includes("\nNew summary.\n\n## Actions\n- [ ] **Alice** — Ship (due 2026-11-01)\n- [ ] Plan\n\n## Decisions\n- Go\n\n"));
  assert.ok(out.includes("<!-- llmide:summary:end -->\n\n## Transcript"));
  // M11: no markers yet (a Mac-written note): hand-written/old text is KEPT, the section is inserted, the caller is told.
  assert.ok(out.includes("Old summary text"));
  assert.equal(applySummaryDetailed(MEETING, s)!.keptExisting, true);
  // Idempotent: applying again changes nothing about the body.
  assert.equal(parseNote(applySummary(out, s)!).body, parseNote(out).body);
  assert.equal(applySummary("---\na: b\n---\nnothing\n", s), null);
  assert.equal(renderSummarySection({ ...s, actions: [], decisions: [], blockers: [] }), "\nNew summary.\n\n");
  // CRLF notes get CRLF everywhere.
  const crlf = applySummary(MEETING.replaceAll("\n", "\r\n"), s)!;
  assert.ok(!/[^\r]\n/.test(crlf), "no bare LF in a CRLF note");
  // A transcript over the cap is clipped and flagged.
  assert.equal(buildRequest(MEETING, "x".repeat(400_001)).truncated, true);
});

test("M11: re-summarise replaces only the marked section; text around it survives byte for byte", () => {
  const s = decodeSummary(REPLY)!;
  const first = applySummary(MEETING, s)!;
  const withNotes = first.replace("<!-- llmide:summary:start -->", "My own notes\n\n<!-- llmide:summary:start -->").replace("## Transcript", "Closing remarks\n\n## Transcript");
  const again = decodeSummary({ ...REPLY, full: "Second summary.", actions: [], decisions: [] })!;
  const out = applySummaryDetailed(withNotes, again)!;
  assert.equal(out.keptExisting, false);
  assert.ok(out.text.includes("My own notes\n\n<!-- llmide:summary:start -->"));
  assert.ok(out.text.includes("Second summary."));
  assert.ok(!out.text.includes("New summary."));
  assert.ok(out.text.includes("Old summary text"), "pre-marker text from the Mac stays");
  assert.ok(out.text.includes("Closing remarks\n\n## Transcript"));
  assert.equal(out.text.split("llmide:summary:start").length, 2, "one section, no duplication");
});

test("summary decoding rejects junk and bounds lists", () => {
  assert.equal(decodeSummary(null), null);
  assert.equal(decodeSummary({ gist: "x" }), null);
  const d = decodeSummary({ full: "f", tldr: ["a", 5, null], actions: [{ text: "" }, { text: "t", owner: "" }, "junk"], generated_at: "x" })!;
  assert.deepEqual(d.tldr, ["a"]);
  assert.deepEqual(d.actions, [{ owner: null, text: "t", due: null }]);
  assert.equal(d.generatedAtMs, 0);
});

const never = new AbortController().signal;
const mkSum = (status: number, body: unknown) => {
  const fake = new FakeHost();
  fake.add(REL, MEETING);
  const host = new FakeWriteHost(fake);
  const phases: string[] = [];
  return { fake, host, phases, deps: (signal = never, core?: { summarize: () => Promise<{ status: number; body: unknown }> }) => ({ host, signal, core: core ?? { summarize: async () => ({ status, body }) }, onPhase: (p: string) => phases.push(p) }) };
};

test("re-summarise: success writes once, through compare-and-swap", async () => {
  const { fake, host, phases, deps } = mkSum(200, REPLY);
  const r = await resummarize(REL, deps() as never);
  assert.deepEqual(phases, ["reading", "summarising", "saving"]);
  assert.equal(host.calls.save, 1);
  assert.equal(fake.files.get(REL)!.text, r.text);
  assert.equal(readKey(r.text, "gist"), "New gist");
});

test("re-summarise: every failure leaves the note untouched and maps to a readable code", async () => {
  for (const [status, code] of [[401, "unauthorized"], [429, "rate_limited"], [504, "timeout"], [502, "failed"], [404, "unavailable"], [500, "failed"]] as const) {
    const { fake, deps } = mkSum(status, {});
    await assert.rejects(resummarize(REL, deps() as never), (e: SummarizeError) => e.code === code, String(status));
    assert.equal(fake.files.get(REL)!.text, MEETING);
  }
  const bad = mkSum(200, { nope: 1 });
  await assert.rejects(resummarize(REL, bad.deps() as never), (e: SummarizeError) => e.code === "bad_reply");
  const none = mkSum(200, REPLY);
  none.fake.files.set(REL, { text: "---\ntitle: x\n---\nplain\n" });
  await assert.rejects(resummarize(REL, none.deps() as never), (e: SummarizeError) => e.code === "no_transcript");
  // The request itself failing (core down / timeout).
  const down = mkSum(200, REPLY);
  await assert.rejects(resummarize(REL, down.deps(never, { summarize: async () => { throw Object.assign(new Error("x"), { code: "NETWORK" }); } }) as never), (e: SummarizeError) => e.code === "unavailable");
  await assert.rejects(resummarize(REL, down.deps(never, { summarize: async () => { throw Object.assign(new Error("x"), { code: "TIMEOUT" }); } }) as never), (e: SummarizeError) => e.code === "timeout");
  for (const c of ["no_transcript", "unauthorized", "timeout", "rate_limited", "failed", "bad_reply", "unavailable", "cancelled", "conflict", "write_failed"] as const) assert.ok(summarizeErrorText(c).length > 10);
});

test("re-summarise: cancel writes nothing; an edit during summarising is a conflict, not an overwrite", async () => {
  const ac = new AbortController();
  const a = mkSum(200, REPLY);
  await assert.rejects(resummarize(REL, a.deps(ac.signal, { summarize: async () => { ac.abort(); return { status: 200, body: REPLY }; } }) as never), (e: SummarizeError) => e.code === "cancelled");
  assert.equal(a.fake.files.get(REL)!.text, MEETING);
  const b = mkSum(200, REPLY);
  await assert.rejects(
    resummarize(REL, b.deps(never, { summarize: async () => { b.fake.files.set(REL, { text: MEETING + "user edit\n", mtimeMs: 3 }); return { status: 200, body: REPLY }; } }) as never),
    (e: SummarizeError) => e.code === "conflict",
  );
  assert.equal(b.fake.files.get(REL)!.text, MEETING + "user edit\n");
  void meetingText;
});

test("checkExternal: a read that raced our own save never replaces the saved text with stale disk text", async () => {
  const { host, ed } = mk("one\n");
  await ed.load();
  const real = host.open.bind(host);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let first = true;
  host.open = async (rel: string) => {
    const o = await real(rel); // reads the OLD note ...
    if (first) { first = false; await hold; } // ... and is delivered after the save below finished
    return o;
  };
  const check = ed.checkExternal();
  ed.edit("two\n");
  assert.equal(await ed.save(), true);
  release();
  await check;
  assert.equal(ed.getSnapshot().draft, "two\n");
  assert.equal(ed.getSnapshot().phase, "clean");
});
