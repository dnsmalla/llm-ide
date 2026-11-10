import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, COLUMN_LABELS, NOTE, columnFor, decodeRunRecordFacts } from "../columns.ts";

const URL7 = "https://github.com/acme/web/pull/7";
const facts = (over = {}) => ({ live: null, lastRecord: null, worktreeExists: false, ship: null, shipStatusError: false, lastKnownColumn: null, ...over });
const record = (over = {}) => ({ runId: "r1", mode: "full", statusCode: "success", needsDecision: null, ship: null, endedAt: "2026-11-09T10:00:00.000Z", ...over });
const liveRun = (state) => ({ runId: "r1", itemKey: "issue:x1", projectRoot: "/p", mode: "full", state, startedAt: "2026-11-09T09:00:00.000Z", log: [] });
const shipStatus = (over = {}) => ({ url: URL7, state: "open", ci: "success", ciSummary: null, comments: [], ...over });
const shipped = record({ ship: { provider: "github", url: URL7 } });
const comment = { author: "rev", body: "nit", at: "2026-11-09T11:00:00Z" };

test("the seven columns in board order with their labels", () => {
  assert.deepEqual(COLUMNS, ["inbox", "needsDecision", "working", "needsYou", "readyToShip", "shipped", "done"]);
  assert.deepEqual(COLUMNS.map((c) => COLUMN_LABELS[c]), ["Inbox", "Needs decision", "Working", "Needs you", "Ready to ship", "Shipped", "Done"]);
});

test("Inbox: a work item with no run", () => {
  assert.deepEqual(columnFor(facts()), { column: "inbox", note: null });
});

test("Needs decision: the last run ended at the Intake gate", () => {
  const f = facts({ lastRecord: record({ statusCode: "failed", needsDecision: "needs decision: see .factory/READINESS.md" }), worktreeExists: true });
  assert.deepEqual(columnFor(f), { column: "needsDecision", note: null });
});

test("Working: a run is live or queued, and a live run wins over everything else", () => {
  assert.deepEqual(columnFor(facts({ live: liveRun("running") })), { column: "working", note: null });
  assert.deepEqual(columnFor(facts({ live: liveRun("queued") })), { column: "working", note: NOTE.queued });
  assert.deepEqual(columnFor(facts({ live: liveRun("paused") })), { column: "working", note: NOTE.paused });
  assert.deepEqual(columnFor(facts({ live: liveRun("running"), lastRecord: shipped, shipStatusError: true, lastKnownColumn: "shipped" })), { column: "working", note: null });
});

test("Needs you: the last run failed, was stopped, errored or was blocked", () => {
  for (const [code, note] of [["failed", NOTE.failed], ["aborted", NOTE.stopped], ["error", NOTE.error], ["blocked.repair_out_of_scope", NOTE.blocked]]) {
    assert.deepEqual(columnFor(facts({ lastRecord: record({ statusCode: code }), worktreeExists: true })), { column: "needsYou", note }, code);
  }
});

test("Needs you: the PR/MR has failing CI or new review comments", () => {
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus({ ci: "failed" }) })), { column: "needsYou", note: NOTE.ciFailed });
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus({ comments: [comment] }) })), { column: "needsYou", note: NOTE.newComments });
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus({ ci: "failed", comments: [comment] }) })), { column: "needsYou", note: NOTE.ciFailedAndComments });
});

test("Ready to ship: the last run passed and has no ship record", () => {
  assert.deepEqual(columnFor(facts({ lastRecord: record(), worktreeExists: true })), { column: "readyToShip", note: null });
});

test("Shipped: the PR/MR is open", () => {
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus() })), { column: "shipped", note: null });
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus({ ci: "pending" }) })), { column: "shipped", note: NOTE.ciRunning });
  // The status was not fetched yet (no error either): the card is shipped, never Ready to ship.
  assert.deepEqual(columnFor(facts({ lastRecord: shipped })), { column: "shipped", note: null });
});

test("merged maps to done; closed unmerged maps to needsYou", () => {
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus({ state: "merged", ci: "failed" }) })), { column: "done", note: null });
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, ship: shipStatus({ state: "closed" }) })), { column: "needsYou", note: NOTE.closedUnmerged });
});

test("interrupted worktree maps to needsYou with Interrupted note", () => {
  assert.deepEqual(columnFor(facts({ worktreeExists: true })), { column: "needsYou", note: "Interrupted" });
});

test("status error keeps the last known column", () => {
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, shipStatusError: true, lastKnownColumn: "needsYou" })), { column: "needsYou", note: "status unavailable" });
  // Nothing known yet: never back to Inbox or Ready to ship.
  assert.deepEqual(columnFor(facts({ lastRecord: shipped, shipStatusError: true })), { column: "shipped", note: "status unavailable" });
});

test("a passed intake-only run goes back to Inbox, ready to start", () => {
  assert.deepEqual(columnFor(facts({ lastRecord: record({ mode: "intakeOnly" }), worktreeExists: true })), { column: "inbox", note: NOTE.intakeReady });
});

test("decodeRunRecordFacts reads the factory fields and rejects other records", () => {
  const raw = { id: "e1", statusCode: "success", endedAt: "2026-11-09T10:00:00.000Z", factoryMode: "intakeOnly", worktree: { runId: "r1", branch: "factory/r1", baseCommit: "abc", repo: "code/web" }, ship: { provider: "gitlab", url: "https://gitlab.com/acme/web/-/merge_requests/3", commit: "def", reused: false }, needsDecision: null };
  const entry = { id: "e1", startedAt: "2026-11-09T09:00:00.000Z" };
  assert.deepEqual(decodeRunRecordFacts(raw, entry), { runId: "r1", mode: "intakeOnly", statusCode: "success", needsDecision: null, ship: { provider: "gitlab", url: "https://gitlab.com/acme/web/-/merge_requests/3" }, reviewedPatchId: null, costUsd: null, durationSeconds: null, verdict: null, changed: null, test: null, failingStage: null, readiness: null, endedAt: "2026-11-09T10:00:00.000Z", entry });
  const reviewed = "d".repeat(64);
  assert.equal(decodeRunRecordFacts({ ...raw, diffSummary: { files: ["src/a.ts"], truncated: false, patchId: reviewed } }).reviewedPatchId, reviewed);
  assert.equal(decodeRunRecordFacts({ ...raw, diffSummary: { files: [], truncated: false, patchId: "short" } }).reviewedPatchId, null, "a malformed id never becomes a comparison");
  assert.equal(decodeRunRecordFacts(raw).entry, null, "no entry given: null");
  assert.equal(decodeRunRecordFacts({ id: "e2", statusCode: "success" }), null, "a non-factory record has no worktree run id");
  assert.equal(decodeRunRecordFacts({ ...raw, worktree: { runId: "../x" } }), null);
  assert.equal(decodeRunRecordFacts({ ...raw, ship: { provider: "github", url: "javascript:alert(1)" } }).ship, null);
  assert.equal(decodeRunRecordFacts({ ...raw, factoryMode: "weird" }).mode, "full");
  assert.equal(decodeRunRecordFacts({ ...raw, needsDecision: "needs decision: see .factory/READINESS.md" }).needsDecision, "needs decision: see .factory/READINESS.md");
  assert.equal(decodeRunRecordFacts(null), null);
});

test("a run marker with no live run is Interrupted, whatever older record exists", () => {
  assert.deepEqual(columnFor(facts({ interrupted: true })), { column: "needsYou", note: NOTE.interrupted });
  assert.deepEqual(columnFor(facts({ interrupted: true, lastRecord: record({ statusCode: "success" }), worktreeExists: true })), { column: "needsYou", note: NOTE.interrupted });
});

test("a record's total cost includes repairs and wins over the stage sum", () => {
  const raw = { statusCode: "success", worktree: { runId: "r1" }, costUsd: 6.1, stages: [{ costUsd: 0.1 }] };
  assert.equal(decodeRunRecordFacts(raw).costUsd, 6.1);
  assert.equal(decodeRunRecordFacts({ ...raw, costUsd: undefined }).costUsd, 0.1, "old records fall back to stages");
});

test("D2a: decodeRunRecordFacts reads verdict, numstat, verify and the failing stage", () => {
  const raw = {
    statusCode: "failed", statusSummary: "Verify failed", needsDecision: "Use Postgres?",
    worktree: { runId: "r1" }, costUsd: 1.2,
    diffSummary: { files: ["src/a.ts", "src/b.ts"], additions: 12, deletions: 3, patchId: null },
    config: { stages: [{ id: "v", name: "Verify", kind: "shellCommand", command: "make test" }, { id: "x", name: "Other", kind: "shellCommand" }] },
    stages: [{ stageName: "Verify", costUsd: 1.2, run: { exitCode: 1, stdout: "boom\nsecond\nthird\nfourth" } }],
  };
  const f = decodeRunRecordFacts(raw);
  assert.equal(f.verdict, "Verify failed");
  assert.deepEqual(f.changed, { files: 2, additions: 12, deletions: 3, truncated: false });
  assert.deepEqual(f.test, { command: "make test", ok: false });
  assert.equal(f.failingStage, null, "a needs-decision run has no failing stage");
  assert.equal(f.readiness, "Use Postgres?");
  const failed = decodeRunRecordFacts({ ...raw, needsDecision: null });
  assert.equal(failed.failingStage.name, "Verify");
  assert.equal(failed.failingStage.error, "boom\nsecond\nthird");
});

test("R-049: the last Verify wins, and a pass or needs-decision has no failing stage", () => {
  const raw = {
    statusCode: "success", worktree: { runId: "r1" },
    config: { stages: [{ id: "v", name: "Verify", kind: "shellCommand", command: "make test" }] },
    stages: [{ stageName: "Verify", run: { exitCode: 1, stdout: "red" } }, { stageName: "Verify", run: { exitCode: 0, stdout: "green" } }],
  };
  const f = decodeRunRecordFacts(raw);
  assert.deepEqual(f.test, { command: "make test", ok: true });
  assert.equal(f.failingStage, null);
  assert.equal(decodeRunRecordFacts({ ...raw, statusCode: "failed" }).failingStage.name, "Verify");
  assert.equal(decodeRunRecordFacts({ ...raw, statusCode: "failed", needsDecision: "Which database?" }).failingStage, null);
});
