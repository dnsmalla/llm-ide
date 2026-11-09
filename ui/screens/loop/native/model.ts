// Loop's persisted contract, mirroring the frozen Swift LoopEngineProjectStore/LoopDefinition/LoopStage/
// LoopEngineConfig. This module is deliberately tolerant: loop.json is committed and older/newer builds must not
// destroy each other's fields. Every field added after the first schema decodes with a default, and an unknown
// stage kind is kept as "unsupported" rather than failing the whole file.

export const LOOP_SCHEMA_VERSION = 2;
export type LoopStageSeverity = "blocking" | "advisory";
export type LoopStageKind =
  | "regressionSweep" | "shellCommand" | "skill" | "artifactCheck" | "testMap" | "testPrune"
  | "incidentTriage" | "codeGraph" | "sdkSurfaceDiff" | "unsupported";

/** Stage kinds the native runner executes; testMap is runnable only for the operations listed below. */
const NATIVE_RUNNABLE_KINDS: ReadonlySet<LoopStageKind> = new Set(["shellCommand", "regressionSweep", "skill", "artifactCheck", "codeGraph", "testPrune"]);
const NATIVE_TEST_OPS: ReadonlySet<string> = new Set(["structure", "map", "ledger"]);

/** The one place that says whether the desktop's native runner can run a stage (run guard, Run stage, button). */
export function isNativeRunnable(stage: Pick<LoopStage, "kind" | "testOp">): boolean {
  return NATIVE_RUNNABLE_KINDS.has(stage.kind) || (stage.kind === "testMap" && stage.testOp !== null && NATIVE_TEST_OPS.has(stage.testOp));
}

export interface LoopStage {
  id: string;
  name: string;
  kind: LoopStageKind;
  command: string | null;
  order: number;
  skillId: string | null;
  targetPath: string | null;
  outputPath: string | null;
  prompt: string | null;
  isDefault: boolean;
  enabled: boolean;
  defaultKey: string | null;
  severity: LoopStageSeverity;
  timeoutSeconds: number | null;
  detectedCommand: string | null;
  check: Record<string, unknown> | null;
  testOp: "structure" | "map" | "ledger" | null;
  graphOp: "snapshot" | "verify" | null;
  allowsRepair: boolean;
  /** Skip this stage in later iterations of the same run once it has passed in that run. Default false. */
  runOnce: boolean;
  defaultRevision: number | null;
  disabledByDetection: boolean | null;
  /** Original object for an unknown kind, so saving does not destroy a newer build's fields. */
  raw: Record<string, unknown> | null;
}

export interface LoopEngineConfig {
  stages: LoopStage[];
  maxIterations: number;
  consecutiveFailureStop: number;
  wallClockBudgetSeconds: number | null;
  pauseTimeoutSeconds: number;
  maxRepairsPerStage: number;
  repairModel: string | null;
  protectedPathPolicy: "revert" | "stop" | "warn" | "off";
  writeSummaryNote: boolean;
  extraProtectedGlobs: string[];
  useWorktreesForConcurrentRuns: boolean;
  alwaysUseWorktree: boolean;
  openMergeRequest: boolean;
  refactorBatchesPerRun: number | null;
}

export interface LoopDefinition {
  id: string;
  name: string;
  isPrimary: boolean;
  goal: string | null;
  acceptanceCriteria: string | null;
  scopeGlobs: string[];
  defaultKey: string | null;
  runsOnSchedule: boolean;
  config: LoopEngineConfig;
}

export interface LoopProjectStore {
  schemaVersion: number;
  loops: LoopDefinition[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const KINDS = new Set<LoopStageKind>(["regressionSweep", "shellCommand", "skill", "artifactCheck", "testMap", "testPrune", "incidentTriage", "codeGraph", "sdkSurfaceDiff", "unsupported"]);

export function decodeStage(v: unknown): LoopStage | null {
  if (!isObj(v) || typeof v.name !== "string") return null;
  const kind = (typeof v.kind === "string" && KINDS.has(v.kind as LoopStageKind) ? v.kind : "unsupported") as LoopStageKind;
  const severity = v.severity === "advisory" ? "advisory" : "blocking";
  return {
    id: str(v.id) ?? crypto.randomUUID(),
    name: v.name,
    kind,
    command: str(v.command),
    order: num(v.order) ?? 0,
    skillId: str(v.skillId),
    targetPath: str(v.targetPath),
    outputPath: str(v.outputPath),
    prompt: str(v.prompt),
    isDefault: bool(v.isDefault, false),
    enabled: bool(v.enabled, true),
    defaultKey: str(v.defaultKey),
    severity,
    timeoutSeconds: num(v.timeoutSeconds),
    detectedCommand: str(v.detectedCommand),
    check: isObj(v.check) ? v.check : null,
    testOp: v.testOp === "structure" || v.testOp === "map" || v.testOp === "ledger" ? v.testOp : null,
    graphOp: v.graphOp === "snapshot" || v.graphOp === "verify" ? v.graphOp : null,
    allowsRepair: bool(v.allowsRepair, true),
    runOnce: bool(v.runOnce, false),
    defaultRevision: num(v.defaultRevision),
    disabledByDetection: typeof v.disabledByDetection === "boolean" ? v.disabledByDetection : null,
    raw: kind === "unsupported" ? v : null,
  };
}

export function decodeConfig(v: unknown): LoopEngineConfig {
  const o = isObj(v) ? v : {};
  const stages = Array.isArray(o.stages) ? o.stages.map(decodeStage).filter((s): s is LoopStage => s !== null) : [];
  const rawPolicy = o.protectedPathPolicy;
  const policy: LoopEngineConfig["protectedPathPolicy"] = rawPolicy === "stop" || rawPolicy === "warn" || rawPolicy === "off" ? rawPolicy
    : rawPolicy === "commit" ? "stop" : rawPolicy === "ignore" ? "off" : "revert";
  return {
    stages,
    maxIterations: num(o.maxIterations) ?? 10,
    consecutiveFailureStop: num(o.consecutiveFailureStop) ?? 2,
    wallClockBudgetSeconds: num(o.wallClockBudgetSeconds),
    pauseTimeoutSeconds: num(o.pauseTimeoutSeconds) ?? 1800,
    maxRepairsPerStage: num(o.maxRepairsPerStage) ?? 3,
    repairModel: str(o.repairModel),
    protectedPathPolicy: policy,
    writeSummaryNote: bool(o.writeSummaryNote, false),
    extraProtectedGlobs: strArray(o.extraProtectedGlobs),
    useWorktreesForConcurrentRuns: bool(o.useWorktreesForConcurrentRuns, false),
    alwaysUseWorktree: bool(o.alwaysUseWorktree, false),
    openMergeRequest: bool(o.openMergeRequest, true),
    refactorBatchesPerRun: num(o.refactorBatchesPerRun),
  };
}

export function decodeDefinition(v: unknown, version: number): LoopDefinition | null {
  if (!isObj(v) || typeof v.name !== "string") return null;
  const runs = typeof v.runsOnSchedule === "boolean" ? v.runsOnSchedule : version < 2;
  return {
    id: str(v.id) ?? crypto.randomUUID(),
    name: v.name,
    isPrimary: bool(v.isPrimary, false),
    goal: str(v.goal),
    acceptanceCriteria: str(v.acceptanceCriteria),
    scopeGlobs: strArray(v.scopeGlobs),
    defaultKey: str(v.defaultKey),
    runsOnSchedule: runs,
    config: decodeConfig(v.config),
  };
}

/** Current `{schemaVersion,loops}` schema, or the legacy bare config wrapped as the Primary "Main Loop". */
export function decodeProjectStore(v: unknown): LoopProjectStore | null {
  if (!isObj(v)) return null;
  const version = num(v.schemaVersion) ?? 1;
  if (Array.isArray(v.loops)) {
    const loops = v.loops.map((l) => decodeDefinition(l, version)).filter((l): l is LoopDefinition => l !== null);
    return { schemaVersion: Math.max(version, 0), loops };
  }
  if (Array.isArray(v.stages)) {
    return { schemaVersion: LOOP_SCHEMA_VERSION, loops: [{ id: crypto.randomUUID(), name: "Main Loop", isPrimary: true, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: null, runsOnSchedule: true, config: decodeConfig(v) }] };
  }
  return null;
}

/** Current-schema JSON for `system/loop.json`; unknown stage fields are written back verbatim. */
export function encodeProjectStore(store: LoopProjectStore): string {
  return JSON.stringify({
    schemaVersion: LOOP_SCHEMA_VERSION,
    loops: store.loops.map((l) => ({
      id: l.id, name: l.name, isPrimary: l.isPrimary,
      ...(l.goal !== null ? { goal: l.goal } : {}),
      ...(l.acceptanceCriteria !== null ? { acceptanceCriteria: l.acceptanceCriteria } : {}),
      scopeGlobs: l.scopeGlobs, defaultKey: l.defaultKey, runsOnSchedule: l.runsOnSchedule,
      config: encodeConfig(l.config),
    })),
  }, null, 2) + "\n";
}

function encodeStage(s: LoopStage): Record<string, unknown> {
  if (s.kind === "unsupported" && s.raw) return s.raw;
  return {
    id: s.id, name: s.name, kind: s.kind,
    ...(s.command !== null ? { command: s.command } : {}),
    order: s.order,
    ...(s.skillId !== null ? { skillId: s.skillId } : {}),
    ...(s.targetPath !== null ? { targetPath: s.targetPath } : {}),
    ...(s.outputPath !== null ? { outputPath: s.outputPath } : {}),
    ...(s.prompt !== null ? { prompt: s.prompt } : {}),
    isDefault: s.isDefault, enabled: s.enabled,
    ...(s.defaultKey !== null ? { defaultKey: s.defaultKey } : {}),
    severity: s.severity,
    ...(s.timeoutSeconds !== null ? { timeoutSeconds: s.timeoutSeconds } : {}),
    ...(s.detectedCommand !== null ? { detectedCommand: s.detectedCommand } : {}),
    ...(s.check !== null ? { check: s.check } : {}),
    ...(s.testOp !== null ? { testOp: s.testOp } : {}),
    ...(s.graphOp !== null ? { graphOp: s.graphOp } : {}),
    allowsRepair: s.allowsRepair,
    ...(s.runOnce ? { runOnce: true } : {}),
    ...(s.defaultRevision !== null ? { defaultRevision: s.defaultRevision } : {}),
    ...(s.disabledByDetection !== null ? { disabledByDetection: s.disabledByDetection } : {}),
  };
}

function encodeConfig(c: LoopEngineConfig): Record<string, unknown> {
  return {
    stages: c.stages.map(encodeStage),
    maxIterations: c.maxIterations,
    consecutiveFailureStop: c.consecutiveFailureStop,
    ...(c.wallClockBudgetSeconds !== null ? { wallClockBudgetSeconds: c.wallClockBudgetSeconds } : {}),
    maxRepairsPerStage: c.maxRepairsPerStage,
    pauseTimeoutSeconds: c.pauseTimeoutSeconds,
    protectedPathPolicy: c.protectedPathPolicy,
    extraProtectedGlobs: c.extraProtectedGlobs,
    writeSummaryNote: c.writeSummaryNote,
    useWorktreesForConcurrentRuns: c.useWorktreesForConcurrentRuns,
    alwaysUseWorktree: c.alwaysUseWorktree,
    openMergeRequest: c.openMergeRequest,
    ...(c.repairModel !== null ? { repairModel: c.repairModel } : {}),
    ...(c.refactorBatchesPerRun !== null ? { refactorBatchesPerRun: c.refactorBatchesPerRun } : {}),
  };
}
