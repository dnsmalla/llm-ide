// Pure selectors over the generated task catalog. Every surface asks this module, never its own table,
// whether a task can run and which prompt it uses.
import { ALIASES, TASKS, TASK_BY_ID, TEMPLATES } from "./registry.generated.ts";
import { PROMPTS, PROMPT_PARTS } from "./prompts.generated.ts";
import type { Availability, TaskDef, TaskEnv, TaskGroup } from "./types.ts";

export { ALIASES, PROMPTS, TASKS, TASK_BY_ID, TEMPLATES };

/** The task's own focus sentence (the part a user may override), or null for a task with no shared frame. */
export function taskFocus(idOrAlias: string): string | null {
  const id = resolveTaskId(idOrAlias);
  return id !== null && Object.hasOwn(PROMPT_PARTS, id) ? PROMPT_PARTS[id]!.focus : null;
}

/** The prompt a run would send with `focusText` as the override (the frame stays). Same rule as the core. */
export function taskPromptWithFocus(idOrAlias: string, focusText: string | null | undefined): string {
  const id = resolveTaskId(idOrAlias);
  const parts = id !== null && Object.hasOwn(PROMPT_PARTS, id) ? PROMPT_PARTS[id] : undefined;
  if (!parts) return taskPrompt(idOrAlias);
  const focus = typeof focusText === "string" && focusText.trim() !== "" ? focusText.slice(0, 4000).replace(/<\/?evidence>/gi, "") : parts.focus;
  return parts.frame.replace("{{focus}}", () => focus);
}

/** A task prompt was requested for a task whose runner has no prompt (deterministic, retired or custom). */
export class TaskPromptError extends Error {
  readonly code = "TASK_NOT_PROMPTABLE";
  constructor(taskId: string) {
    super(`Task "${taskId}" has no prompt: its runner is not an agent task.`);
    this.name = "TaskPromptError";
  }
}

/** Resolve a canonical id or an old alias. Follows one `aliasOf` hop, never a chain. */
export function resolveTaskId(idOrAlias: string): string | null {
  let id: string | null = null;
  if (Object.hasOwn(TASK_BY_ID, idOrAlias)) id = idOrAlias;
  else if (Object.hasOwn(ALIASES, idOrAlias)) id = ALIASES[idOrAlias] ?? null;
  if (id === null) return null;
  const task = TASK_BY_ID[id];
  if (task?.availability.status === "alias" && typeof task.aliasOf === "string" && Object.hasOwn(TASK_BY_ID, task.aliasOf)) {
    return task.aliasOf;
  }
  return id;
}

export function taskById(idOrAlias: string): TaskDef | null {
  const id = resolveTaskId(idOrAlias);
  return id === null ? null : TASK_BY_ID[id] ?? null;
}

/**
 * The one runnability decision. `features`/`coreFeatures` null means "every feature enabled";
 * an empty `task.features` means the task has no extra capability requirement.
 */
export function taskAvailability(task: TaskDef, env: TaskEnv): Availability {
  if (task.availability.status !== "available") {
    return { runnable: false, reason: task.availability.reason ?? `This task is ${task.availability.status}.` };
  }
  for (const feature of task.features) {
    if (env.features !== null && !env.features.has(feature)) {
      return { runnable: false, reason: `Needs the ${feature} feature.` };
    }
    if (env.coreFeatures !== null && !env.coreFeatures.has(feature)) {
      return { runnable: false, reason: `The core was started without the ${feature} feature.` };
    }
  }
  if (env.mode === "remote" && task.requiresLocalHost) {
    return { runnable: false, reason: "Runs on this computer; not available from a hub." };
  }
  if (task.requiresRepo && !env.hasRepo) {
    return { runnable: false, reason: "No linked repository. Add one in Settings → Repositories." };
  }
  if (task.runner?.kind === "desktop-action" && !env.localHost) {
    return { runnable: false, reason: "Needs the desktop app." };
  }
  return { runnable: true, reason: null };
}

/** The exact prompt text an agent task runs. Throws for every non-agent runner. */
export function taskPrompt(idOrAlias: string): string {
  const task = taskById(idOrAlias);
  if (!task || task.runner?.kind !== "agent" || typeof task.runner.prompt !== "string") {
    throw new TaskPromptError(idOrAlias);
  }
  const text = PROMPTS[task.id];
  if (typeof text !== "string") throw new TaskPromptError(task.id);
  return text;
}

export function taskGroup(idOrAlias: string): TaskGroup {
  return taskById(idOrAlias)?.group ?? "Automation";
}
