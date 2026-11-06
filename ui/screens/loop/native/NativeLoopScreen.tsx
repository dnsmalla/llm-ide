// Native Loop screen, first port slice: the Mac three-pane structure over the committed system/loop.json.
// Editing/runner arrive next; every field shown here comes from the file, never from the bridge.
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
import { BUILT_IN_TEMPLATES, applyTemplate, deleteCustomTemplate, initialProjectStore, loadCustomTemplatesState, resetCustomTemplates, saveCustomTemplate, type LoopTemplate } from "./templates.ts";
import { detectTestCommand } from "./environment.ts";
import { runNativeLoop, runStatusCode } from "./runner.ts";
import { shellBus } from "../../shell/bus";
import { evaluateArtifact } from "./artifact.ts";
import { approve, isApproved, revokeAll } from "./approvals.ts";
import { reopenFault, runRegression } from "./regression.ts";
import { runCodeGraph } from "./codegraph.ts";
import { scanTestPrune, writeTestPrune } from "./testprune.ts";
import { writeSummaryNote } from "./summary.ts";
import { clearQueue, loadQueue, saveQueue } from "./queue.ts";
import { checkWrites } from "./protected.ts";
import { guardedAgentCall, type AgentWrites } from "./agent-call.ts";
import { agentRunSucceeded } from "../../autotasks/native/model.ts";
import { cronMatches, describeCron, validateCron } from "../../autotasks/native/cron.ts";
import { decodePrefsView, type LoopDefaults } from "../../shell/host-prefs.ts";
import { buildTestMap, detectTestStructure, ledgerDiff, parseTestResults, readLedger, writeLedger, writeTestMap, writeTestStructure } from "./testmap.ts";
import { appendRunRecord, iterationRecordsWithScores, loadRunRecord, readRecentRuns, runRecordPath, runTrigger, type LoopRunIndexEntry } from "./history.ts";
import "./native-loop.css";

/** The `/kb/loop/agent-run` answer fields the Loop reads. */
type AgentRunReply = AgentWrites & { reply?: string; ran?: boolean; unresolvedSkills?: string[]; resultSubtype?: string | null };

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
  const [templateId, setTemplateId] = useState(BUILT_IN_TEMPLATES[0].id);
  const [testCommand, setTestCommand] = useState<string | null>(null);
  const [envReason, setEnvReason] = useState("Checking the project environment…");
  const [checkingEnv, setCheckingEnv] = useState(false);
  const [envVersions, setEnvVersions] = useState<{ python: string | null; node: string | null; git: string | null } | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runningStage, setRunningStage] = useState(false);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const haltRef = useRef<string | null>(null);
  /** The halt is a failed agent call with nothing out of scope (recorded as `error`, as the Mac does), not a block. */
  const haltErrorRef = useRef(false);
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
    }).then((fn) => { un = fn; }).catch(() => undefined);
    return () => { if (un) un(); };
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
    if (!window.confirm(`Delete “${loop.name}”? Its stages stay in loop.json but the loop disappears from this project.`)) return;
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
        graphOp: kind === "codeGraph" ? "snapshot" : null, allowsRepair: true, defaultRevision: null,
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

  /** Paths with uncommitted changes before an agent call. `null` = the snapshot failed, so nothing may be reverted. */
  const dirtyBefore = async (): Promise<Set<string> | null> => {
    try { return new Set(await invokeHost<string[]>("loop_changed_paths")); } catch { return null; }
  };

  /** Paths git reports as changed right now; null when git cannot say (the post-throw check needs this). */
  const changedPathsNow = async (): Promise<string[] | null> => {
    try { return await invokeHost<string[]>("loop_changed_paths"); } catch { return null; }
  };

  /**
   * Protected-path and scope guard for one agent call (the Mac's checkScope + policy). Shared logic is in
   * protected.ts `checkWrites`; this only wires the Loop's policy, host revert and run log. A violation returns its
   * message; the caller ends the run with it.
   */
  const guardProtected = (paths: readonly string[], target: LoopDefinition, before: ReadonlySet<string> | null, created: readonly string[] = []): Promise<string | null> =>
    checkWrites(
      paths,
      { policy: target.config.protectedPathPolicy, extraProtectedGlobs: target.config.extraProtectedGlobs, scopeGlobs: target.scopeGlobs },
      before,
      created,
      async (p, c) => { await invokeHost("loop_revert_paths", { paths: p, created: c }); },
      (line) => setRunLog((l) => [...l, line]),
    );

  /**
   * Runs one agent call and checks what it wrote, also when the call throws (the Mac re-checks after a throw). Returns
   * the reason the run must stop, or null when the call's writes were acceptable.
   */
  const stopReason = (g: { error: string | null; violation: string | null }): string | null => {
    if (g.error !== null) return `the agent call failed (${g.error})${g.violation ? `; ${g.violation}` : ""}`;
    return g.violation;
  };

  const runOneStage = async (s: LoopStage, target: LoopDefinition, prior: readonly { stage: LoopStage; ok: boolean; output: string }[] = []): Promise<{ ok: boolean; output: string }> => {
    if (s.kind === "shellCommand") {
      const r = await invokeHost<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled?: boolean }>("loop_run_stage", { stageId: s.id, timeoutSecs: s.timeoutSeconds });
      if (r.cancelled) cancelledRef.current = true;
      return { ok: !r.timedOut && !r.cancelled && r.exitCode === 0, output: r.cancelled ? "Stage cancelled." : [r.stdout, r.stderr].filter(Boolean).join("\n") };
    }
    if (s.kind === "regressionSweep") {
      const root = projectRoot ?? "";
      const repoPrefix = workRoot && root && workRoot.startsWith(`${root}/`) ? workRoot.slice(root.length + 1) : "";
      const faultsRoot = repoPrefix ? `${repoPrefix}/system/faults` : "system/faults";
      const r = await runRegression(fs, faultsRoot, {
        async verify(f) {
          const v = await invokeHost<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>("loop_run_fault_verify", { rel: f.rel, timeoutSecs: s.timeoutSeconds });
          return { ok: !v.timedOut && v.exitCode === 0, output: [v.stdout, v.stderr].filter(Boolean).join("\n") };
        },
        async ask(prompt) {
          const a = await core.request<{ reply?: string }>("/kb/complete", { method: "POST", body: { prompt } });
          return a.reply ?? "";
        },
        async judge(saved, fresh) {
          const prompt = ["Compare two answers about a software fault.", "Are they the same meaning for the fault and its fix? Reply with JSON only: {\"same\":true} or {\"same\":false}.", `Saved answer:\n${saved.slice(0, 12_000)}`, `Fresh answer:\n${fresh.slice(0, 12_000)}`].join("\n\n");
          const j = await core.request<{ reply?: string }>("/kb/complete", { method: "POST", body: { prompt } });
          const text = j.reply ?? "";
          const m = /\{[\s\S]*?\}/.exec(text);
          if (!m) return false;
          try { return (JSON.parse(m[0]) as { same?: unknown }).same === true; } catch { return false; }
        },
      });
      return { ok: r.passed, output: r.checked === 0 ? "No fixed faults to re-check." : [...r.notes, ...r.failures].join("\n") };
    }
    if (s.kind === "skill") {
      if (!s.skillId) return { ok: false, output: "This skill stage has no skill id." };
      const parts = [s.prompt?.trim() || `Run the ${s.name} skill for this loop.`];
      if (target.goal) parts.push(`Loop goal: ${target.goal}`);
      if (target.acceptanceCriteria) parts.push(`Acceptance criteria: ${target.acceptanceCriteria}`);
      if (s.targetPath) parts.push(`Target path: ${s.targetPath}`);
      if (s.outputPath) parts.push(`Output path: ${s.outputPath}`);
      const before = await dirtyBefore();
      const g = await guardedAgentCall<AgentRunReply>({
        before,
        call: () => core.request<AgentRunReply>("/kb/loop/agent-run", {
          method: "POST", body: { message: parts.join("\n\n"), skills: [s.skillId], repoRoot: workRoot ?? projectRoot, timeoutMs: (s.timeoutSeconds ?? 1800) * 1000 },
        }),
        changedNow: changedPathsNow,
        check: (paths, b, created) => guardProtected(paths, target, b, created),
      });
      const stop = stopReason(g);
      if (g.result === null || stop !== null) { if (g.violation === null && cancelledRef.current) return { ok: false, output: stop ?? "the agent call failed" }; haltErrorRef.current = g.violation === null; haltRef.current = `${stop ?? "the agent call failed"}; the run stopped`; return { ok: false, output: stop ?? "the agent call failed" }; }
      const r = g.result;
      const ok = agentRunSucceeded(r);
      const why = ok ? [] : r.unresolvedSkills?.length ? ["the skill could not be found, so it did not run"] : r.ran === false ? ["the skill did not run"] : [`the agent run did not finish (${r.resultSubtype ?? "no result"})`];
      return { ok, output: [...why, r.reply ?? "(no reply)", ...(r.changedPaths?.length ? [`changed: ${r.changedPaths.join(", ")}`] : []), ...(r.unresolvedSkills?.length ? [`unresolved skills: ${r.unresolvedSkills.join(", ")}`] : [])].join("\n") };
    }
    if (s.kind === "testMap" && s.testOp === "ledger") {
      const lastTest = [...prior].reverse().find((o) => o.stage.kind === "shellCommand" && /test/i.test(o.stage.name));
      if (!lastTest) return { ok: false, output: "the ledger stage needs a Test stage output earlier in this run" };
      const parsed = parseTestResults(lastTest.output);
      if (parsed.failing.length === 0 && parsed.passing.length === 0) return { ok: false, output: "no test results could be parsed from the Test stage output" };
      const root = projectRoot ?? "";
      const repoPrefix = workRoot && root && workRoot.startsWith(`${root}/`) ? workRoot.slice(root.length + 1) : "";
      const path = `${repoPrefix ? `${repoPrefix}/` : ""}system/loop/test/ledger.json`;
      const previous = await readLedger(fs, path);
      const diff = ledgerDiff(previous, parsed, lastTest.ok);
      const ledger = { runId: crypto.randomUUID(), recordedAt: new Date().toISOString(), failing: parsed.failing, passing: parsed.passing };
      await writeLedger(fs, path, ledger);
      return { ok: true, output: [`${ledger.failing.length} failing · ${ledger.passing.length} passing`, `new failures: ${diff.newFailures.length ? diff.newFailures.join(", ") : "none"}`, `still failing: ${diff.stillFailing.length ? diff.stillFailing.join(", ") : "none"}`, `fixed: ${diff.fixed.length ? diff.fixed.join(", ") : "none"}`, `wrote ${path}`].join("\n") };
    }

    if (s.kind === "testMap") {
      if (s.testOp !== "structure" && s.testOp !== "map") return { ok: false, output: `testMap ${s.testOp ?? "operation"} is not ported yet` };
      const root = projectRoot ?? "";
      const repoPrefix = workRoot && root && workRoot.startsWith(`${root}/`) ? workRoot.slice(root.length + 1) : "";
      const structure = await detectTestStructure(fs, repoPrefix);
      if (s.testOp === "structure") {
        const writes = await writeTestStructure(fs, repoPrefix, structure);
        return { ok: structure.status === "ok", output: [`${structure.roots.length} test root(s)`, ...structure.roots.map((r) => `${r.packageDir || "."}: ${r.runner} · ${r.command}`), ...structure.notes, `wrote ${writes.md} and ${writes.json}`].join("\n") };
      }
      const map = await buildTestMap(fs, repoPrefix, structure, "system/graph/graph.json");
      const writes = await writeTestMap(fs, repoPrefix, map);
      return { ok: true, output: [`${map.entries.length} function(s) · ${map.untestedFunctions} untested · ${map.testedFunctions} tested`, `wrote ${writes.md} and ${writes.json}`].join("\n") };
    }
    if (s.kind === "testPrune") {
      const root = projectRoot ?? "";
      const repoPrefix = workRoot && root && workRoot.startsWith(`${root}/`) ? workRoot.slice(root.length + 1) : "";
      const structure = await detectTestStructure(fs, repoPrefix);
      const findings = await scanTestPrune(fs, repoPrefix, structure);
      const path = await writeTestPrune(fs, repoPrefix, findings);
      return { ok: true, output: `${findings.length} finding(s); report only at ${path}` };
    }
    if (s.kind === "codeGraph") {
      if (s.graphOp !== "snapshot" && s.graphOp !== "verify") return { ok: false, output: "this graph stage has no operation chosen" };
      const root = projectRoot ?? "";
      const repoPrefix = workRoot && root && workRoot.startsWith(`${root}/`) ? workRoot.slice(root.length + 1) : "";
      const before = `${repoPrefix ? `${repoPrefix}/` : ""}system/loop/refactor/graph/before.json`;
      const r = await runCodeGraph(fs, s.graphOp, "system/graph/graph.json", before, async () => {
        await invokeHost("graph_generate", { mode: "code", target: repoPrefix || undefined });
      });
      return { ok: r.passed, output: r.output };
    }
    if (s.kind === "artifactCheck") {
      if (!s.check) return { ok: false, output: "This artifact stage has no check configuration." };
      const root = projectRoot ?? "";
      const repoPrefix = workRoot && root && workRoot.startsWith(`${root}/`) ? workRoot.slice(root.length + 1) : "";
      const r = await evaluateArtifact(fs, s.check, target.config.stages, { repoPrefix, projectPrefix: "" });
      return { ok: r.passed, output: r.passed ? "Artifact check passed." : r.failures.join("\n") };
    }
    throw new Error(`“${s.name}” is a ${s.kind} stage; this native runner executes shell, empty Regression, skill and artifact-check stages`);
  };

  const approvalRoot = workRoot ?? projectRoot ?? "";
  /** Shell commands in a loop that this machine has not approved yet. Read-only: approving stays an explicit confirm. */
  const unapprovedCommands = (target: LoopDefinition): string[] =>
    target.config.stages.flatMap((s) => (s.enabled && s.kind === "shellCommand" && s.command && !isApproved(approvalRoot, s.command) ? [s.command] : []));

  const ensureApprovals = (target: LoopDefinition, prompt = true): string | null => {
    const root = workRoot ?? projectRoot ?? "";
    for (const s of target.config.stages) {
      if (!s.enabled || s.kind !== "shellCommand" || !s.command) continue;
      if (isApproved(root, s.command)) continue;
      if (!prompt) return `“${s.name}” needs command approval before a scheduled run: ${s.command}`;
      if (!window.confirm(`Approve this command for ${target.name}?\n\n${s.command}`)) return `“${s.name}” needs command approval before it can run.`;
      approve(root, s.command);
    }
    return null;
  };

  const stopRun = () => {
    cancelledRef.current = true;
    pausedRef.current = false;
    setPaused(false);
    void invokeHost("loop_cancel").catch(() => undefined);
    setNotice("Stopping the current stage; the loop will end after it returns.");
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

  const executeLoop = async (target: LoopDefinition, scheduled = false) => {
    if (dirty) return;
    const unsupported = target.config.stages.find((s) => s.enabled && !isNativeRunnable(s));
    if (unsupported) { setNotice(`“${unsupported.name}” is a ${unsupported.kind} stage; it cannot run yet.`); return; }
    // A loop.json from a cloned repo can mark a code-applying loop runsOnSchedule; it still never runs unattended.
    if (scheduled && isManualOnly(target)) { setNotice(`“${target.name}” applies code and is manual-only; the schedule skipped it.`); return; }
    const batchBlock = macBatchReason(target);
    if (batchBlock) { setNotice(batchBlock); return; }
    const approval = ensureApprovals(target, !scheduled);
    if (approval) { setNotice(approval); return; }
    runningRef.current = true;
    cancelledRef.current = false;
    haltRef.current = null;
    haltErrorRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setLoopRunning(true);
    setSelectedRun(null);
    setRunRecord(null);
    setRunningStage(true);
    setRunLog((l) => [...l, `▶ ${target.name}`, ""]);
    const started = Date.now();
    let summaryPath: string | null = null;
    try {
      const outcome = await runNativeLoop(target.config, {
        isCancelled() { return cancelledRef.current; },
        async runStage(s, prior) {
          const r = await runOneStage(s, target, prior);
          setRunLog((l) => [...l, `$ ${s.name}`, r.output, ""]);
          return r;
        },
        async repair(s, output, attempt) {
          const message = [`Fix the failing Loop stage “${s.name}” in this repository.`, `Attempt ${attempt}.`, `Stage output:\n${output.slice(0, 12_000)}`];
          if (target.goal) message.push(`Loop goal: ${target.goal}`);
          if (target.acceptanceCriteria) message.push(`Acceptance criteria: ${target.acceptanceCriteria}`);
          const before = await dirtyBefore();
          const g = await guardedAgentCall<AgentRunReply>({
            before,
            call: () => core.request<AgentRunReply>("/kb/loop/agent-run", {
              method: "POST", body: { message: message.join("\n\n"), repoRoot: workRoot ?? projectRoot, timeoutMs: 30 * 60 * 1000, model: target.config.repairModel ?? undefined },
            }),
            changedNow: changedPathsNow,
            check: (paths, b, created) => guardProtected(paths, target, b, created),
          });
          const r: AgentRunReply = g.result ?? {};
          setRunLog((l) => [...l, `↻ repair ${s.name}`, r.reply ?? (g.error !== null ? `(agent call failed: ${g.error})` : "(no reply)"), ...(g.writes.length ? [`changed: ${g.writes.join(", ")}`] : []), ""]);
          const stop = stopReason(g);
          if (g.result === null || stop !== null) { if (g.violation === null && cancelledRef.current) return { ok: false, output: stop ?? "the agent call failed" }; haltErrorRef.current = g.violation === null; haltRef.current = `${stop ?? "the agent call failed"}; the run stopped`; return { ok: false, output: stop ?? "the agent call failed" }; }
          return { ok: agentRunSucceeded(g.result), output: g.result.reply ?? "" };
        },
        log(line) { setRunLog((l) => [...l, line]); },
        halt() { return haltRef.current; },
        haltIsError() { return haltErrorRef.current; },
        holdWhilePaused,
      });
      let changedPaths: string[] = [];
      try { changedPaths = await invokeHost<string[]>("loop_changed_paths"); } catch { changedPaths = []; }
      if (changedPaths.length) setRunLog((l) => [...l, `changed paths: ${changedPaths.join(", ")}`]);
      setRunLog((l) => [...l, outcome.cancelled ? (cancelledRef.current ? "Loop cancelled." : `Loop aborted: ${outcome.statusSummary}`) : outcome.passed ? "Loop passed." : `Loop failed: ${outcome.statusSummary}`]);
      if (!outcome.cancelled && !outcome.passed && outcome.failedStage?.kind === "regressionSweep") {
        const failedRun = [...outcome.stages].reverse().find((o) => o.stage.kind === "regressionSweep" && !o.ok);
        const faultPaths = [...new Set(Array.from(failedRun?.output.matchAll(/^([^\n:]+\\.md):/gm) ?? [], (m) => m[1].trim()))];
        let reopened = 0;
        for (const rel of faultPaths) if (await reopenFault(fs, rel)) reopened += 1;
        if (reopened > 0) setRunLog((l) => [...l, `reopened ${reopened} fixed fault(s).`]);
      }
      if (target.config.writeSummaryNote) {
        try { summaryPath = await writeSummaryNote(fs, target, outcome); setRunLog((l) => [...l, `summary note: ${summaryPath}`]); }
        catch (e) { setRunLog((l) => [...l, `summary note failed: ${e instanceof Error ? e.message : String(e)}`]); }
      }
      setNotice(outcome.cancelled ? (cancelledRef.current ? "The loop was cancelled." : outcome.statusSummary) : outcome.passed ? "The loop passed." : outcome.statusSummary);
      const startedAt = new Date(started).toISOString();
      const entry: LoopRunIndexEntry = { id: crypto.randomUUID(), loopId: target.id, loopName: target.name, startedAt, durationSeconds: (Date.now() - started) / 1000, iterationsUsed: outcome.iterationsUsed, statusCode: runStatusCode(outcome), statusSummary: outcome.statusSummary, trigger: runTrigger(scheduled) };
      const recordStages = outcome.stages.map((o) => ({ stageName: o.stage.name, severity: o.stage.severity, run: { exitCode: o.ok ? 0 : 1, stdout: o.output, stderr: "", timedOut: false, durationMs: 0 } }));
      void appendRunRecord(fs, entry, { ...entry, endedAt: new Date().toISOString(), gitRoot: workRoot ?? projectRoot, config: target.config, changedPaths, summaryPath, stages: recordStages, iterations: iterationRecordsWithScores(outcome.iterations) }).then(() => readRecentRuns(fs)).then(setRuns).catch(() => undefined);
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The loop could not run.");
    } finally {
      runningRef.current = false;
      pausedRef.current = false;
      setPaused(false);
      setLoopRunning(false);
      setRunningStage(false);
      const next = queueRef.current.shift();
      setQueued(queueRef.current.length);
      persistQueue();
      if (next) window.setTimeout(() => void executeLoop(next.loop, next.scheduled), 0);
    }
  };

  const runLoop = (target: LoopDefinition | null = loop, scheduled = false) => {
    if (!target) return;
    if (!runningRef.current && !scheduled) {
      const pending = unapprovedCommands(target).length;
      if (pending > 0) setNotice(`${pending} shell command${pending === 1 ? "" : "s"} in “${target.name}” ${pending === 1 ? "needs" : "need"} approval on this machine; you will be asked before ${pending === 1 ? "it runs" : "each one runs"}.`);
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
    if (stage.kind === "shellCommand" && stage.command && !isApproved(workRoot ?? projectRoot ?? "", stage.command)) {
      if (!window.confirm(`Approve this command?\n\n${stage.command}`)) return;
      approve(workRoot ?? projectRoot ?? "", stage.command);
    }
    setRunningStage(true);
    setRunLog((l) => [...l, `$ ${stage.name}`, ""]);
    try {
      const r = await runOneStage(stage, loop);
      setRunLog((l) => [...l, r.output, r.ok ? "Stage passed." : "Stage failed."]);
      setNotice(r.ok ? "The stage passed." : "The stage failed.");
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The stage could not run.");
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
          {loop.defaultKey === null && store.loops.length > 1 ? <button type="button" className="loop-btn" onClick={deleteLoop}>Delete</button> : null}
        </div>
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
                {s.enabled && s.kind === "shellCommand" && s.command && !isApproved(approvalRoot, s.command) ? <span className="loop-unapproved" title="Command not yet approved on this machine">needs approval</span> : null}
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
            <dt>Runs in</dt><dd>{workRoot ?? projectRoot}</dd>
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
            <button type="button" className="loop-btn" onClick={() => { revokeAll(); setNotice("Revoked every approved Loop shell command on this machine."); }}>Revoke command approvals</button>
            <label className="loop-check"><input type="checkbox" disabled checked={loop.config.openMergeRequest} onChange={() => undefined} /> Open a merge request after a successful run (not ported)</label>
            <label className="loop-check"><input type="checkbox" disabled checked={loop.config.useWorktreesForConcurrentRuns} onChange={() => undefined} /> Isolated worktree for concurrent runs (not ported)</label>
            <label className="loop-check"><input type="checkbox" disabled checked={loop.config.alwaysUseWorktree} onChange={() => undefined} /> Always run in an isolated worktree (not ported)</label>
          </details>
          <details className="loop-advanced">
            <summary>Desktop limits (explicit)</summary>
            <p className="loop-native-hint">Not ported yet: incident-triage execution, worktrees, merge-request shipping and closed-window/background scheduling. These controls are disabled or marked above; a stage that needs them is refused rather than faked.</p>
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
              const config = applyTemplate(t, testCommand);
              if (config.stages.length === 0) { setNotice("This recipe needs a detected test command; none was found."); return; }
              patchLoop((l) => { l.config = config; });
              setSelectedStageId(config.stages[0]?.id ?? null);
              setNotice(`Applied ${t.name}. Save to keep it.`);
            }}>Apply</button>
          </div>
          <div className="loop-inline">
            <button type="button" className="loop-btn" onClick={() => {
              const name = window.prompt("Save the current stages and budgets as a template named:", `${loop.name} Recipe`);
              if (!name) return;
              const summary = window.prompt("What does this loop do? (optional)", "");
              if (summary === null) return;
              try {
                const t = saveCustomTemplate(name, summary, loop.config);
                refreshTemplates();
                setTemplateId(t.id);
                setNotice(`Saved template “${t.name}”.`);
              } catch (e) { setNotice(e instanceof Error ? e.message : "The template could not be saved."); }
            }}>Save as…</button>
            {customTemplates.some((t) => t.id === templateId) ? <button type="button" className="loop-btn" onClick={() => {
              if (!window.confirm("Delete this saved template?")) return;
              try {
                deleteCustomTemplate(templateId);
                refreshTemplates();
                setTemplateId(BUILT_IN_TEMPLATES[0].id);
              } catch (e) { setNotice(e instanceof Error ? e.message : "The template could not be deleted."); }
            }}>Delete template</button> : null}
          </div>
          {customLoad.problem ? (
            <div className="loop-inline">
              <StatusBanner severity="error" message="Saved Loop recipes could not be read in full, so saving and deleting are refused to keep them. The old data is kept as a backup." />
              <button type="button" className="loop-btn" onClick={() => {
                if (!window.confirm("Reset custom templates? The stored recipes are kept as a backup in this app's storage, and the list starts empty.")) return;
                resetCustomTemplates();
                refreshTemplates();
                setTemplateId(BUILT_IN_TEMPLATES[0].id);
                setNotice("Custom templates reset. The old data is kept as a backup.");
              }}>Reset custom templates</button>
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
