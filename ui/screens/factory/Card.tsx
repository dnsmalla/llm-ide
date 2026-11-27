// One Factory card: title, source, the derived note and the actions its column allows.
import { useState, type ReactNode } from "react";
import { ACTION_LABELS, SOURCE_LABELS, cardTone, formatDuration, loopbackTitle, type CardAction, type CardView } from "./board-model.ts";
import { decodeWorktreeStatus, discardWarning, type WorktreeStatus } from "../loop/native/ship-model.ts";
import { formatStepReviews } from "../loop/native/issue-trail.ts";

/** A board's own answer to "may this card be discarded?": confirm with its text, or stop (the board said why itself). */
export type DiscardCheck = () => Promise<
  | { kind: "confirm"; text: string; /** The confirm button's label (default "Discard"). */ label?: string; /** Reads the worktree status the confirm states; absent = no status line. */ readStatus?: () => Promise<unknown>; provider?: "github" | "gitlab" | null; /** Runs on confirm instead of `onAction("discard")`, so each open confirm acts on its own card. */ onConfirm?: () => void | Promise<void> }
  | { kind: "stop" }
>;

export function Card({ view, selected, onOpen, onAction, onDiscardStatus, requestProvider = null, busy = false, discardCheck }: {
  view: CardView;
  selected: boolean;
  onOpen: () => void;
  onAction: (action: CardAction, note?: string) => void;
  /** Reads the item's worktree status before the confirm, so the confirm can state the numbers. */
  onDiscardStatus?: () => Promise<unknown>;
  requestProvider?: "github" | "gitlab" | null;
  /** Approve is shipping: it cannot be clicked again. */
  busy?: boolean;
  /** A board with its own Discard cases (refused, already gone, hide-only) decides here before the confirm shows. */
  discardCheck?: DiscardCheck;
}): ReactNode {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [custom, setCustom] = useState<Extract<Awaited<ReturnType<DiscardCheck>>, { kind: "confirm" }> | null>(null);
  const [checking, setChecking] = useState(false);
  const [discardStatus, setDiscardStatus] = useState<WorktreeStatus | null>(null);
  const [readingDiscard, setReadingDiscard] = useState(false);
  const [noteFor, setNoteFor] = useState<"sendBack" | "requestChanges" | null>(null);
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  return (
    <li className="fx-card" data-key={view.key} data-selected={selected} data-tone={cardTone(view.status)} onKeyDown={(e) => { if (e.key === "Escape") { setConfirmDiscard(false); setCustom(null); setNoteFor(null); setNote(""); } }}>
      <div className="fx-card-top">
        <span className="fx-status">{view.status}</span>
        {view.note ? <span className="fx-note">{view.note}</span> : null}
        <span className="fx-source">{SOURCE_LABELS[view.source]}</span>
      </div>
      <button type="button" className="fx-card-title" onClick={onOpen} title="Show details">{view.title}</button>
      {view.progress != null ? <div className="fx-progress" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress * 100)}><span style={{ width: `${Math.round(view.progress * 100)}%` }} /></div> : null}
      {view.progressLabel || view.durationSeconds != null || (view.costUsd != null && view.costUsd > 0) ? (
        <div className="fx-card-meta">
          {view.progressLabel ? <span>{view.progressLabel}</span> : null}
          {view.durationSeconds != null ? <span>{formatDuration(view.durationSeconds)}</span> : null}
          {view.costUsd != null && view.costUsd > 0 ? <span>${view.costUsd.toFixed(2)}</span> : null}
        </div>
      ) : null}
      {view.request ? <button type="button" className="fx-link" data-tour-id="done-mr-link" onClick={() => onAction("openRequest")}>{view.request.label}</button> : null}
      {view.lastLine ? <p className="fx-card-line" title={view.lastLine}>{view.lastLine.slice(0, 120)}</p> : null}
      {view.verdict ? <p className="fx-hint">{view.verdict}</p> : null}
      {view.stepReviews ? <p className="fx-hint">Step reviews: {formatStepReviews(view.stepReviews)}</p> : null}
      {view.notShipped ? <p className="fx-hint" role="note">Not shipped: {view.notShipped}</p> : null}
      {view.shipOverride ? <p className="fx-hint">Shipped past a secret hit: {view.shipOverride.rule}{view.shipOverride.file ? ` at ${view.shipOverride.file}${view.shipOverride.line ? `:${view.shipOverride.line}` : ""}` : ""}.</p> : null}
      {view.changed ? <p className="fx-hint">{view.changed.files}{view.changed.truncated ? "+" : ""} file{view.changed.files === 1 ? "" : "s"}{view.changed.additions != null ? ` · +${view.changed.additions}/−${view.changed.deletions ?? 0}` : ""}</p> : null}
      {view.test ? <p className="fx-hint">Test: {view.test.ok === null ? "unknown" : view.test.ok ? "passed" : "failed"}{view.test.command ? ` · ${view.test.command}` : ""}</p> : null}
      {view.loopback ? <div className="fx-failure" role="alert"><strong>{loopbackTitle(view.loopback)}</strong>{view.loopback.findings.trim() ? <pre>{view.loopback.findings}</pre> : null}</div> : null}
      {view.failingStage ? <div className="fx-failure"><strong>{view.failingStage.name}</strong><pre>{view.failingStage.error}</pre></div> : null}
      {view.readiness ? (
        <form className="fx-form" aria-label="Answer the decision" onSubmit={(e) => { e.preventDefault(); if (!answer.trim()) return; onAction("answer", answer); setAnswer(""); }}>
          <p className="fx-hint">{view.readiness}</p>
          <label className="fx-field fx-grow"><span>Answer</span><textarea rows={3} maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
          <button type="submit" className="fx-btn fx-primary" disabled={!answer.trim()}>Answer &amp; continue</button>
        </form>
      ) : null}
      {noteFor ? (
        // One form for both: Send back (note optional, CI and comments go with it) and Request changes (note required).
        <form className="fx-form" aria-label={ACTION_LABELS[noteFor]} onSubmit={(e) => { e.preventDefault(); if (noteFor === "requestChanges" && !note.trim()) return; const which = noteFor; setNoteFor(null); onAction(which, note); setNote(""); }}>
          <label className="fx-field fx-grow"><span>{noteFor === "requestChanges" ? "What should change" : "Note for the agent (optional)"}</span><textarea rows={3} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
          {noteFor === "sendBack" ? <span className="fx-hint">The failing CI output and new review comments go with it, fenced as data.</span> : null}
          <button type="submit" className="fx-btn fx-primary" disabled={noteFor === "requestChanges" && !note.trim()}>{ACTION_LABELS[noteFor]}</button>
          <button type="button" className="fx-btn" onClick={() => setNoteFor(null)}>Cancel</button>
        </form>
      ) : null}
      {confirmDiscard ? (
        <div className="fx-actions" role="group" aria-label="Confirm discard">
          <span className="fx-hint" role="alert">{custom ? custom.text : "Remove this card and its worktree?"}{!custom || custom.readStatus ? <> {readingDiscard ? "Reading the worktree…" : discardWarning(discardStatus, (custom ? custom.provider ?? null : requestProvider) ? { provider: (custom ? custom.provider : requestProvider) as "github" | "gitlab" } : null)}</> : null}</span>
          <button type="button" className="fx-btn fx-danger" disabled={readingDiscard} onClick={() => { const confirm = custom?.onConfirm; setConfirmDiscard(false); setCustom(null); if (confirm) void confirm(); else onAction("discard"); }}>{custom?.label ?? "Discard"}</button>
          <button type="button" className="fx-btn" onClick={() => { setConfirmDiscard(false); setCustom(null); setDiscardStatus(null); }}>Cancel</button>
        </div>
      ) : view.actions.length > 0 ? (
        <div className="fx-actions">
          {view.actions.map((a) => (
            <button key={a} type="button" data-tour-id={`card-action-${a}`} disabled={(busy && a === "approve") || (checking && a === "discard")} className={a === "start" || a === "ship" || a === "finishChecks" || a === "approve" || a === "done" ? "fx-btn fx-primary" : "fx-btn"} onClick={() => {
              if (a === "discard") {
                const readStatus = (read: () => Promise<unknown>) => {
                  setReadingDiscard(true);
                  void read().then((raw) => setDiscardStatus(decodeWorktreeStatus(raw))).catch(() => setDiscardStatus(null)).finally(() => setReadingDiscard(false));
                };
                if (discardCheck) {
                  setChecking(true);
                  void discardCheck().then((r) => {
                    if (r.kind === "stop") return;
                    setCustom(r);
                    setConfirmDiscard(true);
                    setDiscardStatus(null);
                    if (r.readStatus) readStatus(r.readStatus);
                  }).catch(() => undefined).finally(() => setChecking(false));
                  return;
                }
                setConfirmDiscard(true);
                setDiscardStatus(null);
                if (onDiscardStatus) readStatus(onDiscardStatus);
                return;
              }
              if (a === "sendBack" || a === "requestChanges") setNoteFor(a);
              else onAction(a);
            }}>{ACTION_LABELS[a]}</button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
