// Run one custom Auto Task through the same core agent endpoint the built-in tasks use. Kept free of React so the
// page and the shell-level scheduler share exactly one path.
import { guardedAgentCall, type AgentWrites } from "../../loop/native/agent-call.ts";
import { readOnlyCheck } from "./read-only.ts";
import { agentRunSucceeded } from "./model.ts";
import { customTaskRunnable, customTaskMessage, CUSTOM_IMPLEMENT_MESSAGE, type CustomAutoTask } from "./custom.ts";
import type { Resolve } from "./usage.ts";
import { decideRun, resolvePath } from "./usage.ts";

export type CustomAgentReply = AgentWrites & { reply?: string; ran?: boolean; unresolvedSkills?: string[]; resultSubtype?: string };

export interface CustomRunDeps {
  request<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<T>;
  /** Aborts the agent call (the page's Stop). Absent = not stoppable from outside. */
  signal?: AbortSignal;
  workRoot(): Promise<string>;
  changedPaths(): Promise<string[] | null>;
  revert(paths: string[], created: string[]): Promise<void>;
}

export interface CustomRunResult {
  ok: boolean;
  reply: string;
  writes: string[];
  error?: string;
  paused?: boolean;
  warning?: string;
}

/** The model-cap check; a failure does not block (same policy as the built-in runner). */
async function modelDecision(deps: CustomRunDeps): Promise<{ proceed: boolean; model?: string; notice?: string; warning?: string }> {
  try {
    const decision = await decideRun(() => deps.request<Resolve>(resolvePath("anthropic"), { method: "GET" }));
    if (!decision.proceed) return { proceed: false, notice: decision.notice };
    return { proceed: true, model: decision.model, warning: decision.warning };
  } catch (e) {
    return { proceed: true, warning: `Model limits could not be checked (${e instanceof Error ? e.message : String(e)}); running with the default model.` };
  }
}

export async function runCustomTask(task: CustomAutoTask, deps: CustomRunDeps): Promise<CustomRunResult> {
  if (!customTaskRunnable(task)) return { ok: false, reply: "", writes: [], error: CUSTOM_IMPLEMENT_MESSAGE };
  const decision = await modelDecision(deps);
  if (!decision.proceed) return { ok: false, reply: "", writes: [], error: decision.notice ?? "Auto Tasks are paused by model limits.", paused: true };
  const workRoot = await deps.workRoot();
  const snapshot = await deps.changedPaths();
  const g = await guardedAgentCall<CustomAgentReply>({
    before: snapshot === null ? null : new Set(snapshot),
    call: () => deps.request<CustomAgentReply>("/kb/loop/agent-run", {
      method: "POST",
      body: { message: customTaskMessage(task), repoRoot: workRoot, model: decision.model, timeoutMs: 30 * 60 * 1000 },
      signal: deps.signal,
    }),
    changedNow: deps.changedPaths,
    check: readOnlyCheck(async (paths, created) => { await deps.revert(paths, created); }),
  });
  if (g.result === null) {
    const error = `${g.error ?? "the agent run failed"}${g.violation ? `; ${g.violation}` : ""}`;
    return { ok: false, reply: "", writes: g.violation === null ? [] : g.writes, error, warning: decision.warning };
  }
  const r = g.result;
  const ok = agentRunSucceeded(r) && g.violation === null;
  return {
    ok,
    reply: r.reply ?? "",
    writes: g.violation === null ? [] : g.writes,
    error: g.violation ?? (ok ? undefined : (r.unresolvedSkills?.length ? `skill not found: ${r.unresolvedSkills.join(", ")}` : "the task did not complete")),
    warning: decision.warning,
  };
}
