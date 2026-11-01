import { test } from "node:test";
import assert from "node:assert/strict";
import * as a from "../native/approvals.ts";

test("Loop command approvals are per project and survive a re-read", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  assert.equal(a.isApproved("/p", "npm test", storage), false);
  a.approve("/p", "npm test", storage);
  assert.equal(a.isApproved("/p", "npm test", storage), true);
  assert.equal(a.isApproved("/other", "npm test", storage), false);
  a.revokeAll(storage);
  assert.equal(a.isApproved("/p", "npm test", storage), false);
});
