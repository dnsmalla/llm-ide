// Built-in Loop recipes. The full Mac template library is larger; these are the safe starting points the desktop
// can create without hidden defaults. Test-stage commands are detected at apply time, never hard-coded.
import type { LoopEngineConfig, LoopStage } from "./model.ts";
import { DETECTED_TEST } from "./environment.ts";

export interface LoopTemplate {
  id: string;
  name: string;
  summary: string;
  config: LoopEngineConfig;
}

function config(stages: Partial<LoopStage>[], overrides: Partial<LoopEngineConfig> = {}): LoopEngineConfig {
  return {
    stages: stages.map((s, i) => ({
      id: crypto.randomUUID(), name: s.name ?? `Stage ${i + 1}`, kind: s.kind ?? "shellCommand", command: s.command ?? null,
      order: i, skillId: null, targetPath: null, outputPath: null, prompt: null, isDefault: false, enabled: true,
      defaultKey: null, severity: s.severity ?? "blocking", timeoutSeconds: null, detectedCommand: null, check: null,
      testOp: null, graphOp: null, allowsRepair: true, defaultRevision: null, disabledByDetection: null, raw: null,
    })),
    maxIterations: 10, consecutiveFailureStop: 3, wallClockBudgetSeconds: null, pauseTimeoutSeconds: 1800,
    maxRepairsPerStage: 3, repairModel: null, protectedPathPolicy: "revert", writeSummaryNote: false,
    extraProtectedGlobs: [], useWorktreesForConcurrentRuns: false, alwaysUseWorktree: false,
    openMergeRequest: true, refactorBatchesPerRun: null, ...overrides,
  };
}

export const BUILT_IN_TEMPLATES: LoopTemplate[] = [
  { id: "test-and-fix", name: "Test & Fix", summary: "Re-check known faults, then the test suite, repairing until both are green.",
    config: config([{ name: "Regression", kind: "regressionSweep" }, { name: "Test", command: DETECTED_TEST }]) },
  { id: "regression", name: "Regression", summary: "Re-check known faults only.",
    config: config([{ name: "Regression", kind: "regressionSweep" }], { maxIterations: 5 }) },
  { id: "test", name: "Test", summary: "Run just the test suite, repairing until green.",
    config: config([{ name: "Test", command: DETECTED_TEST }]) },
  { id: "full-verify", name: "Full Verify", summary: "Lint (advisory), tests, then the fault sweep.",
    config: config([{ name: "Lint", command: "make lint", severity: "advisory" }, { name: "Test", command: DETECTED_TEST }, { name: "Regression", kind: "regressionSweep" }]) },
];

/** Apply a recipe to a repo: new stage ids, resolved test commands, and no Mac "default" identities. */
export function applyTemplate(t: LoopTemplate, detected: string | null): LoopEngineConfig {
  const c = structuredClone(t.config);
  c.stages = c.stages.flatMap((s) => {
    const copy = { ...s, id: crypto.randomUUID(), isDefault: false, defaultKey: null };
    if (copy.command === DETECTED_TEST) {
      if (!detected) return [];
      copy.command = detected;
    }
    return [copy];
  }).map((s, i) => ({ ...s, order: i }));
  return c;
}
