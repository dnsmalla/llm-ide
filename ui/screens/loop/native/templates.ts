// Built-in Loop recipes. The full Mac template library is larger; these are the safe starting points the desktop
// can create without hidden defaults. Test-stage commands are detected at apply time, never hard-coded.
import type { LoopDefinition, LoopEngineConfig, LoopStage } from "./model.ts";
import { DETECTED_TEST } from "./environment.ts";
import { DEFAULT_LOOP_SPECS } from "./defaults.ts";

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

BUILT_IN_TEMPLATES.push(
  { id: "skill-loop", name: "Skill Loop", summary: "Run a chosen skill as a generate step, gated by tests and the fault sweep.", config: config([{ name: "Apply skill", kind: "skill" }, { name: "Test", command: DETECTED_TEST }, { name: "Regression", kind: "regressionSweep" }], { maxIterations: 6 }) },
  { id: "docs-refresh", name: "Docs Refresh", summary: "Regenerate documentation with a skill, then run the project docs check.", config: config([{ name: "Write docs", kind: "skill" }, { name: "Docs check", command: "make docs-check" }], { maxIterations: 4, maxRepairsPerStage: 2 }) },
  { id: "operation-diagnosis", name: "Operation App Diagnosis", summary: "Check the local server responds and the extension and Mac app build cleanly, then the fault sweep.", config: config([{ name: "Server health", command: "curl -sf http://127.0.0.1:3456/health" }, { name: "Extension build", command: "cd extension && npm run build" }, { name: "Mac app build", command: "cd mac && swift build" }, { name: "Regression", kind: "regressionSweep" }], { maxIterations: 6 }) },
  { id: "system-check", name: "System Check", summary: "Verify skills, plugins, connectors, dispatch, backend, shared protocol, the Mac app and known faults.", config: config([
    { name: "Skills", command: "cd extension && node --test tests/agent-skills.test.mjs tests/agent-skill-telemetry.test.mjs tests/skill-library.test.mjs tests/install-project-skills.test.mjs tests/task-skill-routing.test.mjs" },
    { name: "Plugins", command: "cd extension && node --test tests/plugins-loader.test.mjs tests/plugins-installer.test.mjs" },
    { name: "Plugins + MCP", command: "cd extension && node --test tests/mcp-config.test.mjs tests/mcp-state.test.mjs tests/mcp-plugin-servers.test.mjs tests/plugin-mcp-wiring.test.mjs tests/agent-v2-user-mcp.test.mjs tests/plugin-hook-trust.test.mjs tests/plugin-hook-runner.test.mjs tests/plugin-hook-trust-route.test.mjs tests/agent-v2-plugin-hooks.test.mjs tests/mcp-cli-args.test.mjs tests/route-mcp-mode.test.mjs" },
    { name: "Connectors", command: "cd extension && node --test tests/box-connector.test.mjs tests/box-routes.test.mjs tests/slack-source.test.mjs tests/slack-oauth.test.mjs tests/slack-oauth-routes.test.mjs tests/email-source.test.mjs tests/scip-connector.test.mjs tests/scip-scanner.test.mjs tests/git-connector-chunking.test.mjs" },
    { name: "GitHub dispatch", command: "cd extension && node --test tests/dispatch-concurrency.test.mjs tests/dispatch-preview.test.mjs tests/github-pr-secrets.test.mjs tests/outcome-dispatch-sentinel.test.mjs" },
    { name: "Backend", command: "cd extension && npm test" },
    { name: "iOS ↔ Mac shared protocol", command: "make test-shared-protocol" },
    { name: "Mac app", command: "cd mac && swift test" },
    { name: "Regression", kind: "regressionSweep" },
  ], { maxIterations: 8 }) },
);

function defaultConfig(key: string): LoopEngineConfig {
  const spec = DEFAULT_LOOP_SPECS.find((l) => l.defaultKey === key);
  if (!spec) return config([]);
  return structuredClone(spec.config);
}

BUILT_IN_TEMPLATES.push(
  { id: "plan-director", name: "Plan Director", summary: "Index the plans, write the master plan, then run the artifact check.", config: defaultConfig("plan") },
  { id: "refactoring", name: "Refactoring", summary: "Structure, graph, test map, plan, apply and verify a refactor batch.", config: defaultConfig("refactor") },
  { id: "doc-optimization", name: "Doc Optimization", summary: "Index docs, rewrite them, then run the artifact check.", config: defaultConfig("docs") },
  { id: "test-growth", name: "Test Growth", summary: "Test structure, map, writer and ledger in one loop.", config: defaultConfig("test") },
);

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

/** Initial loops for a project that has no `system/loop.json`: the Mac's six starter loops, with fresh stage ids and
 *  the project's detected test command. A test-command stage is dropped when this project has none; skills remain
 *  editable but still need the core agent/skills to run. */
export function initialProjectStore(testCommand: string | null) {
  const loops: LoopDefinition[] = DEFAULT_LOOP_SPECS.map((spec) => {
    const stages = spec.config.stages.flatMap((s) => {
      const command = s.command === DETECTED_TEST ? testCommand : s.command;
      if (s.command === DETECTED_TEST && !command) return [];
      return [{ ...structuredClone(s), id: crypto.randomUUID(), command, isDefault: true }];
    }).map((s, i) => ({ ...s, order: i }));
    const config = structuredClone(spec.config);
    return {
      ...structuredClone(spec), id: crypto.randomUUID(), isPrimary: Boolean(spec.isPrimary),
      config: { ...config, stages },
    };
  });
  const first = loops.find((l) => l.defaultKey === "regression") ?? loops[0];
  if (first && !loops.some((l) => l.isPrimary)) first.isPrimary = true;
  return { schemaVersion: 2 as const, loops };
}
