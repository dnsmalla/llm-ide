// Custom Auto Tasks: a user-created Review task, stored per project on this machine. The Mac model is
// `CustomAutoTask`; the desktop keeps the same fields in localStorage and never invents an Implement runner
// (there is no desktop worktree/branch host command yet). A custom task is a prompt plus an optional cron;
// Review runs are reverted by the runner, exactly like the built-in read-only tasks.
import { cronMatches, nextFireAfter, validateCron } from "./cron.ts";

export type CustomTaskMode = "review" | "implement";

export interface CustomAutoTask {
  id: string;
  projectRoot: string;
  name: string;
  prompt: string;
  mode: CustomTaskMode;
  /** Five-field cron; "" means manual only. */
  cron: string;
  enabled: boolean;
  createdAt: string;
}

const KEY = "llmide.customAutoTasks.v1";
const MAX_NAME = 80;
const MAX_PROMPT = 20_000;

/** Stable id with a recognisable prefix; tests can pass an explicit id. */
export function newCustomTaskId(seed = ""): string {
  const body = seed || (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return `custom-${body.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48)}`;
}

export function normaliseProjectRoot(root: string): string {
  return root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function loadCustomTasks(projectRoot: string, storage: Storage | undefined = globalThis.localStorage): CustomAutoTask[] {
  const root = normaliseProjectRoot(projectRoot);
  if (!root) return [];
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is CustomAutoTask => Boolean(t && typeof t === "object"
      && typeof (t as CustomAutoTask).id === "string"
      && typeof (t as CustomAutoTask).name === "string"
      && typeof (t as CustomAutoTask).prompt === "string"
      && typeof (t as CustomAutoTask).projectRoot === "string"
      && normaliseProjectRoot((t as CustomAutoTask).projectRoot) === root
      && ((t as CustomAutoTask).mode === "review" || (t as CustomAutoTask).mode === "implement")
      && typeof (t as CustomAutoTask).cron === "string"
      && typeof (t as CustomAutoTask).enabled === "boolean"
      && typeof (t as CustomAutoTask).createdAt === "string")).map((t) => ({ ...t, projectRoot: root }));
  } catch { return []; }
}

export function saveCustomTasks(tasks: readonly CustomAutoTask[], projectRoot: string, storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage) return;
  try {
    const all = JSON.parse(storage.getItem(KEY) ?? "[]") as unknown;
    const roots = new Set(tasks.map((t) => normaliseProjectRoot(t.projectRoot)));
    const root = normaliseProjectRoot(projectRoot);
    if (root) roots.add(root);
    const others = Array.isArray(all) ? all.filter((t) => !roots.has(normaliseProjectRoot((t as CustomAutoTask)?.projectRoot ?? ""))) : [];
    storage.setItem(KEY, JSON.stringify([...others, ...tasks]));
  } catch { /* session only */ }
}

export interface CustomTaskDraft { name: string; prompt: string; mode: CustomTaskMode; cron: string; enabled?: boolean }

/** Validate a UI draft. Returns a message, or null when the draft can be saved. */
export function validateCustomTask(draft: CustomTaskDraft): string | null {
  const name = draft.name.trim();
  if (!name) return "Give the task a name.";
  if (name.length > MAX_NAME) return `The name must be ${MAX_NAME} characters or fewer.`;
  if (!draft.prompt.trim()) return "Write the prompt the task should run.";
  if (draft.prompt.length > MAX_PROMPT) return `The prompt must be ${MAX_PROMPT.toLocaleString()} characters or fewer.`;
  if (draft.mode !== "review" && draft.mode !== "implement") return "Choose a valid mode.";
  if (draft.cron.trim() && !validateCron(draft.cron)) return "Use a valid five-field cron expression, or leave it empty for manual runs.";
  return null;
}

export function createCustomTask(projectRoot: string, draft: CustomTaskDraft, id = newCustomTaskId(), now = new Date()): CustomAutoTask {
  const error = validateCustomTask(draft);
  if (error) throw new Error(error);
  return {
    id,
    projectRoot: normaliseProjectRoot(projectRoot),
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    mode: draft.mode,
    cron: draft.cron.trim(),
    enabled: draft.enabled ?? true,
    createdAt: now.toISOString(),
  };
}

export function updateCustomTask(task: CustomAutoTask, patch: Partial<CustomTaskDraft>): CustomAutoTask {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  const next = { ...task, ...patch, name: (patch.name ?? task.name).trim(), prompt: (patch.prompt ?? task.prompt).trim(), cron: (patch.cron ?? task.cron).trim() };
  const error = validateCustomTask(next);
  if (error) throw new Error(error);
  return next;
}

/** Whether the desktop may run a task. Implement needs the worktree/branch host command the desktop does not have. */
export function customTaskRunnable(task: Pick<CustomAutoTask, "mode">): boolean {
  return task.mode === "review";
}

export const CUSTOM_IMPLEMENT_MESSAGE = "Implement mode runs on an isolated branch in the Mac app; the desktop does not have the worktree host command yet. Save this task as Review or run it on the Mac.";

/** The exact prompt sent for a custom task. Custom tasks have no folder settings yet, so the whole project is the scope. */
export function customTaskMessage(task: Pick<CustomAutoTask, "prompt">): string {
  return task.prompt.trim();
}

/** Tasks due at this tick. `fired` carries a per-task minute key so a resumed tab cannot double-fire in one minute. */
export function dueCustomTasks(tasks: readonly CustomAutoTask[], masterEnabled: boolean, now: Date, fired: Readonly<Record<string, string>> = {}): CustomAutoTask[] {
  if (!masterEnabled) return [];
  const minute = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  return tasks.filter((t) => t.mode === "review" && t.enabled && t.cron !== "" && validateCron(t.cron) && cronMatches(t.cron, now) && fired[`${t.id}:${minute}`] !== minute);
}

/** One-line status for a custom task, matching the built-in wording where it overlaps. */
export function customTaskStatus(task: Pick<CustomAutoTask, "mode" | "cron" | "enabled">, masterEnabled: boolean, _now: Date, nextFire?: Date | null): string {
  if (!customTaskRunnable(task)) return "Mac app only — Implement mode is not available here";
  if (!task.cron) return "Manual only — runs when you press Run";
  if (!masterEnabled) return "Auto Tasks paused — master switch off";
  if (!task.enabled) return "Task disabled — won't run";
  const next = nextFire ?? nextFireAfter(task.cron, _now);
  return next ? `Scheduled · next ${next.toLocaleString()}` : "No upcoming fire";
}
