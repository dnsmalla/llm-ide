import { test } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_ROOTS, decodeProjectEntries, decodeProjectFile, projectSaveRequest, safeProjectPath } from "../project-files.ts";

test("the categories are the Mac Library's Code and Data", () => {
  assert.deepEqual(PROJECT_ROOTS.map((r) => r.path), ["code", "data"]);
});

test("paths are project-relative and entries sorted folders-first", () => {
  assert.equal(safeProjectPath("code/a.ts"), "code/a.ts");
  for (const bad of ["", "/abs", "code/../x", "a/\u0000"]) assert.equal(safeProjectPath(bad), null, bad);
  const out = decodeProjectEntries({ entries: [
    { name: "b.ts", path: "code/b.ts", kind: "file" },
    { name: "src", path: "code/src", kind: "dir" },
    { name: "a.ts", path: "code/a.ts", kind: "file" },
    { name: "h", path: "code/.h", kind: "file", hidden: true },
  ] });
  assert.deepEqual(out.map((e) => e.name), ["src", "a.ts", "b.ts"]);
});

test("the viewer only shows text reads", () => {
  assert.deepEqual(decodeProjectFile({ status: "ok", text: "x", size: 1, hash: "h", encoding: "utf-8", bom: false, eol: "lf", read_only: false }), { text: "x", bytes: 1, hash: "h", encoding: "utf-8", bom: false, eol: "lf", read_only: false });
  assert.equal(decodeProjectFile({ status: "ok", text: "x", size: 1, hash: "h", encoding: "unknown", read_only: false })?.read_only, true, "a lossy decode is never editable");
  assert.equal(decodeProjectFile({ status: "binary", text: null }), null);
  assert.equal(decodeProjectFile(null), null);
});

test("save keeps the read hash, encoding, BOM and EOL", () => {
  const b = decodeProjectFile({ status: "ok", text: "a\r\nb", size: 4, hash: "h", encoding: "utf-8", bom: true, eol: "crlf", read_only: false })!;
  assert.deepEqual(projectSaveRequest(b, "a\nb\n"), { text: "a\r\nb\r\n", expected_hash: "h", encoding: "utf-8", bom: true, force: false });
});

test("unsaved Code/Data edits ask before a note or section click closes the file view", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../LibraryScreen.tsx", import.meta.url), "utf8");
  // The store's select guard (note clicks, setSection) sees the file editor's unsaved state, not only the note's.
  assert.match(src, /if \(!dirtyRef\.current && !projectFileDirtyRef\.current\) return true;/);
  assert.match(src, /store\.hasUnsaved = write \? \(\) => dirtyRef\.current \|\| projectFileDirtyRef\.current : null;/);
  // A section click no longer clears the file view before asking.
  const onSection = src.slice(src.indexOf("onSection={(id) => {"), src.indexOf("onExtension={(id) => {"));
  assert.match(onSection, /if \(projectFileDirty\) setPendingNav\(\{ proceed: open \}\);/);
  assert.ok(onSection.indexOf("setProjectFile(null)") > onSection.indexOf("const open = () => {"), "the view closes only inside the guarded action");
  // Closing the view clears the flag, so a later click does not ask about edits that no longer exist.
  assert.match(src, /setProjectFile\(null\);\n    setProjectFileDirty\(false\);\n  \}, \[state\.selectedRel\]\);/);
});

import { countProjectFiles, decodeProjectPage } from "../project-files.ts";

const page = (names: string[], extra: Record<string, unknown> = {}) => ({ entries: names.map((n) => ({ name: n, path: `d/${n}`, kind: "file" })), ...extra });

test("decodeProjectPage keeps the host's total and says how many entries follow", () => {
  const p = decodeProjectPage(page(["a", "b"], { total: 5, next_offset: 2 }));
  assert.deepEqual({ total: p.total, nextOffset: p.nextOffset, remaining: p.remaining, n: p.entries.length }, { total: 5, nextOffset: 2, remaining: 3, n: 2 });
  const last = decodeProjectPage(page(["a"], { total: 1, next_offset: null }));
  assert.equal(last.remaining, 0);
  assert.equal(decodeProjectPage(null).remaining, 0);
});

test("the file count follows every page, so a folder over one page is not cut short", async () => {
  const all = Array.from({ length: 7 }, (_, i) => `f${i}`);
  const list = async (_dir: string, offset: number) => {
    const slice = all.slice(offset, offset + 3);
    return page(slice, { total: all.length, next_offset: offset + 3 < all.length ? offset + 3 : null });
  };
  assert.equal(await countProjectFiles(list, "d", () => false), 7);
});

test("a count walk that became stale stops listing", async () => {
  let calls = 0;
  let stale = false;
  const list = async (_dir: string, offset: number) => { calls += 1; stale = true; return page(["a", "b"], { total: 100, next_offset: offset + 2 }); };
  await countProjectFiles(list, "d", () => stale);
  assert.equal(calls, 1, "no further page is requested once the walk is stale");
});
