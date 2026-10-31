// The queue of parked approvals and questions for the running turn (S-G). Shows ONE request at a time (the oldest),
// a bounded "next up" list and a visible counter, so hundreds of queued approvals stay cheap and no approval is
// answered unseen. Plan cards (S-L) mount through `extra`. Fail closed everywhere: nothing is allowed unless the
// core confirmed it.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { ChatState, PendingApproval } from "../state";
import type { DecisionResult } from "../controller";
import { ApprovalCard, type ToolAction } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { approvalDigest } from "./digest";
import { makeDecider, type DecideRequest } from "./decider";
import { batchGroup, counterText, emptyQueueUi, headOf, reduceUi, summarize } from "./machine";
import { classifyApproval, toolTitle } from "./risk";
import { sanitizeText } from "./sanitize";

export type { DecideRequest };

export interface ApprovalsPanelProps {
  state: Pick<ChatState, "pendingApprovals" | "phase">;
  projectRoot: string | null;
  decide: (req: DecideRequest) => Promise<DecisionResult>;
  /** S-L hook: plan cards rendered above the approvals, inside the same region. */
  extra?: ReactNode;
}

const NEXT_UP = 5;

export function ApprovalsPanel({ state, projectRoot, decide, extra }: ApprovalsPanelProps) {
  const pending = state.pendingApprovals;
  const [ui, dispatch] = useReducer(reduceUi, emptyQueueUi);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const cardEl = useRef<HTMLElement | null>(null);
  const uiRef = useRef(ui); uiRef.current = ui;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const head = headOf(pending, ui);
  const turnClosed = state.phase !== "streaming";

  // What the card shows is what a decision is bound to: record the digest when the head is displayed.
  const headDigest = head ? approvalDigest(head) : null;
  useEffect(() => { if (head && headDigest) dispatch({ type: "show", requestId: head.requestId, digest: headDigest }); }, [head?.requestId, headDigest]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { dispatch({ type: "prune", keep: pending.map((p) => p.requestId) }); }, [pending]);

  // A new request takes focus only when the user is not typing; Alt+. jumps to it from anywhere.
  useEffect(() => {
    if (!head) return;
    const a = document.activeElement as HTMLElement | null;
    const typing = a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable);
    if (!typing) cardEl.current?.focus();
  }, [head?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.altKey && e.key === "." && cardEl.current) { e.preventDefault(); cardEl.current.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const decider = useMemo(() => makeDecider({ getUi: () => uiRef.current, getPending: () => pendingRef.current, dispatch, decide }), [decide]);
  const send = decider.send;
  const onBatch = useCallback(async (group: PendingApproval[]) => {
    await decider.batch(group, (done, total) => setBatchProgress(done < total || total === 0 ? { done, total } : null));
    setBatchProgress(null);
  }, [decider]);

  const summary = useMemo(() => summarize(pending, projectRoot), [pending, projectRoot]);
  const group = useMemo(() => batchGroup(pending, head, projectRoot, ui), [pending, head, projectRoot, ui]);
  if (pending.length === 0) return extra ? <div className="appr-region">{extra}</div> : null;
  const position = head ? pending.indexOf(head) + 1 : 0;
  const upcoming = pending.filter((p) => p !== head && ui.cards[p.requestId]?.phase !== "expired");

  return (
    <div className="appr-region" role="region" aria-label="Requests waiting for you">
      <p className="appr-sr" role="status" aria-live="polite">{counterText(position || 1, pending.length)}{summary.needsIndividualReview ? `, ${summary.needsIndividualReview} need individual review` : ""}</p>
      {extra}
      {pending.length > 1 && (
        <p className="chat-muted appr-counter">
          {pending.length} waiting{summary.needsIndividualReview ? `, ${summary.needsIndividualReview} need individual review` : ""}. Press Alt+. to jump to the current request.
        </p>
      )}
      {head && head.kind === "ToolApproval" && (
        <ApprovalCard
          key={head.requestId} approval={head} ui={ui.cards[head.requestId]} projectRoot={projectRoot} position={position} total={pending.length}
          batch={group} turnClosed={turnClosed} batchProgress={batchProgress} cardRef={(n) => { cardEl.current = n; }}
          onDecide={(action: ToolAction, feedback) => { void send(head, { action, feedback }); }}
          onConfirmRule={(on) => dispatch({ type: "confirm_rule", requestId: head.requestId, on })}
          onBatch={() => void onBatch(group)}
        />
      )}
      {head && head.kind === "AskUserQuestion" && (
        <div ref={(n) => { cardEl.current = n; }} tabIndex={-1}>
          <QuestionCard
            key={head.requestId} approval={head} ui={ui.cards[head.requestId]} position={position} total={pending.length} turnClosed={turnClosed}
            onAnswer={(answers) => { void send(head, { action: "answer", answers }); }} onDecline={() => { void send(head, { action: "deny" }); }}
          />
        </div>
      )}
      {upcoming.length > 0 && (
        <ul className="appr-next" aria-label="Next requests">
          {upcoming.slice(0, NEXT_UP).map((p) => (
            <li key={p.requestId} className="chat-muted">
              {p.kind === "AskUserQuestion" ? "Question" : toolTitle(p.toolName)}
              {p.kind === "ToolApproval" && (() => { const r = classifyApproval(p, projectRoot); const t = r.path ?? p.argsSummary ?? ""; return t ? `: ${sanitizeText(t, 120).text}` : ""; })()}
            </li>
          ))}
          {upcoming.length > NEXT_UP && <li className="chat-muted">and {upcoming.length - NEXT_UP} more</li>}
        </ul>
      )}
    </div>
  );
}
