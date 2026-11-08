import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteBanner, remoteFallbackAction } from "../remote-status.ts";

test("offline shows a banner; only the explicit action switches mode and restarts", async () => {
  assert.equal(remoteBanner("online", true), null);
  assert.match(remoteBanner("offline", true).title, /unreachable/i);
  const calls = [];
  await remoteFallbackAction({ setMode: async (m) => calls.push(["mode", m]), restart: async () => calls.push(["restart"]) });
  assert.deepEqual(calls, [["mode", "local"], ["restart"]]);
});
