// Native Loop screen, first port slice: the Mac three-pane structure over the committed system/loop.json.
// Editing/runner arrive next; every field shown here comes from the file, never from the bridge.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SectionProps } from "@llmide/screens/shell";
import { createHostFs } from "../../explorer/fs";
import { StatusBanner } from "@llmide/ui-kit";
import { invokeHost } from "../../shell/host";
import { core } from "../../shell/runtime";
import { isManualOnly, loadLoops, primaryLoop, saveLoops, type LoopLoad } from "./store.ts";
import type { LoopDefinition, LoopProjectStore, LoopStage } from "./model.ts";
import { BUILT_IN_TEMPLATES, applyTemplate, deleteCustomTemplate, initialProjectStore, loadCustomTemplates, saveCustomTemplate } from "./templates.ts";
import { detectTestCommand } from "./environment.ts";
import { runNativeLoop } from "./runner.ts";
import { evaluateArtifact } from "./artifact.ts";
import { approve, isApproved } from "./approvals.ts";
import { reopenFault, runRegression } from "./regression.ts";
import { runCodeGraph } from "./codegraph.ts";
import { scanTestPrune, writeTestPrune } from "./testprune.ts";
import { buildTestMap, detectTestStructure, ledgerDiff, parseTestResults, readLedger, writeLedger, writeTestMap, writeTestStructure } from "./testmap.ts";
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
  const [envVersions, setEnvVersions] = useState<{ python: string | null; node: string | null; git: string | null } | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runningStage, setRunningStage] = useState(false);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const queueRef = useRef<LoopDefinition[]>([]);
  const [queued, setQueued] = useState(0);
  const [runs, setRuns] = useState<LoopRunIndexEntry[]>([]);
  const [workRoot, setWorkRoot] = useState<string | null>(null);
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
    if (!projectRoot) { setWorkRoot(null); return; }
    let live = true;
    void invokeHost<string>("loop_work_root").then((p) => { if (live) setWorkRoot(p); }).catch(() => { if (live) setWorkRoot(null); });
    return () => { live = false; };
  }, [projectRoot]);

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
      const r = await core.request<{ reply?: string; changedPaths?: string[]; unresolvedSkills?: string[]; resultSubtype?: string }>("/kb/loop/agent-run", {
        method: "POST", body: { message: parts.join("\n\n"), skills: [s.skillId], repoRoot: workRoot ?? projectRoot, timeoutMs: (s.timeoutSeconds ?? 1800) * 1000 },
      });
      return { ok: r.resultSubtype === "success" || (r.resultSubtype == null && typeof r.reply === "string"), output: [r.reply ?? "(no reply)", ...(r.changedPaths?.length ? [`changed: ${r.changedPaths.join(", ")}`] : []), ...(r.unresolvedSkills?.length ? [`unresolved skills: ${r.unresolvedSkills.join(", ")}`] : [])].join("\n") };
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

  const ensureApprovals = (target: LoopDefinition): string | null => {
    const root = workRoot ?? projectRoot ?? "";
    for (const s of target.config.stages) {
      if (!s.enabled || s.kind !== "shellCommand" || !s.command) continue;
      if (isApproved(root, s.command)) continue;
      if (!window.confirm(`Approve this command for ${target.name}?\n\n${s.command}`)) return `“${s.name}” needs command approval before it can run.`;
      approve(root, s.command);
    }
    return null;
  };

  const stopRun = () => {
    cancelledRef.current = true;
    void invokeHost("loop_cancel").catch(() => undefined);
    setNotice("Stopping the current stage; the loop will end after it returns.");
  };

  const executeLoop = async (target: LoopDefinition) => {
    if (dirty) return;
    const unsupported = target.config.stages.find((s) => s.enabled && !(["shellCommand", "regressionSweep", "skill", "artifactCheck", "codeGraph", "testPrune"].includes(s.kind) || (s.kind === "testMap" && (s.testOp === "structure" || s.testOp === "map" || s.testOp === "ledger"))));
    if (unsupported) { setNotice(`“${unsupported.name}” is a ${unsupported.kind} stage; it cannot run yet.`); return; }
    const approval = ensureApprovals(target);
    if (approval) { setNotice(approval); return; }
    if (!window.confirm(`Run “${target.name}”?\n\nIt will iterate up to ${target.config.maxIterations} time(s), repair blocking failures up to ${target.config.maxRepairsPerStage} per stage, and stop after ${target.config.consecutiveFailureStop} non-improving failures.`)) return;
    runningRef.current = true;
    cancelledRef.current = false;
    setRunningStage(true);
    setRunLog((l) => [...l, `▶ ${target.name}`, ""]);
    const started = Date.now();
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
          const r = await core.request<{ reply?: string; changedPaths?: string[]; resultSubtype?: string }>("/kb/loop/agent-run", {
            method: "POST", body: { message: message.join("\n\n"), repoRoot: workRoot ?? projectRoot, timeoutMs: 30 * 60 * 1000 },
          });
          setRunLog((l) => [...l, `↻ repair ${s.name}`, r.reply ?? "(no reply)", ...(r.changedPaths?.length ? [`changed: ${r.changedPaths.join(", ")}`] : []), ""]);
          return { ok: r.resultSubtype === "success" || (r.resultSubtype == null && typeof r.reply === "string"), output: r.reply ?? "" };
        },
        log(line) { setRunLog((l) => [...l, line]); },
      });
      setRunLog((l) => [...l, outcome.passed ? "Loop passed." : `Loop failed: ${outcome.statusSummary}`]);
      if (!outcome.passed && outcome.failedStage?.kind === "regressionSweep") {
        const failedRun = [...outcome.stages].reverse().find((o) => o.stage.kind === "regressionSweep" && !o.ok);
        const faultPaths = [...new Set(Array.from(failedRun?.output.matchAll(/^([^\n:]+\\.md):/gm) ?? [], (m) => m[1].trim()))];
        let reopened = 0;
        for (const rel of faultPaths) if (await reopenFault(fs, rel)) reopened += 1;
        if (reopened > 0) setRunLog((l) => [...l, `reopened ${reopened} fixed fault(s).`]);
      }
      setNotice(outcome.passed ? "The loop passed." : outcome.statusSummary);
      const startedAt = new Date(started).toISOString();
      const entry: LoopRunIndexEntry = { id: crypto.randomUUID(), loopId: target.id, loopName: target.name, startedAt, durationSeconds: (Date.now() - started) / 1000, iterationsUsed: outcome.iterationsUsed, statusCode: outcome.passed ? "success" : "failed", statusSummary: outcome.statusSummary, trigger: "manual" };
      const recordStages = outcome.stages.map((o) => ({ stageName: o.stage.name, severity: o.stage.severity, run: { exitCode: o.ok ? 0 : 1, stdout: o.output, stderr: "", timedOut: false, durationMs: 0 } }));
      void appendRunRecord(fs, entry, { ...entry, endedAt: new Date().toISOString(), gitRoot: workRoot ?? projectRoot, config: target.config, stages: recordStages }).then(() => readRecentRuns(fs)).then(setRuns).catch(() => undefined);
    } catch (e) {
      setRunLog((l) => [...l, e instanceof Error ? e.message : String(e)]);
      setNotice(e instanceof Error ? e.message : "The loop could not run.");
    } finally {
      runningRef.current = false;
      setRunningStage(false);
      const next = queueRef.current.shift();
      setQueued(queueRef.current.length);
      if (next) window.setTimeout(() => void executeLoop(next), 0);
    }
  };

  const runLoop = (target: LoopDefinition | null = loop) => {
    if (!target) return;
    if (runningRef.current) {
      if (!queueRef.current.some((l) => l.id === target.id)) queueRef.current.push(target);
      setQueued(queueRef.current.length);
      setNotice(`Queued “${target.name}”.`);
      return;
    }
    void executeLoop(target);
  };

  const runSelectedStage = async () => {
    if (!loop || !stage || dirty || runningStage) return;
    if (!(["shellCommand", "regressionSweep", "skill", "artifactCheck", "codeGraph", "testPrune"].includes(stage.kind) || (stage.kind === "testMap" && (stage.testOp === "structure" || stage.testOp === "map" || stage.testOp === "ledger")))) { setNotice("This stage kind cannot run in the native runner yet."); return; }
    if (stage.kind === "shellCommand" && !stage.command) { setNotice("This stage has no command yet."); return; }
    if (stage.kind === "skill" && !stage.skillId) { setNotice("This skill stage has no skill id."); return; }
    if (stage.kind === "shellCommand" && stage.command && !isApproved(workRoot ?? projectRoot ?? "", stage.command)) {
      if (!window.confirm(`Approve this command?\n\n${stage.command}`)) return;
      approve(workRoot ?? projectRoot ?? "", stage.command);
    }
    const label = stage.command ?? (stage.kind === "skill" ? `skill ${stage.skillId}` : stage.kind === "artifactCheck" ? "artifact check" : "Regression sweep");
    if (!window.confirm(`Run this stage?\n\n${stage.name}: ${label}`)) return;
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
        const store = initialProjectStore(env.command);
        const r = await saveLoops(fs, store, null);
        setLoad({ kind: "ok", store, hash: r.hash });
        setSelectedLoopId(store.loops[0].id);
        setSelectedStageId(store.loops[0].config.stages[0]?.id ?? null);
        setNotice("Created the default loops from this project's detected test command.");
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "The default loops could not be created.");
      } finally { setSaving(false); }
    };
    return <div className="loop-native-empty"><h1>No Loop configuration</h1><p>This project has no <code>system/loop.json</code> yet. Create the native starter loops here; no Mac app is needed.</p><button type="button" className="loop-btn loop-btn-primary" disabled={saving} onClick={() => void create()}>{saving ? "Creating…" : "Create default loops"}</button>{notice ? <p className="loop-native-hint">{notice}</p> : null}</div>;
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
          <button type="button" className="loop-btn" onClick={() => moveStage(-1)} disabled={!stage || loop.config.stages[0]?.id === stage.id}>↑</button>
          <button type="button" className="loop-btn" onClick={() => moveStage(1)} disabled={!stage || loop.config.stages[loop.config.stages.length - 1]?.id === stage.id}>↓</button>
          <button type="button" className="loop-btn" onClick={() => void runSelectedStage()}  disabled={!stage || dirty || runningStage || !(["shellCommand", "regressionSweep", "skill", "artifactCheck", "codeGraph", "testPrune"].includes(stage.kind) || (stage.kind === "testMap" && (stage.testOp === "structure" || stage.testOp === "map" || stage.testOp === "ledger"))) || (stage.kind === "shellCommand" && !stage.command) || (stage.kind === "skill" && !stage.skillId)}>Run stage</button>
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
        <div className="loop-run-tabs"><span className="loop-run-tab" data-on="true">Run</span><span className="loop-spacer" />{runningStage ? <button type="button" className="loop-btn" onClick={stopRun}>■ Stop</button> : null}<button type="button" className="loop-btn loop-run-btn" disabled={dirty} title={dirty ? "Save the Loop first" : runningStage ? "Queue another run" : "Run the loop"} onClick={() => runLoop()}>{runningStage ? (queued > 0 ? `Queued ${queued}` : "Running… · Queue") : "▶ Run"}</button></div>
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
            <dt>Runs in</dt><dd>{workRoot ?? projectRoot}</dd>
            <dt>Project root</dt><dd>{projectRoot}</dd>
            <dt>Bounded by</dt><dd>{loop.config.maxIterations} iterations · {loop.config.wallClockBudgetSeconds ? `${loop.config.wallClockBudgetSeconds}s time limit` : "no time limit"} · stop after {loop.config.consecutiveFailureStop} non-improving · {loop.config.maxRepairsPerStage} repairs/stage</dd>
            <dt>Scheduled</dt><dd>{loop.runsOnSchedule ? "included in the scheduled Loop Engineering run" : "no — run it from here"}</dd>
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
            <label className="loop-field"><span>Repair model (empty = default)</span><input value={loop.config.repairModel ?? ""} onChange={(e) => patchLoop((l) => { l.config.repairModel = e.target.value || null; })} /></label>
            <label className="loop-field"><span>Protected path policy</span><select value={loop.config.protectedPathPolicy} onChange={(e) => patchLoop((l) => { l.config.protectedPathPolicy = e.target.value as "revert" | "commit" | "ignore"; })}><option value="revert">Revert offending edits</option><option value="commit">Commit offending edits</option><option value="ignore">Ignore</option></select></label>
            <label className="loop-check"><input type="checkbox" checked={loop.config.writeSummaryNote} onChange={(e) => patchLoop((l) => { l.config.writeSummaryNote = e.target.checked; })} /> Write a run-summary note into the Library</label>
            <label className="loop-check"><input type="checkbox" checked={loop.config.openMergeRequest} onChange={(e) => patchLoop((l) => { l.config.openMergeRequest = e.target.checked; })} /> Open a merge request after a successful run</label>
            <label className="loop-check"><input type="checkbox" checked={loop.config.useWorktreesForConcurrentRuns} onChange={(e) => patchLoop((l) => { l.config.useWorktreesForConcurrentRuns = e.target.checked; })} /> Use an isolated worktree when another run holds the repo</label>
            <label className="loop-check"><input type="checkbox" checked={loop.config.alwaysUseWorktree} onChange={(e) => patchLoop((l) => { l.config.alwaysUseWorktree = e.target.checked; })} /> Always run in an isolated worktree</label>
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
              <div className="loop-inline"><label className="loop-check"><input type="checkbox" checked={stage.enabled} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.enabled = e.target.checked; })} /> Enabled</label><label className="loop-field"><span>Severity</span><select value={stage.severity} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.severity = e.target.value as "blocking" | "advisory"; })}><option value="blocking">Blocking</option><option value="advisory">Advisory</option></select></label><label className="loop-check"><input type="checkbox" checked={stage.allowsRepair} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.allowsRepair = e.target.checked; })} /> Allows repair</label></div>
              <label className="loop-field"><span>Kind</span><select value={stage.kind} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.kind = e.target.value as LoopStage["kind"]; })}>
                {Object.entries(stageKindLabel).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select></label>
              {stage.kind === "shellCommand" ? <label className="loop-field"><span>Command</span><input value={stage.command ?? ""} placeholder="npm test" onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.command = e.target.value; })} /></label> : null}
              {stage.kind === "skill" ? <>
                <label className="loop-field"><span>Skill id</span><input value={stage.skillId ?? ""} placeholder="family/skill" onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.skillId = e.target.value || null; })} /></label>
                <label className="loop-field"><span>Target path (optional)</span><input value={stage.targetPath ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.targetPath = e.target.value || null; })} /></label>
                <label className="loop-field"><span>Output path (optional)</span><input value={stage.outputPath ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.outputPath = e.target.value || null; })} /></label>
                <label className="loop-field"><span>Prompt (optional)</span><textarea rows={3} value={stage.prompt ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.prompt = e.target.value || null; })} /></label>
              </> : null}
              {stage.kind === "testMap" ? <label className="loop-field"><span>Test map operation</span><select value={stage.testOp ?? "structure"} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.testOp = e.target.value as "structure" | "map" | "ledger"; })}><option value="structure">Structure</option><option value="map">Map</option><option value="ledger">Ledger</option></select></label> : null}
              {stage.kind === "codeGraph" ? <label className="loop-field"><span>Code graph operation</span><select value={stage.graphOp ?? "snapshot"} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.graphOp = e.target.value as "snapshot" | "verify"; })}><option value="snapshot">Snapshot</option><option value="verify">Verify</option></select></label> : null}
              <label className="loop-field"><span>Timeout (seconds, empty = runner default)</span><input type="number" min={0} value={stage.timeoutSeconds ?? ""} onChange={(e) => patchLoop((l) => { const s = l.config.stages.find((x) => x.id === stage.id); if (s) s.timeoutSeconds = e.target.value === "" ? null : Math.max(0, Number(e.target.value)); })} /></label>
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
            {runRecord && Array.isArray(runRecord.iterations) && runRecord.iterations.length > 0 ? (
              <div className="loop-past-iterations">
                {runRecord.iterations.map((it, i) => { const o = (it ?? {}) as Record<string, unknown>; const stages = Array.isArray(o.stages) ? o.stages : []; return <div key={i}><h4>Iteration {String(o.index ?? i + 1)}</h4>{stages.map((st, j) => { const x = (st ?? {}) as Record<string, unknown>; return <p key={j} className="loop-native-hint">{x.passed === true ? "✓" : "✗"} {String(x.stageName ?? "Stage")}</p>; })}{o.repair ? <p className="loop-native-hint">repair {String((o.repair as Record<string, unknown>).ok) === "true" ? "completed" : "failed"}</p> : null}</div>; })}
              </div>
            ) : null}
          </div>
        ) : runLog.length === 0 ? <p className="loop-native-hint">No runs yet.</p> : <pre className="loop-run-log">{runLog.join("\n")}</pre>}
      </aside>
    </div>
  );
}
