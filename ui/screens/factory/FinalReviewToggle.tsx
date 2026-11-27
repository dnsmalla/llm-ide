// The Final review switch, one component for every loop board (the Factory's and every other loop's), so the choice
// reads and behaves the same everywhere. Each board owns where the setting is saved.
import type { ReactNode } from "react";

export type FinalReviewMode = "auto" | "human";

const TITLE: Record<FinalReviewMode, string> = {
  auto: "AI reviews the change, then it ships",
  human: "The run waits for your approval",
};

/** `mode` null = not known yet (still loading, or no single loop to change): both buttons are disabled. */
export function FinalReviewToggle({ mode, busy = false, onChoose }: { mode: FinalReviewMode | null; busy?: boolean; onChoose: (mode: FinalReviewMode) => void }): ReactNode {
  return (
    <div className="fx-field fx-field-inline" role="group" aria-label="Final review">
      <span>Final review</span>
      {(["auto", "human"] as const).map((m) => (
        <button key={m} type="button" className={`fx-btn${mode === m ? " fx-primary" : ""}`} aria-pressed={mode === m} disabled={mode === null || busy} title={TITLE[m]} onClick={() => onChoose(m)}>
          {m === "auto" ? "Auto" : "Human"}
        </button>
      ))}
    </div>
  );
}
