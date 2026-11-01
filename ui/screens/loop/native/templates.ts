// Built-in Loop recipes. The full Mac template library is larger; these are the safe starting points the desktop
// can create without hidden defaults. Test-stage commands are detected at apply time, never hard-coded.
import type { LoopDefinition, LoopEngineConfig, LoopStage } from "./model.ts";
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

// User recipes are app-wide like the Mac's LoopTemplateStore, not project state. Stored locally; built-ins are
// constants so a later improvement reaches every project.
const CUSTOM_KEY = "llmide.loopTemplates.v1";
export function loadCustomTemplates(storage: Storage | undefined = globalThis.localStorage): LoopTemplate[] {
  try {
    const raw = storage?.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is LoopTemplate => typeof t === "object" && t !== null && typeof (t as LoopTemplate).id === "string" && typeof (t as LoopTemplate).name === "string" && typeof (t as LoopTemplate).config === "object").slice(0, 100);
  } catch { return []; }
}
function persist(list: LoopTemplate[], storage: Storage | undefined): void {
  try { storage?.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* session only */ }
}
export function uniqueTemplateName(name: string, taken: readonly LoopTemplate[]): string {
  const base = name.trim() || "Untitled loop";
  const names = new Set(taken.map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let n = 2;
  while (names.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}
export function saveCustomTemplate(name: string, summary: string, config: LoopEngineConfig, storage: Storage | undefined = globalThis.localStorage): LoopTemplate {
  const list = loadCustomTemplates(storage);
  const t: LoopTemplate = { id: crypto.randomUUID(), name: uniqueTemplateName(name, [...BUILT_IN_TEMPLATES, ...list]), summary: summary.trim(), config: structuredClone(config) };
  persist([...list, t], storage);
  return t;
}
export function deleteCustomTemplate(id: string, storage: Storage | undefined = globalThis.localStorage): void {
  persist(loadCustomTemplates(storage).filter((t) => t.id !== id), storage);
}

/** Initial loops for a project that has no `system/loop.json`: the Mac's Regression starter (and Test when the
 *  project has a detectable test command). Stage ids are fresh; detected commands replace the sentinel. */
export function initialProjectStore(testCommand: string | null) {
  const regression = applyTemplate(BUILT_IN_TEMPLATES.find((t) => t.id === "test-and-fix")!, testCommand);
  const loops: LoopDefinition[] = [{
    id: crypto.randomUUID(), name: "Regression", isPrimary: true, goal: "Find the code behind each known fault and fix it for real.",
    acceptanceCriteria: "The fault sweep reports no failing faults and the test suite still passes.",
    scopeGlobs: [], defaultKey: "regression", runsOnSchedule: false, config: regression,
  }];
  if (testCommand) {
    const test = applyTemplate(BUILT_IN_TEMPLATES.find((t) => t.id === "test")!, testCommand);
    loops.push({ id: crypto.randomUUID(), name: "Test", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "test", runsOnSchedule: false, config: test });
  }
  return { schemaVersion: 2 as const, loops };
}
