// The accepted-changes log, system/self-improvement/changes.jsonl (plan 2026-11-19, phase 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendChangeLines, newOutcomeLines, parseChangeLog, readChangeLog, unrecordedDecisions, CHANGES_FILE } from "../native/improve/changes-log.ts";
import { syncChangeLog } from "../native/improve/panel-model.ts";

function memFs(files = {}) {
  const map = new Map(Object.entries(files));
  const dirs = new Set(["system", ...[...map.keys()].map((k) => k.slice(0, k.lastIndexOf("/")))]);
  const hash = (p) => (map.has(p) ? `h${map.get(p).length}` : null);
  return {
    map,
    read: async (p) => { if (!map.has(p)) throw Object.assign(new Error("missing"), { code: "not_found" }); return { status: "ok", text: map.get(p), hash: hash(p) }; },
    write: async (p, text, opts) => {
      if (!dirs.has(p.slice(0, p.lastIndexOf("/")))) throw Object.assign(new Error("no parent"), { code: "io" });
      if (hash(p) !== opts.expected_hash) throw Object.assign(new Error("conflict"), { code: "conflict" });
      map.set(p, text); return { hash: hash(p) };
    },
    create: async (p) => { dirs.add(p); return p; },
  };
}
const row = (id, status, extra = {}) => ({ id, loopId: "L", stageKey: null, change: { op: "setConfig", field: "maxIterations", before: 3, after: 2 }, rationale: "", evidence: null, suggestedScope: "project", status, scope: null, outcome: null, createdAt: "", decidedAt: null, ...extra });
const state = ({ proposals = [], history = [], offers = [] } = {}) => ({ loops: { L: { finishedRunsSinceReview: 0, proposals, history } }, offers });
const line = (id, action, decide) => ({ id, action, at: "t", loopId: "L", loopKey: null, stageKey: null, decide });

test("the first line creates the folder; later lines append; a damaged line is skipped, never dropped", async () => {
  const fs = memFs();
  await appendChangeLines(fs, [line("1", "accept", { action: "accept", id: "1" })]);
  fs.map.set(CHANGES_FILE, `${fs.map.get(CHANGES_FILE)}{broken\n`);
  await appendChangeLines(fs, [line("2", "revert", { action: "revert", id: "2" })]);
  assert.deepEqual((await readChangeLog(fs)).map((l) => l.id), ["1", "2"]);
  assert.match(fs.map.get(CHANGES_FILE), /\{broken\n/, "the damaged line stays for a person to fix");
  assert.deepEqual(await readChangeLog(memFs()), [], "no file is an empty log");
});

test("decisions the DB missed are found: an accept still proposed, an adopt still offered, a revert still accepted", () => {
  const log = [
    line("1", "accept", { action: "accept", id: "1", scope: "project" }),
    line("2", "accept", { action: "accept", id: "2", scope: "project" }),
    line("3", "adopt", { action: "adopt", id: "3", loopId: "L" }),
    line("4", "revert", { action: "revert", id: "4" }),
    line("5", "accept", { action: "accept", id: "5" }), line("5", "revert", { action: "revert", id: "5" }),
    { ...line("2", "outcome"), verdict: "better" },
  ];
  const s = state({ proposals: [row("1", "proposed")], history: [row("2", "accepted"), row("4", "accepted"), row("5", "reverted")], offers: [row("3", "accepted")] });
  assert.deepEqual(unrecordedDecisions(log, s), [{ action: "accept", id: "1", scope: "project" }, { action: "adopt", id: "3", loopId: "L" }, { action: "revert", id: "4" }]);
});

test("outcome verdicts are logged once, and 'not enough data' is not a verdict", () => {
  const s = state({ history: [row("7", "accepted", { outcome: { verdict: "worse" } }), row("8", "accepted", { outcome: { verdict: "not_enough_data" } })] });
  const first = newOutcomeLines([], s, "t");
  assert.deepEqual(first.map((l) => [l.id, l.action, l.verdict]), [["7", "outcome", "worse"]]);
  assert.deepEqual(newOutcomeLines(first, s), []);
});

test("syncChangeLog re-sends a missed decision and logs new outcomes", async () => {
  const fs = memFs();
  await appendChangeLines(fs, [line("1", "accept", { action: "accept", id: "1", scope: "project" })]);
  const calls = [];
  const core = { request: async (path, init) => { calls.push([path, init.body]); return {}; } };
  const resent = await syncChangeLog(fs, core, "/p", state({ proposals: [row("1", "proposed")], history: [row("9", "accepted", { outcome: { verdict: "better" } })] }));
  assert.equal(resent, true);
  assert.deepEqual(calls, [["/kb/loop/improve/decide", { projectRoot: "/p", action: "accept", id: "1", scope: "project" }]]);
  assert.deepEqual(parseChangeLog(fs.map.get(CHANGES_FILE)).map((l) => [l.id, l.action]), [["1", "accept"], ["9", "outcome"]]);
});
