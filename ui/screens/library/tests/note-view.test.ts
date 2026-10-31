process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNote, loadNote, VIEW_MAX_BYTES } from "../note-view.ts";
import { NotesError } from "../host.ts";
import { applyHead, recordFromEntry } from "../notes-model.ts";
import { FakeHost, meetingText } from "./fake-host.ts";

const ac = () => new AbortController().signal;

test("loadNote reads in chunks, stops at the cap with truncated, and surfaces host error codes", async () => {
  const host = new FakeHost();
  host.chunk = 64 * 1024;
  host.add("small.md", "hello");
  host.add("big.md", "x".repeat(3 * 1024 * 1024));
  host.add("stub.md", "", { placeholder: true });
  const small = await loadNote(host, "small.md", ac());
  assert.deepEqual([small.text, small.truncated], ["hello", false]);
  const big = await loadNote(host, "big.md", ac());
  assert.equal(big.truncated, true);
  assert.equal(big.size, 3 * 1024 * 1024);
  assert.ok(big.text.length >= VIEW_MAX_BYTES && big.text.length < VIEW_MAX_BYTES + 128 * 1024);
  await assert.rejects(loadNote(host, "stub.md", ac()), (e: unknown) => e instanceof NotesError && e.code === "not_downloaded");
  await assert.rejects(loadNote(host, "gone.md", ac()), (e: unknown) => e instanceof NotesError && e.code === "not_found");
});

test("loadNote stops promptly when aborted and does not keep reading", async () => {
  const host = new FakeHost();
  host.chunk = 4096;
  host.add("big.md", "x".repeat(200_000));
  const a = new AbortController();
  const orig = host.read.bind(host);
  host.read = async (...args) => {
    if (host.calls.read === 2) a.abort();
    return orig(...args);
  };
  await assert.rejects(loadNote(host, "big.md", a.signal), (e: unknown) => e instanceof NotesError);
  assert.ok(host.calls.read <= 4, `read ${host.calls.read} chunks after abort`);
});

test("describeNote: meeting note, metadata, frontmatter rows, summary fields", () => {
  const text = meetingText(5, "meet", "duration_seconds: 5400\ngist: Agreed the budget\nsummary_model: sonnet\n").replace("tldr: []", "tldr:\n- one\n- two");
  const rec = applyHead(recordFromEntry({ rel: "source/meetings/2026/10/a.md", size: text.length, mtimeMs: 0, placeholder: false }), text);
  const v = describeNote(rec, { rel: rec.rel, text, size: text.length, mtimeMs: 0, truncated: false });
  assert.equal(v.kind, "meeting");
  assert.equal(v.title, "Meeting 5");
  assert.deepEqual(v.meta.map((m) => m.label), ["Date", "Duration", "Platform", "Language", "Participants", "Summarised by"]);
  assert.equal(v.meta.find((m) => m.label === "Duration")!.value, "1h 30m");
  assert.equal(v.gist, "Agreed the budget");
  assert.deepEqual(v.tldr, ["one", "two"]);
  assert.equal(v.meeting!.transcript.length, 1);
  assert.ok(v.frontmatter.some((r) => r.key === "participants" && r.value === "Alice, Bob"));
  assert.equal(v.hasFrontmatter, true);
});

test("describeNote: llm-doc notes and plain markdown are rendered as markdown; txt as text; failures and truncation are noticed", () => {
  const note = (rel: string, text: string, truncated = false) => ({ rel, text, size: text.length, mtimeMs: 0, truncated });
  const doc = describeNote(undefined, note("llm-doc/meetings/x.md", "---\ntitle: Generated\nplatform: meet\n---\n## Transcript\n[10:00:00] **A**: x"));
  assert.equal(doc.kind, "meeting", "without a record, a transcript heading is enough");
  const rec = recordFromEntry({ rel: "llm-doc/meetings/x.md", size: 1, mtimeMs: 0, placeholder: false });
  assert.equal(describeNote(rec, note("llm-doc/meetings/x.md", "---\ntitle: G\nplatform: meet\n---\ntext")).kind, "markdown");
  const md = describeNote(undefined, note("a/b.md", "# Heading\n\ntext"));
  assert.equal(md.kind, "markdown");
  assert.equal(md.title, "b.md");
  assert.equal(md.hasFrontmatter, false);
  const txt = describeNote(undefined, note("source/emails/raw.txt", "---\nnot: frontmatter\n---\nraw"));
  assert.equal(txt.kind, "text");
  assert.equal(txt.body.startsWith("---"), true);
  const failed = describeNote(undefined, note("a.md", "---\ntitle: T\nsummary_model: failed\n---\nb", true));
  assert.equal(failed.notices.length, 2);
  assert.equal(failed.meta.some((m) => m.label === "Summarised by"), false);
});
