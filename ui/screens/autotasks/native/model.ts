import { fireLabel, nextFireAfter } from "./cron.ts";
import { TASKS as REGISTRY_TASKS, taskAvailability, taskById, taskFocus } from "../../tasks/model.ts";
import type { TaskDef, TaskEnv } from "../../tasks/types.ts";
import { repoSlug } from "../../issues/issues-model.ts";
import type { RepoConfig } from "../../settings/repo-config.ts";

export { taskById };
// Native Auto Tasks catalog and local configuration. The Mac's runner/scheduler is being ported separately; this
// module owns the part the desktop can already be authoritative for: which tasks are enabled, their input/output,
// skill and prompt, stored per project on this machine. No Mobile Control token is involved.
export type AutoTaskId =
  | "sourceUpdate" | "issues.from_notes" | "issues.implement" | "review.merge"
  | "review.code" | "review.doc" | "review.conflicts"
  | "updatePlanStatus" | "generateDoc" | "regression" | "generateKnowledge"
  | "loop.regression" | "sources.update" | "plan.status";

export type AutoTaskGroup = "Pipeline" | "Review" | "Automation" | "Maintenance";
export interface AutoTaskDef { id: AutoTaskId; label: string; group: AutoTaskGroup; prompt: string; readOnlyOutput?: boolean }
export interface AutoTaskConfig {
  enabled: boolean;
  inputPath: string;
  outputPath: string;
  skillName: string;
  template: "builtin" | "custom";
  prompt: string;
  /** Five-field cron; an expression alone does not arm a schedule. */
  cron: string;
  scheduleActive: boolean;
}
export interface AutoTaskLocalState { masterEnabled: boolean; configs: Record<string, AutoTaskConfig>; }

/** The default prompt text the desktop stored before a registry task owned it. A stored copy of it is not an override. */
const RETIRED_DEFAULT_PROMPTS: Readonly<Record<string, string>> = {
  "review.code": "Review the recent commits in this repository for bugs, security issues, and code style problems. This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. Print your findings as a summary to your output.",
  "review.doc": "Review the project's documentation against the code and recent changes. Report inaccurate, missing or stale sections; do not edit files.",
  "review.conflicts": "Review conflict markers and divergent changes. Explain the conflicting intents and propose a resolution without applying it.",
};

const LEGACY_TASKS: readonly AutoTaskDef[] = [];

export const GROUPS: readonly AutoTaskGroup[] = ["Pipeline", "Review", "Automation", "Maintenance"];

/** Registry tasks are the migrated ones; `LEGACY_TASKS` shrinks by one entry per migration commit. */
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

export const TASKS: readonly AutoTaskDef[] = [
  ...REGISTRY_TASKS.flatMap((t) => { const a = toAutoTask(t); return a ? [a] : []; }),
  ...LEGACY_TASKS,
];
export const TASK_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t])) as Record<AutoTaskId, AutoTaskDef>;

const KEY = "llmide.autoTasks.v1";
function blankConfig(t: AutoTaskDef): AutoTaskConfig { return { enabled: false, inputPath: "", outputPath: "", skillName: "", template: "builtin", prompt: t.prompt, cron: "0 * * * *", scheduleActive: false }; }
export function defaultState(): AutoTaskLocalState {
  return { masterEnabled: false, configs: Object.fromEntries(TASKS.map((t) => [t.id, blankConfig(t)])) };
}

export function loadState(storage: Storage | undefined = globalThis.localStorage): AutoTaskLocalState {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<AutoTaskLocalState>;
    const base = defaultState();
    base.masterEnabled = parsed.masterEnabled === true;
    for (const t of TASKS) {
      const legacy = Object.entries(parsed.configs ?? {}).find(([key]) => taskById(key)?.id === t.id);
      const own = parsed.configs?.[t.id];
      const c = own ?? legacy?.[1];
      if (c && typeof c === "object") {
        // A schedule saved while the task was "Mac app only" must not start firing after the migration.
        const migrated = own === undefined && legacy !== undefined;
        base.configs[t.id] = {
          ...base.configs[t.id], ...c,
          scheduleActive: migrated ? false : c.scheduleActive === true,
          prompt: typeof c.prompt === "string" && c.prompt !== RETIRED_DEFAULT_PROMPTS[t.id] ? c.prompt : t.prompt,
        };
      }
    }
    return base;
  } catch { return defaultState(); }
}

export function saveState(s: AutoTaskLocalState, storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* session only */ }
}

const MERGED_NOTICE_KEY = "llmide.autoTasks.updateIssuesMerged.v1";
export const UPDATE_ISSUES_MERGED_NOTICE = "Update Issues was merged into Sources → Issue.";

/** Once, for a user whose stored Update Issues config is now the Sources → Issue row: its own prompt is ignored. */
export function takeMergedNotice(storage: Storage | undefined = globalThis.localStorage): string | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw || storage?.getItem(MERGED_NOTICE_KEY)) return null;
    const parsed = JSON.parse(raw) as Partial<AutoTaskLocalState>;
    if (!parsed.configs || !Object.hasOwn(parsed.configs, "updateIssues")) return null;
    storage?.setItem(MERGED_NOTICE_KEY, "1");
    return UPDATE_ISSUES_MERGED_NOTICE;
  } catch { return null; }
}

/** The Mac's structural tasks (`AutoTask.isStructural`, minus Loop Engineering, which the desktop does not have). They
 *  run deterministic code in the Mac app; the desktop has no such code, so it must never send them to the agent as an
 *  invented prompt. They stay listed, but are not runnable here, and a schedule never fires them. */
export const MAC_ONLY_TASK_IDS: ReadonlySet<AutoTaskId> = new Set<AutoTaskId>([]);
export const MAC_ONLY_MESSAGE = "This task runs deterministic code in the Mac app; the desktop does not run it yet.";

const DEFAULT_TASK_ENV: TaskEnv = { features: null, coreFeatures: null, hasRepo: true, localHost: true, mode: "local" };

/** Whether the desktop may run this task at all. Registry tasks use the one availability function; legacy entries keep the shim. */
export function desktopRunnable(id: string, env: TaskEnv = DEFAULT_TASK_ENV): boolean {
  const registered = taskById(id);
  if (registered) return taskAvailability(registered, env).runnable;
  return !MAC_ONLY_TASK_IDS.has(id as AutoTaskId);
}

/** Whether the page scheduler may fire this task now (apart from the cron match itself). */
/** Why a task cannot run, in the registry's words; null for legacy Mac-only tasks (the screen uses its own copy). */
export function taskUnavailableReason(id: AutoTaskId, env: TaskEnv = DEFAULT_TASK_ENV): string | null {
  const registered = taskById(id);
  if (!registered) return null;
  const availability = taskAvailability(registered, env);
  return availability.runnable ? null : availability.reason;
}

export function scheduledRunAllowed(id: string, c: Pick<AutoTaskConfig, "enabled" | "scheduleActive"> | undefined, hasRepo: boolean, env: TaskEnv = DEFAULT_TASK_ENV): boolean {
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
  const registered = taskById(id);
  if (registered) return registered.requiresRepo;
  return id !== "sourceUpdate";
}

/** Input and output folders are stored project-relative, as on the Mac (`AutoTaskConfig`). Returns the normalized
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
 *  then the next fire. A Mac-only task never fires on the desktop, so its status says so. */
export function scheduleStatusLine(masterEnabled: boolean, c: AutoTaskConfig, id: AutoTaskId, now: Date, env: TaskEnv = DEFAULT_TASK_ENV): string {
  // First: "press Run" or "task disabled" would be wrong for a task the desktop never runs, schedule or not.
  if (!desktopRunnable(id, env)) return "Mac app only — the desktop does not run this task";
  if (!isSchedulable(id)) return "Manual only — runs only when you press Run";
  if (!c.scheduleActive) return "Schedule off — runs only when you press Run";
  if (!masterEnabled) return "Auto Tasks paused — master switch off";
  if (!c.enabled) return "Task disabled — won't run";
  const next = nextFireAfter(c.cron, now);
  return next ? `Scheduled · next ${fireLabel(next)}` : "No upcoming fire";
}
