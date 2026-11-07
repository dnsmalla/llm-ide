import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeIncidents, incidentSummary, STATUS_TEXT } from "../self-heal-model.ts";

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
