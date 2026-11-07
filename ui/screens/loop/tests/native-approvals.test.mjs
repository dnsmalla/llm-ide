import { test } from "node:test";
import assert from "node:assert/strict";
import { setHostBridge } from "../../shell/host.ts";
import { approvalStatus, approveLoop, approveStage, revokeApprovals } from "../native/approvals.ts";

test("Loop approvals are host-minted and carry the exact loop/stage arguments", async () => {
  const calls = [];
  const approval = { token: "host-token", expiresAtMs: 42, stageIds: ["s1"], faultCount: 0 };
  const status = { approved: true, pending: 0, expiresAtMs: 42, token: "host-token" };
  setHostBridge({
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "loop_approve_loop" || command === "loop_approve_stage") return approval;
      if (command === "loop_approval_status") return status;
      return null;
    },
  });
  try {
    assert.deepEqual(await approveLoop("l1"), approval);
    assert.deepEqual(await approveStage("s1", "l1"), approval);
    assert.deepEqual(await approveStage("s1", null), approval);
    assert.deepEqual(await approvalStatus("l1"), status);
    await revokeApprovals();
    assert.deepEqual(calls, [
      ["loop_approve_loop", { loopId: "l1" }],
      ["loop_approve_stage", { stageId: "s1", loopId: "l1" }],
      ["loop_approve_stage", { stageId: "s1" }],
      ["loop_approval_status", { loopId: "l1" }],
      ["loop_revoke_approvals", undefined],
    ]);
    // A declined native dialog comes back as null, not as a page-made token.
    setHostBridge({ invoke: async () => null });
    assert.equal(await approveLoop("l1"), null);
  } finally {
    setHostBridge(null);
  }
});
