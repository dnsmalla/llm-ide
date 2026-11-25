import { test } from "node:test";
import assert from "node:assert/strict";
import * as h from "../native/history.ts";

test("Loop journal index is read newest-first, month-rotated before legacy", async () => {
  const files = {
    "system/loop-runs/index-2026-09.jsonl": JSON.stringify({ id: "r1", startedAt: "2026-09-30T00:00:00Z", loopId: "l", loopName: "L", statusCode: "success" }) + "\n",
    "system/loop-runs/index.jsonl": JSON.stringify({ id: "r2", startedAt: "2026-08-01T00:00:00Z", loopId: "l", loopName: "L", statusCode: "failed" }) + "\n",
  };
  const fs = {
    async list(path) { assert.equal(path, "system/loop-runs"); return { entries: Object.keys(files).map((p) => ({ name: p.split("/").pop(), path: p })) }; },
    async read(path) { return { status: "ok", text: files[path] }; },
  };
  const runs = await h.readRecentRuns(fs);
  assert.deepEqual(runs.map((r) => r.id), ["r1", "r2"]);
  assert.equal((await h.readRecentRuns({ async list() { throw Object.assign(new Error("x"), { code: "missing" }); }, async read() { throw new Error("no"); } })).length, 0);
});

test("a native run appends a month-bucketed record and index line", async () => {
  const writes = [];
  const fs = {
    async create() { return "dir"; },
    async read() { throw Object.assign(new Error("missing"), { code: "missing" }); },
    async write(path, text, opts) { writes.push({ path, text, opts }); return { path, hash: "h" }; },
  };
  await h.appendRunRecord(fs, { id: "r1", loopId: "l", loopName: "L", startedAt: "2026-09-30T00:00:00Z", durationSeconds: 1, iterationsUsed: 1, statusCode: "success", statusSummary: "ok", trigger: "manual" }, { id: "r1" });
  assert.equal(writes[0].path, "system/loop-runs/2026-09/r1.json");
  assert.equal(writes[1].path, "system/loop-runs/index-2026-09.jsonl");
  assert.match(writes[1].text, /"id":"r1"/);
  assert.equal(writes[1].opts.expected_hash, null);
});

test("a run record is read from its month bucket", async () => {
  const fs = { async read(path) { assert.equal(path, "system/loop-runs/2026-09/r9.json"); return { status: "ok", text: '{"id":"r9","statusCode":"success"}' }; } };
  const r = await h.loadRunRecord(fs, "r9", "2026-09-30T01:02:03Z");
  assert.equal(r.statusCode, "success");
  assert.equal(await h.loadRunRecord({ async read() { throw new Error("no"); } }, "r9", "2026-09-30T01:02:03Z"), null);
});

test("a run record path is the month bucket its index entry names", async () => {
  const { runRecordPath } = await import("../native/history.ts");
  assert.equal(runRecordPath("abc", "2026-03-15T12:00:00Z"), "system/loop-runs/2026-03/abc.json");
});

function journalFs() {
  const files = new Map();
  const writes = [];
  return {
    files, writes,
    async create() { return "dir"; },
    async read(path) {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "not_found" });
      return { status: "ok", text: files.get(path), hash: `h-${path}` };
    },
    async write(path, text, opts) { writes.push({ path, opts }); files.set(path, text); return { path, hash: "h2" }; },
  };
}

const factoryEntry = { id: "r1", loopId: "l", loopName: "Factory", startedAt: "2026-11-09T10:00:00Z", durationSeconds: 5, iterationsUsed: 1, statusCode: "failed", statusSummary: "needs decision: see .factory/READINESS.md", trigger: "manual" };

test("run record keeps factory fields through the journal round trip", async () => {
  const fs = journalFs();
  const fields = {
    workItem: { source: "issue", id: "12", title: "Fix login" },
    worktree: { runId: "20261109-100000-abc123", branch: "factory/20261109-100000-abc123", baseCommit: "0123456789abcdef", repo: "/p/code/web" },
    ship: null,
    needsDecision: "needs decision: see .factory/READINESS.md",
    diffSummary: { files: ["src/a.ts"], truncated: false, patchId: "e".repeat(64) },
  };
  await h.appendRunRecord(fs, factoryEntry, { ...factoryEntry, ...fields });
  assert.deepEqual(h.decodeFactoryFields(await h.loadRunRecord(fs, "r1", factoryEntry.startedAt)), fields);

  const ship = { provider: "gitlab", url: "https://gitlab.com/g/p/-/merge_requests/3", commit: "abc123", reused: false };
  assert.equal(await h.setRunRecordShip(fs, factoryEntry, ship), true);
  const path = h.runRecordPath("r1", factoryEntry.startedAt);
  assert.equal(fs.writes.at(-1).path, path);
  assert.equal(fs.writes.at(-1).opts.expected_hash, `h-${path}`, "the update is a compare-and-set on the read hash");
  const after = h.decodeFactoryFields(await h.loadRunRecord(fs, "r1", factoryEntry.startedAt));
  assert.deepEqual(after.ship, ship);
  assert.deepEqual(after.workItem, fields.workItem, "the other fields survive the ship update");
});

test("factory fields decode to null for a plain run and for malformed values", async () => {
  const empty = { workItem: null, worktree: null, ship: null, needsDecision: null, diffSummary: null };
  assert.deepEqual(h.decodeFactoryFields(null), empty);
  assert.deepEqual(h.decodeFactoryFields({ id: "r9", statusCode: "success" }), empty);
  assert.deepEqual(h.decodeFactoryFields({
    workItem: { source: "evil", title: "x" },
    worktree: { runId: "r", branch: 3 },
    ship: { provider: "bitbucket", url: "u", commit: "c" },
    needsDecision: 7,
    diffSummary: { files: "nope" },
  }), empty);
  assert.deepEqual(h.decodeFactoryFields({ diffSummary: { files: ["a", 2], truncated: "yes" } }).diffSummary, { files: ["a"], truncated: false, patchId: null });
  assert.equal(h.decodeFactoryFields({ diffSummary: { files: [], truncated: false, patchId: "short" } }).diffSummary.patchId, null);
  assert.equal(await h.setRunRecordShip(journalFs(), factoryEntry, { provider: "github", url: "u", commit: "c", reused: false }), false, "a missing record is not created");
});

test("R-050: a ship override is recorded with rule, file, line and time", () => {
  const f = h.decodeFactoryFields({ ship: { provider: "github", url: "https://github.com/o/r/pull/1", commit: "abc", reused: false, secretOverride: { rule: "GitHub token", file: "src/a.ts", line: 2, at: "2026-11-10T09:00:00.000Z" } } });
  assert.deepEqual(f.ship.secretOverride, { rule: "GitHub token", file: "src/a.ts", line: 2, at: "2026-11-10T09:00:00.000Z" });
});

// A fs like workspace-core: create is NOT recursive (not_found when the parent is missing, exists when present).
function strictFs(dirs) {
  const files = new Map();
  const miss = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    async create(p) { const parent = p.split("/").slice(0, -1).join("/"); if (dirs.has(p)) throw miss("exists"); if (parent && !dirs.has(parent)) throw miss("not_found"); dirs.add(p); return "dir"; },
    async read(p) { if (!files.has(p)) throw miss("not_found"); return { status: "ok", text: files.get(p), hash: "h" }; },
    async write(p, text) { const parent = p.split("/").slice(0, -1).join("/"); if (parent && !dirs.has(parent)) throw miss("not_found"); files.set(p, text); return { path: p, hash: "h" }; },
  };
}
const ENTRY = { id: "r1", loopId: "l", loopName: "L", startedAt: "2026-09-30T12:00:00Z", durationSeconds: 1, iterationsUsed: 1, statusCode: "success", statusSummary: "ok", trigger: "manual" };

test("appendRunRecord creates system/loop-runs when only system exists", async () => {
  const fs = strictFs(new Set(["system"]));
  await h.appendRunRecord(fs, ENTRY, { id: "r1" });
  assert.ok(fs.files.has("system/loop-runs/2026-09/r1.json"));
  assert.match(fs.files.get("system/loop-runs/index-2026-09.jsonl"), /"id":"r1"/);
});

test("appendRunRecord creates every missing folder when nothing exists", async () => {
  const fs = strictFs(new Set());
  await h.appendRunRecord(fs, ENTRY, { id: "r1" });
  assert.ok(fs.files.has("system/loop-runs/2026-09/r1.json"));
});

// A fs with hash-checked writes: expected_hash null = create-only (exists), a stale hash = conflict, force overwrites.
function hashFs(opts = {}) {
  const dirs = new Set(["system", "system/loop-runs", "system/loop-runs/2026-09"]);
  const files = new Map();
  let version = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    async create(p) { if (dirs.has(p)) throw err("exists"); dirs.add(p); return "dir"; },
    async read(p) { if (!files.has(p)) throw err("not_found"); return { status: "ok", text: files.get(p).text, hash: files.get(p).hash }; },
    async write(p, text, o = {}) {
      if (opts.beforeWrite) await opts.beforeWrite(p);
      const cur = files.get(p);
      if (!o.force) {
        if (cur && (o.expected_hash === null || o.expected_hash === undefined)) throw err("exists");
        if (cur && o.expected_hash !== cur.hash) throw err("conflict");
        if (!cur && o.expected_hash) throw err("conflict");
      }
      files.set(p, { text, hash: `h${++version}` });
      return { path: p, hash: `h${version}` };
    },
  };
}

test("a retry after the index write failed once leaves one record and one index line", async () => {
  const fs = hashFs();
  const realWrite = fs.write;
  let failed = false;
  fs.write = async (p, t, o) => { if (p.endsWith(".jsonl") && !failed) { failed = true; throw new Error("disk"); } return realWrite(p, t, o); };
  await assert.rejects(h.appendRunRecord(fs, ENTRY, { id: "r1" }), /disk/);
  await h.appendRunRecord(fs, ENTRY, { id: "r1" });
  await h.appendRunRecord(fs, ENTRY, { id: "r1" });
  const idx = fs.files.get("system/loop-runs/index-2026-09.jsonl").text.trim().split("\n");
  assert.equal(idx.length, 1);
  assert.ok(fs.files.has("system/loop-runs/2026-09/r1.json"));
});

test("two concurrent appends for the same month keep both index lines", async () => {
  let gate;
  const both = new Promise((r) => { gate = r; });
  let n = 0;
  const fs = hashFs({ beforeWrite: async (p) => { if (p.endsWith(".jsonl") && n++ < 2) { if (n === 2) gate(); await both; } } });
  await Promise.all([
    h.appendRunRecord(fs, { ...ENTRY, id: "a1" }, { id: "a1" }),
    h.appendRunRecord(fs, { ...ENTRY, id: "b1" }, { id: "b1" }),
  ]);
  const ids = fs.files.get("system/loop-runs/index-2026-09.jsonl").text.trim().split("\n").map((l) => JSON.parse(l).id).sort();
  assert.deepEqual(ids, ["a1", "b1"]);
});

test("a retry never overwrites a record the first attempt already wrote", async () => {
  const fs = hashFs();
  await fs.write("system/loop-runs/2026-09/r1.json", "FULL RECORD", { expected_hash: null });
  await h.appendRunRecord(fs, ENTRY, { id: "r1", truncated: true });
  assert.equal(fs.files.get("system/loop-runs/2026-09/r1.json").text, "FULL RECORD");
  assert.match(fs.files.get("system/loop-runs/index-2026-09.jsonl").text, /"id":"r1"/);
});

test("an index read that fails for a reason other than not found is rethrown, not retried as a new index", async () => {
  const fs = hashFs();
  let reads = 0;
  const realRead = fs.read;
  fs.read = async (p) => { if (p.endsWith(".jsonl")) { reads++; throw Object.assign(new Error("permission denied"), { code: "io" }); } return realRead(p); };
  await assert.rejects(h.appendRunRecord(fs, ENTRY, { id: "r1" }), /permission denied/);
  assert.equal(reads, 1);
});
