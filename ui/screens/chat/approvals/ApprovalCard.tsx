// One parked tool approval. Stateless about the decision (the panel owns I/O); local state is only the optional
// deny note and the batch review toggle. Tool arguments are untrusted: everything shown comes from buildPreview.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PendingApproval } from "../state";
import { ArgsPreview } from "./ArgsPreview";
import { counterText, nextFocusIndex, shortcutFor, type CardUi } from "./machine";
import { buildPreview } from "./preview";
import { classifyApproval, toolTitle } from "./risk";
import { describeRule } from "./rules";
import { sanitizeText } from "./sanitize";

export type ToolAction = "allow" | "deny" | "always-allow";

export interface ApprovalCardProps {
  approval: PendingApproval;
  ui: CardUi | undefined;
  projectRoot: string | null;
  position: number;
  total: number;
  /** Requests that can be allowed together with this one (empty = no batch offered). */
  batch: PendingApproval[];
  /** The turn is not running (stopping or over): nothing can be answered. */
  turnClosed: boolean;
  onDecide: (action: ToolAction, feedback?: string) => void;
  onConfirmRule: (on: boolean) => void;
  onBatch: () => void;
  batchProgress: { done: number; total: number } | null;
  cardRef?: (el: HTMLElement | null) => void;
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex='0']";

export function ApprovalCard({ approval, ui, projectRoot, position, total, batch, turnClosed, onDecide, onConfirmRule, onBatch, batchProgress, cardRef }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const [reviewBatch, setReviewBatch] = useState(false);
  const el = useRef<HTMLElement | null>(null);
  const risk = useMemo(() => classifyApproval(approval, projectRoot), [approval, projectRoot]);
  const preview = useMemo(() => buildPreview(approval), [approval]);
  const rule = useMemo(() => describeRule(approval.suggestion, risk, projectRoot), [approval.suggestion, risk, projectRoot]);
  const phase = ui?.phase ?? "idle";
  const locked = turnClosed || phase === "submitting" || phase === "expired" || batchProgress !== null;
  const title = toolTitle(approval.toolName);
  const sessionRule = rule.ok && rule.view.scope === "session" ? rule.view : null;
  const projectRule = rule.ok && rule.view.scope === "project" ? rule.view : null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Tab" && el.current) {
      const items = Array.from(el.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const i = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (i >= 0) { e.preventDefault(); items[i].focus(); }
      return;
    }
    const k = shortcutFor(e);
    if (!k || locked) return;
    e.preventDefault();
    if (k === "allow") onDecide("allow");
    else if (k === "deny") onDecide("deny", note);
    else if (k === "rule" && projectRule) onConfirmRule(true);
    else if (k === "session" && sessionRule) onConfirmRule(true);
  };

  return (
    <section
      ref={(n) => { el.current = n; cardRef?.(n); }} className="appr-card" tabIndex={-1} onKeyDown={onKeyDown}
      role="group" aria-label={`Approval needed: ${title}`} aria-describedby={`appr-note-${approval.requestId}`}
      data-risk={risk.risk} data-destructive={risk.destructive} data-phase={phase}
    >
      <header className="appr-head">
        <h3 className="appr-title">{title}</h3>
        <span className="appr-badge" data-destructive={risk.destructive}>{risk.label}</span>
        <span className="chat-spacer" />
        <span className="chat-muted" aria-label={counterText(position, total)}>{position} of {total}</span>
      </header>
      {risk.path && <p className="appr-path" data-outside={risk.outsideProject}>{sanitizeText(risk.path, 1_000).text}{risk.outsideProject ? " (outside the open project)" : ""}</p>}
      {risk.reasons.length > 0 && <ul className="appr-reasons" aria-label="Why this needs your attention">{risk.reasons.map((r) => <li key={r}>This call {r}.</li>)}</ul>}
      <ArgsPreview preview={preview} />
      {ui?.error && <p role="alert" className="chat-error">{ui.error}{phase === "failed" ? " Nothing was allowed. Choose again to retry." : ""}</p>}

      {ui?.confirmingRule && rule.ok && (
        <div role="group" aria-label="Confirm saved rule" className="appr-rule">
          <p><strong>This will save a rule.</strong> It lets the assistant do the following without asking:</p>
          <p className="appr-exact">{rule.view.exact}</p>
          <p className="chat-muted">{rule.view.scopeText} {rule.view.revoke}</p>
          <div className="appr-actions">
            <button type="button" className="chat-btn chat-primary" disabled={locked} onClick={() => onDecide("always-allow")}>Save rule and allow</button>
            <button type="button" className="chat-btn" disabled={locked} onClick={() => onConfirmRule(false)}>Back</button>
          </div>
        </div>
      )}

      {!ui?.confirmingRule && (
        <>
          <div className="appr-actions">
            <button type="button" className="chat-btn chat-primary" disabled={locked} aria-keyshortcuts="Alt+Y" title="Alt+Y" onClick={() => onDecide("allow")}>Allow once</button>
            {sessionRule && <button type="button" className="chat-btn" disabled={locked} aria-keyshortcuts="Alt+S" title="Alt+S" onClick={() => onConfirmRule(true)}>{sessionRule.button}</button>}
            {projectRule && <button type="button" className="chat-btn" disabled={locked} aria-keyshortcuts="Alt+A" title="Alt+A" onClick={() => onConfirmRule(true)}>{projectRule.button}</button>}
            <button type="button" className="chat-btn chat-danger" disabled={locked} aria-keyshortcuts="Alt+N" title="Alt+N" onClick={() => onDecide("deny", note)}>Deny</button>
          </div>
          <input className="chat-input appr-note-input" aria-label="Optional note to the assistant, sent with Deny" placeholder="Or tell it what to do instead, then Deny (optional)"
            value={note} maxLength={2000} disabled={locked} onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && note.trim() && !locked) { e.preventDefault(); onDecide("deny", note); } }} />
          {!rule.ok && approval.suggestion && <p className="chat-muted">{rule.reason}</p>}
        </>
      )}

      {batch.length > 0 && (
        <div className="appr-batch">
          {!reviewBatch ? (
            <button type="button" className="chat-link-btn" disabled={locked} onClick={() => setReviewBatch(true)}>Review {batch.length} similar edits together...</button>
          ) : (
            <div role="group" aria-label={`Allow ${batch.length} edits together`}>
              <p>Allow these {batch.length} edits once each. Each is checked against what was shown for it.</p>
              <ul className="appr-batch-list" aria-label="Files in this batch">
                {batch.map((b) => <li key={b.requestId}>{sanitizeText(classifyApproval(b, projectRoot).path ?? b.argsSummary ?? "", 300).text}</li>)}
              </ul>
              {batchProgress && <p role="status" aria-live="polite">Allowing {batchProgress.done} of {batchProgress.total}...</p>}
              <div className="appr-actions">
                <button type="button" className="chat-btn chat-primary" disabled={locked} onClick={onBatch}>Allow {batch.length} edits once</button>
                <button type="button" className="chat-btn" disabled={locked} onClick={() => setReviewBatch(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      <p id={`appr-note-${approval.requestId}`} className="chat-muted">
        {turnClosed ? "The turn is stopping; this request can no longer be answered." : phase === "expired" ? "Expired. This request can no longer be answered." : "Waiting for you. It is never allowed automatically, and a timeout only denies."}
      </p>
    </section>
  );
}
