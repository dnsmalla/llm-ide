import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteBanner, remoteFallbackAction } from "../remote-status.ts";

test("offline shows a banner; only the explicit action switches mode and restarts", async () => {
  assert.equal(remoteBanner("online", true), null);
  assert.match(remoteBanner("offline", true).title, /unreachable/i);
  assert.match(remoteBanner("offline", true, "HUB_PIN_MISMATCH").title, /certificate changed/i);
  assert.match(remoteBanner("offline", true, "HUB_PIN_MISMATCH").body, /re-probe|probe it again/i);
  const calls = [];
  await remoteFallbackAction({ setMode: async (m) => calls.push(["mode", m]), restart: async () => calls.push(["restart"]) });
  assert.deepEqual(calls, [["mode", "local"], ["restart"]]);
});

test("R-034 #11: only a pin mismatch is kept as the hub error, and success clears it", async () => {
  const { noteHubError, getHubError, subscribeHubError } = await import("../remote-status.ts");
  let calls = 0;
  const off = subscribeHubError(() => { calls += 1; });
  noteHubError("HUB_UNREACHABLE");
  assert.equal(getHubError(), null);
  noteHubError("HUB_PIN_MISMATCH");
  assert.equal(getHubError(), "HUB_PIN_MISMATCH");
  noteHubError(null);
  assert.equal(getHubError(), null);
  off();
  assert.equal(calls, 2);
});
