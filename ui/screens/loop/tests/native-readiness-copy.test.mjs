import { test } from "node:test";
import assert from "node:assert/strict";
import { copyReadiness, readinessCopyPath } from "../native/readiness-copy.ts";

function memFs(files = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set(["llm-doc"]);
  const writes = [];
  return {
    map, dirs, writes,
    async read(path) {
      if (!map.has(path)) throw Object.assign(new Error("missing"), { code: "not_found" });
      return { status: "ok", text: map.get(path), hash: "h" };
    },
    async create(path) {
      if (dirs.has(path)) throw Object.assign(new Error("exists"), { code: "exists" });
      dirs.add(path);
      return path;
    },
    async write(path, text, opts) { writes.push({ path, text, opts }); map.set(path, text); return { path, hash: "h2" }; },
  };
}

const at = new Date("2026-03-05T10:00:00Z");

test("readinessCopyPath zero-pads the month", () => {
  assert.equal(readinessCopyPath("r1", at), "llm-doc/factory/2026/03/r1-readiness.md");
  assert.equal(readinessCopyPath("r2", new Date("2026-11-30T12:00:00Z")), "llm-doc/factory/2026/11/r2-readiness.md");
});

test("copyReadiness returns false when READINESS.md is absent", async () => {
  const fs = memFs();
  assert.equal(await copyReadiness(fs, "system/loop-worktrees/r1", "r1", at), false);
  assert.equal(fs.writes.length, 0);
  assert.equal(fs.dirs.size, 1, "no folder is created for nothing");
});

test("copyReadiness copies the report and creates the month folders", async () => {
  const fs = memFs({ "system/loop-worktrees/r1/.factory/READINESS.md": "## Scope\nVerdict: ready\n" });
  assert.equal(await copyReadiness(fs, "system/loop-worktrees/r1", "r1", at), true);
  assert.deepEqual(fs.writes.map((w) => [w.path, w.text, w.opts.expected_hash]), [["llm-doc/factory/2026/03/r1-readiness.md", "## Scope\nVerdict: ready\n", null]]);
  for (const d of ["llm-doc", "llm-doc/factory", "llm-doc/factory/2026", "llm-doc/factory/2026/03"]) assert.ok(fs.dirs.has(d), d);
});

test("copyReadiness reads the project root when the prefix is empty", async () => {
  const fs = memFs({ ".factory/READINESS.md": "Verdict: needs-decision\n" });
  assert.equal(await copyReadiness(fs, "", "r3", at), true);
  assert.equal(fs.writes[0].path, "llm-doc/factory/2026/03/r3-readiness.md");
});
