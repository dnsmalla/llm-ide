// Native Auto Tasks screen. Task settings are per project (tasks/store.ts); the schedule runs in the one desktop scheduler
// (tasks/scheduler-host.ts, started by the shell), so it fires while any section is open. This page runs tasks on demand.
import { notifyTask } from "../../shell/notify/notify";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { shellBus } from "../../shell/bus";
import { core } from "../../shell/runtime";
import { invokeHost } from "../../shell/host";
import { createHostFs } from "../../explorer/fs";
import { GROUPS, RESET_TEMPLATE_MESSAGE, resetTemplateTitle, AUTO_TASK_ROWS, enabledTaskOrder, AUTO_TASK_BY_ID, composeTaskMessage, desktopRunnable, isSchedulable, takeMergedNotice, taskUnavailableReason, scheduleStatusLine, normalizeProjectPath, requiresLinkedRepo, type AutoTaskId } from "./model.ts";
import { describeCron, validateCron } from "./cron.ts";
import { addTemplate, loadTemplates, removeTemplate, saveTemplates, type PromptTemplate } from "./prompt-templates.ts";
import { scanLibraryFolders, type LibraryFolder } from "./folders.ts";
import { scanProjectSkills, skillOptionLabel, skillRunId, type ProjectSkill } from "./skills.ts";
import { CUSTOM_IMPLEMENT_MESSAGE, createCustomTask, customTaskRunnable, customTaskStatus, loadCustomTasks, saveCustomTasks, updateCustomTask, validateCustomTask, type CustomAutoTask, type CustomTaskMode } from "./custom.ts";
import { runCustomTask } from "./run-custom.ts";
import { taskFocus, taskPromptWithFocus } from "../../tasks/model.ts";
import { hasLinkedRepo, runRegisteredTask } from "../../tasks/run-registered.ts";
import { loadTaskState, saveTaskState, takeTaskNotices, type TaskConfig, type TaskState } from "../../tasks/store.ts";
import { appendTaskRun, readTaskRuns, runLabel, TASK_RUNS_EVENT, type TaskRunRecord } from "../../tasks/run-history.ts";
import { SKIP_CODES } from "../../tasks/schedule.ts";
import { releaseAutoTask, tryAcquireAutoTask } from "./lock.ts";
import { appendCustomRun, CUSTOM_RUNS_EVENT, readCustomRuns, type CustomTaskRun } from "./custom-schedule.ts";
import "./native-autotasks.css";

/** Paths git reports as changed right now; null when git cannot say. */
async function changedPathsNow(): Promise<string[] | null> {
  try { return await invokeHost<string[]>("loop_changed_paths"); } catch { return null; }
}

/** The focus text a task runs with: the user's own when it is set, else the registry's. */
const promptText = (c: TaskConfig, id: string): string => c.promptOverride ?? taskFocus(id) ?? "";

export function NativeAutoTasksScreen({ projectRoot }: SectionProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  /** False until the project's skills have been read, so a saved skill is not marked "not installed" too early. */
  const [skillsScanned, setSkillsScanned] = useState(false);
  const [state, setState] = useState<TaskState>(() => loadTaskState(projectRoot ?? ""));
  const [selected, setSelected] = useState<AutoTaskId>("review.code");
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
  const [customTasks, setCustomTasks] = useState<CustomAutoTask[]>(() => projectRoot ? loadCustomTasks(projectRoot) : []);
  const [customEdit, setCustomEdit] = useState<CustomAutoTask | "new" | null>(null);
  const [customDraft, setCustomDraft] = useState({ name: "", prompt: "", mode: "review" as CustomTaskMode, cron: "", enabled: true });
  const [customError, setCustomError] = useState<string | null>(null);
  const [customRunning, setCustomRunning] = useState(false);
  const [customRuns, setCustomRuns] = useState<CustomTaskRun[]>(() => readCustomRuns(undefined, projectRoot ?? undefined));
  const [folderPick, setFolderPick] = useState<null | "inputPath" | "outputPath">(null);
  const [folderList, setFolderList] = useState<LibraryFolder[] | null>(null);
  const [folderFilter, setFolderFilter] = useState("");
  /** Aborts the one in-flight Auto Task (built-in or custom: the shared lock allows only one). Stop and leaving use it. */
  const runAbortRef = useRef<AbortController | null>(null);
  const [customDeleteOpen, setCustomDeleteOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const runAllRef = useRef(false);
  const [log, setLog] = useState<string[]>([]);
  const [runs, setRuns] = useState<TaskRunRecord[]>(() => readTaskRuns());
  // Runs are written by the page and by the scheduler; the list re-reads the one store when either writes.
  useEffect(() => {
    const onRuns = () => setRuns(readTaskRuns());
    window.addEventListener(TASK_RUNS_EVENT, onRuns);
    return () => window.removeEventListener(TASK_RUNS_EVENT, onRuns);
  }, []);
  const task = AUTO_TASK_BY_ID[selected];
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
  // The project's one-time notices (copied settings, switched-off schedules) are shown once; the state is then re-read
  // so a later save does not write the taken notices back.
  useEffect(() => {
    const root = projectRoot ?? "";
    const notices = takeTaskNotices(root);
    setState(loadTaskState(root));
    const merged = takeMergedNotice();
    const text = [...notices, ...(merged ? [merged] : [])].join(" ");
    if (text) setNotice(text);
  }, [projectRoot]);
  // A delete armed for one custom task must not carry over to another task's editor.
  useEffect(() => { setCustomDeleteOpen(false); }, [customEdit]);
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
  }, [projectRoot]);
  const hasRepo = hasLinkedRepo();
  const taskEnv = { features: null, coreFeatures: null, hasRepo, localHost: true, mode: "local" as const };
  const selectedReason = taskUnavailableReason(selected, taskEnv);
  const iconFor = (id: AutoTaskId): string => ({ "sources.update": "↻", "issues.from_notes": "◫", "issues.implement": "⌘", reviewMerge: "⇄", "review.code": "✓", "review.doc": "▤", "review.conflicts": "⚠", "plan.status": "▥", "loop.regression": "↺" } as Record<string, string>)[id] ?? "•";
  const grouped = useMemo(() => GROUPS.map((g) => [g, AUTO_TASK_ROWS.filter((t) => t.group === g && (!onlyEnabled || state.configs[t.id]?.enabled))] as const).filter(([, list]) => list.length > 0), [state, onlyEnabled]);

  const update = (patch: Partial<TaskConfig>, id: AutoTaskId = selected) => {
    setState((s) => {
      const next = { ...s, configs: { ...s.configs, [id]: { ...s.configs[id], ...patch } } };
      saveTaskState(projectRoot ?? "", next);
      return next;
    });
  };

  /** Stops the running Auto Task (built-in or custom) through its abort signal. */
  const stopTask = () => {
    runAllRef.current = false;
    runAbortRef.current?.abort();
    setNotice("Stopping the task…");
  };

  // Leaving the page (a project switch remounts it) cancels a run still in flight, as Stop does. The lock is released by
  // the run's own finally once its call rejects.
  useEffect(() => () => {
    runAbortRef.current?.abort();
  }, []);

  /** One task body; the caller owns the lock and the AbortController. */
  const executeTask = async (id: AutoTaskId, signal: AbortSignal): Promise<boolean> => {
    const t = AUTO_TASK_BY_ID[id]; const c = state.configs[id];
    if (!desktopRunnable(id, taskEnv)) { setNotice(taskUnavailableReason(id, taskEnv) ?? "This task cannot run here."); return false; }
    if (!state.masterEnabled) { setNotice("Enable Auto Tasks first."); return false; }
    if (requiresLinkedRepo(id) && !hasRepo) { setNotice("No linked repository detected. Add one in Settings first."); return false; }
    setSelected(id);
    setLog((l) => [...l, `▶ ${t.label}`, ""]);
    const started = new Date();
    const elapsed = () => Math.round((Date.now() - started.getTime()) / 1000);
    try {
      const outcome = await runRegisteredTask(id, {
        projectRoot: projectRoot ?? "",
        promptOverride: c.promptOverride,
        scheduled: false,
        core,
        fs,
        signal,
        log: (line) => setLog((l) => [...l, line]),
      });
      const stopped = signal.aborted;
      const skipped = !outcome.ok && SKIP_CODES.has(outcome.code ?? "");
      const summary = stopped ? "stopped" : outcome.summary;
      appendTaskRun({ id: crypto.randomUUID(), taskId: id, task: t.label, at: started.toISOString(), ok: outcome.ok, ...(skipped ? { skipped } : {}), summary, durationSeconds: elapsed() });
      setNotice(stopped ? `${t.label} stopped.` : outcome.ok ? `${t.label} completed.` : outcome.summary);
      if (!stopped && !skipped) void notifyTask("autotask", outcome.ok);
      return outcome.ok;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setLog((l) => [...l, message]);
      const stopped = signal.aborted;
      appendTaskRun({ id: crypto.randomUUID(), taskId: id, task: t.label, at: started.toISOString(), ok: false, summary: stopped ? "stopped" : message, durationSeconds: elapsed() });
      setNotice(stopped ? `${t.label} stopped.` : message || "The task could not run.");
      if (!stopped) void notifyTask("autotask", false);
      return false;
    }
  };

  /** Run Now: one selected task, with the page's own approval (a person is present). */
  const runTask = async (id: AutoTaskId = selected) => {
    if (runningRef.current) return;
    if (!tryAcquireAutoTask()) { setNotice("Another Auto Task is running; wait for it to finish."); return; }
    const abort = new AbortController();
    runAbortRef.current = abort;
    runningRef.current = true;
    setRunning(true);
    try { await executeTask(id, abort.signal); }
    finally { runAbortRef.current = null; runningRef.current = false; setRunning(false); releaseAutoTask(); }
  };

  /** Run all enabled tasks in menu order, top to bottom. */
  const runAll = async () => {
    if (runningRef.current) return;
    if (!state.masterEnabled) { setNotice("Enable Auto Tasks first."); return; }
    const ids = enabledTaskOrder(grouped.flatMap(([, list]) => list.map((t) => t.id)), state.configs, (id) => desktopRunnable(id, taskEnv));
    if (ids.length === 0) { setNotice("No enabled task can run here."); return; }
    if (!tryAcquireAutoTask()) { setNotice("Another Auto Task is running; wait for it to finish."); return; }
    const abort = new AbortController();
    runAbortRef.current = abort;
    runningRef.current = true;
    runAllRef.current = true;
    setRunning(true);
    let ok = 0;
    try {
      for (const id of ids) {
        if (!runAllRef.current || abort.signal.aborted) break;
        if (await executeTask(id, abort.signal)) ok += 1;
      }
      setNotice(abort.signal.aborted || !runAllRef.current ? `Run all stopped after ${ok} task${ok === 1 ? "" : "s"}.` : `Run all finished: ${ok} of ${ids.length} passed.`);
    } finally {
      runAllRef.current = false;
      runAbortRef.current = null;
      runningRef.current = false;
      setRunning(false);
      releaseAutoTask();
    }
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
    const abort = new AbortController();
    runAbortRef.current = abort;
    setCustomRunning(true);
    const started = new Date();
    try {
      const result = await runCustomTask(task, {
        request: (path, init) => core.request(path, init as never),
        signal: abort.signal,
        workRoot: () => invokeHost<string>("loop_work_root"),
        changedPaths: changedPathsNow,
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
      void notifyTask("autotask", result.ok);
    } catch (e) {
      // A user Stop is not a failure: logged as stopped, and no failure notification.
      const stopped = abort.signal.aborted;
      appendCustomRun({ id: crypto.randomUUID(), taskId: task.id, task: task.name, projectRoot: projectRoot ?? "", at: started.toISOString(), ok: false, summary: stopped ? "stopped" : e instanceof Error ? e.message : "failed", trigger: "manual" });
      setNotice(stopped ? `${task.name} stopped.` : e instanceof Error ? e.message : "The custom task could not run.");
      if (!stopped) void notifyTask("autotask", false);
    } finally { runAbortRef.current = null; setCustomRunning(false); releaseAutoTask(); }
  };

  const openFolderPicker = (field: "inputPath" | "outputPath") => {
    setFolderPick(field); setFolderFilter(""); setFolderList(null);
    void scanLibraryFolders(fs).then((list) => setFolderList(list));
  };
  const setMaster = (v: boolean) => setState((s) => { const n = { ...s, masterEnabled: v }; saveTaskState(projectRoot ?? "", n); return n; });

  return (
    <div className="atn-root">
      <aside className="atn-left" aria-label="Auto tasks">
        <div className="atn-head">
          <button type="button" className="atn-switch" data-on={state.masterEnabled || undefined} aria-label={state.masterEnabled ? "Disable Auto Tasks" : "Enable Auto Tasks"} aria-pressed={state.masterEnabled} onClick={() => setMaster(!state.masterEnabled)} />
          <strong>{state.masterEnabled ? "Enabled" : "Disabled"}</strong>
          <span className="atn-head-actions"><button type="button" className="atn-icon" aria-label="Refresh" onClick={() => setNotice("Auto Tasks settings are local; reloading is not needed.")}>↻</button></span>
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
                      <input type="checkbox" checked={state.configs[t.id]?.enabled ?? false} disabled={!desktopRunnable(t.id, taskEnv)} onClick={(e) => e.stopPropagation()} onChange={(e) => update({ enabled: e.target.checked }, t.id)} aria-label={`${t.label} enabled`} />
                      <span className="atn-task-icon" aria-hidden="true">{iconFor(t.id)}</span><span>{t.label}</span>
                      {desktopRunnable(t.id, taskEnv) ? null : <span className="atn-hint atn-mac-only" title={taskUnavailableReason(t.id, taskEnv) ?? undefined}>Unavailable</span>}
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
        <section className="atn-history"><h3>Recent runs</h3>{runs.length === 0 ? <p className="atn-hint">No runs yet.</p> : <ul>{runs.slice(0, 6).map((r) => <li key={r.id}><span>{r.skipped ? "–" : r.ok ? "✓" : "✗"} {runLabel(r)}</span><span className="atn-hint">{r.skipped ? `Skipped: ${r.summary} · ` : ""}{r.durationSeconds}s · {new Date(r.at).toLocaleString()}</span></li>)}</ul>}</section>
        <section className="atn-history"><h3>Action items</h3><p className="atn-hint">No action items yet. Run Sources → Issue or record a meeting with action items.</p></section>
        <button type="button" className="atn-btn" disabled={running || !state.masterEnabled} title="Run every enabled task from the top" onClick={() => void runAll()}>▶ Run all</button>
      </aside>

      <main className="atn-main">
        <header className="atn-titlebar">
          <span className="atn-title-icon" aria-hidden="true">✓</span>
          <h1>{task.label}</h1>
          <span className="atn-spacer" />
          <button type="button" className="atn-btn atn-primary" disabled={!running && !desktopRunnable(selected, taskEnv)} title={!desktopRunnable(selected, taskEnv) ? (selectedReason ?? undefined) : undefined} onClick={running ? stopTask : () => void runTask()}>{running ? "■ Stop" : "▶ Run"}</button>
        </header>
        <div className="atn-stars" aria-label="Task rating">★ ★ ★ ★ ☆</div>
        <div className="atn-subtitle"><span className="atn-hint" role="status">◷ {scheduleStatusLine(state.masterEnabled, config, selected, new Date(), taskEnv)}{desktopRunnable(selected, taskEnv) && config.scheduleActive && config.enabled && state.masterEnabled ? ` (${describeCron(config.cron)})` : ""}</span><span className="atn-spacer" /><label className="atn-inline"><input type="checkbox" checked={config.enabled} disabled={!desktopRunnable(selected, taskEnv)} onChange={(e) => update({ enabled: e.target.checked })} /> Active</label>{isSchedulable(selected) ? <button type="button" className="atn-btn" onClick={() => { setCronDraft(config.cron); setScheduleActiveDraft(config.scheduleActive); setScheduleError(false); setScheduleOpen(true); }}>Edit</button> : null}</div>
        {notice ? <p className="atn-notice" role="status">{notice}</p> : null}

        {!desktopRunnable(selected, taskEnv) ? (
          <section className="atn-card">
            <header><span aria-hidden="true">ⓘ</span><h2>ABOUT</h2></header>
            <p className="atn-notice">{selectedReason}</p>
          </section>
        ) : null}
        {desktopRunnable(selected, taskEnv) ? (<>
        <section className="atn-card">
          <header><span aria-hidden="true">☰</span><h2>SETTINGS</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Reload task settings" onClick={() => setState(loadTaskState(projectRoot ?? ""))}>↻</button></header>
          {taskFocus(selected) !== null ? (
            <p className="atn-hint">This review runs the registry prompt on the review engine in the registered project. The skill and the input and output folders do not apply to it.</p>
          ) : (<>
          <label className="atn-field"><span>Input path <button type="button" className="atn-link" onClick={() => openFolderPicker("inputPath")}>Choose…</button></span><input value={config.inputPath} placeholder="Whole project" onChange={(e) => update({ inputPath: e.target.value })} /><em>What the task reads. Empty means the whole project.</em></label>
          <label className="atn-field"><span>Output path <button type="button" className="atn-link" onClick={() => openFolderPicker("outputPath")}>Choose…</button></span><input value={config.outputPath} placeholder="Whole project" onChange={(e) => update({ outputPath: e.target.value })} /><em>{task.readOnlyOutput ? "Read-only task — edits are reverted after the run; this is the intended destination." : "Where the task writes its result."}</em></label>
          <label className="atn-field"><span>Skill <button type="button" className="atn-link" aria-label="Rescan skills" disabled={!projectRoot} onClick={rescanSkills}>Rescan</button></span><select value={config.skillName} onChange={(e) => update({ skillName: e.target.value })}><option value="">None</option>{[...skills.map((x) => x.name), ...(config.skillName && !skills.some((x) => x.name === config.skillName) ? [config.skillName] : [])].map((name) => <option key={name} value={name}>{skillOptionLabel(name, skills.some((x) => x.name === name) || !skillsScanned)}</option>)}</select><em>Run the prompt under one of the project's agent skills.</em></label>
          </>)}
        </section>

        {task.prompt ? (<>
        <section className="atn-card">
          <header><span aria-hidden="true">📄</span><h2>TEMPLATE</h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => setResetOpen(true)}>Restore Default</button><button type="button" className="atn-link" onClick={() => { setTemplateName(""); setTemplateOpen(true); }}>Save as…</button></header>
          <select aria-label="Template" value={config.promptOverride === null ? "builtin" : "custom"} onChange={(e) => update({ promptOverride: e.target.value === "builtin" ? null : promptText(config, selected) })}><option value="builtin">Built-in prompt</option><option value="custom">Custom prompt</option></select>
          <select aria-label="Saved prompt template" value={templateSaved ?? ""} onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) { update({ promptOverride: t.prompt }); setTemplateSaved(t.id); } else setTemplateSaved(null); }}>
            <option value="">Saved templates…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {templateSaved && templates.some((t) => t.id === templateSaved) ? <button type="button" className="atn-link" onClick={() => { const next = removeTemplate(templates, templateSaved); setTemplates(next); saveTemplates(next); setTemplateSaved(null); }}>Delete template</button> : null}
          <textarea aria-label="Prompt" rows={7} value={promptText(config, selected)} onChange={(e) => update({ promptOverride: e.target.value })} />
        </section>
        <section className="atn-card">
          <header><span aria-hidden="true">▤</span><h2>EFFECTIVE PROMPT</h2><span className="atn-spacer" /><button type="button" className="atn-link" aria-expanded={showPreview} onClick={() => setShowPreview((v) => !v)}>{showPreview ? "Hide" : "Show"}</button></header>
          {showPreview ? <EffectivePrompt config={config} task={task} /> : <p className="atn-hint">What this task will send to the agent, with the skill and folders above applied.</p>}
        </section>
        </>) : (
        <section className="atn-card">
          <header><span aria-hidden="true">▤</span><h2>RUNNER</h2></header>
          <p className="atn-hint">Runs the {task.label} stage through the shared task runner; this task has no model prompt.</p>
        </section>
        )}
        </>) : null}

        <section className="atn-card atn-log"><header><h2>Log <span className="atn-hint">live</span></h2><span className="atn-spacer" /><button type="button" className="atn-link" onClick={() => setLog([])}>Clear</button></header>{log.length === 0 ? <p className="atn-hint">No log lines yet.</p> : <pre className="atn-log-pre">{log.join("\n")}</pre>}</section>
      </main>
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
            {customEdit !== "new" && customDeleteOpen ? <p className="atn-notice" role="alert">Delete “{customEdit.name}”? This cannot be undone.</p> : null}
            <div className="atn-modal-actions">
              {customEdit !== "new" ? <button type="button" className="atn-btn atn-danger" onClick={() => (customDeleteOpen ? deleteCustom() : setCustomDeleteOpen(true))}>{customDeleteOpen ? "Confirm delete" : "Delete"}</button> : null}
              <span className="atn-spacer" />
              {customEdit !== "new" ? <button type="button" className="atn-btn" disabled={!customRunning && !customTaskRunnable(customEdit)} title={!customTaskRunnable(customEdit) ? CUSTOM_IMPLEMENT_MESSAGE : undefined} onClick={() => (customRunning ? stopTask() : void runCustom(customEdit))}>{customRunning ? "■ Stop" : "▶ Run now"}</button> : null}
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
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setResetOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-danger" onClick={() => { update({ promptOverride: null }); setResetOpen(false); setNotice(`${task.label} prompt restored to default.`); }}>Reset to Default</button></div>
          </div>
        </div>
      ) : null}
      {templateOpen ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-template-title">
          <div className="atn-modal-card">
            <header><h2 id="atn-template-title">Save prompt template</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close template" onClick={() => setTemplateOpen(false)}>×</button></header>
            <label className="atn-field"><span>Name</span><input value={templateName} autoFocus maxLength={80} placeholder="Review checklist" onChange={(e) => setTemplateName(e.target.value)} /></label>
            <p className="atn-hint">Saves this task's current prompt as a reusable template.</p>
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setTemplateOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-primary" disabled={!templateName.trim() || !promptText(config, selected).trim()} onClick={() => { const r = addTemplate(templates, templateName, promptText(config, selected)); if (!r) return; setTemplates(r.list); saveTemplates(r.list); setTemplateSaved(r.saved.id); setTemplateOpen(false); setNotice(`Saved template “${r.saved.name}”.`); }}>Save</button></div>
          </div>
        </div>
      ) : null}
      {scheduleOpen ? (
        <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-schedule-title">
          <div className="atn-modal-card">
            <header><h2 id="atn-schedule-title">Schedule · {task.label}</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close schedule" onClick={() => setScheduleOpen(false)}>×</button></header>
            <label className="atn-inline"><input type="checkbox" checked={scheduleActiveDraft} onChange={(e) => setScheduleActiveDraft(e.target.checked)} /> Run on schedule</label>
            <label className="atn-field"><span>Cron expression</span><input className="atn-cron" value={cronDraft} spellCheck={false} placeholder="0 * * * *" onChange={(e) => { setCronDraft(e.target.value); setScheduleError(!validateCron(e.target.value)); }} /><em>{scheduleError ? "Invalid five-field cron expression." : describeCron(cronDraft)}</em></label>
            <p className="atn-hint">Schedules run while the app is open; missed runs are not backfilled.</p>
            <div className="atn-modal-actions"><button type="button" className="atn-btn" onClick={() => setScheduleOpen(false)}>Cancel</button><button type="button" className="atn-btn atn-primary" disabled={!validateCron(cronDraft)} onClick={() => { if (!validateCron(cronDraft)) { setScheduleError(true); return; } update({ cron: cronDraft.trim(), scheduleActive: scheduleActiveDraft }); setScheduleOpen(false); setNotice(scheduleActiveDraft ? "Schedule saved and active while the app is open." : "Schedule saved; turn on Run on schedule to arm it."); }}>Save</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The exact text a run sends: the same composer the run uses, plus the skill it is run under. */
function EffectivePrompt({ config, task }: { config: TaskConfig; task: { id: string; label: string; readOnlyOutput?: boolean } }): ReactNode {
  const inputPath = normalizeProjectPath(config.inputPath);
  const outputPath = normalizeProjectPath(config.outputPath);
  if (inputPath === null || outputPath === null) {
    return <p className="atn-notice">Input and output must be folders inside the project (relative, no “..”).</p>;
  }
  const skillId = config.skillName ? skillRunId(config.skillName) : null;
  return (
    <>
      {taskFocus(task.id) !== null ? (
        <>
          <pre className="atn-log-pre atn-preview" aria-label={`Effective prompt for ${task.label}`}>{taskPromptWithFocus(task.id, promptText(config, task.id))}</pre>
          <p className="atn-hint">The core runs this registry prompt on the bus review engine in the registered project. Your edit replaces only the focus sentence; the skill and input/output folders do not apply to this task.</p>
        </>
      ) : (
        <>
          <pre className="atn-log-pre atn-preview" aria-label={`Effective prompt for ${task.label}`}>{composeTaskMessage(promptText(config, task.id), inputPath, outputPath)}</pre>
          <p className="atn-hint">{config.skillName ? (skillId ? `Skill: ${skillId}` : `Skill “${config.skillName}” cannot run in an Auto Task.`) : "No skill: the prompt runs on its own."}</p>
        </>
      )}
      {task.readOnlyOutput ? <p className="atn-hint">Read-only task: any file it changes is reverted after the run.</p> : null}
    </>
  );
}

export default NativeAutoTasksScreen;
