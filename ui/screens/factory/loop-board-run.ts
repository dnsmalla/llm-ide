// Pure logic of the run bar on a non-Factory loop's Board. The Board never runs anything itself: it builds a
// "run-loop" request that the Loop page executes through its own approval, worktree and queue path.
import { loopUsesInputPath, normalizeInputPath } from "../loop/native/input-path.ts";
import { RUN_COMMAND_MAX } from "../loop/native/run-command.ts";
import type { LoopDefinition } from "../loop/native/model.ts";

export type BoardRunLoop = Pick<LoopDefinition, "id" | "config" | "inputPath">;

export interface RunBarInput { inputPath: string; task: string }

export interface RunBarState {
  /** True when the loop has stages that read the Input path; otherwise `reads` describes what it reads. */
  showInputPath: boolean;
  /** Read-only line for loops without an input path. */
  reads: string | null;
  inputError: string | null;
  taskRequired: boolean;
  /** Why ▶ Run is disabled, or null when it can be pressed. */
  blocked: string | null;
}

/** The enabled skill steps' target folders, in stage order, without duplicates. */
export function loopReadTargets(loop: BoardRunLoop): string[] {
  const out: string[] = [];
  for (const s of [...loop.config.stages].sort((a, b) => a.order - b.order)) {
    const t = s.enabled && s.kind === "skill" ? s.targetPath?.trim() : "";
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function runBarState(loop: BoardRunLoop, input: RunBarInput): RunBarState {
  const showInputPath = loopUsesInputPath(loop);
  const targets = loopReadTargets(loop);
  const reads = showInputPath ? null : targets.length ? `Reads: ${targets.join(", ")}` : "No input file: shell steps only";
  let inputError: string | null = null;
  if (showInputPath) {
    const n = normalizeInputPath(input.inputPath);
    if ("error" in n) inputError = n.error;
  }
  const taskRequired = loop.config.workMode === "one";
  const blocked = inputError ?? (taskRequired && !input.task.trim() ? "Required: name the item this run should do." : null);
  return { showInputPath, reads, inputError, taskRequired, blocked };
}

/** The bus event for ▶ Run, or null while the form is invalid. The path is sent only when the loop uses one. */
export function buildRunEvent(loop: BoardRunLoop, input: RunBarInput): { type: "run-loop"; loopId: string; inputPath?: string; task?: string } | null {
  const state = runBarState(loop, input);
  if (state.blocked) return null;
  // Collapsed like the Loop page's own task field, so both entry points hand the agent the same one-line text.
  const task = input.task.replace(/\s+/g, " ").trim().slice(0, RUN_COMMAND_MAX);
  const inputPath = state.showInputPath ? (normalizeInputPath(input.inputPath) as { path: string }).path : undefined;
  return { type: "run-loop", loopId: loop.id, ...(inputPath !== undefined ? { inputPath } : {}), ...(task ? { task } : {}) };
}

/** What the bar holds after a successful send: the path stays, the one-time task does not. */
export function afterSend(input: RunBarInput): RunBarInput {
  return { inputPath: input.inputPath, task: "" };
}

const KEY = "llmide.loopBoardRun.";

/**
 * The bar's starting content. Only the task draft is remembered: a remembered input path would shadow later edits of
 * the loop on the Loop page, so the path is always prefilled from the loop itself.
 */
export function loadRunBarInput(loop: Pick<LoopDefinition, "inputPath">, name: string, storage: Pick<Storage, "getItem"> | null): RunBarInput {
  const fallback = { inputPath: loop.inputPath, task: "" };
  try {
    const raw = storage?.getItem(KEY + name);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as { task?: unknown };
    return { inputPath: loop.inputPath, task: typeof v.task === "string" ? v.task.slice(0, RUN_COMMAND_MAX) : "" };
  } catch { return fallback; }
}

/** Per-viewer convenience only: any storage failure just means no remembered text. */
export function saveRunBarInput(name: string, input: RunBarInput, storage: Pick<Storage, "setItem"> | null): void {
  try { storage?.setItem(KEY + name, JSON.stringify({ task: input.task })); } catch { /* private mode */ }
}
