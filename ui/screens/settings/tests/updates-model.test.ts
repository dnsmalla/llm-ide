// ui/screens/settings/tests/updates-model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeUpdateStatus, updateSummary } from "../updates-model.ts";

const base = { configured: true, reason: null, installKind: "self", available: null, lastCheckedMs: null, error: null };

test("decode rejects junk and keeps only known fields", () => {
  assert.equal(decodeUpdateStatus(null), null);
  assert.equal(decodeUpdateStatus({ configured: "yes" }), null);
  const s = decodeUpdateStatus({ ...base, available: { version: "0.3.0", notes: "x".repeat(5000) }, extra: 1 });
  assert.equal(s?.available?.version, "0.3.0");
  assert.equal(s?.available?.notes.length, 2000);
  assert.equal("extra" in (s as object), false);
});

test("summary text for each state", () => {
  assert.match(updateSummary(decodeUpdateStatus({ ...base, configured: false, reason: "no_update_config" })), /no update channel/i);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, installKind: "package" })), /package manager/i);
  assert.match(updateSummary(decodeUpdateStatus(base)), /not checked yet/i);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, lastCheckedMs: 1 })), /up to date/i);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, lastCheckedMs: 1, available: { version: "0.3.0", notes: "" } })), /0\.3\.0 is available/);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, error: "offline" })), /could not check/i);
  assert.match(updateSummary(null), /reading/i);
});
