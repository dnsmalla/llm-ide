import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_LABELS, EMPTY_FACTS, cleanupPlan, formatDuration, nextCardKey, progressLabel, stageTimeline, STATUS_REFRESH_MS, actionsFor, assembleFacts, buildBoard, buildLanes, openIssueCard, markerStage, boardSummary, cardTone, chunkShipRequests, decodeShipResults,
  decodeWorktreeList, factoryAnchor, focusKeyFromAnchor, lastKnownFrom, latestRecords, otherProjectsNote, safeRequestUrl,
  shipRequestsFor, toWorkItem,
} from "../board-model.ts";
import { budget } from "../../test-support/perf.ts";

const item = (key, over = {}) => ({ key, source: "issue", id: key.slice(6), title: `Title ${key}`, body: "", repo: null, addedAt: "2026-11-09T00:00:00.000Z", runIds: [], ...over });
const live = (itemKey, projectRoot = "/p", state = "running") => ({ runId: `run-${itemKey.slice(6)}`, itemKey, projectRoot, mode: "full", state, startedAt: null, log: [] });
const rec = (runId, over = {}) => ({ runId, mode: "full", statusCode: "success", needsDecision: null, ship: null, endedAt: "2026-11-09T10:00:00.000Z", ...over });

test("buildBoard groups items by derived column and keeps insertion order", () => {
  const items = [item("issue:a"), item("issue:b"), item("issue:c"), item("issue:d", { runIds: ["rd"] })];
  const facts = new Map([
    ["issue:b", { ...EMPTY_FACTS, live: live("issue:b") }],
    ["issue:d", { ...EMPTY_FACTS, lastRecord: rec("rd"), worktreeExists: true }],
  ]);
  const board = buildBoard(items, facts);
  assert.deepEqual(Object.keys(board), ["inbox", "needsDecision", "working", "needsYou", "readyToShip", "shipped", "done"]);
  assert.deepEqual(board.inbox.map((c) => c.key), ["issue:a", "issue:c"]);
  assert.deepEqual(board.working.map((c) => c.key), ["issue:b"]);
  assert.deepEqual(board.readyToShip, [{ key: "issue:d", title: "Title issue:d", source: "issue", note: null, lane: "done", status: "Ready to ship", progress: null, actions: ["openDiff", "ship", "discard"], costUsd: null, durationSeconds: null, progressLabel: null, lastLine: null, verdict: null, changed: null, test: null, failingStage: null, readiness: null, notShipped: null, shipOverride: null }]);
  assert.deepEqual(board.done, []);
  assert.equal(lastKnownFrom(board).get("issue:d"), "readyToShip");
});

test("actionsFor readyToShip is openDiff, ship, discard", () => {
  assert.deepEqual(actionsFor("readyToShip", null), ["openDiff", "ship", "discard"]);
});

test("actionsFor needsYou with Interrupted is resume, discard", () => {
  assert.deepEqual(actionsFor("needsYou", "Interrupted"), ["finishChecks", "rerun", "discard"]);
  assert.equal(ACTION_LABELS.finishChecks, "Finish checks");
  assert.equal(ACTION_LABELS.rerun, "Run again from start");
  assert.deepEqual(actionsFor("needsYou", "Not shipped"), ["rerun", "openDiff", "discard"]);
});

test("actionsFor covers every column and every action has a label", () => {
  assert.deepEqual(actionsFor("inbox", null), ["start", "intake", "discard"]);
  assert.deepEqual(actionsFor("inbox", "Intake ready"), ["start", "discard"]);
  assert.deepEqual(actionsFor("needsDecision", null), ["intake", "discard"]);
  assert.deepEqual(actionsFor("working", "Queued"), []);
  assert.deepEqual(actionsFor("needsYou", "CI failed"), ["sendBack", "openRequest", "openDiff", "discard"]);
  assert.deepEqual(actionsFor("needsYou", "New review comments"), ["sendBack", "openRequest", "openDiff", "discard"]);
  assert.deepEqual(actionsFor("needsYou", "CI failed, new review comments"), ["sendBack", "openRequest", "openDiff", "discard"]);
  assert.deepEqual(actionsFor("needsYou", "Closed without merge"), ["openRequest", "discard"]);
  assert.deepEqual(actionsFor("needsYou", "status unavailable"), ["openRequest", "discard"]);
  assert.deepEqual(actionsFor("needsYou", "Failed"), ["resume", "openDiff", "discard"]);
  assert.deepEqual(actionsFor("shipped", null), ["openRequest", "openDiff"]);
  assert.deepEqual(actionsFor("done", null), ["openRequest", "discard"]);
  for (const a of ["start", "openDiff", "ship", "sendBack", "discard", "openRequest", "resume", "intake", "answer"]) assert.equal(typeof ACTION_LABELS[a], "string", a);
});

test("assembleFacts uses the item's last run and ignores live runs of the same key in other projects", () => {
  const url = "https://github.com/acme/web/pull/7";
  const it = item("issue:a", { runIds: ["r0", "r1"] });
  const ctx = {
    projectRoot: "/p",
    live: [live("issue:a", "/other")],
    records: new Map([["r0", rec("r0")], ["r1", rec("r1", { ship: { provider: "github", url } })]]),
    worktrees: new Map([["r1", {}]]),
    ship: new Map([[url, "error"]]),
    lastKnown: new Map([["issue:a", "needsYou"]]),
  };
  const f = assembleFacts(it, ctx);
  assert.equal(f.live, null);
  assert.equal(f.lastRecord.runId, "r1");
  assert.equal(f.worktreeExists, true);
  assert.equal(f.ship, null);
  assert.equal(f.shipStatusError, true);
  assert.equal(f.lastKnownColumn, "needsYou");
  assert.equal(assembleFacts(it, { ...ctx, live: [live("issue:a", "/p")] }).live.projectRoot, "/p");
});

test("ship status requests: one per shipped card, since the run ended, in chunks of 20", () => {
  const url = (n) => `https://github.com/acme/web/pull/${n}`;
  const items = Array.from({ length: 25 }, (_, n) => item(`issue:i${n}`, { runIds: [`r${n}`] }));
  items.push(item("issue:none"));
  const records = new Map(items.slice(0, 25).map((it, n) => [`r${n}`, rec(`r${n}`, { ship: { provider: "github", url: url(n) }, endedAt: n === 0 ? null : "2026-11-09T10:00:00.000Z" })]));
  const reqs = shipRequestsFor(items, records);
  assert.equal(reqs.length, 25);
  assert.deepEqual(reqs[0], { url: url(0), since: "2026-11-09T00:00:00.000Z" }, "no end time: since the item was added");
  assert.deepEqual(reqs[1], { url: url(1), since: "2026-11-09T10:00:00.000Z" });
  assert.deepEqual(chunkShipRequests(reqs).map((c) => c.length), [20, 5]);
});

test("decodeShipResults keeps valid statuses and turns errors and bad shapes into error", () => {
  const good = { url: "https://github.com/a/b/pull/1", state: "open", ci: "failed", ciSummary: "x failed", comments: [{ author: "rev", body: "b".repeat(5000), at: "2026-11-09T11:00:00Z" }, { author: 1 }] };
  const m = decodeShipResults({ results: [good, { url: "https://gitlab.com/a/b/-/merge_requests/2", error: "unauthorized" }, { url: "https://github.com/a/b/pull/3", state: "weird", ci: "none" }, "junk"] });
  assert.equal(m.get(good.url).ci, "failed");
  assert.equal(m.get(good.url).ciSummary, "x failed");
  assert.equal(m.get(good.url).comments.length, 1);
  assert.equal(m.get(good.url).comments[0].body.length, 4000);
  assert.equal(m.get("https://gitlab.com/a/b/-/merge_requests/2"), "error");
  assert.equal(m.get("https://github.com/a/b/pull/3"), "error");
  assert.equal(decodeShipResults(null).size, 0);
});

test("latestRecords reads the newest record per factory run id from the month indexes", async () => {
  const files = {
    "system/loop-runs/index-2026-10.jsonl": JSON.stringify({ id: "e1", startedAt: "2026-10-15T10:00:00.000Z", factoryRunId: "r1" }) + "\n",
    "system/loop-runs/index-2026-11.jsonl": [
      JSON.stringify({ id: "e2", startedAt: "2026-11-15T10:00:00.000Z", factoryRunId: "r1" }),
      JSON.stringify({ id: "e3", startedAt: "2026-11-16T10:00:00.000Z", loopId: "regression" }),
      "{corrupt",
    ].join("\n") + "\n",
    "system/loop-runs/2026-10/e1.json": JSON.stringify({ statusCode: "failed", worktree: { runId: "r1" } }),
    "system/loop-runs/2026-11/e2.json": JSON.stringify({ statusCode: "success", factoryMode: "sendBack", worktree: { runId: "r1" } }),
  };
  const reads = [];
  const fs = {
    async list(path) {
      assert.equal(path, "system/loop-runs");
      return { entries: [{ name: "index-2026-10.jsonl" }, { name: "index-2026-11.jsonl" }, { name: "2026-11" }, { name: "index.jsonl" }] };
    },
    async read(path) {
      reads.push(path);
      if (!(path in files)) throw Object.assign(new Error("nf"), { code: "not_found" });
      return { status: "ok", text: files[path] };
    },
  };
  const out = await latestRecords(fs, new Set(["r1", "r9"]));
  assert.deepEqual([...out.keys()], ["r1"]);
  assert.equal(out.get("r1").statusCode, "success");
  assert.equal(out.get("r1").mode, "sendBack");
  assert.deepEqual(out.get("r1").entry, { id: "e2", startedAt: "2026-11-15T10:00:00.000Z" });
  assert.equal(reads.includes("system/loop-runs/2026-10/e1.json"), false, "an older record of the same run is not loaded");
  assert.equal((await latestRecords(fs, new Set())).size, 0);
  assert.equal((await latestRecords({ async list() { throw new Error("gone"); }, async read() { throw new Error("gone"); } }, new Set(["r1"]))).size, 0);
});

test("decodeWorktreeList keys run info by run id and drops bad rows", () => {
  const m = decodeWorktreeList([{ runId: "r1", project: "/p", repo: "/p/code/web", worktree: "/p/system/loop-worktrees/r1", branch: "factory/r1", baseCommit: "abc" }, { runId: "../x", worktree: "/x" }, null, "junk"]);
  assert.deepEqual([...m.keys()], ["r1"]);
  assert.equal(m.get("r1").branch, "factory/r1");
  assert.equal(decodeWorktreeList({ not: "a list" }).size, 0);
});

test("other-project runs, request URLs, focus anchors and the work item view", () => {
  assert.equal(otherProjectsNote([live("issue:a", "/q"), live("issue:b", "/q"), live("issue:c", "/p")], "/p"), "2 runs live in other projects");
  assert.equal(otherProjectsNote([live("issue:a", "/q")], "/p"), "1 run live in other projects");
  assert.equal(otherProjectsNote([live("issue:c", "/p")], "/p"), null);
  assert.equal(safeRequestUrl("https://github.com/acme/web/pull/7"), "https://github.com/acme/web/pull/7");
  assert.equal(safeRequestUrl("https://gitlab.com/acme/web/-/merge_requests/3"), "https://gitlab.com/acme/web/-/merge_requests/3");
  assert.equal(safeRequestUrl("https://evil.example/x"), null);
  assert.equal(safeRequestUrl("http://github.com/x"), null);
  assert.equal(safeRequestUrl(null), null);
  assert.equal(factoryAnchor("issue:github:acme/web#12"), "item:issue:github:acme/web#12");
  assert.equal(focusKeyFromAnchor(factoryAnchor("issue:github:acme/web#12")), "issue:github:acme/web#12");
  assert.equal(focusKeyFromAnchor("build"), null);
  assert.equal(focusKeyFromAnchor(undefined), null);
  assert.equal(STATUS_REFRESH_MS, 300000);
  assert.deepEqual(toWorkItem(item("issue:a", { repo: "acme/web", runIds: ["r1"] })), { source: "issue", id: "a", title: "Title issue:a", body: "", repo: "acme/web" });
});

test("cleanup keeps a live Loop-page run and an orphan with unshipped changes", () => {
  const worktrees = new Map([["r-live", {}], ["r-dirty", {}], ["r-clean", {}], ["r-merged", {}]]);
  const plan = cleanupPlan(
    [{ runIds: ["r-merged"] }], worktrees,
    [{ runId: "r-live" }], new Set(),
    new Set(["r-merged"]),
    new Map([["r-live", { changedFiles: 0, localCommits: 0 }], ["r-dirty", { changedFiles: 2, localCommits: 0 }], ["r-clean", { changedFiles: 0, localCommits: 0 }], ["r-merged", { changedFiles: 1, localCommits: 1 }]]),
  );
  assert.deepEqual(plan.remove.sort(), ["r-clean", "r-merged"]);
  assert.ok(plan.keep.some((k) => k.runId === "r-live"));
  const marked = cleanupPlan([], new Map([["r-loop", {}]]), [], new Set(["r-loop"]), new Set(), new Map([["r-loop", { changedFiles: 0, localCommits: 0 }]]));
  assert.equal(marked.remove.length, 0);
  assert.equal(marked.keep[0].runId, "r-loop");
  assert.ok(plan.keep.some((k) => k.runId === "r-dirty" && /Discard/.test(k.reason)));
});

test("formatDuration is human, not raw seconds", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(300), "5m");
  assert.equal(formatDuration(5400), "1h 30m");
});

test("a live card shows the typed stage and elapsed time", () => {
  const f = new Map([["issue:a", { ...EMPTY_FACTS, live: { ...live("issue:a"), log: ["wrote tests"], progress: { stageName: "Implement", stageIndex: 3, stageCount: 8, iteration: 2, repairs: 1, lastLine: "wrote tests", startedAt: "2026-11-09T09:55:48.000Z" } } }]]);
  const board = buildBoard([item("issue:a")], f, Date.parse("2026-11-09T10:00:00.000Z"));
  assert.deepEqual(board.working[0].progressLabel, "Implement · 3 of 8 · iter 2 · repair 1 · 4m 12s");
  assert.equal(board.working[0].lastLine, "wrote tests");
  assert.equal(progressLabel({ stageName: null, stageIndex: 0, stageCount: 8, iteration: 0, repairs: 0, startedAt: null }), "Starting");
});

test("stageTimeline returns only the typed stages", () => {
  const rows = stageTimeline({ log: ["$ Intake", "✓ Intake: passed"], progress: { stageName: "Implement", stages: [{ id: "i", name: "Intake", state: "passed" }, { id: "m", name: "Implement", state: "running" }] } });
  assert.deepEqual(rows, [{ id: "i", name: "Intake", state: "passed" }, { id: "m", name: "Implement", state: "running" }]);
  assert.deepEqual(stageTimeline({ log: [], progress: { stageName: "Verify" } }), [], "no typed stages means no invented rows");
});

test("R-048: a typed timeline keeps early stages and resets a repeated stage to running", () => {
  const rows = stageTimeline({ log: [], progress: { stageName: "Implement", stages: [{ id: "i", name: "Implement", state: "running" }, { id: "v", name: "Verify", state: "passed" }] } });
  assert.deepEqual(rows, [{ id: "i", name: "Implement", state: "running" }, { id: "v", name: "Verify", state: "passed" }]);
  assert.deepEqual(stageTimeline({ log: ["$ Same", "$ Same"], progress: null }), [], "log text is never parsed");
});

test("D4: nextCardKey moves within a lane and into the next non-empty lane", () => {
  const L = (...lanes) => lanes.map((cards, i) => ({ id: `l${i}`, label: `l${i}`, cards: cards.map((key) => ({ key })) }));
  const lanes = L(["a", "b"], [], ["c"], [], [], [], []);
  assert.equal(nextCardKey(lanes, "a", "down"), "b");
  assert.equal(nextCardKey(lanes, "a", "right"), "c");
  assert.equal(nextCardKey(lanes, "c", "left"), "a");
  assert.equal(nextCardKey(lanes, "b", "down"), "b");
  assert.equal(nextCardKey(lanes, null, "down"), "a");
  // Left/right keep the row (clamped to the target lane's length), not the lane number.
  const tall = L(["a", "b"], [], [], ["x", "y", "z"], [], [], ["d"]);
  assert.equal(nextCardKey(tall, "a", "right"), "x");
  assert.equal(nextCardKey(tall, "b", "right"), "y");
  assert.equal(nextCardKey(tall, "z", "left"), "b");
  assert.equal(nextCardKey(tall, "z", "right"), "d");
});

test("process lanes: backlog, each step, MR open, done; a card sits in the step it is on or stopped at", () => {
  const steps = ["Plan", "Implement", "Verify", "Review"];
  const items = [item("issue:a"), item("issue:b"), item("issue:c", { runIds: ["rc"] }), item("issue:d", { runIds: ["rd"] }), item("issue:e", { runIds: ["re"] })];
  const facts = new Map([
    ["issue:b", { ...EMPTY_FACTS, live: { ...live("issue:b"), progress: { stageName: "Implement", stageIndex: 1, stageCount: 4, iteration: 1, repairs: 0, stages: [], startedAt: null } } }],
    ["issue:c", { ...EMPTY_FACTS, lastRecord: { ...rec("rc"), statusCode: "failed", failingStage: { name: "Review gate", error: "x" } } }],
    ["issue:d", { ...EMPTY_FACTS, lastRecord: rec("rd") }],
    ["issue:e", { ...EMPTY_FACTS, lastRecord: { ...rec("re"), statusCode: "failed", failingStage: { name: "Doc review", error: "x" } } }],
  ]);
  const lanes = buildLanes(buildBoard(items, facts, Date.now(), { steps }), steps);
  assert.deepEqual(lanes.map((l) => l.label), ["Backlog", "Plan", "Implement", "Verify", "Review", "Doc review", "Done"]);
  const at = (label) => lanes.find((l) => l.label === label).cards.map((c) => c.key);
  assert.deepEqual(at("Backlog"), ["issue:a"]);
  assert.deepEqual(at("Implement"), ["issue:b"]);
  assert.deepEqual(at("Review"), ["issue:c"], "a failed gate sits in the step it checks");
  assert.deepEqual(at("Doc review"), ["issue:e"], "a step the process no longer lists still gets a lane");
  assert.deepEqual(at("Done"), ["issue:d"], "finished, not merged yet");
  assert.equal(lanes.find((l) => l.label === "Review").cards[0].status, "Needs you");
  // A send-back re-run of a shipped item shows its running step, not Done; a queued run waits in Backlog.
  const shipped = { ...rec("rs"), ship: { provider: "github", url: "https://github.com/a/b/pull/1" } };
  const rerun = { ...EMPTY_FACTS, lastRecord: shipped, live: { ...live("issue:s"), progress: { stageName: "Verify", stageIndex: 2, stageCount: 4, iteration: 1, repairs: 0, stages: [], startedAt: null } } };
  const queued = { ...EMPTY_FACTS, live: live("issue:q", "/p", "queued") };
  const two = buildLanes(buildBoard([item("issue:s", { runIds: ["rs"] }), item("issue:q")], new Map([["issue:s", rerun], ["issue:q", queued]]), Date.now(), { steps }), steps);
  assert.deepEqual(two.find((l) => l.label === "Verify").cards.map((c) => c.key), ["issue:s"]);
  assert.deepEqual(two.find((l) => l.label === "Backlog").cards.map((c) => c.key), ["issue:q"]);
});

test("Backlog lists every open issue not on the board; Done holds finished work and drops merged work", () => {
  const steps = ["Implement"];
  const merged = { ...EMPTY_FACTS, lastRecord: { ...rec("rm"), ship: { provider: "github", url: "https://github.com/a/b/pull/2" } }, ship: { url: "https://github.com/a/b/pull/2", state: "merged", ci: "success", ciSummary: null, comments: [] } };
  const open = { ...EMPTY_FACTS, lastRecord: { ...rec("ro"), ship: { provider: "github", url: "https://github.com/a/b/pull/3" } }, ship: { url: "https://github.com/a/b/pull/3", state: "open", ci: "failed", ciSummary: null, comments: [] } };
  const items = [item("issue:a"), item("issue:m", { runIds: ["rm"] }), item("issue:o", { runIds: ["ro"] })];
  const board = buildBoard(items, new Map([["issue:m", merged], ["issue:o", open]]), Date.now(), { steps });
  const lanes = buildLanes(board, steps, [openIssueCard({ key: "issue:a", title: "dup" }), openIssueCard({ key: "issue:new", title: "#9 New" })]);
  const at = (label) => lanes.find((l) => l.label === label).cards.map((c) => c.key);
  assert.deepEqual(at("Backlog"), ["issue:a", "issue:new"], "an open issue already on the board is not listed twice");
  assert.deepEqual(at("Done"), ["issue:o"], "an open MR (even with failed CI) is done-not-merged; a merged one leaves the board");
  assert.equal(lanes.find((l) => l.label === "Done").cards[0].status, "Needs you");
  const fresh = lanes[0].cards[1];
  assert.deepEqual([fresh.status, fresh.actions], ["Open issue", ["start"]]);
});

test("an interrupted run sits in the step its marker names; an MR closed without merge goes back to Backlog", () => {
  const steps = ["Plan", "Implement", "Verify"];
  const shipped = { ...rec("rs"), ship: { provider: "github", url: "https://github.com/a/b/pull/4" } };
  const facts = new Map([
    ["issue:i", { ...EMPTY_FACTS, lastRecord: shipped, worktreeExists: true, interrupted: true, interruptedStage: "Verify", ship: { url: "https://github.com/a/b/pull/4", state: "open", ci: "success", ciSummary: null, comments: [] } }],
    ["issue:j", { ...EMPTY_FACTS, worktreeExists: true, interrupted: true, interruptedStage: null }],
    ["issue:c", { ...EMPTY_FACTS, lastRecord: { ...rec("rc"), ship: { provider: "github", url: "https://github.com/a/b/pull/5" } }, ship: { url: "https://github.com/a/b/pull/5", state: "closed", ci: "none", ciSummary: null, comments: [] } }],
  ]);
  const items = [item("issue:i", { runIds: ["rs"] }), item("issue:j", { runIds: ["rj"] }), item("issue:c", { runIds: ["rc"] })];
  const lanes = buildLanes(buildBoard(items, facts, Date.now(), { steps }), steps);
  const at = (label) => lanes.find((l) => l.label === label).cards.map((c) => `${c.key} ${c.note}`);
  assert.deepEqual(at("Verify"), ["issue:i Interrupted"], "an interrupted re-run of a shipped item shows its step, not Done");
  assert.deepEqual(at("Backlog"), ["issue:j Interrupted", "issue:c Closed without merge"]);
  assert.deepEqual(at("Done"), []);
});

test("boardSummary counts backlog, running, cards that need you and work waiting to merge; cardTone follows the status", () => {
  const card = (status) => ({ key: status, status });
  const lanes = [{ id: "backlog", label: "Backlog", cards: [card("Inbox"), card("Open issue")] }, { id: "step:Verify", label: "Verify", cards: [card("Needs you")] }, { id: "done", label: "Done", cards: [card("Shipped")] }];
  assert.equal(boardSummary(lanes, 2), "2 in backlog · 2 running · 1 needs you · 1 waiting to merge");
  assert.equal(boardSummary([{ id: "backlog", label: "Backlog", cards: [] }, { id: "done", label: "Done", cards: [] }], 0), "0 in backlog · 0 running · 0 waiting to merge");
  assert.deepEqual(["Working", "Needs you", "Needs decision", "Shipped", "Open issue", "Inbox"].map(cardTone), ["run", "alert", "warn", "ok", "ghost", "idle"]);
});

test("markerStage reads the step from a run marker and ignores older or bad markers", () => {
  assert.equal(markerStage(JSON.stringify({ runId: "r", stage: "Review" })), "Review");
  assert.equal(markerStage(JSON.stringify({ runId: "r" })), null);
  assert.equal(markerStage("{not json"), null);
  assert.equal(markerStage(JSON.stringify({ stage: 7 })), null);
  assert.equal(markerStage(null), null);
});

test("Start and Run intake start their own run plan; only Finish checks reviews existing work", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../Board.tsx", import.meta.url), "utf8");
  assert.match(src, /case "start":\s*case "intake": \{\s*const plan = runPlanFor\(action,/);
});

test("D4: the board markup uses a region, labelled lists and a log", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../Board.tsx", import.meta.url), "utf8") + readFileSync(new URL("../LaneBoard.tsx", import.meta.url), "utf8");
  assert.match(src, /role="region" aria-label="Factory board"/);
  assert.match(src, /<ul className="fx-cards" role="list"/);
  assert.match(src, /role="log"/);
  assert.doesNotMatch(src, /className="fx-board" role="list"/);
});

test("D6: 500 cards assemble and build well under 50 ms", () => {
  const items = Array.from({ length: 500 }, (_, i) => item(`issue:${i}`, { runIds: [`r${i}`] }));
  const facts = new Map(items.map((it, i) => [it.key, { ...EMPTY_FACTS, worktreeExists: true, lastRecord: rec(`r${i}`) }]));
  const ctx = { projectRoot: "/p", live: [], records: new Map(items.map((it, i) => [`r${i}`, rec(`r${i}`)])), worktrees: new Map(items.map((it, i) => [`r${i}`, {}])), ship: new Map(), lastKnown: new Map() };
  const t = performance.now();
  for (const it of items) assembleFacts(it, ctx);
  buildBoard(items, facts, Date.now());
  const ms = performance.now() - t;
  assert.ok(ms < budget(50), `500 cards took ${ms.toFixed(1)} ms`);
});

test("a process without an Intake step offers no Run intake on Inbox cards", () => {
  assert.deepEqual(actionsFor("inbox", null, { intake: false }), ["start", "discard"]);
  assert.deepEqual(actionsFor("needsDecision", null, { intake: false }), ["discard"]);
  assert.deepEqual(actionsFor("inbox", null), ["start", "intake", "discard"], "unknown process: unchanged");
  const board = buildBoard([item("issue:a")], new Map(), 0, { intake: false });
  assert.deepEqual(board.inbox[0].actions, ["start", "discard"]);
});
