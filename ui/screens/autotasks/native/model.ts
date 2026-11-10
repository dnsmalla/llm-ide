import { fireLabel, nextFireAfter } from "./cron.ts";
import { TASKS as REGISTRY_TASKS, taskAvailability, taskById, taskFocus } from "../../tasks/model.ts";
import type { TaskDef, TaskEnv } from "../../tasks/types.ts";
import type { TaskConfig } from "../../tasks/store.ts";
import { repoSlug } from "../../issues/issues-model.ts";
import type { RepoConfig } from "../../settings/repo-config.ts";

export { taskById };
// Native Auto Tasks catalog and pure helpers. Task settings are per project and live in tasks/store.ts; this module
// owns the catalog view, availability wording and the pure run/schedule helpers the page and the scheduler share.
export type AutoTaskId =
  | "sourceUpdate" | "issues.from_notes" | "issues.implement" | "review.merge"
  | "review.code" | "review.doc" | "review.conflicts"
  | "updatePlanStatus" | "generateDoc" | "regression" | "generateKnowledge"
  | "loop.regression" | "sources.update" | "plan.status";

export type AutoTaskGroup = "Pipeline" | "Review" | "Automation" | "Maintenance";
export interface AutoTaskDef { id: AutoTaskId; label: string; group: AutoTaskGroup; prompt: string; readOnlyOutput?: boolean }

export const GROUPS: readonly AutoTaskGroup[] = ["Pipeline", "Review", "Automation", "Maintenance"];

/** The screen's rows are a view of the generated registry; nothing here is a second catalog. */
function toAutoTask(t: TaskDef): AutoTaskDef | null {
  if (t.availability.status === "retired" || t.availability.status === "alias") return null;
  return {
    id: t.id as AutoTaskId,
    label: t.label,
    group: t.group as AutoTaskGroup,
    // An agent task with a shared frame edits only its focus sentence; the frame is never user text.
    prompt: t.runner?.kind === "agent" ? taskFocus(t.id) ?? "" : "",
    readOnlyOutput: t.readOnly,
  };
}

export const AUTO_TASK_ROWS: readonly AutoTaskDef[] = REGISTRY_TASKS.flatMap((t) => { const a = toAutoTask(t); return a ? [a] : []; });
export const AUTO_TASK_BY_ID = Object.fromEntries(AUTO_TASK_ROWS.map((t) => [t.id, t])) as Record<AutoTaskId, AutoTaskDef>;

const LEGACY_KEY = "llmide.autoTasks.v1";
const MERGED_NOTICE_KEY = "llmide.autoTasks.updateIssuesMerged.v1";
export const UPDATE_ISSUES_MERGED_NOTICE = "Update Issues was merged into Sources → Issue.";

/** Once, for a user whose stored Update Issues config is now the Sources → Issue row: its own prompt is ignored. */
export function takeMergedNotice(storage: Storage | undefined = globalThis.localStorage): string | null {
  try {
    const raw = storage?.getItem(LEGACY_KEY);
    if (!raw || storage?.getItem(MERGED_NOTICE_KEY)) return null;
    const parsed = JSON.parse(raw) as Partial<{ configs: Record<string, unknown> }>;
    if (!parsed.configs || !Object.hasOwn(parsed.configs, "updateIssues")) return null;
    storage?.setItem(MERGED_NOTICE_KEY, "1");
    return UPDATE_ISSUES_MERGED_NOTICE;
  } catch { return null; }
}

const DEFAULT_TASK_ENV: TaskEnv = { features: null, coreFeatures: null, hasRepo: true, localHost: true, mode: "local" };

/** Whether the desktop may run this task at all: the registry's one availability function decides. */
export function desktopRunnable(id: string, env: TaskEnv = DEFAULT_TASK_ENV): boolean {
  const registered = taskById(id);
  return registered ? taskAvailability(registered, env).runnable : false;
}

/** Why a task cannot run, in the registry's words; null when it can run. */
export function taskUnavailableReason(id: string, env: TaskEnv = DEFAULT_TASK_ENV): string | null {
  const registered = taskById(id);
  if (!registered) return "This task is not in the task registry.";
  const availability = taskAvailability(registered, env);
  return availability.runnable ? null : availability.reason;
}

/** Whether the scheduler may fire this task now (apart from the cron match itself). */
export function scheduledRunAllowed(id: string, c: Pick<TaskConfig, "enabled" | "scheduleActive"> | undefined, hasRepo: boolean, env: TaskEnv = DEFAULT_TASK_ENV): boolean {
  return isSchedulable(id) && desktopRunnable(id, env) && c?.enabled === true && c.scheduleActive === true && (!requiresLinkedRepo(id) || hasRepo);
}

/** A task whose registry schedule is `none` (it writes a tracker or code) only runs when a person presses Run (D17). */
export function isSchedulable(id: string): boolean {
  return taskById(id)?.schedule.schedulable ?? true;
}

/** The provider and repo a Sources -> Issue run files into: the active saved repository, named as the Issues board names it. */
export function issuesFromNotesArgs(c: RepoConfig): { provider: "github" | "gitlab"; repo: string } | null {
  const github = c.saved.github.map((r) => ({ ...r, provider: "github" as const }));
  const gitlab = c.saved.gitlab.map((r) => ({ ...r, provider: "gitlab" as const }));
  // The primary provider's active repository wins when both providers have one.
  const active = (c.primary === "gitlab" ? [...gitlab, ...github] : [...github, ...gitlab]).find((r) => r.active);
  const repo = active ? repoSlug(active.url) : "";
  return active && repo ? { provider: active.provider, repo } : null;
}

/** Mac parity (`AutoTask.requiresLinkedRepo`): only Source Update runs without a linked repository. */
export function requiresLinkedRepo(id: string): boolean {
  return taskById(id)?.requiresRepo ?? true;
}

/** Input and output folders are stored project-relative, as on the Mac. Returns the normalized
 *  relative folder, "" for empty (the whole project), or null when the value is absolute or escapes the project. */
export function normalizeProjectPath(p: string): string | null {
  const t = p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (t === "" || t === ".") return "";
  if (t.startsWith("/") || t.startsWith("~") || /^[a-zA-Z]:/.test(t)) return null;
  if (t.split("/").some((seg) => seg === "..")) return null;
  return t;
}

/** Title and body of the confirmation before a built-in prompt is overwritten (the Mac's `confirmationDialog`). */
export function resetTemplateTitle(label: string): string {
  return `Reset "${label}" template to default?`;
}
export const RESET_TEMPLATE_MESSAGE = "Your custom prompt will be permanently replaced.";

/** The message an Auto Task sends to the agent: its prompt, then the resolved input and output folders. */
export function composeTaskMessage(prompt: string, inputPath: string, outputPath: string): string {
  const parts = [prompt];
  if (inputPath) parts.push(`Input: ${inputPath}`);
  if (outputPath) parts.push(`Output: ${outputPath}`);
  return parts.join("\n\n");
}

/** Whether a `/kb/loop/agent-run` answer is a completed run. The engine refuses to run at all when a requested skill
 *  is not in the user's skills library (`ran: false`, empty reply), which must not read as success. */
export function agentRunSucceeded(r: { reply?: string; ran?: boolean; unresolvedSkills?: string[]; resultSubtype?: string | null }): boolean {
  if (r.ran === false || (r.unresolvedSkills?.length ?? 0) > 0) return false;
  return r.resultSubtype === "success" || (r.resultSubtype == null && typeof r.reply === "string");
}

/** One-line schedule status, in the Mac's order (CronField.statusLine): schedule off, master switch off, task disabled,
 *  then the next fire. A task that cannot run says why first, in the registry's words. */
export function scheduleStatusLine(masterEnabled: boolean, c: Pick<TaskConfig, "enabled" | "scheduleActive" | "cron">, id: string, now: Date, env: TaskEnv = DEFAULT_TASK_ENV): string {
  // First: "press Run" or "task disabled" would be wrong for a task that cannot run, schedule or not.
  const unavailable = taskUnavailableReason(id, env);
  if (unavailable) return unavailable;
  if (!isSchedulable(id)) return "Manual only — runs only when you press Run";
  if (!c.scheduleActive) return "Schedule off — runs only when you press Run";
  if (!masterEnabled) return "Auto Tasks paused — master switch off";
  if (!c.enabled) return "Task disabled — won't run";
  const next = nextFireAfter(c.cron, now);
  return next ? `Scheduled · next ${fireLabel(next)}` : "No upcoming fire";
}
