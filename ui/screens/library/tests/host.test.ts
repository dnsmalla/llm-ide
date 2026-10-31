import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotesHost, decodeHeads, decodeListPage, decodeReadChunk, NotesError, notesErrorText, toNotesError } from "../host.ts";

test("host errors become codes; the raw detail is never the UI text", () => {
  assert.equal(toNotesError("not_downloaded: the file is in iCloud").code, "not_downloaded");
  assert.equal(toNotesError("outside_root: path is outside the notes folder").code, "outside_root");
  assert.equal(toNotesError("something odd").code, "io");
  assert.equal(toNotesError(new Error('host command "notes_list" is not available outside the desktop app')).code, "unavailable");
  assert.equal(toNotesError(new NotesError("no_root")).code, "no_root");
  assert.equal(toNotesError(undefined).code, "io");
  for (const code of ["no_root", "invalid_root", "outside_root", "not_found", "not_downloaded", "too_large", "invalid_path", "io", "budget", "unavailable"] as const) {
    assert.ok(notesErrorText(code).length > 10);
    assert.ok(!notesErrorText(code).includes(":"), "no raw `code: detail` text");
  }
});

test("decoders are defensive about the host's shapes", () => {
  const page = decodeListPage({ entries: [{ rel: "a.md", size: 5, mtime_ms: 7, placeholder: true }, { rel: "", size: 1 }, null, { size: 1 }, { rel: "b.md" }], next_cursor: "b.md", visited: 3 });
  assert.deepEqual(page.entries, [{ rel: "a.md", size: 5, mtimeMs: 7, placeholder: true }, { rel: "b.md", size: 0, mtimeMs: 0, placeholder: false }]);
  assert.equal(page.nextCursor, "b.md");
  assert.equal(decodeListPage({ entries: [], next_cursor: null }).nextCursor, null);
  assert.deepEqual(decodeListPage("junk"), { entries: [], nextCursor: null, visited: 0 });
  assert.deepEqual(decodeReadChunk({ rel: "a.md", size: 3, mtime_ms: 1, offset: 0, text: "abc", next_offset: null }), { rel: "a.md", size: 3, mtimeMs: 1, offset: 0, text: "abc", nextOffset: null });
  const heads = decodeHeads([{ rel: "a.md", size: 1, mtime_ms: 2, head: "---\n", error: null }, { rel: "b.md", head: null, error: "not_downloaded: x" }, 5]);
  assert.equal(heads.length, 2);
  assert.equal(heads[1]!.error, "not_downloaded");
});

test("createNotesHost maps command names and arguments, and wraps failures", async () => {
  const calls: [string, unknown][] = [];
  const host = createNotesHost(async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "notes_read") throw "not_found: nope";
    if (cmd === "notes_root_get") return { name: "notes", root: "/Users/x/notes" } as T;
    return { entries: [], next_cursor: null } as T;
  });
  assert.deepEqual(await host.rootGet(), { name: "notes", root: "/Users/x/notes" });
  await host.list("c", 10);
  await assert.rejects(host.read("a.md", 0, 4096), (e: unknown) => e instanceof NotesError && e.code === "not_found");
  await host.heads(["a.md"], 2048);
  assert.deepEqual(calls.map((c) => c[0]), ["notes_root_get", "notes_list", "notes_read", "notes_heads"]);
  assert.deepEqual(calls[1]![1], { cursor: "c", limit: 10 });
  assert.deepEqual(calls[2]![1], { rel: "a.md", offset: 0, maxBytes: 4096 });
  // No write command is reachable through the typed host.
  assert.deepEqual(Object.keys(host).sort(), ["heads", "list", "read", "rootChoose", "rootClear", "rootGet"]);
});
