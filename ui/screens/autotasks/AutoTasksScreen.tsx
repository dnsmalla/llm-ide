// Auto Tasks, controlled through the Mac app's Mobile Control bridge. Task definitions, schedules, templates and
// model routing stay in the Mac app (the same rule as the iPhone): this screen lists, runs, stops and toggles them.
import type { ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { BridgeGate, useMacBridge } from "../bridge/BridgeGate.tsx";
import { macBridge, type BridgeSnapshot } from "../bridge/mac-bridge.ts";
import "../bridge/bridge.css";
import "./autotasks.css";

const when = (ms: number | null): string => {
  if (ms === null) return "Never";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "Never" : d.toLocaleString();
};

function Content({ snap }: { snap: BridgeSnapshot }): ReactNode {
  const s = snap.autoTasks;
  if (!s) {
    return (
      <div className="bridge-page">
        <p className="st-hint" role="status">Waiting for the Mac’s Auto Tasks state…</p>
        <button type="button" className="bridge-link" onClick={() => macBridge.refresh()}>Refresh</button>
      </div>
    );
  }
  const running = s.isRunning;
  return (
    <div className="bridge-page">
      <div className="bridge-head">
        <h1>Auto Tasks</h1>
        <span className="st-status" data-tone={s.masterEnabled ? "ok" : "warning"}>{s.masterEnabled ? "Master on" : "Master off"}</span>
        <span className="bridge-spacer" />
        <div className="bridge-actions">
          <button type="button" className="lib-btn" onClick={() => macBridge.toggle(null, !s.masterEnabled)}>{s.masterEnabled ? "Turn master off" : "Turn master on"}</button>
          <button type="button" className="lib-btn lib-btn-primary" disabled={running} onClick={() => macBridge.run(null)}>Run all due</button>
          <button type="button" className="lib-btn" disabled={!running} onClick={() => macBridge.stopAuto()}>Stop</button>
          <button type="button" className="lib-btn" onClick={() => macBridge.history()}>History</button>
        </div>
      </div>

      <div className="bridge-meta">
        <span>Last run: {when(s.lastRunDate)}</span>
        <span>{s.statusMessage ?? "Never run"}</span>
        {s.currentTask ? <span>Running: <strong>{s.currentTask}</strong>{s.currentStep ? ` · ${s.currentStep}` : ""}</span> : null}
        <span>{s.createdCount} created · {s.implementedCount} implemented · {s.failedCount} failed</span>
      </div>

      <ul className="bridge-tasks" aria-label="Auto tasks">
        {s.tasks.map((t) => (
          <li key={t.id} className="bridge-task" data-running={s.currentTask === t.id || undefined}>
            <label className="bridge-task-label">
              <input type="checkbox" checked={t.enabled} onChange={(e) => macBridge.toggle(t.id, e.target.checked)} />{" "}
              {t.label}
            </label>
            {t.lastError ? <span className="bridge-error" role="alert">{t.lastError}</span> : null}
            <button type="button" className="lib-btn" disabled={running} onClick={() => macBridge.run(t.id)}>Run</button>
          </li>
        ))}
      </ul>
      {s.tasks.length === 0 ? <p className="st-hint">The Mac reports no Auto Tasks for this build.</p> : null}

      {snap.history.length > 0 ? (
        <section className="bridge-page" aria-label="Auto Task history">
          <h2 className="bridge-head" style={{ margin: 0 }}>History</h2>
          <ul className="bridge-acks">
            {snap.history.map((h, i) => <li key={`${h.lastUpdated}-${i}`}>{when(h.lastUpdated * 1000)} · {h.actionText} — {h.status}</li>)}
          </ul>
        </section>
      ) : null}

      {snap.acks.length > 0 ? (
        <ul className="bridge-acks" aria-live="polite">
          {snap.acks.map((a) => <li key={a.at}>{a.ok ? "✓" : "✕"} {a.message ?? (a.ok ? "Accepted" : "Refused")}{a.code ? ` (${a.code})` : ""}</li>)}
        </ul>
      ) : null}

      <p className="st-hint">Schedules, prompt templates, model routing and task inputs stay editable in the Mac app; this screen is the same remote control the iPhone uses.</p>
    </div>
  );
}

export default function AutoTasksScreen(_props: SectionProps): ReactNode {
  const snap = useMacBridge();
  return <BridgeGate>{() => <Content snap={snap} />}</BridgeGate>;
}
