// The "also remove from the other list" part of a revoke confirmation (Live Chat pairing <-> offline sync). Thin: the
// matching and the pre-checks come from device-link-model.ts.
import type { ReactNode } from "react";
import type { AlsoCandidate } from "../device-link-model.ts";

export interface AlsoState { candidates: AlsoCandidate[]; unavailable: boolean }

export default function AlsoRevoke({ heading, note, state, checked, busy, onToggle }: {
  heading: string; note: string; state: AlsoState | null; checked: readonly string[]; busy: boolean; onToggle: (deviceId: string) => void;
}): ReactNode {
  if (!state) return null;
  if (state.unavailable) return <p className="st-hint">{note}</p>;
  if (state.candidates.length === 0) return null;
  return (
    <div className="st-stack" role="group" aria-label={heading}>
      <span className="st-label">{heading}</span>
      {state.candidates.map((c) => (
        <label key={c.deviceId} className="st-row">
          <input type="checkbox" checked={checked.includes(c.deviceId)} disabled={busy} onChange={() => onToggle(c.deviceId)} />
          <span>{c.label}</span>
        </label>
      ))}
    </div>
  );
}
