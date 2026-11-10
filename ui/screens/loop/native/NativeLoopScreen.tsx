// Native Loop screen, first port slice: the Mac three-pane structure over the committed system/loop.json.
// Editing/runner arrive next; every field shown here comes from the file, never from the bridge.
import { notifyTask } from "../../shell/notify/notify";
import { reportUiIncident } from "../../shell/self-heal";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SectionProps } from "@llmide/screens/shell";
import { createHostFs } from "../../explorer/fs";
import { StatusBanner } from "@llmide/ui-kit";
import { invokeHost } from "../../shell/host";
import { core } from "../../shell/runtime";
import { isBatchSkill, isManualOnly, loadLoops, macBatchReason, primaryLoop, saveLoops, type LoopLoad } from "./store.ts";
import { persistEnsuredDefaults } from "./defaults-save.ts";
import { isNativeRunnable, type LoopDefinition, type LoopProjectStore, type LoopStage } from "./model.ts";
import { BUILT_IN_TEMPLATES, applyTemplate, deleteCustomTemplate, factoryLoop, initialProjectStore, loadCustomTemplatesState, resetCustomTemplates, saveCustomTemplate, type LoopTemplate } from "./templates.ts";
import { detectTestCommand } from "./environment.ts";
import { runNativeLoop, runStatusCode } from "./runner.ts";
import { shellBus } from "../../shell/bus";
import { approvalStatus, approveLoop, approveStage, revokeApprovals, type LoopApprovalStatus } from "./approvals.ts";
import { faultPathsFromOutput, reopenFault } from "./regression.ts";
import { writeSummaryNote } from "./summary.ts";
import { clearQueue, loadQueue, saveQueue } from "./queue.ts";
import { cronMatches, describeCron, validateCron } from "../../autotasks/native/cron.ts";
import { decodePrefsView, type LoopDefaults } from "../../shell/host-prefs.ts";
import { appendRunRecord, decodeFactoryFields, iterationRecordsWithScores, loadRunRecord, readRecentRuns, runRecordPath, runTrigger, setRunRecordShip, type FactoryRunFields, type LoopRunIndexEntry } from "./history.ts";
import { newRunId, repoPrefixFor, runRoot, stageHostArgs, worktreeBlockedStage, type RunInfo } from "./worktree-run.ts";
import { FACTORY_INTAKE_SKILL, FACTORY_TEMPLATE, configFor, factoryStartRefusal, factoryVerifyProblem, isFactoryLoop, needsDecisionSummary, taskMarkdown, type WorkItem } from "./factory.ts";
import { createStageDeps, runOneStage, type StageExecContext } from "./stage-exec.ts";
import { FactoryPicker } from "./FactoryPicker.tsx";
import { ShipPanel } from "./ShipPanel.tsx";
import { copyReadiness, readinessCopyPath } from "./readiness-copy.ts";
import { decodeWorktreeDiff, type WorktreeDiff } from "./ship-model.ts";
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
    refactorBatchesPerRun: null, maxCostUsd: null,
  };
}

/** The run's budgets as the run used them (the record's config snapshot), in the Mac inspector's wording. */
function budgetsLine(config: unknown): string {
  const c = (config ?? {}) as Partial<Record<string, unknown>>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const wall = num(c.wallClockBudgetSeconds);
  const pause = num(c.pauseTimeoutSeconds);
  return `Budgets: ${num(c.maxIterations) ?? "?"} iter · stop after ${num(c.consecutiveFailureStop) ?? "?"} non-improving · ${wall === null ? "no limit" : `${Math.round(wall / 60)} min`} · ${num(c.maxRepairsPerStage) ?? "?"} repairs/stage · pause timeout: ${pause === null ? "unknown" : pause === 0 ? "none" : `${Math.round(pause / 60)} min`} · protected: ${typeof c.protectedPathPolicy === "string" ? c.protectedPathPolicy : "unknown"}`;
}

/** What each protected-path policy does when an agent edit hits a protected or out-of-scope path (the Mac's copy). */
function protectedPolicyCopy(policy: string): string {
  switch (policy) {
    case "revert": return "The edit is undone and the run stops as blocked. A stage that only passed because of such an edit is never reported as fixed.";
    case "stop": return "The edit is left in place for you to inspect and the run stops as blocked.";
    case "warn": return "The edit is logged and the run keeps going, so the stage may then pass because of it.";
    case "off": return "No check at all. A repair can delete the failing test and the run will report success.";
    default: return "";
  }
}

/** Padlock glyph for built-in loops (inline SVG, no emoji). */
const LOCK_ICON = <svg width="9" height="9" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 1 0-4 0v2z" /></svg>;

function cloneStore(store: LoopProjectStore): LoopProjectStore {
  return structuredClone(store);
}

/** A pending confirmation, shown as an in-app bar where it was asked: the desktop webview shows no window.confirm. */
interface Ask { /** What is asked; the bar shows only while this still names the selection. */ key: string; label: string; text: string }

// Cancel takes the focus, so a stray Enter does not delete.
function ConfirmBar({ ask, run, onDone }: { ask: Ask; /** The action as it is NOW, not as it was when asked. */ run: () => void; onDone: () => void }): ReactNode {
  return (
    <div className="loop-confirm" role="alertdialog" aria-label={ask.label} onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}>
      <p className="loop-warn">{ask.text}</p>
      <div className="loop-inline">
        <button type="button" className="loop-btn" autoFocus onClick={onDone}>Cancel</button>
        <button type="button" className="loop-btn loop-btn-primary" onClick={() => { onDone(); run(); }}>{ask.label}</button>
      </div>
    </div>
  );
}

export function NativeLoopScreen({ projectRoot, active }: SectionProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [load, setLoad] = useState<LoopLoad | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [loopDefaults, setLoopDefaults] = useState<LoopDefaults | undefined>(undefined);
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [templateDraft, setTemplateDraft] = useState<{ name: string; summary: string } | null>(null);
  const [templateId, setTemplateId] = useState(BUILT_IN_TEMPLATES[0].id);
  const [testCommand, setTestCommand] = useState<string | null>(null);
  const [envReason, setEnvReason] = useState("Checking the project environment…");
  const [checkingEnv, setCheckingEnv] = useState(false);
  const [envVersions, setEnvVersions] = useState<{ python: string | null; node: string | null; git: string | null } | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runningStage, setRunningStage] = useState(false);
  /** Host-side approval state for the selected loop; null when the host cannot answer (browser fallback). */
  const [approvalState, setApprovalState] = useState<LoopApprovalStatus | null>(null);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  /** Aborts the active run's in-flight agent call (skill or repair stage); Stop and leaving the screen both use it. */
  const runAbortRef = useRef<AbortController | null>(null);
  /** The isolated worktree of the run in progress; null for a main-tree run and between runs. */
  const activeRunRef = useRef<RunInfo | null>(null);
  /** True while a run is being set up (approval done, worktree being prepared); blocks a double start. */
  const startingRef = useRef(false);
  /** Set when the screen unmounts, so a finishing run does not start the next queued one in a stale project. */
  const unmountedRef = useRef(false);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [loopRunning, setLoopRunning] = useState(false);
  const queueRef = useRef<Array<{ loop: LoopDefinition; scheduled: boolean }>>([]);
  const queueRestored = useRef(false);
  const persistQueue = () => {
    if (!projectRoot) return;
    saveQueue(projectRoot, queueRef.current.map((x) => ({ loopId: x.loop.id, scheduled: x.scheduled, at: new Date().toISOString() })));
  };
  const [queued, setQueued] = useState(0);
  const runLoopRef = useRef<(l: LoopDefinition, scheduled?: boolean) => void>(() => undefined);
  const [scheduleCron, setScheduleCron] = useState("");
  const [runs, setRuns] = useState<LoopRunIndexEntry[]>([]);
  const [workRoot, setWorkRoot] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<LoopRunIndexEntry | null>(null);
  const [runRecord, setRunRecord] = useState<Record<string, unknown> | null>(null);
  const [runRecordLoaded, setRunRecordLoaded] = useState(false);
  /** The run whose worktree is open in the Review and Ship panel. */
  const [shipRun, setShipRun] = useState<{ info: RunInfo; item: WorkItem; entry: LoopRunIndexEntry; passed: boolean; diff?: WorktreeDiff; reviewedPatchId?: string | null; requestProvider?: "github" | "gitlab" | null } | null>(null);
  /** The Factory loop waiting for its work item; the picker is shown while this is set. */
  const [pickerLoop, setPickerLoop] = useState<LoopDefinition | null>(null);
  // A picker card for a loop the user has since left must not start that loop over the one now shown.
  useEffect(() => { setPickerLoop(null); }, [selectedLoopId]);
  const openSeq = useRef(0);
  const [customLoad, setCustomLoad] = useState(() => loadCustomTemplatesState());
  const customTemplates = customLoad.templates;
  const refreshTemplates = () => setCustomLoad(loadCustomTemplatesState());

  useEffect(() => {
    let live = true;
    setLoad(null);
    setOpenError(null);
    if (!projectRoot) return undefined;
    void loadLoops(fs).then(async (r) => {
      if (!live) return;
      // Read the host defaults for BOTH a normal store and the first-creation ("missing") path.
      const prefs = await invokeHost<unknown>("get_prefs").catch(() => null);
      if (!live) return;
      const defaults = prefs === null ? undefined : decodePrefsView(prefs)?.stored.loopDefaults;
      setLoopDefaults(defaults);
      // Mac parity: a missing default loop is added AND written on open, so a scheduled run never silently sees
      // an unsaved file. A failed write keeps the loops in memory and asks for the normal Save retry.
      let next = r;
      let added: string[] = [];
      let saved = false;
      let saveError: string | null = null;
      if (r.kind === "ok") {
        const env = await detectTestCommand(fs).catch(() => ({ command: null, reason: "" }));
        if (!live) return;
        const persisted = await persistEnsuredDefaults(fs, r, env.command, defaults);
        if (!live) return;
        next = persisted.load;
        added = persisted.added;
        saved = persisted.saved;
        saveError = persisted.error;
      }
      setLoad(next);
      if (next.kind === "ok") {
        const loop = primaryLoop(next.store);
        setSelectedLoopId(loop?.id ?? null);
        setSelectedStageId(loop?.config.stages[0]?.id ?? null);
        setDirty(added.length > 0 && !saved);
        if (added.length) setNotice(saveError
          ? `Added the missing default loop(s): ${added.join(", ")}. They could not be saved: ${saveError}`
          : `Added and saved the missing default loop(s): ${added.join(", ")}.`);
      }
    }, (e: unknown) => live && setOpenError(e instanceof Error ? e.message : "The Loop file could not be read."));
    return () => { live = false; };
  }, [fs, projectRoot]);

  useEffect(() => {
    // `live` guards the race where the screen unmounts before listen() resolves: the listener is then removed on resolve.
    let live = true;
    let un: (() => void) | null = null;
    void listen<{ stageId: string; stream: "stdout" | "stderr"; text: string }>("loop-stage-output", (e) => {
      const text = e.payload.text;
      if (!text) return;
      setRunLog((l) => {
        if (l.length === 0) return [text];
        const copy = [...l];
        copy[copy.length - 1] = copy[copy.length - 1] + text;
        return copy;
      });
    }).then((fn) => { if (live) un = fn; else fn(); }).catch(() => undefined);
    return () => { live = false; if (un) un(); };
  }, []);

  // A project switch remounts this screen (the shell keys it by project). A run still in flight would keep editing the
  // project with no screen to show it, so leaving the screen cancels it, as Stop does; the queue is kept for the next mount.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (runningRef.current) cancelActiveRun();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectRoot) { setWorkRoot(null); return; }
    let live = true;
    void invokeHost<string>("loop_work_root").then((p) => { if (live) setWorkRoot(p); }).catch(() => { if (live) setWorkRoot(null); });
    return () => { live = false; };
  }, [projectRoot]);

  useEffect(() => {
    if (!projectRoot || !load || load.kind !== "ok" || queueRestored.current) return;
    queueRestored.current = true;
    const byId = new Map(load.store.loops.map((l) => [l.id, l]));
    const restored = loadQueue(projectRoot).flatMap((q) => { const l = byId.get(q.loopId); return l ? [{ loop: l, scheduled: q.scheduled }] : []; });
    if (restored.length) {
      queueRef.current = restored;
      setQueued(restored.length);
      setNotice(`${restored.length} queued run(s) restored. Resume them when ready.`);
      saveQueue(projectRoot, restored.map((x) => ({ loopId: x.loop.id, scheduled: x.scheduled, at: new Date().toISOString() })));
    }
  }, [projectRoot, load]);

  useEffect(() => {
    if (!projectRoot) { setRuns([]); return; }
    let live = true;
    void readRecentRuns(fs).then((r) => { if (live) setRuns(r); }).catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [fs, projectRoot, notice]);

  const openRun = async (entry: LoopRunIndexEntry) => {
    const seq = ++openSeq.current;
    setSelectedRun(entry);
    setRunRecord(null);
    setRunRecordLoaded(false);
    const record = await loadRunRecord(fs, entry.id, entry.startedAt);
    if (seq !== openSeq.current) return;
    setRunRecord(record);
    setRunRecordLoaded(true);
  };

  /** Back to the live log. Nothing about the run is discarded; the journal still has it. */
  const closeRun = () => {
    openSeq.current += 1;
    setSelectedRun(null);
    setRunRecord(null);
    setRunRecordLoaded(false);
  };

  /** Opens Review and Ship for a past run whose worktree still exists (Discard is always offered, Ship only after a pass). */
  const reopenWorktree = async (entry: LoopRunIndexEntry, fields: FactoryRunFields) => {
    if (!fields.worktree) return;
    const runId = fields.worktree.runId;
    let list: RunInfo[];
    try { list = await invokeHost<RunInfo[]>("loop_worktree_list"); } catch (e) { setNotice(e instanceof Error ? e.message : "The worktrees could not be listed."); return; }
    const info = list.find((r) => r.runId === runId);
    if (!info) { setNotice("This run's worktree was removed; only its record is left."); return; }
    const w = fields.workItem;
    const item: WorkItem = w ? { source: w.source, id: w.id, title: w.title, body: "", repo: null } : { source: "text", id: null, title: entry.loopName, body: "", repo: null };
    setShipRun({ info, item, entry, passed: entry.statusCode === "success", reviewedPatchId: fields.diffSummary?.patchId ?? null, requestProvider: fields.ship?.provider ?? null });
  };

  const revealRunRecord = (entry: LoopRunIndexEntry) => {
    void invokeHost("reveal_in_os", { relPath: runRecordPath(entry.id, entry.startedAt) })
      .catch(() => setNotice("Could not show the run record in the file manager."));
  };

  const checkToolchain = async () => {
    setCheckingEnv(true);
    try { setEnvVersions(await invokeHost<{ python: string | null; node: string | null; git: string | null }>("loop_environment_check")); }
    catch { setEnvVersions({ python: null, node: null, git: null }); }
    finally { setCheckingEnv(false); }
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

  // Output rows (the Mac's OUTPUT section): a row is "not yet" until its path exists. Re-checked after each run.
  const [outputExists, setOutputExists] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!projectRoot) return;
    let live = true;
    const exists = async (path: string, list: boolean): Promise<boolean> => {
      try { if (list) await fs.list(path); else await fs.read(path, 1); return true; } catch { return false; }
    };
    void Promise.all([exists("system/loop-runs", true), exists("system/faults.csv", false), exists("llm-doc/loop", true)])
      .then(([journal, faults, summaries]) => { if (live) setOutputExists({ journal, faults, summaries }); });
    return () => { live = false; };
  }, [fs, projectRoot, runs, workRoot]);
  /** The working tree as a project-relative path, for reveal_in_os (which resolves inside the project root). */
  const workRelative = workRoot && projectRoot && workRoot.startsWith(`${projectRoot}/`) ? workRoot.slice(projectRoot.length + 1) : "";
  const revealRel = (rel: string) => { void invokeHost("reveal_in_os", { relPath: rel }).catch(() => setNotice("Could not show that in the file manager.")); };

  const store = load?.kind === "ok" ? load.store : null;
  const loop = store?.loops.find((l) => l.id === selectedLoopId) ?? store?.loops[0] ?? null;
  const stage = loop?.config.stages.find((s) => s.id === selectedStageId) ?? loop?.config.stages[0] ?? null;

  /** Re-read the host's approval state (commands may have changed since the last dialog). */
  const refreshApproval = async (loopId: string) => {
    try { setApprovalState(await approvalStatus(loopId)); } catch { setApprovalState(null); }
  };

  useEffect(() => {
    if (!loop) { setApprovalState(null); return undefined; }
    let live = true;
    void approvalStatus(loop.id).then((s) => { if (live) setApprovalState(s); }).catch(() => { if (live) setApprovalState(null); });
    return () => { live = false; };
  }, [loop?.id]);

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

  const addLoopFromTemplate = (t: LoopTemplate) => {
    if (t.id === FACTORY_TEMPLATE.id) {
      // The Factory is a default loop and runs use the project's one Factory loop, so the template opens it.
      const existing = store?.loops.find(isFactoryLoop) ?? null;
      if (existing) {
        setSelectedLoopId(existing.id);
        setSelectedStageId(existing.config.stages[0]?.id ?? null);
        setNotice(factoryVerifyProblem(existing.config) ?? "This project already has its Factory loop.");
        return;
      }
      const added = factoryLoop(testCommand, loopDefaults);
      mutateStore((s) => { s.loops.push(added); });
      setSelectedLoopId(added.id);
      setSelectedStageId(null);
      return;
    }
    const id = crypto.randomUUID();
    mutateStore((s) => {
      s.loops.push({
        id, name: t.name, isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [],
        defaultKey: null, runsOnSchedule: false, config: applyTemplate(t, testCommand),
      });
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
    mutateStore((s) => {
      s.loops = s.loops.filter((l) => l.id !== loop.id);
      if (loop.isPrimary && s.loops.length > 0 && !s.loops.some((l) => l.isPrimary)) s.loops[0].isPrimary = true;
    });
    const next = store.loops.find((l) => l.id !== loop.id) ?? null;
    setSelectedLoopId(next?.id ?? null);
    setSelectedStageId(next?.config.stages[0]?.id ?? null);
  };

  const setPrimary = () => {
    if (!loop) return;
    mutateStore((s) => { for (const l of s.loops) l.isPrimary = l.id === loop.id; });
  };

  const addStage = (kind: LoopStage["kind"] = "shellCommand") => {
    if (!loop) return;
    const id = crypto.randomUUID();
    mutateStore((s) => {
      const l = s.loops.find((x) => x.id === loop.id); if (!l) return;
      l.config.stages.push({
        id, name: stageKindLabel[kind] ?? "New Stage", kind, command: kind === "shellCommand" ? "" : null,
        order: l.config.stages.length, skillId: null, targetPath: null, outputPath: null, prompt: null,
        isDefault: false, enabled: true, defaultKey: null, severity: "blocking", timeoutSeconds: null,
        detectedCommand: null, check: null, testOp: kind === "testMap" ? "structure" : null,
        graphOp: kind === "codeGraph" ? "snapshot" : null, allowsRepair: true, runOnce: false, defaultRevision: null,
        disabledByDetection: null, raw: null,
      });
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

  const moveStage = (dir: -1 | 1) => {
    if (!loop || !stage) return;
    mutateStore((s) => {
      const l = s.loops.find((x) => x.id === loop.id); if (!l) return;
      const i = l.config.stages.findIndex((x) => x.id === stage.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= l.config.stages.length) return;
      const [moved] = l.config.stages.splice(i, 1);
      l.config.stages.splice(j, 0, moved);
      l.config.stages.forEach((x, k) => { x.order = k; });
    });
  };

  const selectLoop = (l: LoopDefinition) => {
    setSelectedLoopId(l.id);
    setSelectedStageId(l.config.stages[0]?.id ?? null);
  };

  const patchLoop = (fn: (l: LoopDefinition) => void) => {
    if (!loop) return;
    mutateStore((s) => { const target = s.loops.find((l) => l.id === loop.id); if (target) fn(target); });
  };

  /** `{ runId }` for every Loop host call made during a worktree run. */
  const hostRunArgs = () => stageHostArgs(activeRunRef.current?.runId ?? null);
  /** Absolute folder the current run works in (its worktree, else the work root). */
  const currentRunRoot = () => runRoot(projectRoot ?? "", activeRunRef.current, workRoot);

  /** The stage-execution context for one run (or one Run-stage click) in this screen. */
  const stageContext = (runId: string | null, runRootPath: string, token: string | null): StageExecContext => ({
    projectRoot: projectRoot ?? "", runId, runRoot: runRootPath, fs, host: invokeHost, core,
    log: (line) => setRunLog((l) => [...l, line]),
    approvalToken: async () => token,
    signal: runAbortRef.current?.signal,
    isCancelled: () => cancelledRef.current,
    markCancelled: () => { cancelledRef.current = true; },
  });

  /** Cancels the active run: shell and fault stages through loop_cancel, agent calls through their abort signal. */
  const cancelActiveRun = () => {
    cancelledRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    runAbortRef.current?.abort();
    void invokeHost("loop_cancel", hostRunArgs()).catch(() => undefined);
  };

  const stopRun = () => {
    // Stop ends the queue too: otherwise the run's finally would start the next queued loop right after the user stopped.
    queueRef.current = [];
    setQueued(0);
    if (projectRoot) clearQueue(projectRoot);
    cancelActiveRun();
    setNotice("Stopping the current stage; the loop will end after it returns. Queued runs were cleared.");
  };

  // Pause holds the loop at the next stage boundary (the Mac's between-stages hold, not a mid-stage suspend).
  const pauseRun = () => {
    if (!loopRunning || pausedRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    setNotice("Pausing: the loop holds once the current stage finishes. Resume to continue.");
  };
  const resumeRun = () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    setNotice("Resumed.");
  };
  /** Waits while paused; returns "timedOut" when the pause outlasted the limit (0 = none) without a resume. */
  const holdWhilePaused = async (timeoutSeconds: number): Promise<"ok" | "timedOut"> => {
    if (!pausedRef.current) return "ok";
    const since = Date.now();
    while (pausedRef.current && !cancelledRef.current) {
      if (timeoutSeconds > 0 && Date.now() - since >= timeoutSeconds * 1000) return "timedOut";
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    }
    return "ok";
  };

  const executeLoop = async (target: LoopDefinition, scheduled = false, start: { repoRel: string; task: string; item: WorkItem } | null = null) => {
    if (dirty) return;
    const unsupported = target.config.stages.find((s) => s.enabled && !isNativeRunnable(s));
    if (unsupported) { setNotice(`“${unsupported.name}” is a ${unsupported.kind} stage; it cannot run yet.`); return; }
    const useWorktree = target.config.alwaysUseWorktree || isFactoryLoop(target);
    const worktreeBlocked = useWorktree ? worktreeBlockedStage(target.config.stages) : null;
    if (worktreeBlocked) { setNotice(`“${worktreeBlocked.name}” re-checks faults in the main working tree, so it cannot run in an isolated worktree. Turn that stage off or turn off “Always run in an isolated worktree”.`); return; }
    // A loop.json from a cloned repo can mark a code-applying loop runsOnSchedule; it still never runs unattended.
    // A Factory run needs a picked work item; the schedule and the queue never have one.
    if (isFactoryLoop(target) && !start) { setNotice(`“${target.name}” is a Factory loop: start it with ▶ Run and pick a work item.`); return; }
    const verifyProblem = isFactoryLoop(target) ? factoryVerifyProblem(target.config) : null;
    if (verifyProblem) { setNotice(verifyProblem); return; }
    if (scheduled && isManualOnly(target)) { setNotice(`“${target.name}” applies code and is manual-only; the schedule skipped it.`); return; }
    const batchBlock = macBatchReason(target);
    if (batchBlock) { setNotice(batchBlock); return; }
    // The native Rust dialog (or a still-valid grant for exactly the same command hashes) is the approval. A
    // scheduled run never opens a dialog: it reuses an existing grant or skips, so the app cannot self-approve.
    let approvalToken: string | null = null;
    try {
      if (scheduled) {
        const status = await approvalStatus(target.id);
        if (!status.approved) {
          setNotice(`“${target.name}” needs a native host approval for its exact shell commands before a scheduled run; run it once from here.`);
          return;
        }
        // `token` is null when there is nothing to approve (no shell or fault verify commands).
        approvalToken = status.token;
      } else {
        const approval = await approveLoop(target.id);
        if (!approval) { setNotice("The Loop commands were not approved; the run did not start."); return; }
        approvalToken = approval.token;
      }
      await refreshApproval(target.id);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The Loop commands could not be approved.");
      return;
    }
    // The approval dialog is modal and can outlive the screen: a leave while it was open must not start the loop
    // (the unmount cleanup only cancels a run whose runningRef is already set).
    if (unmountedRef.current) return;
    // `runningRef` is set only after the awaits below; this flag stops a second click from starting a second run
    // (and a second worktree) while the first is still being prepared. Every early `return` below clears it.
    if (startingRef.current) return;
    startingRef.current = true;
    // Any run start (Run, queue, schedule, picker) closes the picker so a stale card cannot linger over it.
    setPickerLoop(null);
    let prepared: RunInfo | null = null;
    if (useWorktree) {
      const root = projectRoot ?? "";
      const workRel = workRoot === root ? "" : repoPrefixFor(root, workRoot ?? "");
      if (!root || (!start && workRoot !== root && workRel === "")) {
        setNotice("The repository for this run could not be resolved, so no worktree was created and the run did not start.");
        startingRef.current = false;
        return;
      }
      const task = start ? start.task : `# ${target.name}\n\nLoop run in an isolated worktree. No work item was picked; the loop's goal applies.\n`;
      try {
        prepared = await invokeHost<RunInfo>("loop_worktree_prepare", { repoRel: start ? start.repoRel : workRel, runId: newRunId(new Date(), Math.random), base: null, task });
      } catch (e) {
        setNotice(`The isolated worktree could not be created: ${e instanceof Error ? e.message : String(e)}. The run did not start.`);
        startingRef.current = false;
        return;
      }
      // Check stages read the worktree through the project-scoped fs; a worktree outside the expected folder would
      // make the prefix "" and silently point them at the main tree.
      if (repoPrefixFor(root, prepared.worktree) !== `system/loop-worktrees/${prepared.runId}`) {
        setNotice(`The worktree ${prepared.worktree} is not under this project's system/loop-worktrees/ folder, so the run did not start. The worktree was kept.`);
        startingRef.current = false;
        return;
      }
      if (unmountedRef.current) { startingRef.current = false; return; }
    }
    const activeRun = prepared;
    const marker = activeRun ? `${repoPrefixFor(projectRoot ?? "", activeRun.worktree)}/.factory/RUN.json` : null;
    if (activeRun && isFactoryLoop(target) && marker) {
      try { await fs.write(marker, JSON.stringify({ runId: activeRun.runId, mode: "full", startedAt: new Date().toISOString(), itemKey: start ? (start.item.id ?? start.item.title) : null }), { expected_hash: null }); } catch { /* Resume marker only */ }
    }
    activeRunRef.current = activeRun;
    runningRef.current = true;
    startingRef.current = false;
    cancelledRef.current = false;
    runAbortRef.current = new AbortController();
    pausedRef.current = false;
    setPaused(false);
    setLoopRunning(true);
    setSelectedRun(null);
    setRunRecord(null);
    setShipRun(null);
    setRunningStage(true);
    setRunLog((l) => [...l, `▶ ${target.name}`, ...(activeRun ? [`⎇ isolated worktree system/loop-worktrees/${activeRun.runId} on ${activeRun.branch}, started from ${activeRun.baseCommit.slice(0, 7)}`] : []), ""]);
    const started = Date.now();
    let summaryPath: string | null = null;
    // Shown on the board as Working while it runs; released after the run record is saved (the finally below), so a
    // card can never be left behind. Loaded on demand, so the Loop screen does not hard-depend on the Factory chunk.
    let releaseBoardRun: (() => void) | null = null;
    try {
      if (activeRun && isFactoryLoop(target) && start) {
        try {
          const [intake, manager] = await Promise.all([import("../../factory/intake.ts"), import("./run-manager.ts")]);
          const put = await intake.putRunOnBoard(fs, start.item, activeRun.runId);
          if ("error" in put) setRunLog((l) => [...l, put.error]);
          else releaseBoardRun = manager.trackExternalRun({ runId: activeRun.runId, itemKey: put.key, projectRoot: projectRoot ?? "" });
        } catch (e) {
          setRunLog((l) => [...l, `The run is not on the Factory board: ${e instanceof Error ? e.message : String(e)}`]);
        }
      }
      const outcome = await runNativeLoop(isFactoryLoop(target) ? configFor("full", target.config) : target.config, {
        ...createStageDeps(stageContext(activeRun?.runId ?? null, runRoot(projectRoot ?? "", activeRun, workRoot), approvalToken), target),
        isCancelled() { return cancelledRef.current; },
        log(line) { setRunLog((l) => [...l, line]); },
        holdWhilePaused,
      });
      const needsDecision = isFactoryLoop(target) ? needsDecisionSummary(outcome) : null;
      if (needsDecision) outcome.statusSummary = needsDecision;
      if (activeRun) setRunLog((l) => [...l, `worktree kept: system/loop-worktrees/${activeRun.runId} (branch ${activeRun.branch}); your main working tree was not touched`]);
      let changedPaths: string[] = [];
      try { changedPaths = await invokeHost<string[]>("loop_changed_paths", hostRunArgs()); } catch { changedPaths = []; }
      if (changedPaths.length) setRunLog((l) => [...l, `changed paths: ${changedPaths.join(", ")}`]);
      setRunLog((l) => [...l, outcome.cancelled ? (cancelledRef.current ? "Loop cancelled." : `Loop aborted: ${outcome.statusSummary}`) : outcome.passed ? "Loop passed." : `Loop failed: ${outcome.statusSummary}`]);
      if (!outcome.cancelled && !outcome.passed && outcome.failedStage?.kind === "regressionSweep") {
        const failedRun = [...outcome.stages].reverse().find((o) => o.stage.kind === "regressionSweep" && !o.ok);
        const faultPaths = faultPathsFromOutput(failedRun?.output ?? "");
        let reopened = 0;
        for (const rel of faultPaths) if (await reopenFault(fs, rel)) reopened += 1;
        if (reopened > 0) setRunLog((l) => [...l, `reopened ${reopened} fixed fault(s).`]);
      }
      // Intake ran in this run, so the readiness report is copied to llm-doc/factory/ (the Review Conflicts tree).
      if (activeRun && outcome.stages.some((o) => o.stage.skillId === FACTORY_INTAKE_SKILL)) {
        const copyAt = new Date(started);
        try {
          const copied = await copyReadiness(fs, repoPrefixFor(projectRoot ?? "", activeRun.worktree), activeRun.runId, copyAt);
          setRunLog((l) => [...l, copied ? `readiness report copied to ${readinessCopyPath(activeRun.runId, copyAt)}` : "no .factory/READINESS.md to copy"]);
        } catch (e) {
          setRunLog((l) => [...l, `readiness copy failed: ${e instanceof Error ? e.message : String(e)}`]);
        }
      }
      if (target.config.writeSummaryNote) {
        try { summaryPath = await writeSummaryNote(fs, target, outcome); setRunLog((l) => [...l, `summary note: ${summaryPath}`]); }
        catch (e) { setRunLog((l) => [...l, `summary note failed: ${e instanceof Error ? e.message : String(e)}`]); }
      }
      setNotice(outcome.cancelled ? (cancelledRef.current ? "The loop was cancelled." : outcome.statusSummary) : outcome.passed ? "The loop passed." : outcome.statusSummary);
      if (!outcome.cancelled) void notifyTask("loop", outcome.passed);
      const startedAt = new Date(started).toISOString();
      // factoryRunId + factoryMode: the board finds a card's last run through these fields (the run manager writes them too).
      const entry: LoopRunIndexEntry & { factoryRunId?: string; factoryMode?: "full" } = { id: crypto.randomUUID(), loopId: target.id, loopName: target.name, startedAt, durationSeconds: (Date.now() - started) / 1000, iterationsUsed: outcome.iterationsUsed, statusCode: runStatusCode(outcome), statusSummary: outcome.statusSummary, trigger: runTrigger(scheduled), ...(activeRun && isFactoryLoop(target) ? { factoryRunId: activeRun.runId, factoryMode: "full" as const } : {}) };
      // One diff read per run end: ShipPanel gets it as a prop instead of re-reading (two parallel reads race on the
      // worktree's index.lock).
      const worktreeDiff = activeRun
        ? await invokeHost<unknown>("loop_worktree_diff", { runId: activeRun.runId }).then(decodeWorktreeDiff).catch(() => null)
        : null;
      const diffSummary = worktreeDiff ? { files: worktreeDiff.files, truncated: worktreeDiff.truncated, patchId: worktreeDiff.patchId || null, additions: worktreeDiff.additions, deletions: worktreeDiff.deletions } : null;
      const factoryFields: FactoryRunFields = {
        workItem: start ? { source: start.item.source, id: start.item.id, title: start.item.title } : null,
        worktree: activeRun ? { runId: activeRun.runId, branch: activeRun.branch, baseCommit: activeRun.baseCommit, repo: activeRun.repo } : null,
        ship: null,
        needsDecision,
        diffSummary,
      };
      const recordStages = outcome.stages.map((o) => ({ stageName: o.stage.name, severity: o.stage.severity, costUsd: o.usage?.costUsd ?? null, run: { exitCode: o.ok ? 0 : 1, stdout: o.output, stderr: "", timedOut: false, durationMs: 0 } }));
      // Awaited: Ship's record update (setRunRecordShip) needs the record on disk, so the panel opens only after it.
      await appendRunRecord(fs, entry, { ...entry, endedAt: new Date().toISOString(), gitRoot: currentRunRoot(), config: target.config, changedPaths, summaryPath, ...factoryFields, costUsd: outcome.costUsd ?? recordStages.reduce((n, st) => n + (st.costUsd ?? 0), 0), stages: recordStages, iterations: iterationRecordsWithScores(outcome.iterations) }).then(() => { if (marker) return fs.remove(marker).catch(() => undefined); return undefined; }).then(() => readRecentRuns(fs)).then(setRuns).catch(() => undefined);
      if (isFactoryLoop(target) && activeRun && start && outcome.passed && !outcome.cancelled && target.config.openMergeRequest) setShipRun({ info: activeRun, item: start.item, entry, passed: true, reviewedPatchId: diffSummary?.patchId ?? null, requestProvider: null, ...(worktreeDiff ? { diff: worktreeDiff } : {}) });
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The loop could not run.");
      // The runner itself failed (not a stage verdict): a Self-Heal incident in debug builds.
      reportUiIncident("loop", e instanceof Error ? e.message : String(e));
      void notifyTask("loop", false);
    } finally {
      releaseBoardRun?.();
      runningRef.current = false;
      runAbortRef.current = null;
      activeRunRef.current = null;
      pausedRef.current = false;
      setPaused(false);
      setLoopRunning(false);
      setRunningStage(false);
      void refreshApproval(target.id);
      // A run ended by leaving the screen keeps the queue as persisted: the next mount restores it.
      const next = unmountedRef.current ? undefined : queueRef.current.shift();
      setQueued(queueRef.current.length);
      persistQueue();
      if (next) window.setTimeout(() => void executeLoop(next.loop, next.scheduled), 0);
    }
  };

  const runLoop = (target: LoopDefinition | null = loop, scheduled = false) => {
    if (!target) return;
    if (isFactoryLoop(target) && !scheduled) {
      if (runningRef.current) { setNotice("A Factory run needs its own work item; wait for the current run to finish."); return; }
      setPickerLoop(target);
      return;
    }
    if (runningRef.current) {
      if (!queueRef.current.some((x) => x.loop.id === target.id)) queueRef.current.push({ loop: target, scheduled });
      setQueued(queueRef.current.length);
      persistQueue();
      setNotice(`Queued “${target.name}”.`);
      return;
    }
    void executeLoop(target, scheduled);
  };

  runLoopRef.current = runLoop;

  useEffect(() => {
    if (!projectRoot) return;
    const key = `llmide.loopSchedule.v1.${projectRoot}`;
    let saved: { cron?: string; last?: string } = {};
    try { saved = JSON.parse(localStorage.getItem(key) ?? "{}") as typeof saved; } catch { saved = {}; }
    const cron = (saved.cron ?? "").trim();
    setScheduleCron(cron);
    if (!cron || !validateCron(cron)) return;
    let last = saved.last ?? "";
    const tick = () => {
      const now = new Date();
      const minute = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      if (minute === last || !cronMatches(cron, now)) return;
      last = minute;
      try { localStorage.setItem(key, JSON.stringify({ cron, last })); } catch { /* session only */ }
      const scheduled = (load?.kind === "ok" ? load.store.loops : []).filter((l) => l.runsOnSchedule);
      if (scheduled.length === 0) { setNotice("The schedule fired, but no loop is marked Run on schedule."); return; }
      if (runningRef.current) { setNotice("The schedule fired while a run is active; scheduled loops were skipped."); return; }
      setNotice(`Schedule fired: running ${scheduled.length} loop(s).`);
      for (const l of scheduled) runLoopRef.current(l, true);
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [projectRoot, load]);

  const runScheduledNow = () => {
    if (!store) return;
    const scheduled = store.loops.filter((l) => l.runsOnSchedule);
    if (scheduled.length === 0) { setNotice("No loop is marked Run on schedule."); return; }
    for (const l of scheduled) runLoop(l, true);
  };

  const saveSchedule = (cron: string) => {
    if (!projectRoot) return;
    setScheduleCron(cron);
    try { localStorage.setItem(`llmide.loopSchedule.v1.${projectRoot}`, JSON.stringify({ cron: cron.trim(), last: "" })); } catch { /* session only */ }
  };

  /** Removes only this loop's queued run; the others keep their place. */
  const leaveQueue = () => {
    if (!loop) return;
    const before = queueRef.current.length;
    queueRef.current = queueRef.current.filter((x) => x.loop.id !== loop.id);
    setQueued(queueRef.current.length);
    persistQueue();
    setNotice(queueRef.current.length < before ? `Left the queue: “${loop.name}”.` : `“${loop.name}” is not queued.`);
  };

  const clearQueued = () => {
    queueRef.current = [];
    setQueued(0);
    if (projectRoot) clearQueue(projectRoot);
  };

  const resumeQueue = () => {
    if (runningRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    setQueued(queueRef.current.length);
    persistQueue();
    void executeLoop(next.loop, next.scheduled);
  };

  const runSelectedStage = async () => {
    if (!loop || !stage || dirty || runningStage) return;
    if (!isNativeRunnable(stage)) { setNotice("This stage kind cannot run in the native runner yet."); return; }
    if (stage.kind === "shellCommand" && !stage.command) { setNotice("This stage has no command yet."); return; }
    if (stage.kind === "skill" && !stage.skillId) { setNotice("This skill stage has no skill id."); return; }
    if (stage.kind === "skill" && isBatchSkill(stage.skillId)) { setNotice("This refactor batch stage needs the Mac app's rollback; run it from the Mac."); return; }
    // Shell stages and a Regression stage's fault verifies need the host's native approval for this exact stage.
    let approvalToken: string | null = null;
    if (stage.kind === "shellCommand" || stage.kind === "regressionSweep") {
      try {
        const approval = await approveStage(stage.id, loop.id);
        if (!approval) { setNotice("The stage command was not approved; nothing ran."); return; }
        approvalToken = approval.token;
        await refreshApproval(loop.id);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "The stage command could not be approved.");
        return;
      }
    }
    setRunningStage(true);
    setRunLog((l) => [...l, `$ ${stage.name}`, ""]);
    try {
      const r = await runOneStage(stageContext(null, workRoot ?? projectRoot ?? "", approvalToken), stage, loop, [], { reason: null, isError: false });
      setRunLog((l) => [...l, r.output, r.ok ? "Stage passed." : "Stage failed."]);
      setNotice(r.ok ? "The stage passed." : "The stage failed.");
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The stage could not run.");
    } finally {
      setRunningStage(false);
      void refreshApproval(loop.id);
    }
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
    const create = async () => {
      setSaving(true);
      try {
        const env = await detectTestCommand(fs);
        const store = initialProjectStore(env.command, loopDefaults);
        const r = await saveLoops(fs, store, null);
        setLoad({ kind: "ok", store, hash: r.hash });
        setSelectedLoopId(store.loops[0].id);
        setSelectedStageId(store.loops[0].config.stages[0]?.id ?? null);
        setNotice("Created the default loops from this project's detected test command.");
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "The default loops could not be created.");
      } finally { setSaving(false); }
    };
    return <div className="loop-native-empty"><h1>No loops yet</h1><p>Create starter loops for this project.</p><button type="button" className="loop-btn loop-btn-primary" disabled={saving} onClick={() => void create()}>{saving ? "Creating…" : "Create starter loops"}</button>{notice ? <p className="loop-native-hint">{notice}</p> : null}</div>;
  }
  if (load.kind === "corrupt") return <div className="loop-native-empty"><StatusBanner severity="error" message={load.message} /><p className="loop-native-hint">The file was not overwritten. Recover or remove it in the Mac app.</p></div>;
  if (!store || !loop) return <div className="loop-native-empty"><p>This project has no loops yet.</p></div>;

  const enabledGates = loop.config.stages.filter((s) => s.enabled && s.severity === "blocking");
  const pastFactory = runRecord ? decodeFactoryFields(runRecord) : null;
  return (
    <div className="loop-native" data-active={active}>
      <aside className="loop-pane loop-loops" aria-label="Loops">
        <div className="loop-pane-head"><span>LOOPS</span><select className="loop-add-stage" aria-label="New loop or template" value="" onChange={(e) => { if (e.target.value === "__blank") addLoop(); else { const t = [...BUILT_IN_TEMPLATES, ...customTemplates].find((x) => x.id === e.target.value); if (t) addLoopFromTemplate(t); } }}>
          <option value="">＋ New loop…</option>
          <option value="__blank">Blank loop</option>
          <optgroup label="Built-in">{BUILT_IN_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
          {customTemplates.length > 0 ? <optgroup label="My templates">{customTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup> : null}
        </select></div>
        <div className="loop-actions">
          <button type="button" className="loop-btn" disabled={loop.isPrimary} onClick={setPrimary}>★ Primary</button>
          <button type="button" className="loop-btn" disabled={isManualOnly(loop)} title={isManualOnly(loop) ? "Manual-only: it applies code" : "Include in the scheduled run"} onClick={() => patchLoop((l) => { l.runsOnSchedule = !l.runsOnSchedule; })}>{loop.runsOnSchedule ? "◷ Scheduled" : "◷ Schedule"}</button>
          <button type="button" className="loop-btn" onClick={duplicateLoop}>Duplicate</button>
          {loop.defaultKey === null && store.loops.length > 1 ? <button type="button" className="loop-btn" onClick={() => setAsk({ key: `loop:${loop.id}`, label: "Delete loop", text: `Delete “${loop.name}”? Its stages stay in loop.json but the loop disappears from this project.` })}>Delete</button> : null}
        </div>
        {ask?.key === `loop:${loop.id}` ? <ConfirmBar ask={ask} run={deleteLoop} onDone={() => setAsk(null)} /> : null}
        <ul className="loop-list">
          {store.loops.map((l) => (
            <li key={l.id}>
              <button type="button" className="loop-row" data-on={l.id === loop.id || undefined} onClick={() => selectLoop(l)}>
                <span className="loop-row-name">{l.name}</span>
                <span className="loop-row-icons">{l.isPrimary ? <span title="Primary">★</span> : null}{l.runsOnSchedule ? <span title="Runs on schedule">◷</span> : null}{l.defaultKey !== null ? <span className="loop-lock" title="Built-in loop: it can't be deleted">{LOCK_ICON}</span> : null}</span>
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
        <div className="loop-pane-head"><span>STAGES</span><span className="loop-pane-sub">{loop.name}</span><select className="loop-add-stage" aria-label="Add stage" value="" onChange={(e) => { if (e.target.value) addStage(e.target.value as LoopStage["kind"]); }}>
            <option value="">＋ Add stage…</option>
            {Object.entries(stageKindLabel).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select></div>
        <div className="loop-actions">
          <button type="button" className="loop-btn" onClick={() => moveStage(-1)} disabled={!stage || loop.config.stages[0]?.id === stage.id}>↑</button>
          <button type="button" className="loop-btn" onClick={() => moveStage(1)} disabled={!stage || loop.config.stages[loop.config.stages.length - 1]?.id === stage.id}>↓</button>
          <button type="button" className="loop-btn" onClick={() => void runSelectedStage()}  disabled={!stage || dirty || runningStage || !isNativeRunnable(stage) || (stage.kind === "shellCommand" && !stage.command) || (stage.kind === "skill" && !stage.skillId)}>Run stage</button>
          <button type="button" className="loop-btn" onClick={duplicateStage} disabled={!stage}>Duplicate</button>
          <button type="button" className="loop-btn" onClick={deleteStage} disabled={!stage || stage.isDefault}>Delete</button>
        </div>
        <ul className="loop-list">
          {loop.config.stages.map((s) => (
            <li key={s.id}>
              <button type="button" className="loop-stage-row" data-on={s.id === stage?.id || undefined} onClick={() => setSelectedStageId(s.id)}>
                <span className="loop-stage-name">{s.name}</span>
                {s.enabled && s.kind === "shellCommand" && s.command && approvalState && !approvalState.approved ? <span className="loop-unapproved" title="The host has no valid approval for this loop's exact commands">needs host approval</span> : null}
                {s.isDefault ? <span className="loop-lock" title="Default stage">🔒</span> : null}
                <span className="loop-row-menu" aria-hidden="true">⋯</span>
              </button>
            </li>
          ))}
          {loop.config.stages.length === 0 ? <li className="loop-empty-row">No stages yet.</li> : null}
        </ul>
      </aside>

      <main className="loop-run" aria-label="Run">
        <div className="loop-run-tabs"><span className="loop-run-tab" data-on="true">Run</span><span className="loop-spacer" />{queued > 0 && loop && queueRef.current.some((x) => x.loop.id === loop.id) ? <button type="button" className="loop-btn" onClick={leaveQueue}>Leave queue</button> : null}{queued > 0 ? <button type="button" className="loop-btn" onClick={clearQueued}>Clear queue</button> : null}{queued > 0 && !runningStage ? <button type="button" className="loop-btn" onClick={resumeQueue}>Resume {queued} queued</button> : null}{loopRunning ? <button type="button" className="loop-btn" title={paused ? "Continue with the next stage" : "Hold the loop once the current stage finishes"} onClick={() => (paused ? resumeRun() : pauseRun())}>{paused ? "Resume" : "Pause"}</button> : null}{runningStage ? <button type="button" className="loop-btn" onClick={stopRun}>■ Stop</button> : null}<button type="button" className="loop-btn loop-run-btn" disabled={dirty} title={dirty ? "Save the Loop first" : runningStage ? "Queue another run" : "Run the loop"} onClick={() => runLoop()}>{runningStage ? (queued > 0 ? `Queued ${queued}` : "Running… · Queue") : "▶ Run"}</button></div>
        {notice ? <StatusBanner severity={notice.startsWith("Loop configuration saved") || notice.startsWith("Added and saved") ? "info" : "warning"} message={notice} onDismiss={() => setNotice(null)} /> : null}
        {shipRun ? <ShipPanel key={shipRun.info.runId} info={shipRun.info} initialDiff={shipRun.diff} item={shipRun.item} passed={shipRun.passed} reviewedPatchId={shipRun.reviewedPatchId ?? shipRun.diff?.patchId ?? null} requestProvider={shipRun.requestProvider ?? null} fs={fs} runPrefix={repoPrefixFor(projectRoot, shipRun.info.worktree)} onShipped={(r) => { setRunLog((l) => [...l, `shipped: ${r.url}`]); void setRunRecordShip(fs, shipRun.entry, r).catch(() => false).then((ok) => { if (!ok) setNotice("Shipped, but the run record could not be updated."); }); }} onDiscarded={() => { setShipRun(null); setNotice("The run's worktree and branch were removed."); }} onClose={() => setShipRun(null)} /> : null}
        {pickerLoop ? <FactoryPicker fs={fs} projectRoot={projectRoot} workRoot={workRoot} onCancel={() => setPickerLoop(null)} onStart={(item, repoRel) => { const picked = pickerLoop; setPickerLoop(null); if (!picked) return; const current = store?.loops.find((l) => l.id === picked.id) ?? null; const refusal = factoryStartRefusal({ running: runningRef.current, starting: startingRef.current, dirty, loopExists: current !== null }); if (refusal || current === null) { setNotice(refusal ?? "That Factory loop no longer exists."); return; } void executeLoop(current, false, { repoRel, task: taskMarkdown(item), item }); }} /> : null}
        <section className="loop-card loop-overview">
          <h2>OVERVIEW</h2>
          <label className="loop-field"><span>Name</span><input value={loop.name} onChange={(e) => patchLoop((l) => { l.name = e.target.value; })} /></label>
          <label className="loop-field"><span>Goal — what is this loop trying to achieve?</span><textarea rows={2} value={loop.goal ?? ""} onChange={(e) => patchLoop((l) => { l.goal = e.target.value || null; })} /></label>
          <label className="loop-field"><span>Acceptance criteria — what observable condition means done?</span><textarea rows={2} value={loop.acceptanceCriteria ?? ""} placeholder="Optional; included in repair/skill prompts." onChange={(e) => patchLoop((l) => { l.acceptanceCriteria = e.target.value || null; })} /></label>
          <label className="loop-field"><span>Scope globs (comma separated)</span><input value={loop.scopeGlobs.join(", ")} placeholder="src/**, tests/**" onChange={(e) => patchLoop((l) => { l.scopeGlobs = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></label>
          <div className="loop-gates">
            <h3>{enabledGates.length} gating check{enabledGates.length === 1 ? "" : "s"}.</h3>
            <p className="loop-native-hint">Every iteration re-runs all stages from the top until each gating check passes.</p>
            <ol>{loop.config.stages.filter((s) => s.enabled).map((s, i) => <li key={s.id}><span>{i + 1}</span> {s.name} <code>{s.severity === "blocking" ? "verify" : "advisory"}</code> <code>{stageCheck(s)}</code></li>)}</ol>
          </div>
          <dl className="loop-meta">
            <dt>Runs in</dt><dd>{loop.config.alwaysUseWorktree ? "a new worktree under system/loop-worktrees/ for each run (your working tree is not touched)" : workRoot ?? projectRoot}</dd>
            <dt>Project root</dt><dd>{projectRoot}</dd>
            <dt>Bounded by</dt><dd>{loop.config.maxIterations} iterations · {loop.config.wallClockBudgetSeconds ? `${Math.round(loop.config.wallClockBudgetSeconds / 60)} min time limit` : "no time limit"} · stop after {loop.config.consecutiveFailureStop} non-improving · {loop.config.maxRepairsPerStage} repairs/stage</dd>
            <dt>Scheduled</dt><dd>{loop.runsOnSchedule ? "included in this page's cron schedule" : "no — run it from here"}</dd>
          </dl>
          <div className="loop-budgets">
            <label className="loop-field"><span>Max iterations</span><input type="number" min={1} value={loop.config.maxIterations} onChange={(e) => patchLoop((l) => { l.config.maxIterations = Math.max(1, Number(e.target.value) || 1); })} /></label>
            <label className="loop-field"><span>Time budget (minutes, empty = none)</span><input type="number" min={0} step={15} value={loop.config.wallClockBudgetSeconds === null ? "" : Math.round(loop.config.wallClockBudgetSeconds / 60)} onChange={(e) => patchLoop((l) => { l.config.wallClockBudgetSeconds = e.target.value === "" ? null : Math.max(0, Number(e.target.value)) * 60; })} /></label>
            <label className="loop-field"><span>Stop after non-improving</span><input type="number" min={1} max={10} value={loop.config.consecutiveFailureStop} onChange={(e) => patchLoop((l) => { l.config.consecutiveFailureStop = Math.max(1, Number(e.target.value) || 1); })} /></label>
            <label className="loop-field"><span>Repairs per stage</span><input type="number" min={1} max={10} value={loop.config.maxRepairsPerStage} onChange={(e) => patchLoop((l) => { l.config.maxRepairsPerStage = Math.max(1, Number(e.target.value) || 1); })} /></label>
            <label className="loop-field"><span>Pause timeout (minutes, 0 = none)</span><input type="number" min={0} step={15} value={Math.round(loop.config.pauseTimeoutSeconds / 60)} onChange={(e) => patchLoop((l) => { l.config.pauseTimeoutSeconds = Math.max(0, Number(e.target.value) || 0) * 60; })} /></label>
          </div>
          <details className="loop-advanced">
            <summary>Advanced budgets and policy</summary>
            <label className="loop-field"><span>Repair model (empty = app default)</span><input value={loop.config.repairModel ?? ""} placeholder="model id" onChange={(e) => patchLoop((l) => { l.config.repairModel = e.target.value || null; })} /></label>
            <label className="loop-field"><span>Protected path policy</span><select value={loop.config.protectedPathPolicy} onChange={(e) => patchLoop((l) => { l.config.protectedPathPolicy = e.target.value as "revert" | "stop" | "warn" | "off"; })}><option value="revert">Revert &amp; stop</option><option value="stop">Leave edits &amp; stop</option><option value="warn">Warn and continue</option><option value="off">Do not check</option></select></label>
            <p className={loop.config.protectedPathPolicy === "off" ? "loop-warn" : "loop-native-hint"}>{protectedPolicyCopy(loop.config.protectedPathPolicy)}</p>
            {loop.config.protectedPathPolicy === "off" && loop.scopeGlobs.length > 0 ? <p className="loop-warn">Not enforced: the policy above is Off, which disables the scope check too.</p> : null}
            <label className="loop-field"><span>Extra protected globs (comma separated)</span><input value={loop.config.extraProtectedGlobs.join(", ")} onChange={(e) => patchLoop((l) => { l.config.extraProtectedGlobs = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></label>
            <label className="loop-check"><input type="checkbox" checked={loop.config.writeSummaryNote} onChange={(e) => patchLoop((l) => { l.config.writeSummaryNote = e.target.checked; })} /> Write a run-summary note into the Library</label>
            <button type="button" className="loop-btn" onClick={() => { void revokeApprovals().then(() => { setApprovalState(null); if (loop) void refreshApproval(loop.id); setNotice("Revoked every host Loop command approval."); }).catch((e: unknown) => setNotice(e instanceof Error ? e.message : "The approvals could not be revoked.")); }}>Revoke command approvals</button>
            <label className="loop-check"><input type="checkbox" checked={loop.config.openMergeRequest} onChange={(e) => patchLoop((l) => { l.config.openMergeRequest = e.target.checked; })} /> Offer Ship after a passed run</label>
            <label className="loop-check"><input type="checkbox" disabled checked={loop.config.useWorktreesForConcurrentRuns} onChange={() => undefined} /> Isolated worktree for concurrent runs (not ported)</label>
            <label className="loop-check"><input type="checkbox" checked={loop.config.alwaysUseWorktree || isFactoryLoop(loop)} disabled={isFactoryLoop(loop)} onChange={(e) => patchLoop((l) => { l.config.alwaysUseWorktree = e.target.checked; })} /> Always run in an isolated worktree</label>
          </details>
          <details className="loop-advanced">
            <summary>Desktop limits (explicit)</summary>
            <p className="loop-native-hint">Not ported yet: incident-triage execution and closed-window/background scheduling. These controls are disabled or marked above; a stage that needs them is refused rather than faked.</p>
          </details>
        </section>

        <section className="loop-card">
          <h2>ENVIRONMENT</h2>
          <p><span className="loop-ready" aria-hidden="true">●</span> {testCommand ? "Ready to run" : "No test command detected"}</p>
          <p>Recommended test command: <code>{testCommand ?? "none"}</code></p>
          <p className="loop-native-hint">{envReason} Nothing is installed or changed.</p>
          {envVersions ? <p className="loop-native-hint">Python: {envVersions.python ?? "not found"} · Node: {envVersions.node ?? "not found"} · Git: {envVersions.git ?? "not found"}</p> : null}
          <div className="loop-inline"><button type="button" className="loop-btn" disabled={checkingEnv} onClick={() => void checkEnvironment()}>{checkingEnv ? "Checking…" : "Check again"}</button><button type="button" className="loop-btn" disabled={checkingEnv} onClick={() => void checkToolchain()}>{checkingEnv ? "Checking…" : "Check Python environment…"}</button></div>
        </section>

        <section className="loop-card">
          <h2>SCHEDULE</h2>
          <label className="loop-field"><span>Cron (page-resident scheduler)</span><input value={scheduleCron} placeholder="0 2 * * *" onChange={(e) => saveSchedule(e.target.value)} /></label>
          <p className="loop-native-hint">{scheduleCron && validateCron(scheduleCron) ? `${describeCron(scheduleCron)}. Fires while the Loop page is open; background scheduling is not ported.` : "No valid schedule. The desktop scheduler runs only while this page is open."}</p>
          <p className="loop-native-hint">Loops marked “Run on schedule” are queued when the cron fires.</p>
          <button type="button" className="loop-btn" onClick={runScheduledNow}>Run scheduled loops now</button>
        </section>

        <section className="loop-card" aria-label="Output">
          <h2>OUTPUT</h2>
          <dl className="loop-meta">
            <dt>Run journal</dt><dd><span>system/loop-runs/ · one JSON record per run, plus an index</span>{outputExists.journal ? <button type="button" className="loop-btn" onClick={() => revealRel("system/loop-runs")}>Reveal</button> : <span className="loop-native-hint">not yet</span>}</dd>
            <dt>Fault state</dt><dd><span>system/faults.csv · refreshed by the Regression stage</span>{outputExists.faults ? <button type="button" className="loop-btn" onClick={() => revealRel("system/faults.csv")}>Reveal</button> : <span className="loop-native-hint">not yet</span>}</dd>
            <dt>Working tree</dt><dd><span>{workRoot ? "repair edits land here and stay; review with git before committing" : "not resolved yet"}</span>{workRoot ? <button type="button" className="loop-btn" onClick={() => revealRel(workRelative)}>Reveal</button> : null}</dd>
            <dt>Run log</dt><dd><span>live, in the panel to the right</span></dd>
            {loop.config.writeSummaryNote ? <><dt>Summary notes</dt><dd><span>llm-doc/loop/ · one readable note per run</span>{outputExists.summaries ? <button type="button" className="loop-btn" onClick={() => revealRel("llm-doc/loop")}>Reveal</button> : <span className="loop-native-hint">none written yet</span>}</dd></> : null}
          </dl>
        </section>

        <section className="loop-card">
          <h2>TEMPLATE</h2>
          <div className="loop-inline">
            <select aria-label="Template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <optgroup label="Built-in">{BUILT_IN_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
              {customTemplates.length > 0 ? <optgroup label="My templates">{customTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup> : null}
            </select>
            <button type="button" className="loop-btn" onClick={() => {
              const t = [...BUILT_IN_TEMPLATES, ...customTemplates].find((x) => x.id === templateId);
              if (!t) return;
              if (t.id === FACTORY_TEMPLATE.id) { setNotice("The Factory is its own loop in the list on the left; it cannot be applied over another loop."); return; }
              const config = applyTemplate(t, testCommand);
              if (config.stages.length === 0) { setNotice("This recipe needs a detected test command; none was found."); return; }
              patchLoop((l) => { l.config = config; });
              setSelectedStageId(config.stages[0]?.id ?? null);
              setNotice(`Applied ${t.name}. Save to keep it.`);
            }}>Apply</button>
          </div>
          <div className="loop-inline">
            <button type="button" className="loop-btn" aria-expanded={templateDraft !== null} onClick={() => setTemplateDraft({ name: `${loop.name} Recipe`, summary: "" })}>Save as…</button>
            {customTemplates.some((t) => t.id === templateId) ? <button type="button" className="loop-btn" onClick={() => setAsk({ key: `template:${templateId}`, label: "Delete template", text: "Delete this saved template?" })}>Delete template</button> : null}
          </div>
          {templateDraft ? (
            <form className="loop-confirm" aria-label="Save as template" onSubmit={(e) => {
              e.preventDefault();
              if (!templateDraft.name.trim()) return;
              try {
                const t = saveCustomTemplate(templateDraft.name, templateDraft.summary, loop.config);
                refreshTemplates();
                setTemplateId(t.id);
                setNotice(`Saved template “${t.name}”.`);
              } catch (err) { setNotice(err instanceof Error ? err.message : "The template could not be saved."); }
              setTemplateDraft(null);
            }}>
              <label className="loop-field"><span>Save the current stages and budgets as a template named</span><input autoFocus value={templateDraft.name} maxLength={200} onChange={(e) => setTemplateDraft({ ...templateDraft, name: e.target.value })} /></label>
              <label className="loop-field"><span>What does this loop do? (optional)</span><input value={templateDraft.summary} maxLength={500} onChange={(e) => setTemplateDraft({ ...templateDraft, summary: e.target.value })} /></label>
              <div className="loop-inline">
                <button type="button" className="loop-btn" onClick={() => setTemplateDraft(null)}>Cancel</button>
                <button type="submit" className="loop-btn loop-btn-primary" disabled={!templateDraft.name.trim()}>Save template</button>
              </div>
            </form>
          ) : null}
          {ask?.key === `template:${templateId}` ? <ConfirmBar ask={ask} onDone={() => setAsk(null)} run={() => {
            try {
              deleteCustomTemplate(templateId);
              refreshTemplates();
              setTemplateId(BUILT_IN_TEMPLATES[0].id);
            } catch (e) { setNotice(e instanceof Error ? e.message : "The template could not be deleted."); }
          }} /> : null}
          {customLoad.problem ? (
            <div className="loop-inline">
              <StatusBanner severity="error" message="Saved Loop recipes could not be read in full, so saving and deleting are refused to keep them. The old data is kept as a backup." />
              <button type="button" className="loop-btn" onClick={() => setAsk({ key: "reset-templates", label: "Reset custom templates", text: "Reset custom templates? The stored recipes are kept as a backup in this app's storage, and the list starts empty." })}>Reset custom templates</button>
              {ask?.key === "reset-templates" ? <ConfirmBar ask={ask} onDone={() => setAsk(null)} run={() => {
                resetCustomTemplates();
                refreshTemplates();
                setTemplateId(BUILT_IN_TEMPLATES[0].id);
                setNotice("Custom templates reset. The old data is kept as a backup.");
              }} /> : null}
            </div>
          ) : null}
          <p className="loop-native-hint">{[...BUILT_IN_TEMPLATES, ...customTemplates].find((x) => x.id === templateId)?.summary}</p>
          <p className="loop-warn">Applying replaces this loop&apos;s stages and budgets. Nothing is saved until you press Save, and shell stages need approving again.</p>
        </section>

        {stage ? (
          <section className="loop-card">
            <h2>PROCESS</h2>
            <div className="loop-stage-editor">
              <div className="loop-stage-editor-head"><span>{loop.config.stages.indexOf(stage) + 1}</span><span>{stage.enabled ? "●" : "○"} {stage.name}</span><span className="loop-native-hint">{stage.severity}</span></div>
              <label className="loop-field"><span>Name</span><input value={stage.name} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.name = e.target.value; })} /></label>
              <div className="loop-inline"><label className="loop-check"><input type="checkbox" checked={stage.enabled} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.enabled = e.target.checked; })} /> Enabled</label><label className="loop-field"><span>Severity</span><select value={stage.severity} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.severity = e.target.value as "blocking" | "advisory"; })}><option value="blocking">Blocking</option><option value="advisory">Advisory</option></select></label><label className="loop-check"><input type="checkbox" checked={stage.allowsRepair} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.allowsRepair = e.target.checked; })} /> Allows repair</label></div>
              <label className="loop-field"><span>Kind</span><select value={stage.kind} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.kind = e.target.value as LoopStage["kind"]; })}>
                {Object.entries(stageKindLabel).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select></label>
              {stage.kind === "shellCommand" ? <label className="loop-field"><span>Command</span><input value={stage.command ?? ""} placeholder="npm test" onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.command = e.target.value; })} />{testCommand && stage.command !== testCommand ? <button type="button" className="loop-btn" onClick={() => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.command = testCommand; })}>Use detected: {testCommand}</button> : null}</label> : null}
              {stage.kind === "skill" ? <>
                <label className="loop-field"><span>Skill id</span><input value={stage.skillId ?? ""} placeholder="family/skill" onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.skillId = e.target.value || null; })} /></label>
                <label className="loop-field"><span>Target path (optional)</span><input value={stage.targetPath ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.targetPath = e.target.value || null; })} /></label>
                <label className="loop-field"><span>Output path (optional)</span><input value={stage.outputPath ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.outputPath = e.target.value || null; })} /></label>
                <label className="loop-field"><span>Prompt (optional)</span><textarea rows={3} value={stage.prompt ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.prompt = e.target.value || null; })} /></label>
              </> : null}
              {stage.kind === "testMap" ? <label className="loop-field"><span>Test map operation</span><select value={stage.testOp ?? "structure"} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.testOp = e.target.value as "structure" | "map" | "ledger"; })}><option value="structure">Structure</option><option value="map">Map</option><option value="ledger">Ledger</option></select></label> : null}
              {stage.kind === "codeGraph" ? <label className="loop-field"><span>Code graph operation</span><select value={stage.graphOp ?? "snapshot"} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.graphOp = e.target.value as "snapshot" | "verify"; })}><option value="snapshot">Snapshot</option><option value="verify">Verify</option></select></label> : null}
              <label className="loop-field"><span>Timeout (seconds, empty = runner default)</span><input type="number" min={0} value={stage.timeoutSeconds ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.timeoutSeconds = e.target.value === "" ? null : Math.max(0, Number(e.target.value)); })} /></label>
              {stage.kind === "artifactCheck" ? <label className="loop-field"><span>Check JSON</span><textarea key={stage.id} rows={6} defaultValue={JSON.stringify(stage.check ?? {}, null, 2)} onBlur={(e) => { try { const v = JSON.parse(e.target.value) as Record<string, unknown>; patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.check = v; }); } catch { setNotice("Check JSON is not valid; the previous check is unchanged."); } }} /></label> : null}
              <p className="loop-native-hint">{stageKindLabel[stage.kind] ?? stage.kind}{stage.defaultKey ? ` · ${stage.defaultKey}` : ""}</p>
            </div>
          </section>
        ) : null}
      </main>

      <aside className="loop-log" aria-label="Run log">
        <div className="loop-pane-head"><span>RUN LOG</span><span className="loop-spacer" /><button type="button" className="loop-native-hint loop-clear" onClick={() => { const text = runLog.join("\n"); if (text) void navigator.clipboard?.writeText(text).then(() => setNotice("Run log copied.")).catch(() => setNotice("Could not copy the run log.")); }}>Copy</button><button type="button" className="loop-native-hint loop-clear" onClick={() => setRunLog([])}>Clear</button></div>
        {selectedRun ? (
          <div className="loop-past-run">
            <div className="loop-inline"><h3>{selectedRun.loopName}</h3><span className="loop-spacer" />{runRecord ? <button type="button" className="loop-btn" onClick={() => revealRunRecord(selectedRun)}>Reveal JSON</button> : null}<button type="button" className="loop-btn" onClick={closeRun}>Back</button></div>
            <p className="loop-native-hint">{selectedRun.statusCode} · {new Date(selectedRun.startedAt).toLocaleString()} · {selectedRun.iterationsUsed} iteration{selectedRun.iterationsUsed === 1 ? "" : "s"}</p>
            <p>{selectedRun.statusSummary}</p>
            {!runRecordLoaded ? <p className="loop-native-hint" role="status">Loading the run record…</p> : runRecord === null ? <p className="loop-native-hint">Could not load this run&apos;s record. It may have been removed or edited by hand.</p> : <>
              <p className="loop-native-hint">{budgetsLine(runRecord.config)}</p>
              {pastFactory?.workItem ? <p className="loop-native-hint">Work item: {pastFactory.workItem.title}{pastFactory.workItem.id ? ` (${pastFactory.workItem.source} ${pastFactory.workItem.id})` : ""}</p> : null}
              {pastFactory?.needsDecision ? <p className="loop-warn">{pastFactory.needsDecision}</p> : null}
              {pastFactory?.worktree ? <p className="loop-native-hint">Worktree branch <code>{pastFactory.worktree.branch}</code> · started from <code>{pastFactory.worktree.baseCommit.slice(0, 7)}</code></p> : null}
              {pastFactory?.diffSummary ? <p className="loop-native-hint">Diff: {pastFactory.diffSummary.files.length} file(s){pastFactory.diffSummary.truncated ? " (list cut)" : ""}{pastFactory.diffSummary.files.length ? ` · ${pastFactory.diffSummary.files.slice(0, 20).join(", ")}` : ""}</p> : null}
              {pastFactory?.ship ? <p className="loop-native-hint">Shipped to {pastFactory.ship.provider}{pastFactory.ship.reused ? " (updated)" : ""}: {pastFactory.ship.url}</p> : null}
              {pastFactory?.worktree ? <button type="button" className="loop-btn" onClick={() => void reopenWorktree(selectedRun, pastFactory)}>Review worktree…</button> : null}
              {Array.isArray(runRecord.changedPaths) && runRecord.changedPaths.length > 0 ? <p className="loop-native-hint">Changed: {runRecord.changedPaths.map(String).join(", ")}</p> : null}
              {typeof runRecord.summaryPath === "string" && runRecord.summaryPath ? <button type="button" className="loop-btn" onClick={() => shellBus.publish({ type: "open-file", path: runRecord.summaryPath as string })}>Open summary note</button> : null}
              {Array.isArray(runRecord.stages) && runRecord.stages.length > 0 ? (
                <ul>{runRecord.stages.map((st, i) => { const o = st as Record<string, unknown>; const run = (o.run ?? {}) as Record<string, unknown>; const output = String(run.stdout ?? ""); return <li key={i}><details><summary>{String(o.stageName ?? "Stage")} · exit {String(run.exitCode ?? "?")} · {String(run.durationMs ?? "")} ms</summary>{output ? <pre className="loop-run-log">{output}</pre> : <p className="loop-native-hint">No captured output.</p>}</details></li>; })}</ul>
              ) : <p className="loop-native-hint">No stages executed.</p>}
              {Array.isArray(runRecord.iterations) && runRecord.iterations.length > 0 ? (
                <div className="loop-past-iterations">
                  {runRecord.iterations.map((it, i) => { const o = (it ?? {}) as Record<string, unknown>; const stages = Array.isArray(o.stages) ? o.stages : []; return <div key={i}><h4>Iteration {String(o.index ?? i + 1)}</h4>{stages.map((st, j) => { const x = (st ?? {}) as Record<string, unknown>; return <details key={j}><summary>{x.passed === true ? "✓" : "✗"} {String(x.stageName ?? "Stage")}{typeof x.score === "number" ? ` · ${x.score} failing` : ""}</summary><pre className="loop-run-log">{String(x.output ?? "")}</pre></details>; })}{o.repair ? <p className="loop-native-hint">repair {String((o.repair as Record<string, unknown>).ok) === "true" ? "completed" : "failed"}</p> : null}</div>; })}
                </div>
              ) : null}
            </>}
          </div>
        ) : runLog.length === 0 ? <p className="loop-native-hint">No runs yet.</p> : <pre className="loop-run-log">{runLog.join("\n")}</pre>}
      </aside>
    </div>
  );
}
