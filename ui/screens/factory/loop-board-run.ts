// Pure logic of the run bar on a non-Factory loop's Board. The Board never runs anything itself: it builds a
// "run-loop" request that the Loop page executes through its own approval, worktree and queue path.
import { loopUsesInputPath, normalizeInputPath } from "../loop/native/input-path.ts";
import { RUN_COMMAND_MAX } from "../loop/native/run-command.ts";
import { branchDiscardRefusal } from "../loop/native/loop-branch.ts";
import type { FactoryRunFields, LoopRunIndexEntry } from "../loop/native/history.ts";
import type { LoopDefinition } from "../loop/native/model.ts";
import type { RunInfo } from "../loop/native/worktree-run.ts";

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

const HIDDEN_KEY = "llmide.loopBoardHidden.";
const HIDDEN_MAX = 200;

/**
 * Run ids this board has discarded, hidden from its own view only: Discard removes the run's worktree and branch
 * (reverting every change it made), but the Loop journal is append-only and keeps no "deleted" concept, so there is
 * nothing to tell the next refresh to leave out except this per-viewer list.
 */
export function loadHiddenRunIds(name: string, storage: Pick<Storage, "getItem"> | null): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(HIDDEN_KEY + name);
    if (!raw) return new Set();
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === "string")) : new Set();
  } catch { return new Set(); }
}

/** Per-viewer convenience only: any storage failure just means the card reappears after a reload. */
export function saveHiddenRunIds(name: string, ids: ReadonlySet<string>, storage: Pick<Storage, "setItem"> | null): void {
  try { storage?.setItem(HIDDEN_KEY + name, JSON.stringify([...ids].slice(-HIDDEN_MAX))); } catch { /* private mode */ }
}

export type DiscardTarget =
  | { kind: "ok"; info: RunInfo }
  | { kind: "gone" }
  | { kind: "no-worktree" }
  | { kind: "unreadable" }
  | { kind: "refused"; reason: string };

/**
 * Which worktree a Board card's Discard acts on, or why it may not. The run's OWN journal entry id (`run.id`, a
 * fresh UUID per run) is never the worktree's runId: a non-Factory loop's worktree is created with the loop's own
 * slug (shared by every run of that loop), read back here from the run's record
 * (`fields.worktree.runId` — the same field `reopenWorktree` reads). Using `run.id` for the host calls instead
 * would always report "no worktree", even when one exists.
 *
 * `fields` and `worktrees` must say whether the record and the live worktree list were actually read — a failed
 * read (loop_worktree_list always refuses in SSH mode; no project may be open; a record read can fail) must never
 * be folded into "confirmed gone": that would let the caller silently hide a card whose worktree, branch and
 * unshipped changes are still there, with no way back (hiding is a one-way, per-viewer action).
 * - `"no-worktree"`: the record has no `worktree.runId` at all — this run worked directly on the main tree (a loop
 *   with `alwaysUseWorktree: false`). There is nothing to revert through a worktree, but its edits may still sit
 *   live, uncommitted, in the main tree: the caller must say so and ask before hiding, never hide silently.
 * - `"gone"`: the record names a worktree id, the live list was read successfully, and that id is not in it — the
 *   shared worktree this loop's runs all point to was already removed by discarding another one of its cards.
 *   Genuinely nothing left to revert: safe for the caller to hide without asking.
 * - `"unreadable"`: the record or the live list could not be read. Unknown state: never hide, never offer to.
 */
export function discardTarget(
  run: LoopRunIndexEntry,
  fields: { ok: true; worktree: FactoryRunFields["worktree"] } | { ok: false },
  worktrees: { ok: true; list: readonly RunInfo[] } | { ok: false },
  runsOfThisLoop: readonly Pick<LoopRunIndexEntry, "id" | "loopId" | "startedAt">[],
  runningLoopId: string | null,
): DiscardTarget {
  if (!fields.ok) return { kind: "unreadable" };
  const worktreeRunId = fields.worktree?.runId ?? null;
  if (!worktreeRunId) return { kind: "no-worktree" };
  if (!worktrees.ok) return { kind: "unreadable" };
  const info = worktrees.list.find((w) => w.runId === worktreeRunId);
  if (!info) return { kind: "gone" };
  const refusal = branchDiscardRefusal(info, runsOfThisLoop, run, runningLoopId);
  return refusal ? { kind: "refused", reason: refusal } : { kind: "ok", info };
}
