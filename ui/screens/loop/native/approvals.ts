// Host-minted approvals for Loop shell commands (R-014#2). This module carries ONLY the opaque token the Rust host
// returns after its native Cancel-first dialog; the token is bound to the exact command hash, loop/stage, working
// folder and an expiry. A page-side string is never accepted by the host, and there is no localStorage "approved"
// list: editing system/loop.json invalidates the host approval and the run is refused.
import { invokeHost } from "../../shell/host.ts";

export interface LoopApproval {
  token: string;
  expiresAtMs: number;
  stageIds: string[];
  faultCount: number;
}

export interface LoopApprovalStatus {
  approved: boolean;
  pending: number;
  expiresAtMs: number | null;
  token: string | null;
}

/** Native dialog for a whole loop, or an existing valid grant for the exact same commands. `null` = declined. */
export async function approveLoop(loopId: string): Promise<LoopApproval | null> {
  return invokeHost<LoopApproval | null>("loop_approve_loop", { loopId });
}

/** Native dialog for one stage (its shell command, or a Regression stage's fault verify commands). */
export async function approveStage(stageId: string, loopId: string | null): Promise<LoopApproval | null> {
  return invokeHost<LoopApproval | null>("loop_approve_stage", loopId === null ? { stageId } : { stageId, loopId });
}

/** Whether a valid approval already covers the loop's exact current commands. Never shows a dialog. */
export async function approvalStatus(loopId: string): Promise<LoopApprovalStatus> {
  return invokeHost<LoopApprovalStatus>("loop_approval_status", { loopId });
}

/** Drops every Loop approval this app has minted. */
export async function revokeApprovals(): Promise<void> {
  await invokeHost<unknown>("loop_revoke_approvals");
}
