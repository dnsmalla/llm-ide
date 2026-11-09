import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addFilesToFolder,
  addSummary,
  candidateName,
  createFolder,
  pickReason,
  planRemove,
  projectEntryProblem,
  projectMutations,
  runRemove,
  validateEntryName,
  type Mutations,
  type PickedFile,
} from "../project-ops.ts";

// ---- removal paths ------------------------------------------------------------------------

test("removal refuses the project root, the category roots, paths outside Code/Data and anything inside .git", () => {
  const refused = ["", "code", "data", "/code/a.ts", "code/../x", "code//a", "code/a/", "docs/a.md", "codex/a", "code/.git", "code/.git/config", "code/x/.GIT/HEAD", "data/GIT~1/x", "code/a\u0000b", "code/.git./x"];
  for (const p of refused) assert.notEqual(projectEntryProblem(p), null, JSON.stringify(p));
  assert.equal(projectEntryProblem("code/src/a.ts"), null);
  assert.equal(projectEntryProblem("data/raw/2026/x.csv"), null);
});

test("planRemove refuses bad paths and otherwise names the item and says it goes to the Trash", () => {
  assert.equal(planRemove("code", "dir", 3).ok, false);
  const f = planRemove("code/a.ts", "file", null);
  assert.equal(f.ok, true);
  if (!f.ok) return;
  assert.equal(f.name, "a.ts");
  assert.match(f.message, /"a\.ts" will be moved to the Trash/);
  assert.match(f.message, /restore it from the Trash/);
  assert.match(f.message, /Nothing is deleted permanently/);
});

test("a folder plan says how many items it holds when the tree knows, and that everything inside goes too", () => {
  const known = planRemove("data/raw", "dir", 4);
  assert.ok(known.ok);
  if (known.ok) assert.match(known.message, /holds 4 items at its top level/);
  const unknown = planRemove("data/raw", "dir", null);
  assert.ok(unknown.ok);
  if (unknown.ok) {
    assert.doesNotMatch(unknown.message, /holds/);
    assert.match(unknown.message, /with everything inside it/);
  }
});

test("runRemove moves only the planned path to the trash and never anything else", async () => {
  const calls: string[] = [];
  const trash = async (p: string) => {
    calls.push(p);
  };
  const plan = planRemove("code/a.ts", "file", null);
  assert.deepEqual(await runRemove(plan, trash), { ok: true });
  assert.deepEqual(calls, ["code/a.ts"]);

  const refused = planRemove("code", "dir", null);
  assert.equal((await runRemove(refused, trash)).ok, false);
  assert.deepEqual(calls, ["code/a.ts"], "a refused plan never reaches the host");
});

test("runRemove shows the plain Trash message when the Trash is unavailable and deletes nothing", async () => {
  const trash = async () => {
    throw { code: "trash_unavailable", message: "no trash" };
  };
  const r = await runRemove(planRemove("code/a.ts", "file", null), trash);
  assert.deepEqual(r, { ok: false, message: "The system Trash is not available, so nothing was deleted." });
});

// ---- names --------------------------------------------------------------------------------

test("name validation table", () => {
  const ok = ["notes", "my folder", "a.b", "naïve", "x".repeat(255), ".env", "v1.2"];
  for (const n of ok) assert.equal(validateEntryName(n), null, n);
  const bad: [string, string][] = [
    ["", "empty"],
    ["   ", "blank"],
    [".", "dot"],
    ["..", "dot-dot"],
    ["..x", "leading dot-dot"],
    ["a/b", "slash"],
    ["a\\b", "backslash"],
    ["a\u0000b", "NUL"],
    ["a\nb", "newline"],
    ["a\u007fb", "DEL"],
    ["a‮b", "bidi override"],
    ["x".repeat(256), "too long"],
    ["é".repeat(128), "over 255 bytes"],
    [" lead", "leading space"],
    ["trail ", "trailing space"],
    ["end.", "trailing dot"],
    ["CON", "reserved"],
    ["con.txt", "reserved with extension"],
    ["COM1", "reserved COM"],
    ["lpt9.log", "reserved LPT"],
    [".git", "git dir"],
    [".GIT", "git dir any case"],
  ];
  for (const [n, why] of bad) assert.notEqual(validateEntryName(n), null, why);
});

test("candidate names: the name, then 'stem n.ext' (dotfiles and extension-less names get the suffix at the end)", () => {
  assert.equal(candidateName("report.txt", 0), "report.txt");
  assert.equal(candidateName("report.txt", 1), "report 1.txt");
  assert.equal(candidateName("report.txt", 2), "report 2.txt");
  assert.equal(candidateName("archive.tar.gz", 1), "archive.tar 1.gz");
  assert.equal(candidateName("README", 1), "README 1");
  assert.equal(candidateName(".env", 1), ".env 1");
});

// ---- add file -----------------------------------------------------------------------------

/** An in-memory project: create refuses existing names with code "exists", like the host. */
function fakeProject(opts: { picks?: PickedFile[]; bytes?: Record<string, Uint8Array>; failWrite?: boolean } = {}) {
  const files = new Map<string, string>();
  const released: string[] = [];
  const trashed: string[] = [];
  const bytes = opts.bytes ?? {};
  const m: Mutations = {
    async pick() {
      return { files: opts.picks ?? [], rejected: [] };
    },
    async read(handle, offset, len) {
      const b = bytes[handle] ?? new Uint8Array();
      return b.slice(offset, offset + len);
    },
    async release(handle) {
      released.push(handle);
    },
    async create() {
      throw Object.assign(new Error("x"), { code: "unexpected" }); // adding files never creates a placeholder
    },
    async writeNew(path, text) {
      if (opts.failWrite) throw { code: "io", message: "disk" };
      if (files.has(path)) throw { code: "exists", message: "exists" };
      files.set(path, text);
    },
    async trash(path) {
      trashed.push(path);
      files.delete(path);
    },
  };
  return { m, files, released, trashed };
}

const picked = (handle: string, name: string, size: number): PickedFile => ({ handle, name, size });
const utf8 = (s: string) => new TextEncoder().encode(s);

test("add file: a text file is written into the folder, the handle is released, the next free name is used on a clash", async () => {
  const p = fakeProject({ picks: [picked("h1", "report.txt", 5), picked("h2", "report.txt", 3)], bytes: { h1: utf8("hello"), h2: utf8("two") } });
  p.files.set("code/report.txt", "existing");
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "report.txt", 5), picked("h2", "report.txt", 3)]);
  assert.deepEqual(r.added, ["code/report 1.txt", "code/report 2.txt"]);
  assert.equal(p.files.get("code/report.txt"), "existing", "an existing file is never overwritten");
  assert.equal(p.files.get("code/report 1.txt"), "hello");
  assert.equal(p.files.get("code/report 2.txt"), "two");
  assert.deepEqual(p.released.sort(), ["h1", "h2"]);
});

test("add file: binary, NUL-containing, bad-name and oversized picks are skipped with a reason and nothing is created", async () => {
  const p = fakeProject({
    bytes: { bin: new Uint8Array([0xff, 0xfe, 0x00, 0x01]), nul: utf8("a\u0000b") },
    picks: [picked("bin", "x.png", 4), picked("nul", "n.txt", 3), picked("bad", "a/b.txt", 1), picked("big", "big.txt", 26 * 1024 * 1024)],
  });
  const r = await addFilesToFolder(p.m, "data", [picked("bin", "x.png", 4), picked("nul", "n.txt", 3), picked("bad", "a/b.txt", 1), picked("big", "big.txt", 26 * 1024 * 1024)]);
  assert.deepEqual(r.added, []);
  assert.equal(r.skipped.length, 4);
  assert.equal(p.files.size, 0);
  assert.match(r.skipped[0]!.reason, /Only text files/);
  assert.match(r.skipped[2]!.reason, /Names cannot contain/);
  assert.match(r.skipped[3]!.reason, /25 MB/);
  assert.deepEqual(p.released.sort(), ["bad", "big", "bin", "nul"], "every handle is released, including skipped ones");
});

test("add file: a failed write leaves nothing behind and never moves anything to the Trash", async () => {
  const p = fakeProject({ picks: [picked("h1", "a.txt", 2)], bytes: { h1: utf8("hi") }, failWrite: true });
  p.files.set("code/b.txt", "user work");
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "a.txt", 2)]);
  assert.deepEqual(r.added, []);
  assert.match(r.skipped[0]!.reason, /Nothing was added/);
  assert.deepEqual(p.trashed, []);
  assert.deepEqual([...p.files], [["code/b.txt", "user work"]]);
});

test("add file: a file that changed size after the pick (short read) is refused, not truncated", async () => {
  const p = fakeProject({ bytes: { h1: utf8("hel") } });
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "a.txt", 5)]);
  assert.deepEqual(r.added, []);
  assert.match(r.skipped[0]!.reason, /changed while it was being read/);
  assert.equal(p.files.size, 0);
});

test("add file: BOM, CRLF and non-ASCII text are passed through unchanged; invalid UTF-8 is refused", async () => {
  const p = fakeProject({ bytes: { h1: new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xc3, 0xa9]), h2: new Uint8Array([0x61, 0x81]) } });
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "a.txt", 8), picked("h2", "b.txt", 2)]);
  assert.deepEqual(r.added, ["code/a.txt"]);
  assert.deepEqual([...new TextEncoder().encode(p.files.get("code/a.txt")!)], [0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xc3, 0xa9]);
  // 0x81 at the end is an incomplete sequence in both UTF-8 and Shift-JIS, so the file is still refused.
  assert.match(r.skipped[0]!.reason, /Only text files/);
});

test("add file: a Shift-JIS (CP932) CSV is accepted and stored as UTF-8; binary bytes are still refused", async () => {
  // "名" + ideographic space + "日本語" + LF, in Shift-JIS.
  const sjis = new Uint8Array([0x96, 0xbc, 0x81, 0x40, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
  const p = fakeProject({ bytes: { h1: sjis, h2: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) } });
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "list.csv", sjis.length), picked("h2", "x.bin", 4)]);
  assert.deepEqual(r.added, ["code/list.csv"]);
  assert.equal(p.files.get("code/list.csv"), "名　日本語\n");
  assert.deepEqual(r.notes, [{ name: "list.csv", note: "converted from Shift-JIS to UTF-8" }]);
  assert.match(r.skipped[0]!.reason, /Only text files/);
});

test("add file: a Latin-1 file that Shift-JIS would decode ('café au lait') is refused, not stored as mojibake", async () => {
  // 0xE9 followed by a space is not a valid Shift-JIS pair, so the file fails in both decoders.
  const latin1 = new Uint8Array([...utf8("caf"), 0xe9, ...utf8(" au lait")]);
  const p = fakeProject({ bytes: { h1: latin1 } });
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "cafe.txt", latin1.length)]);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.notes, []);
  assert.equal(p.files.size, 0);
  assert.match(r.skipped[0]!.reason, /Only text files/);
});

test("add file: plain UTF-8 adds no conversion note", async () => {
  const p = fakeProject({ bytes: { h1: utf8("日本語 text") } });
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "memo.txt", 14)]);
  assert.deepEqual(r.added, ["code/memo.txt"]);
  assert.deepEqual(r.notes, []);
});

test("the add summary mentions a conversion note alongside the added and skipped files", () => {
  const text = addSummary(["code/list.csv"], [], [{ name: "list.csv", note: "converted from Shift-JIS to UTF-8" }]);
  assert.equal(text, "Added 1 file: code/list.csv. list.csv: converted from Shift-JIS to UTF-8.");
  assert.equal(addSummary(["code/list.csv"], [{ name: "x.png", reason: "r" }], []), "Added 1 file: code/list.csv. Skipped 1: x.png (r).");
});

test("add file: the free-name search is bounded", async () => {
  const p = fakeProject({ bytes: { h1: utf8("x") } });
  p.files.set("code/a.txt", "");
  for (let n = 1; n < 1000; n++) p.files.set(`code/a ${n}.txt`, "");
  const r = await addFilesToFolder(p.m, "code", [picked("h1", "a.txt", 1)]);
  assert.match(r.skipped[0]!.reason, /No free name/);
  assert.equal(p.files.size, 1000);
});

test("add file: the target folder must be inside Code or Data (the project root and .git are refused)", async () => {
  const p = fakeProject({ picks: [picked("h1", "a.txt", 1)], bytes: { h1: utf8("a") } });
  await assert.rejects(addFilesToFolder(p.m, "", [picked("h1", "a.txt", 1)]));
  await assert.rejects(addFilesToFolder(p.m, "code/.git", [picked("h1", "a.txt", 1)]));
  assert.equal(p.files.size, 0);
});

// ---- add folder ---------------------------------------------------------------------------

test("add folder creates one EMPTY folder inside the target with the typed name, refusing bad names before any host call", async () => {
  const made: string[] = [];
  const create = async (path: string, kind: "file" | "dir") => {
    made.push(`${kind}:${path}`);
    return path;
  };
  assert.equal(await createFolder(create, "code/src", "lib"), "code/src/lib");
  assert.deepEqual(made, ["dir:code/src/lib"]);
  await assert.rejects(createFolder(create, "code", "../x"));
  await assert.rejects(createFolder(create, "code", "CON"));
  assert.equal(made.length, 1, "a refused name makes no host call");
});

test("add folder reports an existing name in plain words", async () => {
  const create = async () => {
    throw { code: "exists", message: "exists" };
  };
  await assert.rejects(createFolder(create, "code", "src"), (e: Error) => /already exists/.test(e.message));
});

test("the add summary names what was added and what was skipped, and why", () => {
  assert.equal(addSummary(["code/a.txt"], []), "Added 1 file: code/a.txt.");
  assert.equal(addSummary([], []), "No files were added.");
  assert.equal(addSummary(["code/a.txt", "code/b.txt"], [{ name: "x.png", reason: "Only text files can be added here yet." }]), "Added 2 files. Skipped 1: x.png (Only text files can be added here yet.).");
});

test("the host wrapper removes only through fs_delete (trash) and writes only as a no-replace create", async () => {
  const calls: [string, unknown][] = [];
  const m = projectMutations(async (cmd, args) => {
    calls.push([cmd, args]);
    return cmd === "attach_read" ? new Uint8Array([1]) : cmd === "attach_pick_files" ? { files: [], rejected: [] } : "p";
  });
  await m.pick();
  await m.read("h", 0, 1);
  await m.release("h");
  await m.create("code/d", "dir");
  await m.writeNew("code/a.txt", "x");
  await m.trash("code/a.txt");
  assert.deepEqual(calls.map(([c]) => c), ["attach_pick_files", "attach_read", "attach_release", "fs_create", "fs_write_file", "fs_delete"]);
  const write = (calls[4]![1] as { req: Record<string, unknown> }).req;
  assert.equal(write.expected_hash, null, "no expected hash: the host refuses to replace an existing file");
  assert.equal(write.force, false);
  assert.deepEqual(calls[5]![1], { path: "code/a.txt" });
});

test("host pick rejections are shown in plain words, never as codes", () => {
  assert.equal(pickReason("too_large"), "larger than 25 MB");
  assert.equal(pickReason("whatever_new"), "could not be added");
});
