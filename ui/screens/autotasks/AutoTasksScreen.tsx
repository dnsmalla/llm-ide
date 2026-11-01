// Auto Tasks, controlled through the Mac app's Mobile Control bridge. Task definitions, schedules, templates and
// model routing stay in the Mac app (the same rule as the iPhone): this screen lists, runs, stops and toggles them.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { useMacBridge } from "../bridge/BridgeGate.tsx";
import { macBridge, type BridgeSnapshot, type AutoTaskInfo, type AutoTaskState } from "../bridge/mac-bridge.ts";
import "../bridge/bridge.css";
import "./autotasks.css";
import { shellBus } from "../shell/bus";

const when = (ms: number | null): string => {
  if (ms === null) return "Never";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "Never" : d.toLocaleString();
};

const GROUP_ORDER = ["Pipeline", "Review", "Automation", "Maintenance"] as const;
const GROUP: Record<string, (typeof GROUP_ORDER)[number]> = {
  sourceUpdate: "Pipeline", sourcesToIssue: "Pipeline", updateIssues: "Pipeline",
  implementIssues: "Pipeline", reviewMerge: "Pipeline",
  reviewCode: "Review", reviewDoc: "Review", reviewConflicts: "Review",
  regression: "Automation", loopEngineering: "Automation",
  generateDoc: "Maintenance", generateKnowledge: "Maintenance", updatePlanStatus: "Maintenance",
};
const groupOf = (t: AutoTaskInfo): string => GROUP[t.id] ?? "Automation";

/** The Mac's task catalog, used while no Mac engine is attached. No fake run state: every task starts Off. */
const LOCAL_TASKS: AutoTaskInfo[] = [
  { id: "sourceUpdate", label: "Source Update", enabled: false, lastError: null },
  { id: "sourcesToIssue", label: "Sources to Issue", enabled: false, lastError: null },
  { id: "implementIssues", label: "Implement Issues", enabled: false, lastError: null },
  { id: "reviewMerge", label: "Review Merge", enabled: false, lastError: null },
  { id: "reviewCode", label: "Review Code", enabled: false, lastError: null },
  { id: "reviewDoc", label: "Review Doc", enabled: false, lastError: null },
  { id: "reviewConflicts", label: "Review Conflicts", enabled: false, lastError: null },
  { id: "updateIssues", label: "Update Issues", enabled: false, lastError: null },
  { id: "updatePlanStatus", label: "Update Plan Status", enabled: false, lastError: null },
  { id: "generateDoc", label: "Generate Doc", enabled: false, lastError: null },
  { id: "regression", label: "Regression", enabled: false, lastError: null },
  { id: "generateKnowledge", label: "Knowledge", enabled: false, lastError: null },
];
const LOCAL_STATE: AutoTaskState = {
  masterEnabled: false, isRunning: false, currentTask: null, currentStep: null, statusMessage: null,
  lastRunDate: null, createdCount: 0, implementedCount: 0, failedCount: 0, tasks: LOCAL_TASKS,
};

function Content({ snap }: { snap: BridgeSnapshot }): ReactNode {
  const connected = snap.autoTasks !== null;
  const s = snap.autoTasks ?? LOCAL_STATE;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onlyEnabled, setOnlyEnabled] = useState(false);

  useEffect(() => {
    if (selectedId === null || !s.tasks.some((t) => t.id === selectedId)) setSelectedId(s.tasks[0]?.id ?? null);
  }, [s, selectedId]);

  const grouped = useMemo(() => {
    const tasks = s.tasks.filter((t) => !onlyEnabled || t.enabled);
    return GROUP_ORDER.map((g) => [g, tasks.filter((t) => groupOf(t) === g)] as const).filter(([, list]) => list.length > 0);
  }, [s, onlyEnabled]);

  const running = s.isRunning;
  const selected = s.tasks.find((t) => t.id === selectedId) ?? null;
  const logs = snap.logs?.tasks.find((t) => t.id === selectedId)?.lines ?? [];

  return (
    <div className="at-page">
      {!connected ? (
        <div className="at-connect" role="status">
          <strong>Desktop Auto Tasks</strong>
          <span>The native task runner is being ported. Until it lands, this page shows the Mac task catalog and settings; no Mobile Control token is required for this screen.</span>
          <button type="button" className="lib-btn" onClick={() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "mobile" })}>Mac bridge (optional)</button>
        </div>
      ) : null}
      <header className="at-head">
        <h1>Auto Tasks</h1>
        <span className="st-status" data-tone={s.masterEnabled ? "ok" : "warning"}>{s.masterEnabled ? "Master on" : "Master off"}</span>
        <span className="bridge-spacer" />
        <label className="at-check">
          <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
          <span>Show only enabled</span>
        </label>
        <button type="button" className="lib-btn" disabled={!connected} onClick={() => macBridge.toggle(null, !s.masterEnabled)}>{s.masterEnabled ? "Turn master off" : "Turn master on"}</button>
        <button type="button" className="lib-btn lib-btn-primary" disabled={!connected || running} onClick={() => macBridge.run(null)}>Run all</button>
        <button type="button" className="lib-btn" disabled={!connected || !running} onClick={() => macBridge.stopAuto()}>Stop</button>
        <button type="button" className="lib-btn" disabled={!connected} onClick={() => macBridge.history()}>Action items</button>
      </header>

      <div className="at-meta">
        <span>Last run: {when(s.lastRunDate)}</span>
        <span>{s.statusMessage ?? "Never run"}</span>
        {s.currentTask ? <span>Running: <strong>{s.currentTask}</strong>{s.currentStep ? ` · ${s.currentStep}` : ""}</span> : null}
        <span>{s.createdCount} created · {s.implementedCount} implemented · {s.failedCount} failed</span>
      </div>

      <div className="at-workspace">
        <aside className="at-list" aria-label="Auto tasks">
          {grouped.map(([group, tasks]) => (
            <section key={group} className="at-group">
              <h2 className="at-group-title">{group} Tasks</h2>
              <ul className="at-ulist">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="at-item" data-on={selectedId === t.id || undefined} onClick={() => setSelectedId(t.id)}>
                      <span className="at-item-label">{t.label}</span>
                      <span className="at-item-state">{t.enabled ? "On" : "Off"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {grouped.length === 0 ? <p className="st-hint">No tasks match this filter.</p> : null}
        </aside>

        <section className="at-detail" aria-label="Selected task">
          {selected ? (
            <>
              <header className="at-detail-head">
                <h2>{selected.label}</h2>
                <span className="st-status" data-tone={selected.enabled ? "ok" : "warning"}>{selected.enabled ? "Enabled" : "Off"}</span>
                <span className="bridge-spacer" />
                <button type="button" className="lib-btn" disabled={!connected} onClick={() => macBridge.toggle(selected.id, !selected.enabled)}>{selected.enabled ? "Turn off" : "Turn on"}</button>
                <button type="button" className="lib-btn lib-btn-primary" disabled={!connected || running} onClick={() => macBridge.run(selected.id)}>Run task</button>
              </header>
              {selected.lastError ? <p className="bridge-error" role="alert">{selected.lastError}</p> : null}
              <p className="st-hint">Schedules, prompt templates, model routing and task inputs are edited in the Mac app; this is the same remote control the iPhone uses.</p>
              <section aria-label="Task log">
                <h3>Log</h3>
                <pre className="bridge-log">{logs.length > 0 ? logs.map((l) => `${new Date(l.timestamp * 1000).toLocaleTimeString()}  ${l.text}`).join("\n") : "No log lines for this task yet."}</pre>
              </section>
              {(() => {
                const cfg = snap.setup?.configs.find((c) => c.taskId === selected.id);
                const template = cfg?.templateId ? snap.setup?.templates.find((t) => t.id === cfg.templateId) : null;
                return (
                  <section aria-label="Task setup">
                    <h3>Setup</h3>
                    <dl className="bridge-meta">
                      <div><dt>Project</dt><dd>{snap.setup?.hasProject ? snap.setup.projectName ?? "Open" : "No project open on the Mac"}</dd></div>
                      <div><dt>Input</dt><dd>{cfg?.inputPath ?? "Not set"}</dd></div>
                      <div><dt>Output</dt><dd>{cfg?.outputPath ?? "Not set"}</dd></div>
                      <div><dt>Skill</dt><dd>{cfg?.skillName ?? "Not set"}</dd></div>
                      <div><dt>Template</dt><dd>{template?.name ?? cfg?.templateId ?? "Not set"}</dd></div>
                    </dl>
                    {template ? <pre className="bridge-log" aria-label="Prompt template">{template.body}</pre> : null}
                    <p className="st-hint">Templates, paths, skills and schedules are edited in the Mac app; this snapshot is read-only.</p>
                  </section>
                );
              })()}
            </>
          ) : <p className="st-hint">Select a task.</p>}
        </section>
      </div>

      {snap.history.length > 0 ? (
        <section className="at-history" aria-label="Action items">
          <h2>Action items</h2>
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
    </div>
  );
}

export default function AutoTasksScreen(_props: SectionProps): ReactNode {
  const snap = useMacBridge();
  useEffect(() => {
    if (macBridge.paired) macBridge.connect();
  }, []);
  return <Content snap={snap} />;
}
