// Native Loop screen, first port slice: the Mac three-pane structure over the committed system/loop.json.
// Editing/runner arrive next; every field shown here comes from the file, never from the bridge.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { createHostFs } from "../../explorer/fs";
import { StatusBanner } from "@llmide/ui-kit";
import { invokeHost } from "../../shell/host";
import { isManualOnly, loadLoops, primaryLoop, saveLoops, type LoopLoad } from "./store.ts";
import type { LoopDefinition, LoopProjectStore, LoopStage } from "./model.ts";
import { BUILT_IN_TEMPLATES, applyTemplate, deleteCustomTemplate, loadCustomTemplates, saveCustomTemplate } from "./templates.ts";
import { detectTestCommand } from "./environment.ts";
import { appendRunRecord, loadRunRecord, readRecentRuns, type LoopRunIndexEntry } from "./history.ts";
import "./native-loop.css";

const stageKindLabel: Record<string, string> = {
  regressionSweep: "Regression sweep", shellCommand: "Shell command", skill: "Skill", artifactCheck: "Artifact check",
  testMap: "Test map", testPrune: "Test prune", incidentTriage: "Incident triage", codeGraph: "Code graph",
  sdkSurfaceDiff: "SDK diff", unsupported: "Unsupported",
};

function stageCheck(s: LoopStage): string {
  if (s.command) return s.command;
  if (s.skillId) return s.skillId;
  if (s.testOp) return `test ${s.testOp}`;
  if (s.graphOp) return `graph ${s.graphOp}`;
  if (s.kind === "regressionSweep") return "system/faults/";
  return stageKindLabel[s.kind] ?? s.kind;
}

function loopConfigTemplate() {
  return {
    stages: [], maxIterations: 10, consecutiveFailureStop: 2, wallClockBudgetSeconds: null,
    pauseTimeoutSeconds: 1800, maxRepairsPerStage: 3, repairModel: null,
    protectedPathPolicy: "revert" as const, writeSummaryNote: false, extraProtectedGlobs: [],
    useWorktreesForConcurrentRuns: false, alwaysUseWorktree: false, openMergeRequest: true,
    refactorBatchesPerRun: null,
  };
}

function cloneStore(store: LoopProjectStore): LoopProjectStore {
  return structuredClone(store);
}

export function NativeLoopScreen({ projectRoot, active }: SectionProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [load, setLoad] = useState<LoopLoad | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(BUILT_IN_TEMPLATES[0].id);
  const [testCommand, setTestCommand] = useState<string | null>(null);
  const [envReason, setEnvReason] = useState("Checking the project environment…");
  const [checkingEnv, setCheckingEnv] = useState(false);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runningStage, setRunningStage] = useState(false);
  const [runs, setRuns] = useState<LoopRunIndexEntry[]>([]);
  const [selectedRun, setSelectedRun] = useState<LoopRunIndexEntry | null>(null);
  const [runRecord, setRunRecord] = useState<Record<string, unknown> | null>(null);
  const [customTemplates, setCustomTemplates] = useState(() => loadCustomTemplates());

  useEffect(() => {
    let live = true;
    setLoad(null);
    setOpenError(null);
    if (!projectRoot) return undefined;
    void loadLoops(fs).then((r) => {
      if (!live) return;
      setLoad(r);
      if (r.kind === "ok") {
        const loop = primaryLoop(r.store);
        setSelectedLoopId(loop?.id ?? null);
        setSelectedStageId(loop?.config.stages[0]?.id ?? null);
        setDirty(false);
      }
    }, (e: unknown) => live && setOpenError(e instanceof Error ? e.message : "The Loop file could not be read."));
    return () => { live = false; };
  }, [fs, projectRoot]);

  useEffect(() => {
    if (!projectRoot) { setRuns([]); return; }
    let live = true;
    void readRecentRuns(fs).then((r) => { if (live) setRuns(r); }).catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [fs, projectRoot, notice]);

  const openRun = async (entry: LoopRunIndexEntry) => {
    setSelectedRun(entry);
    setRunRecord(await loadRunRecord(fs, entry.id, entry.startedAt));
  };

  const checkEnvironment = async () => {
    setCheckingEnv(true);
    try {
      const r = await detectTestCommand(fs);
      setTestCommand(r.command);
      setEnvReason(r.reason);
    } finally { setCheckingEnv(false); }
  };

  useEffect(() => {
    if (!projectRoot) return;
    void checkEnvironment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, projectRoot]);

  const store = load?.kind === "ok" ? load.store : null;
  const loop = store?.loops.find((l) => l.id === selectedLoopId) ?? store?.loops[0] ?? null;
  const stage = loop?.config.stages.find((s) => s.id === selectedStageId) ?? loop?.config.stages[0] ?? null;

  const mutateStore = (fn: (store: LoopProjectStore) => void) => {
    if (!store) return;
    const next = cloneStore(store);
    fn(next);
    setLoad({ kind: "ok", store: next, hash: load?.kind === "ok" ? load.hash : "" });
    setDirty(true);
    setNotice(null);
  };

  const addLoop = () => {
    if (!store) return;
    const id = crypto.randomUUID();
    mutateStore((s) => {
      s.loops.push({ id, name: `New Loop ${s.loops.length + 1}`, isPrimary: s.loops.length === 0, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: null, runsOnSchedule: false, config: { ...loopConfigTemplate(), stages: [] } });
    });
    setSelectedLoopId(id);
    setSelectedStageId(null);
  };

  const duplicateLoop = () => {
    if (!loop) return;
    const id = crypto.randomUUID();
    mutateStore((s) => {
      const copy = structuredClone(loop);
      copy.id = id; copy.name = `${loop.name} Copy`; copy.isPrimary = false; copy.defaultKey = null; copy.runsOnSchedule = false;
      s.loops.push(copy);
    });
    setSelectedLoopId(id);
    setSelectedStageId(null);
  };

  const deleteLoop = () => {
    if (!store || !loop || loop.defaultKey !== null || store.loops.length <= 1) return;
    if (!window.confirm(`Delete “${loop.name}”? Its stages stay in loop.json but the loop disappears from this project.`)) return;
    mutateStore((s) => { s.loops = s.loops.filter((l) => l.id !== loop.id); });
    const next = store.loops.find((l) => l.id !== loop.id) ?? null;
    setSelectedLoopId(next?.id ?? null);
    setSelectedStageId(next?.config.stages[0]?.id ?? null);
  };

  const setPrimary = () => {
    if (!loop) return;
    mutateStore((s) => { for (const l of s.loops) l.isPrimary = l.id === loop.id; });
  };

  const addStage = () => {
    if (!loop) return;
    const id = crypto.randomUUID();
    mutateStore((s) => {
      const l = s.loops.find((x) => x.id === loop.id); if (!l) return;
      l.config.stages.push({ id, name: "New Stage", kind: "shellCommand", command: "", order: l.config.stages.length, skillId: null, targetPath: null, outputPath: null, prompt: null, isDefault: false, enabled: true, defaultKey: null, severity: "blocking", timeoutSeconds: null, detectedCommand: null, check: null, testOp: null, graphOp: null, allowsRepair: true, defaultRevision: null, disabledByDetection: null, raw: null });
    });
    setSelectedStageId(id);
  };

  const deleteStage = () => {
    if (!stage || stage.isDefault || !loop) return;
    mutateStore((s) => { const l = s.loops.find((x) => x.id === loop.id); if (l) l.config.stages = l.config.stages.filter((x) => x.id !== stage.id); });
    setSelectedStageId(loop.config.stages.find((x) => x.id !== stage.id)?.id ?? null);
  };

  const duplicateStage = () => {
    if (!stage || !loop) return;
    const id = crypto.randomUUID();
    mutateStore((s) => {
      const l = s.loops.find((x) => x.id === loop.id); if (!l) return;
      const copy = structuredClone(stage); copy.id = id; copy.isDefault = false; copy.defaultKey = null; copy.order = l.config.stages.length; copy.name = `${stage.name} Copy`;
      l.config.stages.push(copy);
    });
    setSelectedStageId(id);
  };

  const selectLoop = (l: LoopDefinition) => {
    setSelectedLoopId(l.id);
    setSelectedStageId(l.config.stages[0]?.id ?? null);
  };

  const patchLoop = (fn: (l: LoopDefinition) => void) => {
    if (!loop) return;
    mutateStore((s) => { const target = s.loops.find((l) => l.id === loop.id); if (target) fn(target); });
  };

  const runSelectedStage = async () => {
    if (!stage || dirty || runningStage) return;
    if (stage.kind !== "shellCommand" || !stage.command) { setNotice("Only a saved shell-command stage can run in this slice."); return; }
    if (!window.confirm(`Run this stage?\n\n${stage.command}`)) return;
    setRunningStage(true);
    setRunLog((l) => [...l, `$ ${stage.command}`, ""]);
    try {
      const r = await invokeHost<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>("loop_run_stage", { stageId: stage.id, timeoutSecs: stage.timeoutSeconds });
      setRunLog((l) => [...l, r.stdout, r.stderr, `${r.timedOut ? "TIMED OUT" : `exit ${r.exitCode ?? "?"}`} · ${r.durationMs} ms`].filter(Boolean));
      setNotice(r.timedOut ? "The stage timed out." : r.exitCode === 0 ? "The stage passed." : `The stage exited ${r.exitCode ?? "without a code"}.`);
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The stage could not run.");
    } finally { setRunningStage(false); }
  };

  const runLoop = async () => {
    if (!loop || dirty || runningStage) return;
    if (!window.confirm(`Run “${loop.name}”?\n\nThis native slice runs the loop's enabled shell-command stages once; other stage kinds stop the run.`)) return;
    setRunningStage(true);
    setRunLog((l) => [...l, `▶ ${loop.name}`, ""]);
    try {
      const r = await invokeHost<{ loopName: string; passed: boolean; stages: Array<{ stageName: string; severity: string; run: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number } }> }>("loop_run_loop", { loopId: loop.id });
      const lines: string[] = [];
      for (const s of r.stages) lines.push(`$ ${s.stageName}`, s.run.stdout, s.run.stderr, `${s.run.timedOut ? "TIMED OUT" : `exit ${s.run.exitCode ?? "?"}`} · ${s.run.durationMs} ms`, "");
      lines.push(r.passed ? "Loop passed." : "Loop failed.");
      setRunLog((l) => [...l, ...lines]);
      setNotice(r.passed ? "The loop passed." : "The loop did not pass.");
      const startedAt = new Date().toISOString();
      const entry: LoopRunIndexEntry = { id: crypto.randomUUID(), loopId: loop.id, loopName: loop.name, startedAt, durationSeconds: r.stages.reduce((n, x) => n + x.run.durationMs, 0) / 1000, iterationsUsed: 1, statusCode: r.passed ? "success" : "failed", statusSummary: r.stages.map((x) => `${x.stageName}: ${x.run.exitCode === 0 ? "pass" : "fail"}`).join(", "), trigger: "manual" };
      void appendRunRecord(fs, entry, { ...entry, endedAt: new Date().toISOString(), gitRoot: projectRoot, config: loop.config, stages: r.stages }).then(() => readRecentRuns(fs)).then(setRuns).catch(() => undefined);
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The loop could not run.");
    } finally { setRunningStage(false); }
  };

  const save = async () => {
    if (!store || load?.kind !== "ok" || saving) return;
    setSaving(true);
    try {
      const r = await saveLoops(fs, store, load.hash);
      setLoad({ kind: "ok", store, hash: r.hash });
      setDirty(false);
      setNotice("Loop configuration saved.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The Loop file could not be saved.");
    } finally { setSaving(false); }
  };

  if (!projectRoot) return <div className="loop-native-empty"><p>Open a project to use Loop.</p></div>;
  if (openError) return <div className="loop-native-empty"><StatusBanner severity="error" message={openError} /></div>;
  if (!load) return <div className="loop-native-empty" role="status"><p>Loading loops…</p></div>;
  if (load.kind === "missing") {
    return <div className="loop-native-empty"><h1>No Loop configuration</h1><p>This project has no <code>system/loop.json</code>. Open the project in the Mac app once to seed the default loops, or create them here in the next port slice.</p></div>;
  }
  if (load.kind === "corrupt") return <div className="loop-native-empty"><StatusBanner severity="error" message={load.message} /><p className="loop-native-hint">The file was not overwritten. Recover or remove it in the Mac app.</p></div>;
  if (!store || !loop) return <div className="loop-native-empty"><p>This project has no loops yet.</p></div>;

  const enabledGates = loop.config.stages.filter((s) => s.enabled && s.severity === "blocking");
  return (
    <div className="loop-native" data-active={active}>
      <aside className="loop-pane loop-loops" aria-label="Loops">
        <div className="loop-pane-head"><span>LOOPS</span><button type="button" className="loop-plus" aria-label="New loop" title="New loop" onClick={addLoop}>＋</button></div>
        <div className="loop-actions">
          <button type="button" className="loop-btn" disabled={loop.isPrimary} onClick={setPrimary}>★ Primary</button>
          <button type="button" className="loop-btn" disabled={isManualOnly(loop)} title={isManualOnly(loop) ? "Manual-only: it applies code" : "Include in the scheduled run"} onClick={() => patchLoop((l) => { l.runsOnSchedule = !l.runsOnSchedule; })}>{loop.runsOnSchedule ? "◷ Scheduled" : "◷ Schedule"}</button>
          <button type="button" className="loop-btn" onClick={duplicateLoop}>Duplicate</button>
          {loop.defaultKey === null && store.loops.length > 1 ? <button type="button" className="loop-btn" onClick={deleteLoop}>Delete</button> : null}
        </div>
        <ul className="loop-list">
          {store.loops.map((l) => (
            <li key={l.id}>
              <button type="button" className="loop-row" data-on={l.id === loop.id || undefined} onClick={() => selectLoop(l)}>
                <span className="loop-row-name">{l.name}</span>
                <span className="loop-row-icons">{l.isPrimary ? <span title="Primary">★</span> : null}{l.runsOnSchedule ? <span title="Runs on schedule">◷</span> : null}</span>
                <span className="loop-row-menu" aria-hidden="true">⋯</span>
              </button>
            </li>
          ))}
        </ul>
        <section className="loop-recent" aria-label="Recent runs">
          <h3>RECENT RUNS</h3>
          {runs.length === 0 ? <p className="loop-native-hint">No runs yet.</p> : <ul>{runs.slice(0, 6).map((r) => <li key={r.id}><button type="button" className="loop-run-link" onClick={() => void openRun(r)}><span>{r.loopName}</span><span className="loop-native-hint">{r.statusCode} · {Math.round(r.durationSeconds)}s</span></button></li>)}</ul>}
        </section>
        <div className="loop-pane-foot"><span className="loop-native-hint">{dirty ? "Unsaved changes" : "Saved to system/loop.json"}</span>{dirty ? <button type="button" className="loop-btn" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button> : null}</div>
      </aside>

      <aside className="loop-pane loop-stages" aria-label="Stages">
        <div className="loop-pane-head"><span>STAGES</span><span className="loop-pane-sub">{loop.name}</span><button type="button" className="loop-plus" aria-label="Add stage" title="Add stage" onClick={addStage}>＋</button></div>
        <div className="loop-actions">
          <button type="button" className="loop-btn" onClick={() => void runSelectedStage()} disabled={!stage || dirty || runningStage}>Run stage</button>
          <button type="button" className="loop-btn" onClick={duplicateStage} disabled={!stage}>Duplicate</button>
          <button type="button" className="loop-btn" onClick={deleteStage} disabled={!stage || stage.isDefault}>Delete</button>
        </div>
        <ul className="loop-list">
          {loop.config.stages.map((s) => (
            <li key={s.id}>
              <button type="button" className="loop-stage-row" data-on={s.id === stage?.id || undefined} onClick={() => setSelectedStageId(s.id)}>
                <span className="loop-stage-name">{s.name}</span>
                {s.isDefault ? <span className="loop-lock" title="Default stage">🔒</span> : null}
                <span className="loop-row-menu" aria-hidden="true">⋯</span>
              </button>
            </li>
          ))}
          {loop.config.stages.length === 0 ? <li className="loop-empty-row">No stages yet.</li> : null}
        </ul>
      </aside>

      <main className="loop-run" aria-label="Run">
        <div className="loop-run-tabs"><span className="loop-run-tab" data-on="true">Run</span><span className="loop-spacer" /><button type="button" className="loop-btn loop-run-btn" disabled={dirty || runningStage} title={dirty ? "Save the Loop first" : "Runs the enabled shell-command stages once"} onClick={() => void runLoop()}>{runningStage ? "Running…" : "▶ Run"}</button></div>
        {notice ? <StatusBanner severity={notice.startsWith("Loop configuration saved") ? "info" : "warning"} message={notice} onDismiss={() => setNotice(null)} /> : null}
        <section className="loop-card loop-overview">
          <h2>OVERVIEW</h2>
          <label className="loop-field"><span>Name</span><input value={loop.name} onChange={(e) => patchLoop((l) => { l.name = e.target.value; })} /></label>
          <label className="loop-field"><span>Goal — what is this loop trying to achieve?</span><textarea rows={2} value={loop.goal ?? ""} onChange={(e) => patchLoop((l) => { l.goal = e.target.value || null; })} /></label>
          <label className="loop-field"><span>Acceptance criteria — what observable condition means done?</span><textarea rows={2} value={loop.acceptanceCriteria ?? ""} placeholder="Optional; included in repair/skill prompts." onChange={(e) => patchLoop((l) => { l.acceptanceCriteria = e.target.value || null; })} /></label>
          <div className="loop-gates">
            <h3>{enabledGates.length} gating check{enabledGates.length === 1 ? "" : "s"}.</h3>
            <p className="loop-native-hint">Every iteration re-runs all stages from the top until each gating check passes.</p>
            <ol>{loop.config.stages.filter((s) => s.enabled).map((s, i) => <li key={s.id}><span>{i + 1}</span> {s.name} <code>{s.severity === "blocking" ? "verify" : "advisory"}</code> <code>{stageCheck(s)}</code></li>)}</ol>
          </div>
          <dl className="loop-meta">
            <dt>Runs in</dt><dd>{projectRoot}</dd>
            <dt>Project root</dt><dd>{projectRoot}</dd>
            <dt>Bounded by</dt><dd>{loop.config.maxIterations} iterations · {loop.config.wallClockBudgetSeconds ? `${loop.config.wallClockBudgetSeconds}s time limit` : "no time limit"} · stop after {loop.config.consecutiveFailureStop} non-improving · {loop.config.maxRepairsPerStage} repairs/stage</dd>
            <dt>Scheduled</dt><dd>{loop.runsOnSchedule ? "included in the scheduled Loop Engineering run" : "no — run it from here"}</dd>
          </dl>
          <div className="loop-budgets">
            <label className="loop-field"><span>Max iterations</span><input type="number" min={1} value={loop.config.maxIterations} onChange={(e) => patchLoop((l) => { l.config.maxIterations = Math.max(1, Number(e.target.value) || 1); })} /></label>
            <label className="loop-field"><span>Time limit (seconds, empty = none)</span><input type="number" min={0} value={loop.config.wallClockBudgetSeconds ?? ""} onChange={(e) => patchLoop((l) => { l.config.wallClockBudgetSeconds = e.target.value === "" ? null : Math.max(0, Number(e.target.value)); })} /></label>
            <label className="loop-field"><span>Stop after non-improving</span><input type="number" min={1} value={loop.config.consecutiveFailureStop} onChange={(e) => patchLoop((l) => { l.config.consecutiveFailureStop = Math.max(1, Number(e.target.value) || 1); })} /></label>
            <label className="loop-field"><span>Repairs per stage</span><input type="number" min={0} value={loop.config.maxRepairsPerStage} onChange={(e) => patchLoop((l) => { l.config.maxRepairsPerStage = Math.max(0, Number(e.target.value) || 0); })} /></label>
          </div>
        </section>

        <section className="loop-card">
          <h2>ENVIRONMENT</h2>
          <p><span className="loop-ready" aria-hidden="true">●</span> {testCommand ? "Test command detected" : "No test command detected"}</p>
          <p>Recommended test command: <code>{testCommand ?? "none"}</code></p>
          <p className="loop-native-hint">{envReason} Nothing is installed or changed.</p>
          <button type="button" className="loop-btn" disabled={checkingEnv} onClick={() => void checkEnvironment()}>{checkingEnv ? "Checking…" : "Check again"}</button>
        </section>

        <section className="loop-card">
          <h2>TEMPLATE</h2>
          <div className="loop-inline">
            <select aria-label="Template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {BUILT_IN_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              {customTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button type="button" className="loop-btn" onClick={() => {
              const t = [...BUILT_IN_TEMPLATES, ...customTemplates].find((x) => x.id === templateId);
              if (!t) return;
              const config = applyTemplate(t, testCommand);
              if (config.stages.length === 0) { setNotice("This recipe needs a detected test command; none was found."); return; }
              patchLoop((l) => { l.config = config; });
              setSelectedStageId(config.stages[0]?.id ?? null);
              setNotice(`Applied ${t.name}.`);
            }}>Apply</button>
          </div>
          <div className="loop-inline">
            <button type="button" className="loop-btn" onClick={() => {
              const name = window.prompt("Save the current stages and budgets as a template named:", `${loop.name} Recipe`);
              if (!name) return;
              const t = saveCustomTemplate(name, "", loop.config);
              setCustomTemplates(loadCustomTemplates());
              setTemplateId(t.id);
              setNotice(`Saved template “${t.name}”.`);
            }}>Save as…</button>
            {customTemplates.some((t) => t.id === templateId) ? <button type="button" className="loop-btn" onClick={() => { if (!window.confirm("Delete this saved template?")) return; deleteCustomTemplate(templateId); setCustomTemplates(loadCustomTemplates()); setTemplateId(BUILT_IN_TEMPLATES[0].id); }}>Delete template</button> : null}
          </div>
          <p className="loop-native-hint">{[...BUILT_IN_TEMPLATES, ...customTemplates].find((x) => x.id === templateId)?.summary}</p>
        </section>

        {stage ? (
          <section className="loop-card">
            <h2>PROCESS</h2>
            <div className="loop-stage-editor">
              <div className="loop-stage-editor-head"><span>{loop.config.stages.indexOf(stage) + 1}</span><span>{stage.enabled ? "●" : "○"} {stage.name}</span><span className="loop-native-hint">{stage.severity}</span></div>
              <label className="loop-field"><span>Name</span><input value={stage.name} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.name = e.target.value; })} /></label>
              <div className="loop-inline"><label className="loop-check"><input type="checkbox" checked={stage.enabled} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.enabled = e.target.checked; })} /> Enabled</label><label className="loop-field"><span>Severity</span><select value={stage.severity} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.severity = e.target.value as "blocking" | "advisory"; })}><option value="blocking">Blocking</option><option value="advisory">Advisory</option></select></label></div>
              {stage.command ? <label className="loop-field"><span>Command</span><input value={stage.command} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.command = e.target.value; })} /></label> : null}
              <p className="loop-native-hint">{stageKindLabel[stage.kind] ?? stage.kind}{stage.defaultKey ? ` · ${stage.defaultKey}` : ""}</p>
            </div>
          </section>
        ) : null}
      </main>

      <aside className="loop-log" aria-label="Run log">
        <div className="loop-pane-head"><span>RUN LOG</span><button type="button" className="loop-native-hint loop-clear" onClick={() => setRunLog([])}>Clear</button></div>
        {selectedRun ? (
          <div className="loop-past-run">
            <h3>{selectedRun.loopName}</h3>
            <p className="loop-native-hint">{selectedRun.statusCode} · {new Date(selectedRun.startedAt).toLocaleString()} · {selectedRun.iterationsUsed} iteration{selectedRun.iterationsUsed === 1 ? "" : "s"}</p>
            <p>{selectedRun.statusSummary}</p>
            {runRecord && Array.isArray(runRecord.stages) ? (
              <ul>{runRecord.stages.map((st, i) => { const o = st as Record<string, unknown>; const run = (o.run ?? {}) as Record<string, unknown>; return <li key={i}>{String(o.stageName ?? "Stage")} · exit {String(run.exitCode ?? "?")} · {String(run.durationMs ?? "")} ms</li>; })}</ul>
            ) : null}
            {runRecord && Array.isArray(runRecord.iterations) && runRecord.iterations.length > 0 ? <p className="loop-native-hint">{runRecord.iterations.length} iterations recorded by the Mac journal.</p> : null}
          </div>
        ) : runLog.length === 0 ? <p className="loop-native-hint">No runs yet.</p> : <pre className="loop-run-log">{runLog.join("\n")}</pre>}
      </aside>
    </div>
  );
}
