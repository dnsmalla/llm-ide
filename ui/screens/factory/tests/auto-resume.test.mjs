import { test } from "node:test";
import assert from "node:assert/strict";
import { _resetAutoResumeForTests, autoResumeOnce, storedPendingRunIds } from "../auto-resume.ts";
import { memFs } from "./mem-fs.mjs";

const item = (key = "issue:2", runIds = ["r1"]) => ({ key, source: "issue", id: key.slice(6), title: "Colorful buttons", body: "", repo: "g/p", provider: "gitlab", addedAt: "2026-11-12T00:00:00.000Z", runIds });
const MARK = "system/loop-worktrees/r1/.factory/RUN.json";
const marker = (over = {}) => JSON.stringify({ runId: "r1", mode: "full", startedAt: "2026-11-12T09:00:00.000Z", ...over });

function project({ items = [item()], record = null, withMarker = true, plan = true } = {}) {
  const files = {
    "system/factory/items.json": JSON.stringify({ schemaVersion: 1, items }),
  };
  if (withMarker) files[MARK] = marker();
  if (plan) files["system/loop-worktrees/r1/.factory/PLAN.md"] = "plan";
  if (record) {
    files["system/loop-runs/index-2026-11.jsonl"] = JSON.stringify({ id: "e1", startedAt: "2026-11-12T08:00:00.000Z", factoryRunId: "r1" }) + "\n";
    files["system/loop-runs/2026-11/e1.json"] = JSON.stringify({ worktree: { runId: "r1", branch: "factory/r1", baseCommit: "a", repo: "/p/code/p" }, factoryMode: "full", ...record });
  }
  return memFs(files);
}

function deps(fs, over = {}) {
  _resetAutoResumeForTests();
  const started = [];
  const notices = [];
  const stored = { ids: {} };
  return {
    started, notices, stored,
    d: {
      projectRoot: () => "/p",
      fs: () => fs,
      worktrees: async () => new Map([["r1", { runId: "r1", worktree: "/p/system/loop-worktrees/r1" }]]),
      live: () => [],
      localSpawnedCore: () => true,
      loopIsManualOnly: async () => false,
      changedFiles: async () => 3,
      start: (root, it, mode, opts) => { started.push({ root, key: it.key, mode, runId: opts?.runId, recorded: { ...stored.ids } }); return opts?.runId ?? "new"; },
      readResumed: () => stored.ids,
      writeResumed: (ids) => { stored.ids = { ...ids }; return true; },
      notice: (m) => notices.push(m),
      ...over,
    },
  };
}

test("an interrupted card with written work resumes as a check run on its own worktree, id recorded first", async () => {
  const w = deps(project());
  assert.equal(await autoResumeOnce(w.d), 1);
  assert.equal(w.started.length, 1);
  assert.deepEqual([w.started[0].mode, w.started[0].runId], ["check", "r1"]);
  assert.deepEqual(w.started[0].recorded, { r1: true }, "persisted BEFORE start");
  assert.match(w.notices[0], /Colorful buttons/);
});

test("nothing written yet: resumes as a full run (the downgrade)", async () => {
  const w = deps(project(), { changedFiles: async () => 0 });
  assert.equal(await autoResumeOnce(w.d), 1);
  assert.equal(w.started[0].mode, "full");
});

test("once per run id: a second call, a fresh process with the same storage and a throwing start all start nothing more", async () => {
  const w = deps(project());
  await autoResumeOnce(w.d);
  assert.equal(await autoResumeOnce(w.d), 0);
  _resetAutoResumeForTests();
  assert.equal(await autoResumeOnce(w.d), 0);
  assert.equal(w.started.length, 1);
  const t = deps(project(), { start: () => { throw new Error("declined"); } });
  assert.equal(await autoResumeOnce(t.d), 0, "never throws");
  assert.deepEqual(t.stored.ids, { r1: true });
  assert.equal(await autoResumeOnce(t.d), 0);
});

test("a declined approval (marker stays, run fails) is not retried", async () => {
  const w = deps(project());
  await autoResumeOnce(w.d);
  assert.equal(await autoResumeOnce(w.d), 0);
});

const NEGATIVES = {
  "a live run for the item": [project(), { live: () => [{ runId: "r1", itemKey: "issue:2", projectRoot: "/p" }] }],
  "no marker": [project({ withMarker: false }), {}],
  "a marker with a later finished record": [project({ record: { statusCode: "success", endedAt: "2026-11-12T10:00:00.000Z" } }), {}],
  "an awaiting_review record": [project({ record: { statusCode: "awaiting_review", endedAt: "2026-11-12T08:30:00.000Z" } }), {}],
  "a failed record with no marker": [project({ withMarker: false, record: { statusCode: "failed", endedAt: "2026-11-12T10:00:00.000Z" } }), {}],
  "a blocked record with no marker": [project({ withMarker: false, record: { statusCode: "blocked.repair_out_of_scope", endedAt: "2026-11-12T10:00:00.000Z" } }), {}],
  "an adopted, remote or SSH core": [project(), { localSpawnedCore: () => false }],
  "a manual-only loop": [project(), { loopIsManualOnly: async () => true }],
  "a discarded item": [project({ items: [] }), {}],
  "no open project": [project(), { projectRoot: () => null }],
  "a marker of another run id": [project({ items: [item("issue:2", ["r0", "r1"])] }), { worktrees: async () => new Map([["r1", { runId: "r1", worktree: "/p/system/loop-worktrees/r1" }]]) }],
  "a marker without startedAt": [project(), {}],
  "a finished record without endedAt": [project({ record: { statusCode: "success" } }), {}],
  "unreadable once-per-run storage (null)": [project(), { readResumed: () => null }],
  "unreadable once-per-run storage (throws)": [project(), { readResumed: () => { throw new Error("storage"); } }],
  "a failed write of the once-per-run id": [project(), { writeResumed: () => false }],
  "a finished record still pending for this run": [project(), { pendingRunIds: () => new Set(["r1"]) }],
};
for (const [name, [fs, over]] of Object.entries(NEGATIVES)) {
  test(`no auto-resume for ${name}`, async () => {
    if (name === "a marker of another run id") fs.put(MARK, marker({ runId: "r0" }));
    if (name === "a marker without startedAt") fs.put(MARK, JSON.stringify({ runId: "r1" }));
    const w = deps(fs, over);
    assert.equal(await autoResumeOnce(w.d), 0);
    assert.equal(w.started.length, 0);
    assert.deepEqual(w.stored.ids, {});
  });
}

test("storedPendingRunIds: a held record's run id and a marker:<runId> entry both block", () => {
  const data = JSON.stringify([
    { projectRoot: "/p", entry: { id: "e1" }, record: { worktree: { runId: "r1" } }, copy: null, marker: "m" },
    { projectRoot: "/p", entry: { id: "marker:r2" }, record: {}, copy: null, marker: "m", markerOnly: true },
    { projectRoot: "/other", entry: { id: "marker:r3" }, record: {}, copy: null, marker: "m", markerOnly: true },
  ]);
  globalThis.localStorage = { getItem: () => data, setItem() {} };
  try {
    assert.deepEqual([...storedPendingRunIds("/p")].sort(), ["r1", "r2"]);
  } finally { delete globalThis.localStorage; }
});

for (const mode of ["full", "continue", "check"]) {
  test(`a ${mode} marker is auto-resumed`, async () => {
    const fs = memFs({ "system/factory/items.json": JSON.stringify({ schemaVersion: 1, items: [item()] }), [MARK]: marker({ mode }), "system/loop-worktrees/r1/.factory/PLAN.md": "plan" });
    const w = deps(fs);
    assert.equal(await autoResumeOnce(w.d), 1);
    assert.equal(w.started[0].mode, "check");
  });
}

test("an intakeOnly marker resumes as intakeOnly, never as a full run", async () => {
  const fs = memFs({ "system/factory/items.json": JSON.stringify({ schemaVersion: 1, items: [item()] }), [MARK]: marker({ mode: "intakeOnly" }) });
  const w = deps(fs, { changedFiles: async () => 0 });
  assert.equal(await autoResumeOnce(w.d), 1);
  assert.deepEqual([w.started[0].mode, w.started[0].runId], ["intakeOnly", "r1"]);
});

for (const mode of ["humanReview", "sendBack", "rework", "mystery", undefined]) {
  test(`a ${mode} marker is left on the card and not recorded as resumed`, async () => {
    const m = JSON.parse(marker()); if (mode === undefined) delete m.mode; else m.mode = mode;
    const fs = memFs({ "system/factory/items.json": JSON.stringify({ schemaVersion: 1, items: [item()] }), [MARK]: JSON.stringify(m), "system/loop-worktrees/r1/.factory/PLAN.md": "plan" });
    const w = deps(fs);
    assert.equal(await autoResumeOnce(w.d), 0);
    assert.equal(w.started.length, 0);
    assert.deepEqual(w.stored.ids, {});
  });
}
