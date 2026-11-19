// The health line of one extension: status, a Check button, each problem with its one fix, and (MCP) the
// tools the server listed. Presentational: the owning model keeps the results and runs the checks and the fixes
// (re-checks after a fix, and checks on open where no program starts). Every string is React text; the problem text was cleaned by the decoder.
import type { ReactNode } from "react";
import type { HealthResult } from "./decoders.ts";
import { FIX_HINT, checkedText, fixPlan, problemSentence, statusLine, toolsHeading, type FixAction, type HealthKind } from "./health-model.ts";
import { Badge } from "./ui.tsx";

export interface HealthProps {
  kind: HealthKind;
  id: string;
  result: HealthResult | undefined;
  checking: boolean;
  /** The owner's busy state (a fix or switch in flight). */
  busy?: boolean;
  onCheck: (force: boolean) => void;
  /** A fix the owner can run for this kind; a missing one shows no button. */
  actions: Partial<Record<FixAction, () => void>>;
  now?: number;
}

export function Health({ kind, result, checking, busy = false, onCheck, actions, now }: HealthProps): ReactNode {
  const line = statusLine(result, checking);
  const when = checking ? "" : checkedText(result?.checkedAt, now);
  return (
    <section className="ext-health" aria-label="Health">
      <h3>Health</h3>
      <div className="ext-health-line">
        <span role="status">
          <Badge tone={line.tone}>{line.text}</Badge>
          {when && <span className="lib-muted"> {when}</span>}
        </span>
        <button type="button" className="lib-btn" disabled={checking} onClick={() => onCheck(true)}>
          {checking ? "Checking…" : "Check"}
        </button>
      </div>
      {result && result.problems.length > 0 && (
        <ul className="ext-health-problems" aria-label="Problems">
          {result.problems.map((p, i) => {
            const plan = fixPlan(p, kind);
            const run = plan.type === "button" ? actions[plan.action] : undefined;
            return (
              <li key={i}>
                <span>{p.message}</span>
                {plan.type === "text" && <span className="lib-muted"> {plan.text}</span>}
                {plan.type === "button" && !run && <span className="lib-muted"> {FIX_HINT}</span>}
                {plan.type === "button" && run && (
                  <button type="button" className="lib-btn" disabled={busy || checking} aria-label={`${plan.label}: ${problemSentence(p, kind)}`} onClick={run}>
                    {plan.label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {result && result.tools.length > 0 && (
        <details className="ext-health-tools">
          <summary>{toolsHeading(result.tools.length)}</summary>
          <ul className="ext-members" aria-label="Tools">
            {result.tools.map((t, i) => (
              <li key={i}>
                <strong>{t.name}</strong>
                {t.description && <span className="lib-muted">{t.description}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
