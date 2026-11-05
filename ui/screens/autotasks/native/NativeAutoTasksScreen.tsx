// Native Auto Tasks screen. Independent of Mobile Control: the task catalog and per-task settings are local. The
// runner/scheduler is the next port phase; while it is absent, Run controls are explicitly disabled rather than
// pretending to execute.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { shellBus } from "../../shell/bus";
import { readRepoConfig } from "../../settings/repo-config.ts";
import { core } from "../../shell/runtime";
import { invokeHost } from "../../shell/host";
import { createHostFs } from "../../explorer/fs";
import { GROUPS, MAC_ONLY_MESSAGE, RESET_TEMPLATE_MESSAGE, resetTemplateTitle, TASKS, TASK_BY_ID, agentRunSucceeded, composeTaskMessage, desktopRunnable, scheduleStatusLine, loadState, normalizeProjectPath, requiresLinkedRepo, saveState, scheduledRunAllowed, type AutoTaskConfig, type AutoTaskId, type AutoTaskLocalState } from "./model.ts";
import { cronMatches, describeCron, validateCron } from "./cron.ts";
import { addTemplate, loadTemplates, removeTemplate, saveTemplates, type PromptTemplate } from "./prompt-templates.ts";
import { scanLibraryFolders, type LibraryFolder } from "./folders.ts";
import { scanProjectSkills, skillOptionLabel, skillRunId, type ProjectSkill } from "./skills.ts";
import { ModelLimitsPanel } from "./ModelLimitsPanel.tsx";
import { CUSTOM_IMPLEMENT_MESSAGE, createCustomTask, customTaskRunnable, customTaskStatus, loadCustomTasks, saveCustomTasks, updateCustomTask, validateCustomTask, type CustomAutoTask, type CustomTaskMode } from "./custom.ts";
import { runCustomTask } from "./run-custom.ts";
import { releaseAutoTask, tryAcquireAutoTask } from "./lock.ts";
import { appendCustomRun, CUSTOM_RUNS_EVENT, readCustomRuns, type CustomTaskRun } from "./schedule.ts";
import { decideRun, resolvePath, type Resolve } from "./usage.ts";
import { guardedAgentCall, type AgentWrites } from "../../loop/native/agent-call.ts";
import { readOnlyCheck } from "./read-only.ts";
import "./native-autotasks.css";

/** The `/kb/loop/agent-run` answer fields an Auto Task reads. */
type AgentRunReply = AgentWrites & { reply?: string; ran?: boolean; unresolvedSkills?: string[]; resultSubtype?: string };

/** Paths git reports as changed right now; null when git cannot say. */
async function changedPathsNow(): Promise<string[] | null> {
  try { return await invokeHost<string[]>("loop_changed_paths"); } catch { return null; }
}

interface AutoTaskRun { id: string; task: string; at: string; ok: boolean; summary: string; durationSeconds: number }

export function NativeAutoTasksScreen({ projectRoot }: SectionProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  /** False until the project's skills have been read, so a saved skill is not marked "not installed" too early. */
  const [skillsScanned, setSkillsScanned] = useState(false);
  const [state, setState] = useState<AutoTaskLocalState>(() => loadState());
  const [selected, setSelected] = useState<AutoTaskId>("reviewCode");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState("");
  const [scheduleError, setScheduleError] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleActiveDraft, setScheduleActiveDraft] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>(loadTemplates);
  const [templateSaved, setTemplateSaved] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [customTasks, setCustomTasks] = useState<CustomAutoTask[]>(() => projectRoot ? loadCustomTasks(projectRoot) : []);
  const [customEdit, setCustomEdit] = useState<CustomAutoTask | "new" | null>(null);
  const [customDraft, setCustomDraft] = useState({ name: "", prompt: "", mode: "review" as CustomTaskMode, cron: "", enabled: true });
  const [customError, setCustomError] = useState<string | null>(null);
  const [customRunning, setCustomRunning] = useState(false);
  const [customRuns, setCustomRuns] = useState<CustomTaskRun[]>(() => readCustomRuns(undefined, projectRoot ?? undefined));
  const [folderPick, setFolderPick] = useState<null | "inputPath" | "outputPath">(null);
  const [folderList, setFolderList] = useState<LibraryFolder[] | null>(null);
  const [folderFilter, setFolderFilter] = useState("");
  const firedRef = useRef<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [runs, setRuns] = useState<AutoTaskRun[]>(() => {
    try { const raw = localStorage.getItem("llmide.autoTaskRuns.v1"); const v = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(v) ? v.slice(0, 50) as AutoTaskRun[] : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("llmide.autoTaskRuns.v1", JSON.stringify(runs.slice(0, 50))); } catch { /* session only */ } }, [runs]);
  const task = TASK_BY_ID[selected];
  const config = state.configs[selected];
  const rescanSkills = () => {
    setSkillsScanned(false);
    void scanProjectSkills(fs).then((list) => { setSkills(list); setSkillsScanned(true); });
  };
  useEffect(() => {
    if (!projectRoot) { setSkills([]); setSkillsScanned(false); return; }
    let live = true;
    void scanProjectSkills(fs).then((list) => { if (live) { setSkills(list); setSkillsScanned(true); } });
    return () => { live = false; };
  }, [fs, projectRoot]);
  useEffect(() => { setCronDraft(config.cron); setScheduleError(false); }, [selected, config.cron]);
  useEffect(() => {
    setCustomTasks(projectRoot ? loadCustomTasks(projectRoot) : []);
    setCustomEdit(null);
  }, [projectRoot]);
  useEffect(() => {
    const onRuns = (e: Event) => {
      const all = (e as CustomEvent).detail as CustomTaskRun[] | undefined;
      setCustomRuns((all ?? readCustomRuns()).filter((r) => !projectRoot || r.projectRoot === projectRoot));
    };
    window.addEventListener(CUSTOM_RUNS_EVENT, onRuns);
    return () => window.removeEventListener(CUSTOM_RUNS_EVENT, onRuns);
  }, []);
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
    if (!state.masterEnabled) return;
    const tick = () => {
      if (running) return;
      const now = new Date();
      const minute = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      for (const t of TASKS) {
        const c = state.configs[t.id];
        if (!scheduledRunAllowed(t.id, c, hasRepo) || !validateCron(c.cron)) continue;
        if (!cronMatches(c.cron, now)) continue;
        const key = `${t.id}:${minute}`;
        if (firedRef.current[key]) continue;
        let persisted: Record<string, string> = {};
        try { persisted = JSON.parse(localStorage.getItem("llmide.autoTaskFired.v1") ?? "{}") as Record<string, string>; } catch { persisted = {}; }
        if (persisted[key]) { firedRef.current[key] = minute; continue; }
        persisted[key] = minute;
        firedRef.current[key] = minute;
        try { localStorage.setItem("llmide.autoTaskFired.v1", JSON.stringify(Object.fromEntries(Object.entries(persisted).slice(-200)))); } catch { /* session */ }
        void runTask(t.id);
        return;
      }
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [state, running, hasRepo]);

  const runTask = async (id: AutoTaskId = selected) => {
    if (running) return;
    const t = TASK_BY_ID[id]; const c = state.configs[id];
    if (!desktopRunnable(id)) { setNotice(MAC_ONLY_MESSAGE); return; }
    if (!state.masterEnabled) { setNotice("Enable Auto Tasks first."); return; }
    if (requiresLinkedRepo(id) && !hasRepo) { setNotice("No linked repository detected. Add one in Settings first."); return; }
    const inputPath = normalizeProjectPath(c.inputPath);
    const outputPath = normalizeProjectPath(c.outputPath);
    if (inputPath === null || outputPath === null) { setNotice("Input and output must be folders inside the project (relative, no “..”)."); return; }
    const skillId = c.skillName ? skillRunId(c.skillName) : null;
    if (c.skillName && !skillId) { setNotice(`“${c.skillName}” cannot run in an Auto Task (code-applying or not a plain skill name).`); return; }
    if (!tryAcquireAutoTask()) { setNotice("Another Auto Task is running; wait for it to finish."); return; }
    setRunning(true);
    setLog((l) => [...l, `▶ ${t.label}`, ""]);
    const started = new Date();
    try {
      const workRoot = await invokeHost<string>("loop_work_root");
      // The server's model caps apply here: a paused chain stops the run, and an engaged one picks the model. As on
      // the Mac, a failed check does not block the run (an older server or a blip would stop every night run); the
      // log says so.
      // The desktop has no saved default model yet, so no `prefer` is sent (the Mac sends its defaultModelId).
      const decision = await decideRun(() => core.request<Resolve>(resolvePath("anthropic")));
      if (decision.proceed && decision.warning) { const w = decision.warning; setLog((l) => [...l, w]); }
      if (!decision.proceed) {
        setLog((l) => [...l, decision.notice]);
        setRuns((xs) => [{ id: crypto.randomUUID(), task: t.label, at: started.toISOString(), ok: false, summary: "paused by model limits", durationSeconds: Math.round((Date.now() - started.getTime()) / 1000) }, ...xs].slice(0, 50));
        setNotice(decision.notice);
        return;
      }
      // A read-only task's writes are checked whether the call returns or throws. The pre-run snapshot is what makes the
      // revert safe: a path that was already dirty before the run is never reverted (its edits would be lost).
      const snapshot = t.readOnlyOutput ? await changedPathsNow() : null;
      const g = await guardedAgentCall<AgentRunReply>({
        before: snapshot === null ? null : new Set(snapshot),
        call: () => core.request<AgentRunReply>("/kb/loop/agent-run", {
          method: "POST", body: { message: composeTaskMessage(c.prompt, inputPath, outputPath), repoRoot: workRoot, skills: skillId ? [skillId] : undefined, model: decision.proceed ? decision.model : undefined, timeoutMs: 30 * 60 * 1000 },
        }),
        changedNow: changedPathsNow,
        check: t.readOnlyOutput
          ? readOnlyCheck(async (paths, created) => { await invokeHost("loop_revert_paths", { paths, created }); })
          : async () => null,
      });
      if (t.readOnlyOutput && g.writes.length) {
        setLog((l) => [...l, g.violation ? `read-only task not reverted: ${g.violation}` : `read-only task reverted: ${g.writes.join(", ")}`]);
      }
      if (g.result === null) throw new Error(`the agent run failed (${g.error ?? "unknown error"})${g.violation ? `; ${g.violation}` : ""}`);
      const r = g.result;
      const touched = t.readOnlyOutput && g.violation === null ? [] : g.writes;
      // A read-only task whose edits could not be reverted did not complete: its writes are left in place and reported.
      const ok = agentRunSucceeded(r) && g.violation === null;
      setLog((l) => [...l, r.reply ?? "(no reply)", ...(touched.length ? [`changed: ${touched.join(", ")}`] : []), ...(r.unresolvedSkills?.length ? [`did not run: skill not found in your skills library: ${r.unresolvedSkills.join(", ")}`] : [])]);
      setRuns((xs) => [{ id: crypto.randomUUID(), task: t.label, at: started.toISOString(), ok, summary: r.resultSubtype ?? (ok ? "completed" : "failed"), durationSeconds: Math.round((Date.now() - started.getTime()) / 1000) }, ...xs].slice(0, 50));
      setNotice(ok ? `${t.label} completed.` : `${t.label} did not complete.`);
    } catch (e) {
      setLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setRuns((xs) => [{ id: crypto.randomUUID(), task: t.label, at: started.toISOString(), ok: false, summary: e instanceof Error ? e.message : "failed", durationSeconds: Math.round((Date.now() - started.getTime()) / 1000) }, ...xs].slice(0, 50));
      setNotice(e instanceof Error ? e.message : "The task could not run.");
    } finally { setRunning(false); releaseAutoTask(); }
  };

  const openCustom = (task?: CustomAutoTask) => {
    setCustomError(null);
    if (task) {
      setCustomEdit(task);
      setCustomDraft({ name: task.name, prompt: task.prompt, mode: task.mode, cron: task.cron, enabled: task.enabled });
    } else {
      setCustomEdit("new");
      setCustomDraft({ name: "", prompt: "", mode: "review", cron: "", enabled: true });
    }
  };
  const persistCustom = (list: CustomAutoTask[]) => { setCustomTasks(list); if (projectRoot) saveCustomTasks(list, projectRoot); };
  const saveCustom = () => {
    if (!projectRoot) { setCustomError("Open a project first."); return; }
    const error = validateCustomTask(customDraft) ?? (customDraft.cron.trim() && !validateCron(customDraft.cron) ? "Use a valid five-field cron expression, or leave it empty." : null);
    if (error) { setCustomError(error); return; }
    try {
      if (customEdit === "new" || customEdit === null) {
        const next = createCustomTask(projectRoot, customDraft);
        persistCustom([...customTasks, next]);
        setCustomEdit(next);
      } else {
        const next = updateCustomTask(customEdit, customDraft);
        persistCustom(customTasks.map((t) => t.id === next.id ? next : t));
        setCustomEdit(next);
      }
      setCustomError(null);
      setNotice(`Saved custom task “${customDraft.name.trim()}”.`);
    } catch (e) { setCustomError(e instanceof Error ? e.message : String(e)); }
  };
  const deleteCustom = () => {
    if (customEdit === "new" || customEdit === null) { setCustomEdit(null); return; }
    persistCustom(customTasks.filter((t) => t.id !== customEdit.id));
    setCustomEdit(null);
    setNotice("Custom task deleted.");
  };
  const runCustom = async (task: CustomAutoTask) => {
    if (customRunning) return;
    if (!customTaskRunnable(task)) { setNotice(CUSTOM_IMPLEMENT_MESSAGE); return; }
    if (!state.masterEnabled) { setNotice("Enable Auto Tasks first."); return; }
    if (!tryAcquireAutoTask()) { setNotice("Another Auto Task is running; wait for it to finish."); return; }
    setCustomRunning(true);
    const started = new Date();
    try {
      const result = await runCustomTask(task, {
        request: (path, init) => core.request(path, init as never),
        workRoot: () => invokeHost<string>("loop_work_root"),
        changedPaths: async () => { try { return await invokeHost<string[]>("loop_changed_paths"); } catch { return null; } },
        revert: async (paths, created) => { await invokeHost("loop_revert_paths", { paths, created }); },
      });
      if (result.warning) setLog((l) => [...l, result.warning!]);
      if (result.writes.length) setLog((l) => [...l, `left behind: ${result.writes.join(", ")}`]);
      appendCustomRun({
        id: crypto.randomUUID(), taskId: task.id, task: task.name, projectRoot: projectRoot ?? "", at: started.toISOString(), ok: result.ok,
        summary: result.reply.trim().split("\n")[0]?.slice(0, 300) || result.error || (result.ok ? "completed" : "failed"),
        trigger: "manual",
      });
      setNotice(result.ok ? `${task.name} completed.` : `${task.name} did not complete: ${result.error ?? "failed"}`);
    } catch (e) {
      appendCustomRun({ id: crypto.randomUUID(), taskId: task.id, task: task.name, projectRoot: projectRoot ?? "", at: started.toISOString(), ok: false, summary: e instanceof Error ? e.message : "failed", trigger: "manual" });
      setNotice(e instanceof Error ? e.message : "The custom task could not run.");
    } finally { setCustomRunning(false); releaseAutoTask(); }
  };

  const openFolderPicker = (field: "inputPath" | "outputPath") => {
    setFolderPick(field); setFolderFilter(""); setFolderList(null);
    void scanLibraryFolders(fs).then((list) => setFolderList(list));
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
            <p>No linked repository detected. Auto Tasks other than Source Update need an active GitHub or GitLab project with a local clone path and a matching token.</p>
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
                      <input type="checkbox" checked={state.configs[t.id]?.enabled ?? false} disabled={!desktopRunnable(t.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => update({ enabled: e.target.checked }, t.id)} aria-label={`${t.label} enabled`} />
                      <span className="atn-task-icon" aria-hidden="true">{iconFor(t.id)}</span><span>{t.label}</span>
                      {desktopRunnable(t.id) ? null : <span className="atn-hint atn-mac-only">Mac app</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {grouped.length === 0 ? <p className="atn-hint">No tasks match this filter.</p> : null}
        </div>
        <section className="atn-custom" aria-label="Custom tasks">
          <h3 className="atn-group">Custom Tasks <button type="button" className="atn-link" disabled={!projectRoot} onClick={() => openCustom()}>Add</button></h3>
          {!projectRoot ? <p className="atn-hint">Open a project to add custom tasks.</p> : customTasks.length === 0 ? <p className="atn-hint">No custom tasks yet.</p> : (
            <ul>
              {customTasks.map((t) => (
                <li key={t.id}>
                  <button type="button" className="atn-row" data-on={customEdit !== "new" && customEdit?.id === t.id || undefined} onClick={() => openCustom(t)}>
                    <input type="checkbox" checked={t.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => persistCustom(customTasks.map((x) => x.id === t.id ? { ...x, enabled: e.target.checked } : x))} aria-label={`${t.name} enabled`} />
                    <span className="atn-task-icon" aria-hidden="true">✦</span><span>{t.name}</span>
                    {!customTaskRunnable(t) ? <span className="atn-hint atn-mac-only">Mac only</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {customRuns.length ? <section className="atn-history"><h3>Recent custom runs</h3><ul>{customRuns.slice(0, 3).map((r) => <li key={r.id}><span>{r.ok ? "✓" : "✗"} {r.task}</span><span className="atn-hint">{new Date(r.at).toLocaleString()}</span></li>)}</ul></section> : null}
        </section>
        <button type="button" className="atn-model" onClick={() => setLimitsOpen(true)}>Model &amp; Limits</button>
        <section className="atn-history"><h3>Recent runs</h3>{runs.length === 0 ? <p className="atn-hint">No runs yet.</p> : <ul>{runs.slice(0, 6).map((r) => <li key={r.id}><span>{r.ok ? "✓" : "✗"} {r.task}</span><span className="atn-hint">{r.durationSeconds}s · {new Date(r.at).toLocaleString()}</span></li>)}</ul>}</section>
        <section className="atn-history"><h3>Action items</h3><p className="atn-hint">No action items yet. Run Sources → Issue or record a meeting with action items.</p></section>
        <button type="button" className="atn-run-now" disabled={running || !desktopRunnable(selected)} title={!desktopRunnable(selected) ? MAC_ONLY_MESSAGE : running ? "A task is running" : "Run the selected task now"} onClick={() => void runTask()}>{running ? "Running…" : "▶ Run Now"}</button>
      </aside>

      <main className="atn-main">
        <header className="atn-titlebar">
          <span className="atn-title-icon" aria-hidden="true">✓</span>
          <h1>{task.label}</h1>
          <span className="atn-spacer" />
          <button type="button" className="atn-btn atn-primary" disabled={running || !desktopRunnable(selected)} title={!desktopRunnable(selected) ? MAC_ONLY_MESSAGE : undefined} onClick={() => void runTask()}>{running ? "Running…" : "▶ Run"}</button>
        </header>
        <div className="atn-stars" aria-label="Task rating">★ ★ ★ ★ ☆</div>
        <div className="atn-subtitle"><span className="atn-hint" role="status">◷ {scheduleStatusLine(state.masterEnabled, config, selected, new Date())}{desktopRunnable(selected) && config.scheduleActive && config.enabled && state.masterEnabled ? ` (${describeCron(config.cron)})` : ""}</span><span className="atn-spacer" /><label className="atn-inline"><input type="checkbox" checked={config.enabled} disabled={!desktopRunnable(selected)} onChange={(e) => update({ enabled: e.target.checked })} /> Active</label><button type="button" className="atn-btn" onClick={() => { setCronDraft(config.cron); setScheduleActiveDraft(config.scheduleActive); setScheduleError(false); setScheduleOpen(true); }}>Edit</button></div>
        {notice ? <p className="atn-notice" role="status">{notice}</p> : null}

        {!desktopRunnable(selected) ? (
          <section className="atn-card">
            <header><span aria-hidden="true">ⓘ</span><h2>ABOUT</h2></header>
            <p className="atn-notice">{MAC_ONLY_MESSAGE}</p>
          </section>
        ) : null}
        {desktopRunnable(selected) ? (<>
        <section className="atn-card">
          <header><span aria-hidden="true">☰</span><h2>SETTINGS</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Reload task settings" onClick={() => setState(loadState())}>↻</button></header>
          <label className="atn-field"><span>Input path <button type="button" className="atn-link" onClick={() => openFolderPicker("inputPath")}>Choose…</button></span><input value={config.inputPath} placeholder="Whole project" onChange={(e) => update({ inputPath: e.target.value })} /><em>What the task reads. Empty means the whole project.</em></label>
          <label className="atn-field"><span>Output path <button type="button" className="atn-link" onClick={() => openFolderPicker("outputPath")}>Choose…</button></span><input value={config.outputPath} placeholder="Whole project" onChange={(e) => update({ outputPath: e.target.value })} /><em>{task.readOnlyOutput ? "Read-only task — edits are reverted after the run; this is the intended destination." : "Where the task writes its result."}</em></label>
          <label className="atn-field"><span>Skill <button type="button" className="atn-link" aria-label="Rescan skills" disabled={!projectRoot} onClick={rescanSkills}>Rescan</button></span><select value={config.skillName} onChange={(e) => update({ skillName: e.target.value })}><option value="">None</option>{[...skills.map((x) => x.name), ...(config.skillName && !skills.some((x) => x.name === config.skillName) ? [config.skillName] : [])].map((name) => <option key={name} value={name}>{skillOptionLabel(name, skills.some((x) => x.name === name) || !skillsScanned)}</option>)}</select><em>Run the prompt under one of the project's agent skills.</em></label>
        </section>

        <section className="atn-card">
          <header><span aria-hidden="true">📄</span><h2>TEMPLATE</h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => setResetOpen(true)}>Restore Default</button><button type="button" className="atn-link" onClick={() => { setTemplateName(""); setTemplateOpen(true); }}>Save as…</button></header>
          <select aria-label="Template" value={config.template} onChange={(e) => update({ template: e.target.value as "builtin" | "custom" })}><option value="builtin">Built-in prompt</option><option value="custom">Custom prompt</option></select>
          <select aria-label="Saved prompt template" value={templateSaved ?? ""} onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) { update({ template: "custom", prompt: t.prompt }); setTemplateSaved(t.id); } else setTemplateSaved(null); }}>
            <option value="">Saved templates…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {templateSaved && templates.some((t) => t.id === templateSaved) ? <button type="button" className="atn-link" onClick={() => { const next = removeTemplate(templates, templateSaved); setTemplates(next); saveTemplates(next); setTemplateSaved(null); }}>Delete template</button> : null}
          <textarea aria-label="Prompt" rows={7} value={config.prompt} onChange={(e) => update({ prompt: e.target.value, template: "custom" })} />
        </section>
        <section className="atn-card">
          <header><span aria-hidden="true">▤</span><h2>EFFECTIVE PROMPT</h2><span className="atn-spacer" /><button type="button" className="atn-link" aria-expanded={showPreview} onClick={() => setShowPreview((v) => !v)}>{showPreview ? "Hide" : "Show"}</button></header>
          {showPreview ? <EffectivePrompt config={config} task={task} /> : <p className="atn-hint">What this task will send to the agent, with the skill and folders above applied.</p>}
        </section>
        </>) : null}

        <section className="atn-card atn-log"><header><h2>Log <span className="atn-hint">live</span></h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => setLog([])}>Clear</button></header>{log.length === 0 ? <p className="atn-hint">No log lines yet.</p> : <pre className="atn-log-pre">{log.join("\n")}</pre>}</section>
      </main>
      {limitsOpen ? <ModelLimitsPanel onClose={() => setLimitsOpen(false)} /> : null}
      {customEdit ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-custom-title">
          <div className="atn-modal-card atn-custom-editor">
            <header><h2 id="atn-custom-title">{customEdit === "new" ? "New custom task" : "Custom task"}</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close custom task" onClick={() => setCustomEdit(null)}>×</button></header>
            <label className="atn-field"><span>Name</span><input value={customDraft.name} maxLength={80} autoFocus placeholder="Nightly cleanup" onChange={(e) => setCustomDraft((d) => ({ ...d, name: e.target.value }))} /></label>
            <label className="atn-field"><span>Mode</span><select value={customDraft.mode} onChange={(e) => setCustomDraft((d) => ({ ...d, mode: e.target.value as CustomTaskMode }))}><option value="review">Review — edits are reverted</option><option value="implement">Implement — Mac only</option></select><em>{customDraft.mode === "implement" ? CUSTOM_IMPLEMENT_MESSAGE : "The task runs against the whole project and every file it changes is reverted."}</em></label>
            <label className="atn-field"><span>Schedule</span><input className="atn-cron" value={customDraft.cron} spellCheck={false} placeholder="0 * * * * — empty for manual only" onChange={(e) => setCustomDraft((d) => ({ ...d, cron: e.target.value }))} /><em>{customDraft.cron.trim() ? (validateCron(customDraft.cron) ? describeCron(customDraft.cron) : "Invalid five-field cron expression.") : "Manual only."}</em></label>
            <label className="atn-field"><span>Prompt</span><textarea rows={8} value={customDraft.prompt} onChange={(e) => setCustomDraft((d) => ({ ...d, prompt: e.target.value }))} /></label>
            {customError ? <p className="atn-notice" role="alert">{customError}</p> : null}
            {customEdit !== "new" ? <p className="atn-hint">{customTaskStatus(customEdit, state.masterEnabled, new Date())}</p> : null}
            <div className="atn-modal-actions">
              {customEdit !== "new" ? <button type="button" className="atn-btn atn-danger" onClick={deleteCustom}>Delete</button> : null}
              <span className="atn-spacer" />
              {customEdit !== "new" ? <button type="button" className="atn-btn" disabled={customRunning || !customTaskRunnable(customEdit)} title={!customTaskRunnable(customEdit) ? CUSTOM_IMPLEMENT_MESSAGE : undefined} onClick={() => void runCustom(customEdit)}>{customRunning ? "Running…" : "▶ Run now"}</button> : null}
              <button type="button" className="atn-btn" onClick={() => setCustomEdit(null)}>Cancel</button>
              <button type="button" className="atn-btn atn-primary" onClick={saveCustom}>{customEdit === "new" ? "Create" : "Save"}</button>
            </div>
          </div>
        </div>
      ) : null}
      {folderPick ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-folder-title">
          <div className="atn-modal-card">
            <header><h2 id="atn-folder-title">{folderPick === "inputPath" ? "Input folder" : "Output folder"}</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close folder picker" onClick={() => setFolderPick(null)}>×</button></header>
            {!projectRoot ? <p className="atn-hint">Open a project to choose a folder.</p> : folderList === null ? <p className="atn-hint">Reading the project's folders…</p> : (<>
              <input aria-label="Filter folders" placeholder="Filter folders" value={folderFilter} onChange={(e) => setFolderFilter(e.target.value)} />
              <ul className="atn-folder-list">
                <li><button type="button" className="atn-row" data-on={(folderPick === "inputPath" ? config.inputPath : config.outputPath) === "" || undefined} onClick={() => { update({ [folderPick]: "" }); setFolderPick(null); }}><span>Whole project</span></button></li>
                {folderList.filter((f) => f.path.toLowerCase().includes(folderFilter.trim().toLowerCase())).map((f) => (
                  <li key={f.path} style={{ paddingLeft: (f.depth - 1) * 14 }}><button type="button" className="atn-row" data-on={(folderPick === "inputPath" ? config.inputPath : config.outputPath) === f.path || undefined} onClick={() => { update({ [folderPick]: f.path }); setFolderPick(null); }}><span>{f.path.split("/").pop()}</span><span className="atn-hint">{f.path}</span></button></li>
                ))}
              </ul>
              {folderList.length === 0 ? <p className="atn-hint">This project has no Library folders yet.</p> : null}
            </>)}
            <div className="atn-modal-actions"><button type="button" className="atn-btn" disabled={!folderPick || (folderPick === "inputPath" ? config.inputPath : config.outputPath) === ""} onClick={() => { if (folderPick) update({ [folderPick]: "" }); setFolderPick(null); }}>Clear</button><button type="button" className="atn-btn" onClick={() => setFolderPick(null)}>Cancel</button></div>
          </div>
        </div>
      ) : null}
      {resetOpen ? (
        <div className="atn-modal" role="alertdialog" aria-modal="true" aria-labelledby="atn-reset-title" aria-describedby="atn-reset-body">
          <div className="atn-modal-card">
            <header><h2 id="atn-reset-title">{resetTemplateTitle(task.label)}</h2></header>
            <p id="atn-reset-body" className="atn-hint">{RESET_TEMPLATE_MESSAGE}</p>
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setResetOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-danger" onClick={() => { update({ template: "builtin", prompt: task.prompt }); setResetOpen(false); setNotice(`${task.label} prompt restored to default.`); }}>Reset to Default</button></div>
          </div>
        </div>
      ) : null}
      {templateOpen ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-template-title">
          <div className="atn-modal-card">
            <header><h2 id="atn-template-title">Save prompt template</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close template" onClick={() => setTemplateOpen(false)}>×</button></header>
            <label className="atn-field"><span>Name</span><input value={templateName} autoFocus maxLength={80} placeholder="Review checklist" onChange={(e) => setTemplateName(e.target.value)} /></label>
            <p className="atn-hint">Saves this task's current prompt as a reusable template.</p>
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setTemplateOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-primary" disabled={!templateName.trim() || !config.prompt.trim()} onClick={() => { const r = addTemplate(templates, templateName, config.prompt); if (!r) return; setTemplates(r.list); saveTemplates(r.list); setTemplateSaved(r.saved.id); setTemplateOpen(false); setNotice(`Saved template “${r.saved.name}”.`); }}>Save</button></div>
          </div>
        </div>
      ) : null}
      {scheduleOpen ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-schedule-title">
          <div className="atn-modal-card">
            <header><h2 id="atn-schedule-title">Schedule · {task.label}</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close schedule" onClick={() => setScheduleOpen(false)}>×</button></header>
            <label className="atn-inline"><input type="checkbox" checked={scheduleActiveDraft} onChange={(e) => setScheduleActiveDraft(e.target.checked)} /> Run on schedule</label>
            <label className="atn-field"><span>Cron expression</span><input className="atn-cron" value={cronDraft} spellCheck={false} placeholder="0 * * * *" onChange={(e) => { setCronDraft(e.target.value); setScheduleError(!validateCron(e.target.value)); }} /><em>{scheduleError ? "Invalid five-field cron expression." : describeCron(cronDraft)}</em></label>
            <p className="atn-hint">The schedule runs while the Auto Tasks page is open; background scheduling is not ported yet.</p>
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setScheduleOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-primary" disabled={!validateCron(cronDraft)} onClick={() => { if (!validateCron(cronDraft)) { setScheduleError(true); return; } update({ cron: cronDraft.trim(), scheduleActive: scheduleActiveDraft }); setScheduleOpen(false); setNotice(scheduleActiveDraft ? "Schedule saved and active while this page is open." : "Schedule saved; turn on Run on schedule to arm it."); }}>Save</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The exact text a run sends: the same composer `runTask` uses, plus the skill it is run under. */
function EffectivePrompt({ config, task }: { config: AutoTaskConfig; task: { label: string; readOnlyOutput?: boolean } }): ReactNode {
  const inputPath = normalizeProjectPath(config.inputPath);
  const outputPath = normalizeProjectPath(config.outputPath);
  if (inputPath === null || outputPath === null) {
    return <p className="atn-notice">Input and output must be folders inside the project (relative, no “..”).</p>;
  }
  const skillId = config.skillName ? skillRunId(config.skillName) : null;
  return (
    <>
      <pre className="atn-log-pre atn-preview" aria-label={`Effective prompt for ${task.label}`}>{composeTaskMessage(config.prompt, inputPath, outputPath)}</pre>
      <p className="atn-hint">{config.skillName ? (skillId ? `Skill: ${skillId}` : `Skill “${config.skillName}” cannot run in an Auto Task.`) : "No skill: the prompt runs on its own."}</p>
      {task.readOnlyOutput ? <p className="atn-hint">Read-only task: any file it changes is reverted after the run.</p> : null}
    </>
  );
}

export default NativeAutoTasksScreen;
