// The decision flow behind the cards, free of React so it is tested with plain fakes: binding check, in-flight lock,
// the core call, and the batch loop. Reads the CURRENT queue and UI through getters, so a closure never acts on a
// stale copy.
import type { DecisionResult } from "../controller";
import type { PendingApproval } from "../state";
import { approvalDigest } from "./digest";
import { checkBinding, type QueueUi, type UiAction } from "./machine";

export type DecideRequest = { requestId: string; action: "allow" | "deny" | "always-allow" | "answer"; answers?: Record<string, string>; feedback?: string };

export interface DeciderDeps {
  getUi: () => QueueUi;
  getPending: () => readonly PendingApproval[];
  dispatch: (a: UiAction) => void;
  decide: (req: DecideRequest) => Promise<DecisionResult>;
}

export const CHANGED_MESSAGE = "This request changed after it was shown. Review it again before answering.";

/** Record every listed member as SHOWN (its digest is what a later decision is bound to). Call when the members are put on screen. */
export function showMembers(dispatch: (a: UiAction) => void, members: readonly PendingApproval[]): void {
  for (const m of members) dispatch({ type: "show", requestId: m.requestId, digest: approvalDigest(m) });
}

export function makeDecider(d: DeciderDeps) {
  /** One decision. True only when the core accepted it. A refusal leaves the request pending (or expired), never allowed. */
  async function send(a: PendingApproval, req: Omit<DecideRequest, "requestId">): Promise<boolean> {
    if (d.getUi().cards[a.requestId]?.phase === "submitting") return false;
    const live = d.getPending().find((p) => p.requestId === a.requestId);
    if (!live) return false;
    if (!checkBinding(d.getUi(), live).ok) {
      d.dispatch({ type: "show", requestId: live.requestId, digest: approvalDigest(live) });
      d.dispatch({ type: "failed", requestId: live.requestId, error: CHANGED_MESSAGE });
      return false;
    }
    d.dispatch({ type: "submitting", requestId: a.requestId });
    const r = await d.decide({ requestId: a.requestId, ...req });
    if (r.ok) return true;
    d.dispatch({ type: r.permanent ? "expired" : "failed", requestId: a.requestId, error: r.message });
    return false;
  }

  /** Allow once for each member, in order, each with its own binding check. Stops at the first refusal. Returns how many were allowed. */
  async function batch(group: readonly PendingApproval[], progress: (done: number, total: number) => void): Promise<number> {
    let done = 0;
    progress(0, group.length);
    for (const g of group) {
      if (!(await send(g, { action: "allow" }))) break;
      progress(++done, group.length);
    }
    return done;
  }
  return { send, batch };
}
