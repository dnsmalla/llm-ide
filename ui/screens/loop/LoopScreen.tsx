// Loop, controlled through the Mac app's Mobile Control bridge. The loop definition (stages, budgets, verify
// commands, repair policy) stays in the Mac app; this is the remote-control surface the iPhone also uses.
import { useEffect, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { BridgeRequired, useMacBridge } from "../bridge/BridgeGate.tsx";
import { macBridge, type BridgeSnapshot } from "../bridge/mac-bridge.ts";
import "../bridge/bridge.css";
import "./loop.css";

const when = (s: number | null): string => (s === null ? "Never" : new Date(s * 1000).toLocaleString());

function Content({ snap }: { snap: BridgeSnapshot }): ReactNode {
  const l = snap.loop;
  useEffect(() => {
    if (!l?.running) return undefined;
    const t = window.setInterval(() => macBridge.loopRefresh(), 2000);
    return () => window.clearInterval(t);
  }, [l?.running]);
  if (!l) {
    return (
      <div className="bridge-page">
        <p className="st-hint" role="status">Waiting for the Mac’s Loop state…</p>
        <button type="button" className="bridge-link" onClick={() => macBridge.refresh()}>Refresh</button>
      </div>
    );
  }
  if (!l.configured) {
    return (
      <div className="bridge-page">
        <h1>Loop</h1>
        <p>This project has no saved Loop configuration. Set it up in the Mac app’s Loop page first; this screen controls the same loop once it exists.</p>
      </div>
    );
  }
  return (
    <div className="bridge-page">
      <div className="bridge-head">
        <h1>Loop</h1>
        <span className="st-status" data-tone={l.running ? "ok" : undefined}>{l.running ? "Running" : "Idle"}</span>
        {l.projectName ? <span className="st-hint">{l.projectName}</span> : null}
        <span className="bridge-spacer" />
        <div className="bridge-actions">
          <button type="button" className="lib-btn lib-btn-primary" disabled={l.running} onClick={() => macBridge.startLoop()}>Start loop</button>
          <button type="button" className="lib-btn" disabled={!l.running} onClick={() => macBridge.stopLoop()}>Stop</button>
        </div>
      </div>

      <div className="bridge-meta">
        <span>{l.iteration > 0 ? `Iteration ${l.iteration} of ${l.maxIterations}` : `Max iterations: ${l.maxIterations}`}</span>
        {l.queuedCount > 0 ? <span>{l.queuedCount} queued</span> : null}
        {l.startedHere ? <span>Started from this desktop</span> : null}
        <span>Last: {l.lastStatusSummary ?? "no finished run"} · {when(l.lastFinishedAt)}</span>
      </div>

      <section aria-label="Loop stages">
        <h2>Stages</h2>
        <ul className="bridge-stages">
          {l.stages.map((st) => (
            <li key={`${st.order}-${st.name}`} className="bridge-stage">
              <span className="bridge-task-label">{st.order + 1}. {st.name}</span>
              <span className="st-hint">{st.kind}{st.severity ? ` · ${st.severity}` : ""}{st.enabled ? "" : " · disabled"}</span>
              {st.stageId ? <button type="button" className="lib-btn" disabled={l.running} onClick={() => macBridge.startStage(st.stageId!)}>Run stage</button> : null}
            </li>
          ))}
        </ul>
        {l.stages.length === 0 ? <p className="st-hint">The Mac has no stages in this loop.</p> : null}
      </section>

      <section aria-label="Loop log">
        <h2>Log</h2>
        <pre className="bridge-log">{l.logTail.length > 0 ? l.logTail.join("\n") : "No log lines yet."}</pre>
      </section>

      <section aria-label="Past loop runs">
        <h2>Past runs</h2>
        {snap.loopRuns.length === 0 ? <p className="st-hint">No finished runs yet.</p> : (
          <ul className="bridge-acks">
            {snap.loopRuns.slice(0, 20).map((r) => (
              <li key={r.id}>{new Date(r.startedAt * 1000).toLocaleString()} · {r.statusSummary || r.statusCode} · {Math.round(r.durationSeconds)}s · {r.iterationsUsed} iteration{r.iterationsUsed === 1 ? "" : "s"} · {r.trigger}</li>
            ))}
          </ul>
        )}
      </section>

      {snap.acks.length > 0 ? (
        <ul className="bridge-acks" aria-live="polite">
          {snap.acks.map((a) => <li key={a.at}>{a.ok ? "✓" : "✕"} {a.message ?? (a.ok ? "Accepted" : "Refused")}</li>)}
        </ul>
      ) : null}
      <p className="st-hint">Stage order, budgets, verify commands and repair policy are edited in the Mac app; this is the same remote control the iPhone uses.</p>
    </div>
  );
}

export default function LoopScreen(_props: SectionProps): ReactNode {
  const snap = useMacBridge();
  return <BridgeRequired>{() => <Content snap={snap} />}</BridgeRequired>;
}
