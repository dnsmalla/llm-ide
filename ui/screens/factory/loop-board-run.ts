// Pure logic of the run bar on a non-Factory loop's Board. The Board never runs anything itself: it builds a
// "run-loop" request that the shell answers through the run manager (approval, worktree, queue and ship are the manager's).
import { loopUsesInputPath, normalizeInputPath } from "../loop/native/input-path.ts";
import { RUN_COMMAND_MAX } from "../loop/native/run-command.ts";
import { branchDiscardRefusal, isNewestRunOfLoop } from "../loop/native/loop-branch.ts";
import { decodeFactoryFields, type FactoryRunFields, type LoopRunIndexEntry } from "../loop/native/history.ts";
import type { LoopDefinition } from "../loop/native/model.ts";
import type { RunInfo } from "../loop/native/worktree-run.ts";
import type { WorktreeStatus } from "../loop/native/ship-model.ts";
import { LANE_DONE, LANE_WAITING, stepLane, type CardAction, type CardView, type Lane } from "./board-model.ts";
import { decodeRunRecordFacts, type ShipStatus } from "./columns.ts";

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

/** The lane of a run held for a person's approval (Final review: Human), placed just before Done. */
export const WAITING_LANE = "Waiting for you";

/**
 * What the board shows for a run recorded as `awaiting_review` (a held run), or null for any other run (or a record
 * that could not be read). Every run of a loop shares one branch, so only the loop's newest run still holds it:
 * - `waiting`: held for your approval (Final review: Human); Approve ships the branch.
 * - `reviewDiff`: held because the worktree had files an earlier run left; it ships only after a person looks at the
 *   diff (the Loop page's Ship panel), never with one click.
 * - `superseded`: a later run of the loop has the branch now, or the branch was discarded: nothing left to approve.
 * - `shipped`: already shipped (from this board or the Ship panel).
 */
export type HeldState =
  | { kind: "waiting"; worktreeRunId: string; mergedMr: string | null }
  | { kind: "reviewDiff" }
  | { kind: "superseded" }
  | { kind: "shipped" };

export function heldState(
  run: Pick<LoopRunIndexEntry, "id" | "loopId" | "statusCode">,
  record: Record<string, unknown> | null,
  runsOfLoop: readonly Pick<LoopRunIndexEntry, "id" | "loopId" | "startedAt">[],
): HeldState | null {
  if (run.statusCode !== "awaiting_review" || record === null) return null;
  const fields = decodeFactoryFields(record);
  if (fields.ship) return { kind: "shipped" };
  if (!fields.worktree || !isNewestRunOfLoop(runsOfLoop, run)) return { kind: "superseded" };
  const awaiting = typeof record.awaiting === "object" && record.awaiting !== null ? record.awaiting as Record<string, unknown> : {};
  if (awaiting.reason === "leftoverFiles") return { kind: "reviewDiff" };
  return { kind: "waiting", worktreeRunId: fields.worktree.runId, mergedMr: typeof record.mergedMr === "string" && record.mergedMr ? record.mergedMr : null };
}

/** The board's lanes: the loop's steps, any other lane a card is in, then Waiting for you, then Done last. */
export function orderLanes(steps: readonly string[], cardLanes: readonly string[]): string[] {
  const done = "Done";
  const out = [...steps];
  for (const lane of cardLanes) if (!out.includes(lane) && lane !== done && lane !== WAITING_LANE) out.push(lane);
  if (cardLanes.includes(WAITING_LANE)) out.push(WAITING_LANE);
  if (cardLanes.includes(done) && !out.includes(done)) out.push(done);
  return out.length ? out : [done];
}

const DONE = "Done";

/** "just now" / "5m ago" / "3h ago" / "2d ago"; an unparseable value is shown as is. */
export function whenText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export const statusWord = (code: string): string => code === "success" ? "passed" : code.startsWith("blocked") ? "blocked" : code.startsWith("stopped") ? "stopped" : code === "aborted" ? "cancelled" : code === "awaiting_review" ? "awaiting review" : code === "running" ? "running" : "failed";
/** The status word of a held run. */
export const HELD_WORD: Record<HeldState["kind"], string> = { waiting: "awaiting review", reviewDiff: "review the diff", superseded: "not shipped", shipped: "shipped" };
const HELD_SUFFIX = / (Waiting for your review\.|Held: .*)$/;

/** The lane a run belongs to (by name): Done on success, Waiting for you when held, else its last executed or failed stage. */
export function laneOf(run: LoopRunIndexEntry, record: Record<string, unknown> | null, steps: readonly string[], held: HeldState | null): { lane: string; note: string } {
  if (run.statusCode === "success") return { lane: DONE, note: run.statusSummary };
  if (held?.kind === "waiting" || held?.kind === "reviewDiff") return { lane: WAITING_LANE, note: run.statusSummary };
  if (held?.kind === "shipped") return { lane: DONE, note: `${run.statusSummary.replace(HELD_SUFFIX, "")} Shipped.` };
  if (held?.kind === "superseded") return { lane: DONE, note: `${run.statusSummary.replace(HELD_SUFFIX, "")} Not shipped: a later run of this loop has its branch now, or the branch was discarded.` };
  const rows = Array.isArray(record?.stages) ? record.stages : [];
  let last: string | null = null;
  let failed: string | null = null;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const name = (row as { stageName?: unknown }).stageName;
    if (typeof name === "string" && name.trim()) last = name.trim();
    const exit = ((row as { run?: { exitCode?: unknown } }).run?.exitCode);
    if (typeof exit === "number" && exit !== 0) failed = last;
  }
  return { lane: failed ?? last ?? steps[0] ?? DONE, note: run.statusSummary };
}

const laneIdOf = (name: string): string => (name === DONE ? LANE_DONE : name === WAITING_LANE ? LANE_WAITING : stepLane(name));
const laneNameOf = (id: string): string => (id === LANE_DONE ? DONE : id === LANE_WAITING ? WAITING_LANE : id.slice("step:".length));

export interface LoopRunCardInput {
  run: LoopRunIndexEntry;
  record: Record<string, unknown> | null;
  steps: readonly string[];
  held: HeldState | null;
  /** What the Done lane shows for this run (doneState); null or absent for a card that is not finished. */
  done?: DoneState | null;
  /** The loop only checks (Regression, Plan): a finished card without an MR offers Done but never Discard. */
  checkOnly?: boolean;
  /** The loop's running card: it sits at `lane`, shows `note` and offers no action. */
  live?: { lane: string; note: string; /** How far the run is through its steps, 0..1. */ progress?: number | null };
  now?: number;
}

/**
 * What a finished card means for the Done lane, or null when the run is not finished (finished = passed, or held and
 * then shipped / superseded). Needs the MR's live status when the record names one:
 * - `mrOpen`: the MR is open (or its status is not known yet): the card stays until it is merged. `statusError`: the
 *   status check failed (MR deleted, token removed, provider down), so Done is offered too and only hides the card.
 * - `mrMerged`: merged: the card goes away by itself.
 * - `mrClosed`: closed without merging: the person ends the card with Done.
 * - `noMr`: the run opened no MR (the setting is off, a blocked ship, or a check-only loop): Done ends the card.
 */
export type DoneState = { kind: "mrOpen"; url: string; statusError?: true } | { kind: "mrMerged" } | { kind: "mrClosed" } | { kind: "noMr" };

export function doneState(
  run: Pick<LoopRunIndexEntry, "statusCode">,
  record: Record<string, unknown> | null,
  held: HeldState | null,
  shipStatus: ShipStatus | "error" | null | undefined,
): DoneState | null {
  const finished = run.statusCode === "success" || held?.kind === "shipped" || held?.kind === "superseded";
  if (!finished) return null;
  const url = decodeFactoryFields(record).ship?.url ?? null;
  if (!url) return { kind: "noMr" };
  if (shipStatus === "error") return { kind: "mrOpen", url, statusError: true };
  if (shipStatus) {
    if (shipStatus.state === "merged") return { kind: "mrMerged" };
    if (shipStatus.state === "closed") return { kind: "mrClosed" };
  }
  return { kind: "mrOpen", url };
}

function doneCardView(done: DoneState | null, checkOnly: boolean, hasWorktree: boolean): { actions: CardAction[]; note: string | null; request: { label: string } | null } | null {
  if (!done) return null;
  switch (done.kind) {
    case "mrOpen": return done.statusError
      ? { actions: ["done", "openRequest", "openLog"], note: "Its MR status could not be read; Done clears this card and keeps the branch.", request: { label: "MR status unknown" } }
      : { actions: ["openRequest", "openLog"], note: null, request: { label: "MR open — shown until merged" } };
    case "mrMerged": return { actions: ["openLog"], note: null, request: null };
    case "mrClosed": return { actions: ["done", "openLog", "discard"], note: "Its MR was closed without merging.", request: null };
    // A check-only run made before they moved to the project folder may still have its worktree: Discard removes it.
    case "noMr": return { actions: checkOnly && !hasWorktree ? ["done", "openLog"] : ["done", "openLog", "discard"], note: null, request: null };
  }
}

/** One run as a board card: the same CardView the Factory draws, so both boards render through Card. */
export function loopRunCardView(input: LoopRunCardInput): CardView {
  const { run, record, steps, held, live, now, done, checkOnly } = input;
  const at = live ?? laneOf(run, record, steps, held);
  const facts = decodeRunRecordFacts(record);
  const diff = decodeFactoryFields(record).diffSummary;
  const stopped = run.statusCode !== "success" && !held;
  const doneView = live ? null : doneCardView(done ?? null, checkOnly === true, decodeFactoryFields(record).worktree !== null);
  const actions: CardAction[] = live ? [] : doneView ? doneView.actions : held?.kind === "waiting" ? (checkOnly === true ? ["done", "openLog", "discard"] : ["approve", "openLog", "discard"]) : ["openLog", "discard"];
  const cost = typeof record?.costUsd === "number" && Number.isFinite(record.costUsd) ? record.costUsd : facts?.costUsd ?? null;
  const changed = facts?.changed ?? (diff ? { files: diff.files.length, additions: null, deletions: null, truncated: diff.truncated } : null);
  return {
    key: run.id,
    title: `${run.loopName} · ${whenText(run.startedAt, now)}`,
    source: "text",
    note: doneView?.note ? `${at.note} ${doneView.note}` : at.note,
    lane: laneIdOf(at.lane),
    ...(doneView?.request ? { request: doneView.request } : {}),
    status: held ? HELD_WORD[held.kind] : statusWord(run.statusCode),
    actions,
    durationSeconds: run.durationSeconds > 0 ? run.durationSeconds : null,
    costUsd: cost,
    progressLabel: `${run.iterationsUsed} iteration${run.iterationsUsed === 1 ? "" : "s"}`,
    ...(live?.progress != null ? { progress: live.progress } : {}),
    ...(changed ? { changed } : {}),
    ...(facts?.stepReviews ? { stepReviews: facts.stepReviews } : {}),
    ...(stopped && facts?.loopback ? { loopback: facts.loopback } : {}),
    ...(facts?.failingStage ? { failingStage: facts.failingStage } : {}),
  };
}

/** The board's lanes for a loop: its steps, other lanes, Waiting for you, Done last, each holding its cards in order. */
export function loopRunLanes(steps: readonly string[], cards: readonly CardView[]): Lane[] {
  return orderLanes(steps, cards.map((c) => laneNameOf(c.lane))).map((name) => {
    const id = laneIdOf(name);
    return { id, label: name, cards: cards.filter((c) => c.lane === id) };
  });
}

/** Said when Done finds work in the branch that was never shipped; nothing is removed then. */
export const UNSHIPPED_MESSAGE = "This run's branch still has unshipped changes: open the run to ship them, or Discard to remove them.";

/** What a Done click does, decided from the worktree check (and, for an MR loop, the worktree's status). */
export type DoneStep =
  | { kind: "error"; text: string }
  | { kind: "hide" }
  | { kind: "unshipped" }
  | { kind: "remove"; worktreeRunId: string };

/**
 * Done never deletes unshipped work. A worktree that cannot be read, or whose status cannot be read, changes nothing.
 * A card that is not this loop's newest run (`refused`), or whose worktree is gone or never existed, is only hidden.
 * A check-only loop's Done only hides the card: it works on the project folder, so an old worktree of it (from before
 * that rule) stays until the person discards it. Any other loop's worktree is removed only when it has no changed
 * files and no unpushed commits.
 */
export function doneStep(target: DiscardTarget, checkOnly: boolean, status: WorktreeStatus | null): DoneStep {
  switch (target.kind) {
    case "unreadable": return { kind: "error", text: "Could not check this run's worktree; try again." };
    case "refused":
    case "gone":
    case "no-worktree": return { kind: "hide" };
    case "ok":
      if (checkOnly) return { kind: "hide" };
      if (status === null) return { kind: "error", text: "Could not read this run's worktree status; nothing was removed." };
      return status.changedFiles > 0 || status.localCommits > 0 ? { kind: "unshipped" } : { kind: "remove", worktreeRunId: target.info.runId };
  }
}

/** Said when a worktree removal finds the loop started a run in the meantime. */
export const LOOP_BUSY_MESSAGE = "This loop started a run; try again when it ends.";
/** Said when Approve is pressed on an old held run of a check-only loop. */
export const CHECK_ONLY_APPROVE_MESSAGE = "Plan and Regression no longer open merge requests; use Done to clear this card.";
