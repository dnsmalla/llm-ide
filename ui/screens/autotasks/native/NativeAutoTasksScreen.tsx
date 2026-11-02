// Native Auto Tasks screen. Independent of Mobile Control: the task catalog and per-task settings are local. The
// runner/scheduler is the next port phase; while it is absent, Run controls are explicitly disabled rather than
// pretending to execute.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { shellBus } from "../../shell/bus";
import { readRepoConfig } from "../../settings/repo-config.ts";
import { core } from "../../shell/runtime";
import { invokeHost } from "../../shell/host";
import { GROUPS, TASKS, TASK_BY_ID, loadState, saveState, type AutoTaskConfig, type AutoTaskId, type AutoTaskLocalState } from "./model.ts";
import { cronMatches, describeCron, validateCron } from "./cron.ts";
import "./native-autotasks.css";

interface AutoTaskRun { id: string; task: string; at: string; ok: boolean; summary: string; durationSeconds: number }

export function NativeAutoTasksScreen(_props: SectionProps): ReactNode {
  const [state, setState] = useState<AutoTaskLocalState>(() => loadState());
  const [selected, setSelected] = useState<AutoTaskId>("reviewCode");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState("");
  const [scheduleError, setScheduleError] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const firedRef = useRef<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [runs, setRuns] = useState<AutoTaskRun[]>(() => {
    try { const raw = localStorage.getItem("llmide.autoTaskRuns.v1"); const v = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(v) ? v.slice(0, 50) as AutoTaskRun[] : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("llmide.autoTaskRuns.v1", JSON.stringify(runs.slice(0, 50))); } catch { /* session only */ } }, [runs]);
  const task = TASK_BY_ID[selected];
  const config = state.configs[selected];
  useEffect(() => { setCronDraft(config.cron); setScheduleError(false); }, [selected, config.cron]);
  const hasRepo = (() => { try { const c = readRepoConfig(); return [...c.saved.github, ...c.saved.gitlab].some((r) => r.active && r.clonePath.trim() !== ""); } catch { return false; } })();
  const iconFor = (id: AutoTaskId): string => ({ sourceUpdate: "↻", sourcesToIssue: "◫", implementIssues: "⌘", reviewMerge: "⇄", reviewCode: "✓", reviewDoc: "▤", reviewConflicts: "⚠", updateIssues: "☑", updatePlanStatus: "▥", generateDoc: "▦", regression: "↺", generateKnowledge: "✦" } as Record<string, string>)[id] ?? "•";
  const grouped = useMemo(() => GROUPS.map((g) => [g, TASKS.filter((t) => t.group === g && (!onlyEnabled || state.configs[t.id]?.enabled))] as const).filter(([, list]) => list.length > 0), [state, onlyEnabled]);

  const update = (patch: Partial<AutoTaskConfig>, id: AutoTaskId = selected) => {
    setState((s) => {
      const next = { ...s, configs: { ...s.configs, [id]: { ...s.configs[id], ...patch } } };
      saveState(next);
      return next;
    });
  };
  useEffect(() => {
    if (!state.masterEnabled || !hasRepo) return;
    const tick = () => {
      if (running) return;
      const now = new Date();
      const minute = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      for (const t of TASKS) {
        const c = state.configs[t.id];
        if (!c?.enabled || !c.scheduleActive || !validateCron(c.cron)) continue;
        if (!cronMatches(c.cron, now)) continue;
        const key = `${t.id}:${minute}`;
        if (firedRef.current[key]) continue;
        let persisted: Record<string, string> = {};
        try { persisted = JSON.parse(localStorage.getItem("llmide.autoTaskFired.v1") ?? "{}") as Record<string, string>; } catch { persisted = {}; }
        if (persisted[key]) { firedRef.current[key] = minute; continue; }
        persisted[key] = minute;
        firedRef.current[key] = minute;
        try { localStorage.setItem("llmide.autoTaskFired.v1", JSON.stringify(Object.fromEntries(Object.entries(persisted).slice(-200)))); } catch { /* session */ }
        void runTask(t.id, true);
        return;
      }
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [state, running, hasRepo]);

  const runTask = async (id: AutoTaskId = selected, scheduled = false) => {
    if (running) return;
    const t = TASK_BY_ID[id]; const c = state.configs[id];
    if (!state.masterEnabled) { setNotice("Enable Auto Tasks first."); return; }
    if (!hasRepo) { setNotice("No linked repository detected. Add one in Settings first."); return; }
    if (!scheduled && !window.confirm(`Run “${t.label}” now?\n\n${c.prompt.slice(0, 500)}`)) return;
    setRunning(true);
    setLog((l) => [...l, `▶ ${t.label}`, ""]);
    const started = new Date();
    try {
      const workRoot = await invokeHost<string>("loop_work_root");
      const parts = [c.prompt];
      if (c.inputPath.trim()) parts.push(`Input: ${c.inputPath.trim()}`);
      if (c.outputPath.trim()) parts.push(`Output: ${c.outputPath.trim()}`);
      const r = await core.request<{ reply?: string; changedPaths?: string[]; changedExtraPaths?: string[]; resultSubtype?: string }>("/kb/loop/agent-run", {
        method: "POST", body: { message: parts.join("\n\n"), repoRoot: workRoot, skills: c.skillName ? [c.skillName] : undefined, timeoutMs: 30 * 60 * 1000 },
      });
      let touched = r.changedPaths ?? [];
      if (t.readOnlyOutput && touched.length) {
        try { await invokeHost("loop_revert_paths", { paths: touched }); setLog((l) => [...l, `read-only task reverted: ${touched.join(", ")}`]); touched = []; }
        catch (e) { setLog((l) => [...l, `read-only revert failed: ${e instanceof Error ? e.message : String(e)}`]); }
      }
      const ok = r.resultSubtype === "success" || (r.resultSubtype == null && typeof r.reply === "string");
      setLog((l) => [...l, r.reply ?? "(no reply)", ...(touched.length ? [`changed: ${touched.join(", ")}`] : [])]);
      setRuns((xs) => [{ id: crypto.randomUUID(), task: t.label, at: started.toISOString(), ok, summary: r.resultSubtype ?? (ok ? "completed" : "failed"), durationSeconds: Math.round((Date.now() - started.getTime()) / 1000) }, ...xs].slice(0, 50));
      setNotice(ok ? `${t.label} completed.` : `${t.label} did not complete.`);
    } catch (e) {
      setLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setRuns((xs) => [{ id: crypto.randomUUID(), task: t.label, at: started.toISOString(), ok: false, summary: e instanceof Error ? e.message : "failed", durationSeconds: Math.round((Date.now() - started.getTime()) / 1000) }, ...xs].slice(0, 50));
      setNotice(e instanceof Error ? e.message : "The task could not run.");
    } finally { setRunning(false); }
  };

  const setMaster = (v: boolean) => setState((s) => { const n = { ...s, masterEnabled: v }; saveState(n); return n; });

  return (
    <div className="atn-root">
      <aside className="atn-left" aria-label="Auto tasks">
        <div className="atn-head">
          <button type="button" className="atn-switch" data-on={state.masterEnabled || undefined} aria-label={state.masterEnabled ? "Disable Auto Tasks" : "Enable Auto Tasks"} aria-pressed={state.masterEnabled} onClick={() => setMaster(!state.masterEnabled)} />
          <strong>{state.masterEnabled ? "Enabled" : "Disabled"}</strong>
          <span className="atn-head-actions"><button type="button" className="atn-icon" aria-label="Expand" title="Run state is managed by the native scheduler (next phase)">⤢</button><button type="button" className="atn-icon" aria-label="Refresh" onClick={() => setNotice("Auto Tasks settings are local; reloading is not needed.")}>↻</button></span>
        </div>
        {!hasRepo ? (
          <div className="atn-warning">
            <p>No linked repository detected. Auto Tasks need an active GitHub or GitLab project with a local clone path and a matching token.</p>
            <button type="button" className="atn-link" onClick={() => shellBus.publish({ type: "goto-section", section: "settings" })}>Open Settings</button>
          </div>
        ) : null}
        <label className="atn-filter"><input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} /> Show only enabled</label>
        <div className="atn-groups">
          {grouped.map(([group, tasks]) => (
            <section key={group}>
              <h3 className="atn-group">{group} Tasks</h3>
              <ul>
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="atn-row" data-on={selected === t.id || undefined} onClick={() => setSelected(t.id)}>
                      <input type="checkbox" checked={state.configs[t.id]?.enabled ?? false} onClick={(e) => e.stopPropagation()} onChange={(e) => update({ enabled: e.target.checked }, t.id)} aria-label={`${t.label} enabled`} />
                      <span className="atn-task-icon" aria-hidden="true">{iconFor(t.id)}</span><span>{t.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {grouped.length === 0 ? <p className="atn-hint">No tasks match this filter.</p> : null}
        </div>
        <button type="button" className="atn-model" onClick={() => setNotice("Model & Limits is part of the runner/settings port.")}>Model &amp; Limits</button>
        <section className="atn-history"><h3>Recent runs</h3>{runs.length === 0 ? <p className="atn-hint">No runs yet.</p> : <ul>{runs.slice(0, 6).map((r) => <li key={r.id}><span>{r.ok ? "✓" : "✗"} {r.task}</span><span className="atn-hint">{r.durationSeconds}s · {new Date(r.at).toLocaleString()}</span></li>)}</ul>}</section>
        <section className="atn-history"><h3>Action items</h3><p className="atn-hint">No action items yet. Run Sources → Issue or record a meeting with action items.</p></section>
        <button type="button" className="atn-run-now" disabled={running} title={running ? "A task is running" : "Run the selected task now"} onClick={() => void runTask()}>{running ? "Running…" : "▶ Run Now"}</button>
      </aside>

      <main className="atn-main">
        <header className="atn-titlebar">
          <span className="atn-title-icon" aria-hidden="true">✓</span>
          <h1>{task.label}</h1>
          <span className="atn-spacer" />
          <button type="button" className="atn-btn atn-primary" disabled={running} onClick={() => void runTask()}>{running ? "Running…" : "▶ Run"}</button>
        </header>
        <div className="atn-stars" aria-label="Task rating">★ ★ ★ ★ ☆</div>
        <div className="atn-subtitle"><span className="atn-hint">◷ {config.scheduleActive ? `Scheduled · ${describeCron(config.cron)}` : "Schedule off — runs only when you press Run"}</span><span className="atn-spacer" /><label className="atn-inline"><input type="checkbox" checked={config.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> Active</label><button type="button" className="atn-btn" onClick={() => { setCronDraft(config.cron); setScheduleError(false); setScheduleOpen(true); }}>Edit</button></div>
        {notice ? <p className="atn-notice" role="status">{notice}</p> : null}

        <section className="atn-card">
          <header><span aria-hidden="true">☰</span><h2>SETTINGS</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Reload task settings" onClick={() => setState(loadState())}>↻</button></header>
          <label className="atn-field"><span>Input path</span><input value={config.inputPath} placeholder="Whole project" onChange={(e) => update({ inputPath: e.target.value })} /><em>What the task reads. Empty means the whole project.</em></label>
          <label className="atn-field"><span>Output path</span><input value={config.outputPath} placeholder="Whole project" onChange={(e) => update({ outputPath: e.target.value })} /><em>{task.readOnlyOutput ? "Read-only task — edits are reverted after the run; this is the intended destination." : "Where the task writes its result."}</em></label>
          <label className="atn-field"><span>Skill</span><select value={config.skillName} onChange={(e) => update({ skillName: e.target.value })}><option value="">None</option></select><em>Run the prompt under one of the project's agent skills.</em></label>
        </section>

        <section className="atn-card">
          <header><span aria-hidden="true">📄</span><h2>TEMPLATE</h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => update({ template: "builtin", prompt: task.prompt })}>Restore Default</button><button type="button" className="atn-link" onClick={() => setNotice("Saving named prompt templates is part of the template-store port.")}>New…</button></header>
          <select aria-label="Template" value={config.template} onChange={(e) => update({ template: e.target.value as "builtin" | "custom" })}><option value="builtin">Built-in prompt</option><option value="custom">Custom prompt</option></select>
          <textarea aria-label="Prompt" rows={7} value={config.prompt} onChange={(e) => update({ prompt: e.target.value, template: "custom" })} />
        </section>

        <section className="atn-card atn-log"><header><h2>Log <span className="atn-hint">live</span></h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => setLog([])}>Clear</button></header>{log.length === 0 ? <p className="atn-hint">No log lines yet.</p> : <pre className="atn-log-pre">{log.join("\n")}</pre>}</section>
      </main>
      {scheduleOpen ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-schedule-title">
          <div className="atn-modal-card">
            <header><h2 id="atn-schedule-title">Schedule · {task.label}</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close schedule" onClick={() => setScheduleOpen(false)}>×</button></header>
            <label className="atn-inline"><input type="checkbox" checked={config.scheduleActive} onChange={(e) => update({ scheduleActive: e.target.checked })} /> Run on schedule</label>
            <label className="atn-field"><span>Cron expression</span><input className="atn-cron" value={cronDraft} spellCheck={false} placeholder="0 * * * *" onChange={(e) => { setCronDraft(e.target.value); setScheduleError(!validateCron(e.target.value)); }} /><em>{scheduleError ? "Invalid five-field cron expression." : describeCron(cronDraft)}</em></label>
            <p className="atn-hint">The schedule runs while the Auto Tasks page is open; background scheduling is not ported yet.</p>
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setScheduleOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-primary" disabled={!validateCron(cronDraft)} onClick={() => { if (!validateCron(cronDraft)) { setScheduleError(true); return; } update({ cron: cronDraft.trim() }); setScheduleOpen(false); setNotice(config.scheduleActive ? "Schedule saved and active while this page is open." : "Schedule saved; turn on Run on schedule to arm it."); }}>Save</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default NativeAutoTasksScreen;
