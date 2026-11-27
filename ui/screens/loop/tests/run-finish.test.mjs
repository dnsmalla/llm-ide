import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunEntryAndRecord, finishLoopRun } from "../native/run-finish.ts";
import { factoryLoop, initialProjectStore } from "../native/templates.ts";

const store = initialProjectStore("npm test");
const plain = { ...store.loops.find((l) => l.defaultKey === "refactor"), config: { ...store.loops.find((l) => l.defaultKey === "refactor").config, openMergeRequest: true, reviewMode: "auto" } };
const humanLoop = { ...plain, config: { ...plain.config, reviewMode: "human", finalReview: "human" } };
const factory = factoryLoop("npm test");
const info = { runId: "r1", project: "/p", repo: "", worktree: "/p/system/loop-worktrees/r1", branch: "loop/x", baseCommit: "abc" };
const passed = { passed: true, iterationsUsed: 1, stages: [], iterations: [], failedStage: null, statusSummary: "All good." };
const failed = { ...passed, passed: false, statusSummary: "Verify failed." };

const input = (over = {}) => ({
  id: "id1", loop: plain, outcome: passed, startedAt: "2026-01-01T00:00:00.000Z", durationSeconds: 3, endedAt: "2026-01-01T00:00:03.000Z", trigger: "manual",
  activeRun: info, start: null, end: "ship", heldReason: "human", mergedMr: null, changedPaths: ["a.ts"], summaryPath: "llm-doc/loop/runs/x/run.md", needsDecision: null, diffSummary: null, gitRoot: "/p/wt", ...over,
});

test("passed run that ships: success, plain summary, no held fields", () => {
  const { entry, record } = buildRunEntryAndRecord(input());
  assert.equal(entry.statusCode, "success");
  assert.equal(entry.statusSummary, "All good.");
  assert.equal(entry.factoryRunId, undefined);
  assert.equal(record.awaiting, undefined);
  assert.equal(record.gitRoot, "/p/wt");
  assert.deepEqual(record.worktree, { runId: "r1", branch: "loop/x", baseCommit: "abc", repo: "" });
  assert.equal(record.ship, null);
  assert.equal(record.summaryPath, "llm-doc/loop/runs/x/run.md");
  assert.deepEqual(Object.keys(record).slice(0, 9), ["id", "loopId", "loopName", "startedAt", "durationSeconds", "iterationsUsed", "statusCode", "statusSummary", "trigger"]);
});

test("passed run with no changes (discard) gets the No changes suffix", () => {
  const { entry } = buildRunEntryAndRecord(input({ end: "discard" }));
  assert.equal(entry.statusSummary, "All good. No changes.");
  assert.equal(entry.statusCode, "success");
});

test("held for a person: awaiting_review, waiting text, held fields with the merged MR", () => {
  const { entry, record } = buildRunEntryAndRecord(input({ loop: humanLoop, end: "hold", heldReason: "human", mergedMr: "https://x/mr/1" }));
  assert.equal(entry.statusCode, "awaiting_review");
  assert.equal(entry.statusSummary, "All good. Waiting for your review.");
  assert.deepEqual(record.awaiting, { held: "success", kind: "passed", failedStage: null, reason: "human" });
  assert.equal(record.mergedMr, "https://x/mr/1");
});

test("held for leftover files uses the Ship-panel text", () => {
  const { entry, record } = buildRunEntryAndRecord(input({ end: "hold", heldReason: "leftoverFiles" }));
  assert.match(entry.statusSummary, /^All good\. Held: its worktree had files an earlier run left;/);
  assert.equal(record.awaiting.reason, "leftoverFiles");
  assert.equal("mergedMr" in record, false);
});

test("failed run that keeps its branch: failed, summary untouched", () => {
  const { entry, record } = buildRunEntryAndRecord(input({ outcome: failed, end: "keep" }));
  assert.equal(entry.statusCode, "failed");
  assert.equal(entry.statusSummary, "Verify failed.");
  assert.equal(record.awaiting, undefined);
});

test("Factory run started on the page carries the board fields and the work item", () => {
  const item = { source: "issue", id: "7", title: "Do it", body: "", repo: null };
  const { entry, record } = buildRunEntryAndRecord(input({ loop: factory, end: null, start: { item }, needsDecision: "pick one" }));
  assert.equal(entry.factoryRunId, "r1");
  assert.equal(entry.factoryMode, "full");
  assert.deepEqual(record.workItem, { source: "issue", id: "7", title: "Do it" });
  assert.equal(record.needsDecision, "pick one");
});

function harness({ diff = { text: "", truncated: false, patchId: "p1", files: ["a.ts"], additions: 1, deletions: 0 }, shipLine = "Draft MR: https://x/mr/2", removed = true } = {}) {
  const calls = [];
  const deps = {
    host: async (cmd) => { calls.push(`host:${cmd}`); if (cmd === "loop_worktree_diff") { if (diff === null) throw new Error("no diff"); return diff; } if (cmd === "loop_worktree_remove_if_empty") return removed; return undefined; },
    appendRecord: async (e, r) => { calls.push("append"); deps.saved = { e, r }; },
    removeMarker: async () => { calls.push("marker"); },
    readRuns: async () => { calls.push("readRuns"); return []; },
    setRuns: () => calls.push("setRuns"),
    postRunFinished: async () => { calls.push("signal"); },
    onSignalPosted: () => calls.push("signalDone"),
    syncStateBack: async () => { calls.push("sync"); },
    ship: async (e) => { calls.push("ship"); deps.shipArg = e; return shipLine; },
    now: () => 1000, newId: () => "id1",
    log: (l) => calls.push(`log:${l}`), setNotice: (t) => calls.push(`notice:${t}`),
  };
  return { calls, deps };
}
const finishInput = (over = {}) => ({ loop: plain, outcome: passed, started: 0, trigger: "manual", activeRun: info, start: null, projectRoot: "/p", runPrefix: "", leftoverFiles: 0, mergedMr: null, changedPaths: [], summaryPath: null, needsDecision: null, gitRoot: () => "/p/wt", ...over });
const order = (calls, names) => names.map((n) => calls.findIndex((c) => c === n || c.startsWith(`${n}`)));

test("changes + auto review: one diff read, then sync, record, signal, ship; no panel", async () => {
  const { calls, deps } = harness();
  const r = await finishLoopRun(deps, finishInput());
  assert.equal(calls.filter((c) => c === "host:loop_worktree_diff").length, 1);
  const [diff, sync, append, marker, readRuns, setRuns, signal, ship] = order(calls, ["host:loop_worktree_diff", "sync", "append", "marker", "readRuns", "setRuns", "signal", "ship"]);
  assert.ok(diff < sync && sync < append && append < marker && marker < readRuns && readRuns < setRuns && append < signal && append < ship, calls.join(","));
  assert.deepEqual(deps.shipArg, {
    runId: "r1", projectRoot: "/p", mode: "full", runPrefix: "",
    item: { source: "text", id: null, title: `${plain.name} run r1`, body: "", repo: null, key: "loop:r1", provider: null },
    info, entry: deps.saved.e, statusCode: "success", needsDecision: false, failedStage: null, kind: "passed", processName: plain.name, mergedMr: null,
  });
  assert.ok(calls.includes("notice:The loop passed. Draft MR: https://x/mr/2"));
  assert.equal(r.manualShip, null);
  assert.equal(deps.saved.e.statusCode, "success");
});

test("blocked shipper opens the Ship panel with the diff and patch id", async () => {
  const { deps } = harness({ shipLine: "MR not opened: secret scan" });
  const r = await finishLoopRun(deps, finishInput());
  assert.equal(r.manualShip.item.title, `${plain.name} run r1`);
  assert.equal(r.manualShip.reviewedPatchId, "p1");
  assert.equal(r.manualShip.diff.patchId, "p1");
});

test("human review holds: record first, no ship, panel offered", async () => {
  const { calls, deps } = harness();
  const r = await finishLoopRun(deps, finishInput({ loop: humanLoop }));
  assert.equal(calls.includes("ship"), false);
  assert.equal(deps.saved.e.statusCode, "awaiting_review");
  assert.ok(r.manualShip);
});

test("leftover files hold even in auto review", async () => {
  const { deps } = harness();
  const r = await finishLoopRun(deps, finishInput({ leftoverFiles: 2 }));
  assert.equal(deps.saved.r.awaiting.reason, "leftoverFiles");
  assert.ok(r.manualShip);
});

test("no changes discards: record then removeIfEmpty, no ship, no panel", async () => {
  const { calls, deps } = harness({ diff: { text: "", truncated: false, patchId: "", files: [], additions: 0, deletions: 0 } });
  const r = await finishLoopRun(deps, finishInput());
  const [append, remove] = order(calls, ["append", "host:loop_worktree_remove_if_empty"]);
  assert.ok(append >= 0 && append < remove, calls.join(","));
  assert.equal(calls.includes("ship"), false);
  assert.equal(deps.saved.e.statusSummary, "All good. No changes.");
  assert.equal(r.manualShip, null);
});

test("unreadable diff keeps the branch: nothing removed or shipped", async () => {
  const { calls, deps } = harness({ diff: null });
  await finishLoopRun(deps, finishInput());
  assert.equal(calls.includes("ship"), false);
  assert.equal(calls.includes("host:loop_worktree_remove_if_empty"), false);
  assert.equal(deps.saved.r.diffSummary, null);
});

test("Factory run started here: saves the record, then offers Ship for its item; no state sync", async () => {
  const { calls, deps } = harness();
  const item = { source: "issue", id: "7", title: "Do it", body: "", repo: null };
  const f = { ...factory, config: { ...factory.config, openMergeRequest: true } };
  const r = await finishLoopRun(deps, finishInput({ loop: f, start: { item } }));
  assert.equal(calls.includes("sync"), false);
  assert.ok(calls.indexOf("append") >= 0);
  assert.equal(r.manualShip.item, item);
  const failedRun = await finishLoopRun(harness().deps, finishInput({ loop: f, start: { item }, outcome: failed }));
  assert.equal(failedRun.manualShip, null);
});

test("no project means no signal; a failed append is logged, not thrown", async () => {
  const { calls, deps } = harness();
  deps.postRunFinished = null;
  deps.appendRecord = async () => { throw new Error("disk full"); };
  await finishLoopRun(deps, finishInput({ loop: humanLoop }));
  assert.equal(calls.includes("signal"), false);
  assert.ok(calls.includes("log:run record not written: disk full"));
});

test("cancelled run keeps the branch: no panel, no ship, no removal", async () => {
  const { calls, deps } = harness();
  const r = await finishLoopRun(deps, finishInput({ outcome: { ...failed, cancelled: true } }));
  assert.equal(r.manualShip, null);
  assert.equal(calls.includes("ship"), false);
  assert.equal(calls.includes("host:loop_worktree_remove_if_empty"), false);
  assert.ok(calls.includes("append"));
});

test("Factory without openMergeRequest or without a start offers no Ship and never ships or removes", async () => {
  const item = { source: "issue", id: "7", title: "Do it", body: "", repo: null };
  const off = { ...factory, config: { ...factory.config, openMergeRequest: false } };
  const on = { ...factory, config: { ...factory.config, openMergeRequest: true } };
  for (const [loop, start] of [[off, { item }], [on, null]]) {
    const { calls, deps } = harness();
    const r = await finishLoopRun(deps, finishInput({ loop, start }));
    assert.equal(r.manualShip, null);
    assert.equal(calls.includes("ship"), false);
    assert.equal(calls.includes("host:loop_worktree_remove_if_empty"), false);
    assert.ok(calls.includes("append"));
  }
});

test("a held run passes the merged MR through to the Ship panel", async () => {
  const { deps } = harness();
  const r = await finishLoopRun(deps, finishInput({ loop: humanLoop, mergedMr: "https://x/mr/9" }));
  assert.equal(r.manualShip.mergedMr, "https://x/mr/9");
  assert.equal(deps.saved.r.mergedMr, "https://x/mr/9");
});

test("a run without a worktree reads no diff, syncs nothing, and only records and signals", async () => {
  const { calls, deps } = harness();
  const r = await finishLoopRun(deps, finishInput({ activeRun: null }));
  assert.equal(r.manualShip, null);
  assert.equal(calls.some((c) => c.startsWith("host:")), false);
  assert.equal(calls.includes("sync"), false);
  assert.ok(calls.includes("append") && calls.includes("signal"));
  assert.equal(calls.includes("ship"), false);
});
