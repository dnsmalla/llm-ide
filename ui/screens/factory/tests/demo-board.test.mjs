// A seven-card demo: one work item per board column, with the run record each column is derived from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newWorkItem } from "../items.ts";
import { EMPTY_FACTS, buildBoard, assembleFacts } from "../board-model.ts";

const at = new Date("2026-11-11T00:00:00.000Z");
const item = (n, source = "issue", title = `Demo ${n}`) => {
  const row = newWorkItem({ source, id: source === "text" ? null : String(n), title, body: "", repo: "acme/web", provider: "github" }, at);
  row.runIds = [`r${n - 100}`];
  return row;
};
const record = (over = {}) => ({ runId: "", mode: "full", statusCode: "success", needsDecision: null, ship: null, endedAt: at.toISOString(), verdict: "PASS", changed: 3, test: "pass", failingStage: null, costUsd: 0.42, durationSeconds: 65, readiness: null, ...over });
const url = (n) => `https://github.com/acme/web/pull/${n}`;

test("demo data: one item per column keeps its card, actions, note and ship state", () => {
  const items = [item(101), item(102, "spec"), item(103, "text", "Free text idea"), item(104), item(105), item(106), item(107)];
  const records = new Map([
    ["r1", record({ runId: "r1" })],
    ["r2", record({ runId: "r2", statusCode: "failed", needsDecision: "needs decision", verdict: "DECISION", readiness: "needs-decision" })],
    ["r3", record({ runId: "r3" })],
    ["r4", record({ runId: "r4", statusCode: "failed", verdict: "FAIL", failingStage: "verify" })],
    ["r5", record({ runId: "r5" })],
    ["r6", record({ runId: "r6", ship: { provider: "github", url: url(6) } })],
    ["r7", record({ runId: "r7", ship: { provider: "github", url: url(7) } })],
  ]);
  const facts = new Map([
    [items[0].key, { ...EMPTY_FACTS }],
    [items[1].key, { ...EMPTY_FACTS, lastRecord: records.get("r2"), worktreeExists: true }],
    [items[2].key, { ...EMPTY_FACTS, live: { runId: "r3", itemKey: items[2].key, projectRoot: "/demo", mode: "full", state: "running", startedAt: at.toISOString(), log: ["reading context"] } }],
    [items[3].key, { ...EMPTY_FACTS, lastRecord: records.get("r4"), worktreeExists: true }],
    [items[4].key, { ...EMPTY_FACTS, lastRecord: records.get("r5"), worktreeExists: true }],
    [items[5].key, { ...EMPTY_FACTS, lastRecord: records.get("r6"), ship: { url: url(6), state: "open", ci: "pending", ciSummary: null, comments: [] } }],
    [items[6].key, { ...EMPTY_FACTS, lastRecord: records.get("r7"), ship: { url: url(7), state: "merged", ci: "success", ciSummary: null, comments: [] } }],
  ]);
  const board = buildBoard(items, facts, at.getTime());
  assert.deepEqual(Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])), { inbox: 1, needsDecision: 1, working: 1, needsYou: 1, readyToShip: 1, shipped: 1, done: 1 });
  assert.deepEqual(board.inbox[0].actions, ["start", "intake", "discard"]);
  assert.deepEqual(board.needsDecision[0].actions, ["intake", "discard"]);
  assert.deepEqual(board.working[0].actions, []);
  assert.deepEqual(board.needsYou[0].actions, ["resume", "openDiff", "discard"]);
  assert.deepEqual(board.readyToShip[0].actions, ["openDiff", "ship", "discard"]);
  assert.deepEqual(board.shipped[0].actions, ["openRequest", "openDiff"]);
  assert.deepEqual(board.done[0].actions, ["openRequest", "discard"]);
  assert.equal(board.shipped[0].note, "CI running");
  assert.equal(board.working[0].lastLine, "reading context");

  const live = assembleFacts(items[2], { projectRoot: "/demo", live: [facts.get(items[2].key).live], records, worktrees: new Map([["r3", {}]]), ship: new Map(), lastKnown: new Map() });
  assert.equal(live.live?.state, "running");
  assert.equal(live.worktreeExists, true);
});
