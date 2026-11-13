// Stage execution for the native Loop runner: one stage, one repair, and the halt they raise. It is shared by the
// Loop screen and the factory run manager, so it closes over nothing: every host call, core call, file read and log
// line goes through the StageExecContext. Host commands the host scopes by run carry the run id, so a run keeps
// working in its own worktree after the user opens another project.
import type { FsApi } from "../../explorer/fs";
import type { CoreClient } from "../../shell/core";
import { agentRunSucceeded } from "../../autotasks/native/model.ts";
import { guardedAgentCall, type AgentWrites, type GuardedCallOutcome } from "./agent-call.ts";
import { evaluateArtifact } from "./artifact.ts";
import { runCodeGraph } from "./codegraph.ts";
import { FACTORY_INTAKE_SKILL, FACTORY_REPAIR_HINT, FACTORY_REVIEW_SKILL, REFACTOR_MOVE_SKILLS, agentRunBody, guardedPaths, isFactoryLoop, reviewDiffSection } from "./factory.ts";
import { importOnlyFiles } from "./import-only.ts";
import { registrySource, stagePromptText } from "./default-stage.ts";
import type { LoopDefinition, LoopStage } from "./model.ts";
import { checkWrites, isTestFileName } from "./protected.ts";
import { runRegression } from "./regression.ts";
import type { RunnerDeps, StageOutcome, StageRunResult } from "./runner.ts";
import { buildTestMap, detectTestStructure, ledgerDiff, parseTestResults, readLedger, writeLedger, writeTestMap, writeTestStructure } from "./testmap.ts";
import { scanTestPrune, writeTestPrune } from "./testprune.ts";
import { changedPathArgs, repoPrefixFor, stageHostArgs } from "./worktree-run.ts";

/** `invokeHost`'s shape; tests pass a fake. */
export type HostInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** The one core-client method stage execution uses. */
export type CoreFetch = Pick<CoreClient, "request">;
/** The `/kb/loop/agent-run` answer fields the Loop reads. */
export type AgentRunReply = AgentWrites & { reply?: string; ran?: boolean; unresolvedSkills?: string[]; resultSubtype?: string | null; usage?: { costUsd?: number } };

export interface StageExecContext {
  /** Absolute root of the project the run started in. */
  projectRoot: string;
  /** The worktree run's id, or null for a run in the main working tree (host calls then carry no runId). */
  runId: string | null;
  /** Absolute folder the stages work in: the run's worktree, else the Loop work root, else the project root. */
  runRoot: string;
  fs: FsApi;
  host: HostInvoke;
  core: CoreFetch;
  log(line: string): void;
  /** The host-minted approval token for a shell or fault-verify stage. */
  approvalToken(stage: LoopStage): Promise<string | null>;
  /** Aborts the run's in-flight agent call (Stop). */
  signal?: AbortSignal;
  isCancelled(): boolean;
  /** The host reported a shell stage as cancelled. */
  markCancelled(): void;
}

/** The halt one run raised. A reason ends the run; `isError` = a failed agent call with nothing out of scope. */
export interface HaltState { reason: string | null; isError: boolean }

type ShellRun = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled?: boolean };
type Prior = readonly StageOutcome[];

/** Paths with uncommitted changes before an agent call. `null` = the snapshot failed, so nothing may be reverted. */
async function dirtyBefore(ctx: StageExecContext): Promise<Set<string> | null> {
  try { return new Set(await ctx.host<string[]>("loop_changed_paths", changedPathArgs(ctx.runId, ctx.projectRoot))); } catch { return null; }
}

/** Paths git reports as changed right now; null when git cannot say (the post-throw check needs this). */
async function changedPathsNow(ctx: StageExecContext): Promise<string[] | null> {
  try { return await ctx.host<string[]>("loop_changed_paths", changedPathArgs(ctx.runId, ctx.projectRoot)); } catch { return null; }
}

/** Protected-path and scope guard for one agent call (the Mac's checkScope + policy). */
function guardProtected(ctx: StageExecContext, paths: readonly string[], target: LoopDefinition, before: ReadonlySet<string> | null, created: readonly string[] = []): Promise<string | null> {
  return checkWrites(
    paths,
    { policy: target.config.protectedPathPolicy, extraProtectedGlobs: target.config.extraProtectedGlobs, scopeGlobs: target.scopeGlobs },
    before,
    created,
    async (p, c) => { await ctx.host("loop_revert_paths", { paths: p, created: c, ...changedPathArgs(ctx.runId, ctx.projectRoot) }); },
    (line) => ctx.log(line),
  );
}

/**
 * The `- Files:` entries of the batch a stage works on. Refactor Apply works on the first `(status: todo)` batch; Conform
 * runs after Apply marked that batch done, so it works on the last `(status: done)` one (batches are applied in plan order,
 * so a later todo batch is never Conform's). A missing or unreadable plan names none.
 */
async function batchFileList(ctx: StageExecContext, which: "todo" | "done"): Promise<string[]> {
  const prefix = repoPrefixFor(ctx.projectRoot, ctx.runRoot);
  const planPath = prefix ? `${prefix}/llm-doc/loop/refactor/REFACTOR.md` : "llm-doc/loop/refactor/REFACTOR.md";
  let text: string | null;
  try {
    text = (await ctx.fs.read(planPath, 8_000_000)).text;
  } catch {
    return [];
  }
  if (typeof text !== "string") return [];
  const lines = text.split("\n");
  const heads = lines.flatMap((l, i) => (/^### R\d+\b/.test(l) ? [i] : []));
  const at = which === "todo"
    ? heads.find((i) => /\(status:\s*todo\)/.test(lines[i]))
    : heads.filter((i) => /\(status:\s*done\)/.test(lines[i])).pop();
  if (at === undefined) return [];
  let end = at + 1;
  while (end < lines.length && !lines[end].startsWith("### ")) end++;
  return lines.slice(at + 1, end).flatMap((l) => {
    const m = /^\s*-\s*Files:\s*(.*)$/.exec(l);
    return m ? m[1].replace(/`/g, "").split(/[\s,]+/).filter((f) => f !== "") : [];
  });
}

/**
 * Existing test files a refactor move changed only by import lines, read from the worktree diff. Worktree runs only; any
 * error or a truncated diff keeps none of them, so the guard judges (and reverts) them as before.
 */
async function importOnlyTests(ctx: StageExecContext, target: LoopDefinition, s: LoopStage, paths: readonly string[], created: readonly string[], allowed: readonly string[]): Promise<string[]> {
  if (ctx.runId === null || isFactoryLoop(target) || !s.skillId || !REFACTOR_MOVE_SKILLS.has(s.skillId)) return [];
  const candidates = paths.filter((p) => !created.includes(p) && isTestFileName(p));
  if (candidates.length === 0) return [];
  try {
    const d = await ctx.host<{ text?: unknown; truncated?: unknown }>("loop_worktree_diff", { runId: ctx.runId });
    if (d.truncated === true || typeof d.text !== "string") return [];
    const kept = importOnlyFiles(d.text, candidates, allowed);
    if (kept.length) ctx.log(`kept import-only test edits: ${kept.join(", ")}`);
    return kept;
  } catch {
    return [];
  }
}

/** The reason the run must stop after one agent call, or null when its writes were acceptable. */
function stopReason(g: { error: string | null; violation: string | null }): string | null {
  if (g.error !== null) return `the agent call failed (${g.error})${g.violation ? `; ${g.violation}` : ""}`;
  return g.violation;
}

/** A failed or violating agent call: halts the run unless the user already cancelled it. */
function haltOn(ctx: StageExecContext, halt: HaltState, violation: string | null, stop: string | null): StageRunResult {
  const output = stop ?? "the agent call failed";
  if (violation === null && ctx.isCancelled()) return { ok: false, output };
  halt.isError = violation === null;
  halt.reason = `${output}; the run stopped`;
  return { ok: false, output };
}

async function runShell(ctx: StageExecContext, s: LoopStage, target: LoopDefinition): Promise<StageRunResult> {
  const approvalToken = await ctx.approvalToken(s);
  const r = await ctx.host<ShellRun>("loop_run_stage", { stageId: s.id, loopId: target.id, approvalToken, timeoutSecs: s.timeoutSeconds, ...stageHostArgs(ctx.runId) });
  if (r.cancelled) ctx.markCancelled();
  return { ok: !r.timedOut && !r.cancelled && r.exitCode === 0, output: r.cancelled ? "Stage cancelled." : [r.stdout, r.stderr].filter(Boolean).join("\n") };
}

async function runRegressionStage(ctx: StageExecContext, s: LoopStage, prefix: string): Promise<StageRunResult> {
  const approvalToken = await ctx.approvalToken(s);
  const faultsRoot = prefix ? `${prefix}/system/faults` : "system/faults";
  const r = await runRegression(ctx.fs, faultsRoot, {
    async verify(f) {
      const v = await ctx.host<ShellRun>("loop_run_fault_verify", { rel: f.rel, approvalToken, timeoutSecs: s.timeoutSeconds });
      return { ok: !v.timedOut && v.exitCode === 0, output: [v.stdout, v.stderr].filter(Boolean).join("\n") };
    },
    async ask(prompt) {
      const a = await ctx.core.request<{ reply?: string }>("/kb/complete", { method: "POST", body: { prompt } });
      return a.reply ?? "";
    },
    async judge(saved, fresh) {
      const prompt = ["Compare two answers about a software fault.", "Are they the same meaning for the fault and its fix? Reply with JSON only: {\"same\":true} or {\"same\":false}.", `Saved answer:\n${saved.slice(0, 12_000)}`, `Fresh answer:\n${fresh.slice(0, 12_000)}`].join("\n\n");
      const j = await ctx.core.request<{ reply?: string }>("/kb/complete", { method: "POST", body: { prompt } });
      const m = /\{[\s\S]*?\}/.exec(j.reply ?? "");
      if (!m) return false;
      try { return (JSON.parse(m[0]) as { same?: unknown }).same === true; } catch { return false; }
    },
  });
  return { ok: r.passed, output: r.checked === 0 ? "No fixed faults to re-check." : [...r.notes, ...r.failures].join("\n") };
}

/** A `.factory/` report path a stage must write, else null. Only these are cleared before the stage runs. */
function factoryReportPath(s: LoopStage): string | null {
  return s.outputPath && s.outputPath.startsWith(".factory/") ? s.outputPath : null;
}

const normaliseRel = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** The report is written only when the agent run itself reports the path (a stale file must never decide a gate). */
function wroteReport(r: AgentRunReply, path: string): boolean {
  const want = normaliseRel(path);
  return [...(r.changedPaths ?? []), ...(r.createdPaths ?? [])].some((p) => normaliseRel(p) === want);
}

async function runSkill(ctx: StageExecContext, s: LoopStage, target: LoopDefinition, halt: HaltState): Promise<StageRunResult> {
  if (!s.skillId) return { ok: false, output: "This skill stage has no skill id." };
  const report = factoryReportPath(s);
  if (report) {
    // Host side and run scoped: a send-back or resume reuses the worktree, so an earlier PASSED report would still end
    // in the gate's exact verdict line. Remove it before the agent call; the stage fails if the agent does not rewrite it.
    try {
      await ctx.host("loop_clear_factory_output", { path: report, ...stageHostArgs(ctx.runId) });
    } catch (e) {
      return { ok: false, output: `the old report could not be cleared before the stage (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  // A built-in stage that is still unedited runs the registry prompt, the same text the editor shows.
  const parts = [stagePromptText(s, registrySource(s))?.trim() || `Run the ${s.name} skill for this loop.`];
  if (target.goal) parts.push(`Loop goal: ${target.goal}`);
  if (target.acceptanceCriteria) parts.push(`Acceptance criteria: ${target.acceptanceCriteria}`);
  if (s.targetPath) parts.push(`Target path: ${s.targetPath}`);
  if (s.outputPath) parts.push(`Output path: ${s.outputPath}`);
  // The Review stage reviews the worktree diff, which the agent cannot run git to read (Phase A Task 9, 6f).
  if (ctx.runId !== null && s.skillId === FACTORY_REVIEW_SKILL) {
    try {
      const d = await ctx.host<{ text?: unknown; truncated?: unknown }>("loop_worktree_diff", { runId: ctx.runId });
      parts.push(reviewDiffSection({ text: typeof d.text === "string" ? d.text : "", truncated: d.truncated === true }));
    } catch (e) {
      return { ok: false, output: `the worktree diff could not be read for the review (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  const before = await dirtyBefore(ctx);
  // The batch's file list as planned, read BEFORE the agent runs: apply edits the plan itself (it marks the batch done),
  // so a list read afterwards could name a module the agent added to it.
  const moves = ctx.runId !== null && !isFactoryLoop(target) && s.skillId !== null && REFACTOR_MOVE_SKILLS.has(s.skillId);
  const plannedFiles = moves ? await batchFileList(ctx, s.skillId === "skills/refactor-apply" ? "todo" : "done") : [];
  // Only Intake also reads the project's llm-doc/ (a split layout keeps it outside the run's worktree).
  const llmDocExists = s.skillId === FACTORY_INTAKE_SKILL && ctx.projectRoot ? await ctx.fs.list("llm-doc").then(() => true, () => false) : false;
  const g = await guardedAgentCall<AgentRunReply>({
    before,
    call: () => ctx.core.request<AgentRunReply>("/kb/loop/agent-run", {
      method: "POST", body: agentRunBody({ message: parts.join("\n\n"), stage: s, repoRoot: ctx.runRoot, timeoutMs: (s.timeoutSeconds ?? 1800) * 1000, projectRoot: ctx.projectRoot, llmDocExists }),
      signal: ctx.signal,
    }),
    changedNow: () => changedPathsNow(ctx),
    check: async (paths, b, created) => guardProtected(ctx, guardedPaths(target, s, paths, created, await importOnlyTests(ctx, target, s, paths, created, plannedFiles)), target, b, created),
  });
  const stop = stopReason(g);
  if (g.result === null || stop !== null) return haltOn(ctx, halt, g.violation, stop);
  // A succeeded agent call that did not write its report is a failed stage, not a pass on the file just deleted.
  if (report && !wroteReport(g.result, report)) {
    return { ok: false, output: `the report was not written: ${report}. The stage failed instead of reading an older report.` };
  }
  return skillResult(g.result);
}

function skillResult(r: AgentRunReply): StageRunResult {
  const ok = agentRunSucceeded(r);
  const why = ok ? [] : r.unresolvedSkills?.length ? ["the skill could not be found, so it did not run"] : r.ran === false ? ["the skill did not run"] : [`the agent run did not finish (${r.resultSubtype ?? "no result"})`];
  return { ok, output: [...why, r.reply ?? "(no reply)", ...(r.changedPaths?.length ? [`changed: ${r.changedPaths.join(", ")}`] : []), ...(r.unresolvedSkills?.length ? [`unresolved skills: ${r.unresolvedSkills.join(", ")}`] : [])].join("\n"), ...(typeof r.usage?.costUsd === "number" ? { usage: { costUsd: r.usage.costUsd } } : {}) };
}

async function runLedger(ctx: StageExecContext, prior: Prior, prefix: string): Promise<StageRunResult> {
  const lastTest = [...prior].reverse().find((o) => o.stage.kind === "shellCommand" && /test/i.test(o.stage.name));
  if (!lastTest) return { ok: false, output: "the ledger stage needs a Test stage output earlier in this run" };
  const parsed = parseTestResults(lastTest.output);
  // Unparseable output is not a failing test run: the Test stage decides pass/fail, and a ledger with nothing in it would mislead.
  if (parsed.failing.length === 0 && parsed.passing.length === 0) return { ok: true, output: "no per-test results in the Test output (the Test stage itself decides pass/fail); the ledger was not updated" };
  const path = `${prefix ? `${prefix}/` : ""}system/loop/test/ledger.json`;
  const previous = await readLedger(ctx.fs, path);
  const diff = ledgerDiff(previous, parsed, lastTest.ok);
  const ledger = { runId: crypto.randomUUID(), recordedAt: new Date().toISOString(), failing: parsed.failing, passing: parsed.passing };
  await writeLedger(ctx.fs, path, ledger);
  return { ok: true, output: [`${ledger.failing.length} failing · ${ledger.passing.length} passing`, `new failures: ${diff.newFailures.length ? diff.newFailures.join(", ") : "none"}`, `still failing: ${diff.stillFailing.length ? diff.stillFailing.join(", ") : "none"}`, `fixed: ${diff.fixed.length ? diff.fixed.join(", ") : "none"}`, `wrote ${path}`].join("\n") };
}

async function runTestMap(ctx: StageExecContext, s: LoopStage, prefix: string): Promise<StageRunResult> {
  if (s.testOp !== "structure" && s.testOp !== "map") return { ok: false, output: `testMap ${s.testOp ?? "operation"} is not ported yet` };
  const structure = await detectTestStructure(ctx.fs, prefix);
  if (s.testOp === "structure") {
    const writes = await writeTestStructure(ctx.fs, prefix, structure);
    return { ok: structure.status === "ok", output: [`${structure.roots.length} test root(s)`, ...structure.roots.map((r) => `${r.packageDir || "."}: ${r.runner} · ${r.command}`), ...structure.notes, `wrote ${writes.md} and ${writes.json}`].join("\n") };
  }
  // graph_generate("code") writes this file; a missing or non-graph file falls back to file matching.
  const map = await buildTestMap(ctx.fs, prefix, structure, graphPathFor(ctx.runId));
  const writes = await writeTestMap(ctx.fs, prefix, map);
  return { ok: true, output: [`${map.entries.length} function(s) · ${map.untestedFunctions} untested · ${map.testedFunctions} tested`, `wrote ${writes.md} and ${writes.json}`].join("\n") };
}

async function runTestPruneStage(ctx: StageExecContext, prefix: string): Promise<StageRunResult> {
  const structure = await detectTestStructure(ctx.fs, prefix);
  const findings = await scanTestPrune(ctx.fs, prefix, structure);
  const path = await writeTestPrune(ctx.fs, prefix, findings);
  return { ok: true, output: `${findings.length} finding(s); report only at ${path}` };
}

/** A worktree run's graph folder, so its graph never touches the project's main graph or the MR diff; null = the project's. */
const runGraphOut = (runId: string | null): string | null => (runId !== null ? `system/loop-runs/${runId}/graph` : null);
/** The code graph a stage reads: the run's own snapshot in a worktree run, else the project's. */
const graphPathFor = (runId: string | null): string => `${runGraphOut(runId) ?? "system/graph"}/graph-code.json`;

async function runGraph(ctx: StageExecContext, s: LoopStage, prefix: string): Promise<StageRunResult> {
  if (s.graphOp !== "snapshot" && s.graphOp !== "verify") return { ok: false, output: "this graph stage has no operation chosen" };
  const out = runGraphOut(ctx.runId);
  const graphPath = graphPathFor(ctx.runId);
  const before = out ? `${out}/before.json` : `${prefix ? `${prefix}/` : ""}system/loop/refactor/graph/before.json`;
  const r = await runCodeGraph(ctx.fs, s.graphOp, graphPath, before, async () => {
    await ctx.host("graph_generate", { mode: "code", target: prefix || undefined, ...(out ? { out } : {}) });
  });
  return { ok: r.passed, output: r.output };
}

async function runArtifact(ctx: StageExecContext, s: LoopStage, target: LoopDefinition, prefix: string): Promise<StageRunResult> {
  if (!s.check) return { ok: false, output: "This artifact stage has no check configuration." };
  // A worktree run must not accept a stale file from the main tree, so the project-root fallback is off there.
  const check = ctx.runId !== null ? { ...s.check, projectRootFallback: false } : s.check;
  const r = await evaluateArtifact(ctx.fs, check, target.config.stages, { repoPrefix: prefix, projectPrefix: "" });
  return { ok: r.passed, output: r.passed ? "Artifact check passed." : r.failures.join("\n") };
}

/** Runs one stage once, without the run log wrapper (the screen's "Run stage" button uses it directly). */
export async function runOneStage(ctx: StageExecContext, s: LoopStage, target: LoopDefinition, prior: Prior, halt: HaltState): Promise<StageRunResult> {
  const prefix = repoPrefixFor(ctx.projectRoot, ctx.runRoot);
  if (s.kind === "shellCommand") return runShell(ctx, s, target);
  if (s.kind === "regressionSweep") return runRegressionStage(ctx, s, prefix);
  if (s.kind === "skill") return runSkill(ctx, s, target, halt);
  if (s.kind === "testMap" && s.testOp === "ledger") return runLedger(ctx, prior, prefix);
  if (s.kind === "testMap") return runTestMap(ctx, s, prefix);
  if (s.kind === "testPrune") return runTestPruneStage(ctx, prefix);
  if (s.kind === "codeGraph") return runGraph(ctx, s, prefix);
  if (s.kind === "artifactCheck") return runArtifact(ctx, s, target, prefix);
  throw new Error(`“${s.name}” is a ${s.kind} stage; this native runner executes shell, empty Regression, skill and artifact-check stages`);
}

async function repairStage(ctx: StageExecContext, s: LoopStage, output: string, attempt: number, target: LoopDefinition, halt: HaltState): Promise<StageRunResult> {
  const message = [`Fix the failing Loop stage “${s.name}” in this repository.`, `Attempt ${attempt}.`, `Stage output:\n${output.slice(0, 12_000)}`];
  if (target.goal) message.push(`Loop goal: ${target.goal}`);
  if (target.acceptanceCriteria) message.push(`Acceptance criteria: ${target.acceptanceCriteria}`);
  if (isFactoryLoop(target)) message.push(FACTORY_REPAIR_HINT);
  const before = await dirtyBefore(ctx);
  const g: GuardedCallOutcome<AgentRunReply> = await guardedAgentCall<AgentRunReply>({
    before,
    call: () => ctx.core.request<AgentRunReply>("/kb/loop/agent-run", {
      method: "POST", body: { message: message.join("\n\n"), skills: [], repoRoot: ctx.runRoot, timeoutMs: 30 * 60 * 1000, model: target.config.repairModel ?? undefined, ...(isFactoryLoop(target) ? { denyWrite: ".factory" as const } : {}) },
      signal: ctx.signal,
    }),
    changedNow: () => changedPathsNow(ctx),
    // A repair gets no Implement exemption (stage = null): it can never edit the verifier.
    check: (paths, b, created) => guardProtected(ctx, guardedPaths(target, null, paths, created), target, b, created),
  });
  const r: AgentRunReply = g.result ?? {};
  for (const line of [`↻ repair ${s.name}`, r.reply ?? (g.error !== null ? `(agent call failed: ${g.error})` : "(no reply)"), ...(g.writes.length ? [`changed: ${g.writes.join(", ")}`] : []), ""]) ctx.log(line);
  const stop = stopReason(g);
  if (g.result === null || stop !== null) return haltOn(ctx, halt, g.violation, stop);
  return { ok: agentRunSucceeded(g.result), output: g.result.reply ?? "", ...(typeof g.result.usage?.costUsd === "number" ? { usage: { costUsd: g.result.usage.costUsd } } : {}) };
}

/** The runner deps that execute stages for one run. Each call has its own halt state. */
export function createStageDeps(ctx: StageExecContext, loop: LoopDefinition): Pick<RunnerDeps, "runStage" | "repair" | "halt" | "haltIsError"> {
  const halt: HaltState = { reason: null, isError: false };
  return {
    async runStage(s, prior) {
      let r: StageRunResult;
      try {
        r = await runOneStage(ctx, s, loop, prior, halt);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        r = { ok: false, output: `${s.name} failed: ${message}` };
        // An infrastructure throw is not a verdict on the code: end the run as an error, before any repair agent is paid.
        if (!halt.reason) { halt.reason = `${s.name} failed: ${message}; the run stopped`; halt.isError = true; }
      }
      ctx.log(`$ ${s.name}`);
      ctx.log(r.output);
      ctx.log("");
      return r;
    },
    repair: (s, output, attempt) => repairStage(ctx, s, output, attempt, loop, halt),
    halt: () => halt.reason,
    haltIsError: () => halt.isError,
  };
}
