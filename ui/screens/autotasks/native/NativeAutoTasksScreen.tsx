// Native Auto Tasks screen. Independent of Mobile Control: the task catalog and per-task settings are local. The
// runner/scheduler is the next port phase; while it is absent, Run controls are explicitly disabled rather than
// pretending to execute.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { shellBus } from "../../shell/bus";
import { readRepoConfig } from "../../settings/repo-config.ts";
import { GROUPS, TASKS, TASK_BY_ID, loadState, saveState, type AutoTaskConfig, type AutoTaskId, type AutoTaskLocalState } from "./model.ts";
import { describeCron, validateCron } from "./cron.ts";
import "./native-autotasks.css";

export function NativeAutoTasksScreen(_props: SectionProps): ReactNode {
  const [state, setState] = useState<AutoTaskLocalState>(() => loadState());
  const [selected, setSelected] = useState<AutoTaskId>("reviewCode");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState("");
  const [scheduleError, setScheduleError] = useState(false);
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
        <section className="atn-history"><h3>Recent runs</h3><p className="atn-hint">No runs yet. The native runner will record them here.</p></section>
        <section className="atn-history"><h3>Action items</h3><p className="atn-hint">No action items yet. Run Sources → Issue or record a meeting with action items.</p></section>
        <button type="button" className="atn-run-now" disabled title="The native runner is the next port phase">▶ Run Now</button>
      </aside>

      <main className="atn-main">
        <header className="atn-titlebar">
          <span className="atn-title-icon" aria-hidden="true">✓</span>
          <h1>{task.label}</h1>
          <span className="atn-spacer" />
          <button type="button" className="atn-btn atn-primary" disabled title="The native runner is the next port phase">▶ Run</button>
        </header>
        <div className="atn-stars" aria-label="Task rating">★ ★ ★ ★ ☆</div>
        <div className="atn-subtitle"><span className="atn-hint">◷ {config.scheduleActive ? `Scheduled · ${config.cron}` : "Schedule off — runs only when you press Run"}</span><span className="atn-spacer" /><label className="atn-inline"><input type="checkbox" checked={config.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> Active</label><button type="button" className="atn-btn" onClick={() => document.getElementById("atn-schedule")?.scrollIntoView({ behavior: "smooth", block: "center" })}>Edit</button></div>
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

        <section className="atn-card" id="atn-schedule">
          <header><span aria-hidden="true">◷</span><h2>SCHEDULE</h2><span className="atn-spacer" /><label className="atn-inline"><input type="checkbox" checked={config.scheduleActive} onChange={(e) => update({ scheduleActive: e.target.checked })} /> Run on schedule</label></header>
          <div className="atn-inline atn-schedule-row">
            <input className="atn-cron" aria-label="Cron expression" value={cronDraft} spellCheck={false} placeholder="0 * * * *" onChange={(e) => { setCronDraft(e.target.value); setScheduleError(!validateCron(e.target.value)); }} />
            <button type="button" className="atn-btn" disabled={!validateCron(cronDraft)} onClick={() => { if (!validateCron(cronDraft)) { setScheduleError(true); return; } update({ cron: cronDraft.trim(), scheduleActive: config.scheduleActive }); setNotice(null); }}>Save</button>
          </div>
          <p className={scheduleError ? "atn-error" : "atn-hint"}>{scheduleError ? "Invalid five-field cron expression." : describeCron(cronDraft)}</p>
          <p className="atn-hint">{config.scheduleActive ? "Armed for the native scheduler (not ported yet)." : "Manual only — Run Now will run it; the schedule is off."}</p>
        </section>

        <section className="atn-card atn-log"><header><h2>Log <span className="atn-hint">live</span></h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => setNotice("Clear is available once the native runner exists.")}>Clear</button></header><p className="atn-hint">No log lines yet. The native runner will stream here.</p></section>
      </main>
    </div>
  );
}

export default NativeAutoTasksScreen;
