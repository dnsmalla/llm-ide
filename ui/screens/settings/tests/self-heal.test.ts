import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeDiff, decodeIncidents, decodePrepared, decodeVerified, incidentSummary, proposalsOf, STATUS_TEXT } from "../self-heal-model.ts";

const row = (o: Record<string, unknown> = {}) => ({
  id: "3f9a1c0b7d2e4a65", source: "server", category: "POST /kb/notes/:id", message: "db is locked",
  stack: "Error: db is locked\n    at x (~/llm-ide/extension/kb/db.mjs:9:1)", environmental: null, firstSeen: 1, lastSeen: 2,
  count: 3, attempts: 0, status: "new", note: null, proposal: null, ...o,
});

test("decodeIncidents keeps well-formed rows, cleans the text and drops the rest", () => {
  const out = decodeIncidents({ incidents: [row(), row({ id: "nothex" }), row({ status: "done" }), row({ source: "x" }), row({ count: -1 }), null,
    row({ id: "0000000000000001", message: "a‮b\nc", stack: null, environmental: "offline" })] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].stack, ["Error: db is locked", "at x (~/llm-ide/extension/kb/db.mjs:9:1)"]);
  assert.equal(out[1].message, "ab c", "bidi controls and newlines cannot disguise the text");
  assert.deepEqual(out[1].stack, []);
  assert.equal(out[1].environmental, "offline");
  assert.deepEqual(decodeIncidents(null), []);
  assert.deepEqual(decodeIncidents({ incidents: "x" }), []);
});

test("the summary counts incidents and the environmental ones; every status has words", () => {
  assert.equal(incidentSummary([]), "No incidents recorded.");
  const list = decodeIncidents({ incidents: [row(), row({ id: "0000000000000001", environmental: "auth" })] });
  assert.equal(incidentSummary(list), "2 incidents, 1 environmental (not app bugs).");
  assert.equal(incidentSummary(list.slice(0, 1)), "1 incident.");
  assert.deepEqual(Object.keys(STATUS_TEXT).sort(), ["fixed", "fixing", "ignored", "needsHuman", "new", "proposed"]);
});

const RUN = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const proposal = { mainRepo: "/src", worktreePath: `/data/self-heal/loop-worktrees/${RUN}`, branch: `self-heal/${RUN}`, baseCommit: "a".repeat(40) };

test("proposals: decoded only on proposed rows, grouped by run with their notes", () => {
  const list = decodeIncidents({ incidents: [
    row({ status: "proposed", note: "guard the null", proposal }),
    row({ id: "0000000000000001", status: "proposed", note: null, proposal }),
    row({ id: "0000000000000002", status: "new", proposal }),
    row({ id: "0000000000000003", status: "proposed", proposal: { ...proposal, branch: "main" } }),
  ] });
  assert.equal(list[0].note, "guard the null");
  assert.equal(list[2].proposal, null, "a proposal on a row that is not proposed is ignored");
  assert.equal(list[3].proposal, null, "a branch that is not self-heal/<uuid> is ignored");
  assert.deepEqual(proposalsOf(list), [{ runId: RUN, worktreePath: proposal.worktreePath, incidentIds: ["3f9a1c0b7d2e4a65", "0000000000000001"], notes: ["guard the null"] }]);
});

test("host answers are decoded strictly; hidden marks in a diff are made visible", () => {
  assert.deepEqual(decodePrepared(proposal), proposal);
  assert.equal(decodePrepared({ ...proposal, branch: "self-heal/x" }), null);
  assert.equal(decodePrepared({ ...proposal, baseCommit: "HEAD" }), null);
  assert.deepEqual(decodeVerified({ batch: "b", passed: true, timedOut: false, hasChanges: false, reverted: ["Makefile", 3], output: "ok" }), { batch: "b", passed: true, timedOut: false, hasChanges: false, reverted: ["Makefile"], output: "ok" });
  assert.equal(decodeVerified({ batch: "b", passed: "yes" }), null);
  assert.deepEqual(decodeDiff({ text: "+a‮b\n", truncated: false, patchId: "f".repeat(64) }), { text: "+a�b\n", truncated: false, patchId: "f".repeat(64) });
  assert.equal(decodeDiff({ text: "x", truncated: false, patchId: "short" }), null);
});
