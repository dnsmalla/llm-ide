// Native Auto Tasks catalog and local configuration. The Mac's runner/scheduler is being ported separately; this
// module owns the part the desktop can already be authoritative for: which tasks are enabled, their input/output,
// skill and prompt, stored per project on this machine. No Mobile Control token is involved.
export type AutoTaskId =
  | "sourceUpdate" | "sourcesToIssue" | "implementIssues" | "reviewMerge"
  | "reviewCode" | "reviewDoc" | "reviewConflicts"
  | "updateIssues" | "updatePlanStatus" | "generateDoc" | "regression" | "generateKnowledge";

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

export const TASKS: readonly AutoTaskDef[] = [
  { id: "sourceUpdate", label: "Source Update", group: "Pipeline", prompt: "Update the project's source notes from the latest captured sources. Record what changed and where it was written." },
  { id: "sourcesToIssue", label: "Sources → Issue", group: "Pipeline", prompt: "Turn the unresolved action items in the latest sources into tracked issues. Report every issue you create." },
  { id: "implementIssues", label: "Implement Issues", group: "Pipeline", prompt: "Pick the next open issue that is ready to implement, implement it, and report the changed files and test result." },
  { id: "reviewMerge", label: "Review & Merge", group: "Pipeline", prompt: "Review the pending merge request for bugs, missing tests and unintended changes. Report findings; do not merge." },
  { id: "reviewCode", label: "Review Code", group: "Review", readOnlyOutput: true, prompt: "Review the recent commits in this repository for bugs, security issues, and code style problems. This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. Print your findings as a summary to your output." },
  { id: "reviewDoc", label: "Review Doc", group: "Review", readOnlyOutput: true, prompt: "Review the project's documentation against the code and recent changes. Report inaccurate, missing or stale sections; do not edit files." },
  { id: "reviewConflicts", label: "Review Conflicts", group: "Review", prompt: "Review conflict markers and divergent changes. Explain the conflicting intents and propose a resolution without applying it." },
  { id: "updateIssues", label: "Update Issues", group: "Automation", prompt: "Update the tracked issues with the current status and evidence from the repository. Report every issue you change." },
  { id: "updatePlanStatus", label: "Update Plan Status", group: "Automation", prompt: "Update the project plan status from the current repository state. Report which plan items moved." },
  { id: "generateDoc", label: "Generate Documentation", group: "Automation", prompt: "Generate the requested project document from the current sources and repository state." },
  { id: "regression", label: "Regression", group: "Maintenance", prompt: "Re-run the known regression checks and report every verdict." },
  { id: "generateKnowledge", label: "Knowledge", group: "Maintenance", prompt: "Update the project knowledge base with durable facts learned from the recent work." },
];

export const GROUPS: readonly AutoTaskGroup[] = ["Pipeline", "Review", "Automation", "Maintenance"];
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
      const c = parsed.configs?.[t.id];
      if (c && typeof c === "object") base.configs[t.id] = { ...base.configs[t.id], ...c, prompt: typeof c.prompt === "string" ? c.prompt : t.prompt };
    }
    return base;
  } catch { return defaultState(); }
}

export function saveState(s: AutoTaskLocalState, storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* session only */ }
}

/** Mac parity (`AutoTask.requiresLinkedRepo`): only Source Update runs without a linked repository. */
export function requiresLinkedRepo(id: AutoTaskId): boolean {
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

/** Whether a `/kb/loop/agent-run` answer is a completed run. The engine refuses to run at all when a requested skill
 *  is not in the user's skills library (`ran: false`, empty reply), which must not read as success. */
export function agentRunSucceeded(r: { reply?: string; ran?: boolean; unresolvedSkills?: string[]; resultSubtype?: string | null }): boolean {
  if (r.ran === false || (r.unresolvedSkills?.length ?? 0) > 0) return false;
  return r.resultSubtype === "success" || (r.resultSubtype == null && typeof r.reply === "string");
}
