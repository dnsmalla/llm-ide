import type { ReactNode } from "react";

/** A labelled control with an optional hint line below it. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="st-field">
      <span className="st-label">{label}</span>
      {children}
      {hint ? <span className="st-hint">{hint}</span> : null}
    </label>
  );
}
