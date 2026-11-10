// One Factory card: title, source, the derived note and the actions its column allows.
import { useState, type ReactNode } from "react";
import { ACTION_LABELS, SOURCE_LABELS, formatDuration, type CardAction, type CardView } from "./board-model.ts";
import { decodeWorktreeStatus, discardWarning, type WorktreeStatus } from "../loop/native/ship-model.ts";

export function Card({ view, selected, onOpen, onAction, onDiscardStatus, requestProvider = null }: {
  view: CardView;
  selected: boolean;
  onOpen: () => void;
  onAction: (action: CardAction, note?: string) => void;
  /** Reads the item's worktree status before the confirm, so the confirm can state the numbers. */
  onDiscardStatus?: () => Promise<unknown>;
  requestProvider?: "github" | "gitlab" | null;
}): ReactNode {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discardStatus, setDiscardStatus] = useState<WorktreeStatus | null>(null);
  const [readingDiscard, setReadingDiscard] = useState(false);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  return (
    <li className="fx-card" data-key={view.key} data-selected={selected} onKeyDown={(e) => { if (e.key === "Escape") { setConfirmDiscard(false); setSendBackOpen(false); setNote(""); } }}>
      <button type="button" className="fx-card-title" onClick={onOpen} title="Show details">{view.title}</button>
      <div className="fx-card-meta">
        <span className="fx-source">{SOURCE_LABELS[view.source]}</span>
        {view.note ? <span className="fx-note">{view.note}</span> : null}
        {view.progressLabel ? <span className="fx-hint">{view.progressLabel}</span> : null}
        {view.durationSeconds != null ? <span className="fx-hint">{formatDuration(view.durationSeconds)}</span> : null}
        {view.costUsd != null && view.costUsd > 0 ? <span className="fx-hint">${view.costUsd.toFixed(2)}</span> : null}
        {view.lastLine ? <span className="fx-hint" title={view.lastLine}>{view.lastLine.slice(0, 120)}</span> : null}
      </div>
      {view.verdict ? <p className="fx-hint">{view.verdict}</p> : null}
      {view.shipOverride ? <p className="fx-hint">Shipped past a secret hit: {view.shipOverride.rule}{view.shipOverride.file ? ` at ${view.shipOverride.file}${view.shipOverride.line ? `:${view.shipOverride.line}` : ""}` : ""}.</p> : null}
      {view.changed ? <p className="fx-hint">{view.changed.files}{view.changed.truncated ? "+" : ""} file{view.changed.files === 1 ? "" : "s"}{view.changed.additions != null ? ` · +${view.changed.additions}/−${view.changed.deletions ?? 0}` : ""}</p> : null}
      {view.test ? <p className="fx-hint">Test: {view.test.ok === null ? "unknown" : view.test.ok ? "passed" : "failed"}{view.test.command ? ` · ${view.test.command}` : ""}</p> : null}
      {view.failingStage ? <div className="fx-failure"><strong>{view.failingStage.name}</strong><pre>{view.failingStage.error}</pre></div> : null}
      {view.readiness ? (
        <form className="fx-form" aria-label="Answer the decision" onSubmit={(e) => { e.preventDefault(); if (!answer.trim()) return; onAction("answer", answer); setAnswer(""); }}>
          <p className="fx-hint">{view.readiness}</p>
          <label className="fx-field fx-grow"><span>Answer</span><textarea rows={3} maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
          <button type="submit" className="fx-btn fx-primary" disabled={!answer.trim()}>Answer &amp; continue</button>
        </form>
      ) : null}
      {sendBackOpen ? (
        <form className="fx-form" aria-label="Send back" onSubmit={(e) => { e.preventDefault(); setSendBackOpen(false); onAction("sendBack", note); setNote(""); }}>
          <label className="fx-field fx-grow"><span>Note for the agent (optional)</span><textarea rows={3} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
          <span className="fx-hint">The failing CI output and new review comments go with it, fenced as data.</span>
          <button type="submit" className="fx-btn fx-primary">Send back</button>
          <button type="button" className="fx-btn" onClick={() => setSendBackOpen(false)}>Cancel</button>
        </form>
      ) : null}
      {confirmDiscard ? (
        <div className="fx-actions" role="group" aria-label="Confirm discard">
          <span className="fx-hint" role="alert">Remove this card and its worktree? {readingDiscard ? "Reading the worktree…" : discardWarning(discardStatus, requestProvider ? { provider: requestProvider } : null)}</span>
          <button type="button" className="fx-btn fx-danger" disabled={readingDiscard} onClick={() => { setConfirmDiscard(false); onAction("discard"); }}>Discard</button>
          <button type="button" className="fx-btn" onClick={() => { setConfirmDiscard(false); setDiscardStatus(null); }}>Cancel</button>
        </div>
      ) : view.actions.length > 0 ? (
        <div className="fx-actions">
          {view.actions.map((a) => (
            <button key={a} type="button" className={a === "start" || a === "ship" ? "fx-btn fx-primary" : "fx-btn"} onClick={() => {
              if (a === "discard") {
                setConfirmDiscard(true);
                setDiscardStatus(null);
                if (onDiscardStatus) {
                  setReadingDiscard(true);
                  void onDiscardStatus().then((raw) => setDiscardStatus(decodeWorktreeStatus(raw))).catch(() => setDiscardStatus(null)).finally(() => setReadingDiscard(false));
                }
                return;
              }
              if (a === "sendBack") setSendBackOpen(true);
              else onAction(a);
            }}>{ACTION_LABELS[a]}</button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
