// The Mac's plan-mode mismatch bar (CodeAssistantPanel+Session.planSwitchBanner): a planning request sent from a mode
// that will start working instead of planning. The user still decides; "Keep" hides it until the draft is cleared.
import { useEffect, useState } from "react";
import { MODES } from "../route";
import { offersPlanSwitch } from "./detect";

export function PlanSwitchNotice({ draft, mode, onSwitch }: { draft: string; mode: string; onSwitch: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (draft === "") setDismissed(false); }, [draft]);
  if (dismissed || !offersPlanSwitch(draft, mode)) return null;
  const label = MODES.find((m) => m.id === mode)?.label ?? mode;
  return (
    <div className="chat-note" role="status">
      <span>This reads as a planning request, but the mode is {label}. It will start working instead of planning.</span>
      <button type="button" className="chat-btn chat-primary" onClick={onSwitch}>Switch to Plan</button>
      <button type="button" className="chat-btn" onClick={() => setDismissed(true)}>Keep {label}</button>
    </div>
  );
}
