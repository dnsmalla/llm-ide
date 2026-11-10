// Project-scoped task config (Task 15). One record per project root under `llmide.tasks.v2:<root>`. The former global
// `llmide.autoTasks.v1` is copied into a project the first time that project is opened, and is never deleted or
// rewritten. A stored record that cannot be parsed falls back to defaults and is kept as it was.
import { validateCron } from "../autotasks/native/cron.ts";
import { normaliseProjectRoot } from "../autotasks/native/custom.ts";
import { ALIASES, TASK_BY_ID, TASKS } from "./registry.generated.ts";
import { taskById, taskFocus } from "./model.ts";
import type { TaskDef } from "./types.ts";

export interface TaskConfig {
  enabled: boolean;
  inputPath: string;
  outputPath: string;
  skillName: string;
  /** An agent task's own prompt text when the user changed it; null = the registry's focus sentence. */
  promptOverride: string | null;
  /** Five-field cron; "" for a task that cannot be scheduled. */
  cron: string;
  scheduleActive: boolean;
}

export interface TaskState {
  masterEnabled: boolean;
  configs: Record<string, TaskConfig>;
  /** One-time migration notices, shown once by `takeTaskNotices`. */
  notices: string[];
}

const PREFIX = "llmide.tasks.v2:";
const MIGRATED_KEY = "llmide.tasks.v2.migrated";
const LEGACY_KEY = "llmide.autoTasks.v1";
const DEFAULT_CRON = "0 * * * *";

export const COPIED_NOTICE = "Your Auto Tasks settings were copied into this project. Task settings are now kept per project.";
export const SWITCHED_OFF_NOTICE = "These schedules were switched off because the task now does real work:";

/**
 * D17 (decision table, 2026-11-10): tasks whose runner changed when the registry took them over (Tasks 2-13). A schedule
 * saved for one of them while it was a placeholder starts switched off, and so does every one of them after migration.
 * Ids are the canonical registry ids; the legacy names they replace are in `ALIASES`.
 */
export const SWITCHED_OFF_ON_MIGRATION: ReadonlySet<string> = new Set([
  "sources.update",      // sourceUpdate
  "issues.from_notes",   // sourcesToIssue, updateIssues
  "issues.implement",    // implementIssues
  "review.merge",        // reviewMerge
  "plan.status",         // updatePlanStatus
  "loop.regression",     // regression
  "knowledge.update",    // generateKnowledge (retired)
  "docs.generate",       // generateDoc (retired)
  "review.code",         // reviewCode
  "review.doc",          // reviewDoc
  "review.conflicts",    // reviewConflicts
]);

/** The prompts the desktop stored before the registry owned them. A stored copy of one is not an override. */
const RETIRED_DEFAULT_PROMPTS: Readonly<Record<string, string>> = {
  "review.code": "Review the recent commits in this repository for bugs, security issues, and code style problems. This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. Print your findings as a summary to your output.",
  "review.doc": "Review the project's documentation against the code and recent changes. Report inaccurate, missing or stale sections; do not edit files.",
  "review.conflicts": "Review conflict markers and divergent changes. Explain the conflicting intents and propose a resolution without applying it.",
};

const AVAILABLE: readonly TaskDef[] = TASKS.filter((t) => t.availability.status === "available");

function schedulable(t: TaskDef): boolean {
  return t.schedule.backend === "desktop" && t.schedule.schedulable;
}

function defaultConfig(t: TaskDef): TaskConfig {
  return {
    enabled: false, inputPath: "", outputPath: "", skillName: "", promptOverride: null,
    cron: schedulable(t) ? t.schedule.defaultCron ?? DEFAULT_CRON : "", scheduleActive: false,
  };
}

export function defaultTaskState(): TaskState {
  return { masterEnabled: false, configs: Object.fromEntries(AVAILABLE.map((t) => [t.id, defaultConfig(t)])), notices: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The prompt the registry or an earlier desktop build would send unedited; such a prompt is not an override. */
function isUneditedPrompt(id: string, prompt: string): boolean {
  const p = prompt.trim();
  return p === "" || p === (RETIRED_DEFAULT_PROMPTS[id] ?? "").trim() || p === (taskFocus(id) ?? "").trim();
}

/** Reads one stored config for `t`; anything malformed takes the default for that field. */
function readConfig(t: TaskDef, c: Record<string, unknown>, promptOverride: string | null): TaskConfig {
  const base = defaultConfig(t);
  const cronOk = typeof c.cron === "string" && validateCron(c.cron);
  return {
    enabled: c.enabled === true,
    inputPath: text(c.inputPath),
    outputPath: text(c.outputPath),
    skillName: text(c.skillName),
    promptOverride: t.runner?.kind === "agent" ? promptOverride : null,
    cron: schedulable(t) ? (cronOk ? (c.cron as string) : base.cron) : "",
    scheduleActive: schedulable(t) && c.scheduleActive === true,
  };
}

function parseState(raw: string): TaskState | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isRecord(v)) return null;
    const stored = isRecord(v.configs) ? v.configs : {};
    const configs: Record<string, TaskConfig> = {};
    for (const t of AVAILABLE) {
      const c = isRecord(stored[t.id]) ? stored[t.id] as Record<string, unknown> : null;
      configs[t.id] = c ? readConfig(t, c, typeof c.promptOverride === "string" && c.promptOverride.trim() !== "" ? c.promptOverride : null) : defaultConfig(t);
    }
    const notices = Array.isArray(v.notices) ? v.notices.filter((n): n is string => typeof n === "string") : [];
    return { masterEnabled: v.masterEnabled === true, configs, notices };
  } catch { return null; }
}

function readLegacy(storage: Storage | undefined): Record<string, unknown> | null {
  try {
    const raw = storage?.getItem(LEGACY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return isRecord(v) ? v : null;
  } catch { return null; }
}

/** An alias that resolves through another alias (`updateIssues`) yields to a direct name for the same task. */
const aliasHop = (key: string): boolean => {
  const id = ALIASES[key];
  return id !== undefined && TASK_BY_ID[id]?.availability.status === "alias";
};

/** The one-time copy of the legacy global config into a fresh project state. */
function migrateLegacy(legacy: Record<string, unknown>): TaskState {
  const state = defaultTaskState();
  state.masterEnabled = legacy.masterEnabled === true;
  const stored = isRecord(legacy.configs) ? legacy.configs : {};
  const armedAndSwitchedOff: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(stored).sort((a, b) => Number(aliasHop(a)) - Number(aliasHop(b)))) {
    const t = taskById(key);
    const c = stored[key];
    if (!t || t.availability.status !== "available" || !isRecord(c) || seen.has(t.id)) continue;
    seen.add(t.id);
    const legacyPrompt = text(c.prompt);
    const override = t.runner?.kind === "agent" && !isUneditedPrompt(t.id, legacyPrompt) ? legacyPrompt : null;
    const next = readConfig(t, c, override);
    if (SWITCHED_OFF_ON_MIGRATION.has(t.id)) {
      if (c.scheduleActive === true) armedAndSwitchedOff.push(t.label);
      next.scheduleActive = false;
    }
    state.configs[t.id] = next;
  }
  state.notices = [
    COPIED_NOTICE,
    ...(armedAndSwitchedOff.length ? [`${SWITCHED_OFF_NOTICE} ${armedAndSwitchedOff.join(", ")}.`] : []),
  ];
  return state;
}

function migratedRoots(storage: Storage | undefined): string[] {
  try {
    const v = JSON.parse(storage?.getItem(MIGRATED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];
  } catch { return []; }
}

/**
 * The task state of one project. A project with no stored state is seeded once from the legacy global config; a later
 * change to the legacy key does not reach it. A project root that is empty gets defaults and is never written.
 */
export function loadTaskState(projectRoot: string, storage: Storage | undefined = globalThis.localStorage): TaskState {
  const root = normaliseProjectRoot(projectRoot);
  if (!root) return defaultTaskState();
  let raw: string | null = null;
  try { raw = storage?.getItem(PREFIX + root) ?? null; } catch { return defaultTaskState(); }
  if (raw !== null) return parseState(raw) ?? defaultTaskState();
  if (migratedRoots(storage).includes(root)) return defaultTaskState();
  const legacy = readLegacy(storage);
  const state = legacy ? migrateLegacy(legacy) : defaultTaskState();
  saveTaskState(root, state, storage);
  try { storage?.setItem(MIGRATED_KEY, JSON.stringify([...migratedRoots(storage), root])); } catch { /* the next load copies again only if the project has no state */ }
  return state;
}

export function saveTaskState(projectRoot: string, state: TaskState, storage: Storage | undefined = globalThis.localStorage): void {
  const root = normaliseProjectRoot(projectRoot);
  if (!root || !storage) return;
  const key = PREFIX + root;
  try {
    // A stored value this build cannot read is copied aside once, so saving over it never destroys it.
    const existing = storage.getItem(key);
    if (existing !== null && parseState(existing) === null && storage.getItem(`${key}.unreadable`) === null) {
      storage.setItem(`${key}.unreadable`, existing);
    }
    storage.setItem(key, JSON.stringify(state));
  } catch { /* session only */ }
}

/** The one-time notices for a project, returned once and then cleared from its stored state. */
export function takeTaskNotices(projectRoot: string, storage: Storage | undefined = globalThis.localStorage): string[] {
  const state = loadTaskState(projectRoot, storage);
  if (state.notices.length === 0) return [];
  saveTaskState(projectRoot, { ...state, notices: [] }, storage);
  return state.notices;
}
