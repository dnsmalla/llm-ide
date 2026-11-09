// One Factory card: title, source, the derived note and the actions its column allows.
import { useState, type ReactNode } from "react";
import { ACTION_LABELS, SOURCE_LABELS, type CardAction, type CardView } from "./board-model.ts";

export function Card({ view, selected, onOpen, onAction }: { view: CardView; selected: boolean; onOpen: () => void; onAction: (action: CardAction) => void }): ReactNode {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  return (
    <li className="fx-card" data-key={view.key} data-selected={selected}>
      <button type="button" className="fx-card-title" onClick={onOpen} title="Show details">{view.title}</button>
      <div className="fx-card-meta">
        <span className="fx-source">{SOURCE_LABELS[view.source]}</span>
        {view.note ? <span className="fx-note">{view.note}</span> : null}
      </div>
      {confirmDiscard ? (
        <div className="fx-actions" role="group" aria-label="Confirm discard">
          <span className="fx-hint">Remove this card and its worktree?</span>
          <button type="button" className="fx-btn fx-danger" onClick={() => { setConfirmDiscard(false); onAction("discard"); }}>Discard</button>
          <button type="button" className="fx-btn" onClick={() => setConfirmDiscard(false)}>Cancel</button>
        </div>
      ) : view.actions.length > 0 ? (
        <div className="fx-actions">
          {view.actions.map((a) => (
            <button key={a} type="button" className={a === "start" || a === "ship" ? "fx-btn fx-primary" : "fx-btn"} onClick={() => (a === "discard" ? setConfirmDiscard(true) : onAction(a))}>{ACTION_LABELS[a]}</button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
