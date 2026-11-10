// The desktop half of a desktop-claimed bus command (B5, `issues.implement`): poll the core for approved Factory
// commands, claim one with a lease, start a Factory run for each issue, report stage progress (which is also the
// heartbeat) and write the one terminal event. Pure: every host, core, file and run-manager call is injected, so node
// tests load this module without the shell. `ship` is never honoured: the run stops at Ready to ship and a desktop
// click is still the only Ship.
import type { RunMode } from "./run-manager.ts";

export interface ClaimedCommand { id: string; kind: string; args: { projectId?: string; issueIds?: string[]; ship?: boolean }; /** The registered folder of args.projectId (the desktop only starts a command in the open project). */ projectRoot: string | null }

export interface BusRunnerDeps {
  /** POST/GET the core's bus routes (the host proof is added by the core client's transport). */
  requestRaw(path: string, opts?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }>;
  /** The open project; a claimed command only starts in the project it names. */
  activeProject(): string | null;
  /** The live runs (their log's last `$ <stage>` line is the progress step). */
  live(): readonly { runId: string; projectRoot: string; log: readonly string[] }[];
  concurrency(): number;
  /** Store the issues as Factory cards and start one `full` run each; returns the run ids it started. */
  sendItems(projectRoot: string, issueIds: readonly string[]): Promise<{ runIds: string[]; missing: string[] }>;
  now(): number;
  /** A message for the board (a claim that could not start, a missing issue). */
  notice?(message: string): void;
}

interface Claim { command: ClaimedCommand; token: string; projectRoot: string; runIds: string[]; lastProgressAt: number; lastStep: string | null }
interface Finished { statusCode: string; statusSummary: string }

const PROGRESS_EVERY_MS = 30_000;
/** A claimed command whose runs never report (a crash between the claim and the run) is finished on this timer. */
const CLAIM_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_PER_POLL = 4;

let claims = new Map<string, Claim>();
let finished = new Map<string, Finished>();

/** The run manager's `onRunFinished` hook, so a claim can finish the moment its last run ends. */
export function noteRunFinished(runId: string, statusCode: string, statusSummary = ""): void {
  finished.set(runId, { statusCode, statusSummary });
}

export function resetBusRunnerForTests(): void {
  claims = new Map();
  finished = new Map();
}

/** The live claims (tests and the board's diagnostics). */
export function activeClaims(): readonly { commandId: string; projectRoot: string; runIds: readonly string[] }[] {
  return [...claims.values()].map((c) => ({ commandId: c.command.id, projectRoot: c.projectRoot, runIds: c.runIds }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A claimable row from GET /bus/claimable, or null when it is malformed. */
export function decodeClaimable(body: unknown): ClaimedCommand[] {
  const rows = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const out: ClaimedCommand[] = [];
  for (const r of rows) {
    if (!isRecord(r) || typeof r.id !== "string" || typeof r.kind !== "string" || !isRecord(r.args)) continue;
    const issues = Array.isArray(r.args.issueIds) ? r.args.issueIds.filter((x): x is string => typeof x === "string") : [];
    out.push({ id: r.id, kind: r.kind, args: { projectId: typeof r.args.projectId === "string" ? r.args.projectId : undefined, issueIds: issues, ship: r.args.ship === true }, projectRoot: typeof r.projectRoot === "string" ? r.projectRoot : null });
  }
  return out;
}

/** How a finished run maps to the command's terminal state: a cancel is an interruption, not a failure. */
export function finishStateFor(statusCodes: readonly string[]): "succeeded" | "failed" | "interrupted" {
  if (statusCodes.some((s) => s === "aborted")) return "interrupted";
  return statusCodes.every((s) => s === "success") ? "succeeded" : "failed";
}

/** The result a finished command carries: the card is ready to ship, and nothing was shipped from the phone. */
export function finishResult(state: "succeeded" | "failed" | "interrupted", statusSummary = ""): Record<string, unknown> {
  if (state !== "succeeded") return { readyToShip: false, shipped: false, summary: statusSummary.slice(0, 500) };
  return { readyToShip: true, shipped: false };
}

/** The last stage a run reported (`$ Review` → `stage: Review`), or null before the first one. */
function lastStep(log: readonly string[]): string | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const line = log[i];
    if (typeof line === "string" && line.startsWith("$ ")) return `stage: ${line.slice(2).trim().slice(0, 120)}`;
  }
  return null;
}

async function post(deps: BusRunnerDeps, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    return await deps.requestRaw(path, { method: "POST", body });
  } catch {
    return { status: 0, body: null };
  }
}

/** Finishes one claim whose runs have all reported (or whose claim outlived the timeout). */
async function finishClaim(deps: BusRunnerDeps, claim: Claim): Promise<boolean> {
  const mine = claim.runIds.map((id) => finished.get(id) ?? null);
  const done = claim.runIds.length > 0 && mine.every((f) => f !== null);
  const expired = deps.now() - claim.lastProgressAt > CLAIM_TIMEOUT_MS;
  if (!done && !expired) return false;
  const statuses = mine.filter((f): f is Finished => f !== null).map((f) => f.statusCode);
  const state = expired && !done ? "interrupted" : finishStateFor(statuses);
  const summary = mine.filter((f): f is Finished => f !== null).map((f) => f.statusSummary).filter(Boolean).join("; ");
  const r = await post(deps, `/bus/commands/${claim.command.id}/finish`, { claimToken: claim.token, state, result: finishResult(state, summary) });
  // 200 = finished; 409 LEASE_LOST = the lease or the command is gone, so nothing is left to report.
  if (r.status === 200 || r.status === 409) {
    if (r.status === 409 && state === "succeeded") {
      const leaseLost = (r.body as { error?: { code?: string } } | null)?.error?.code === "LEASE_LOST";
      deps.notice?.(leaseLost ? "The phone command timed out, the run finished: Ready to ship." : "The phone command is no longer active; the run finished.");
    }
    claims.delete(claim.command.id);
    for (const id of claim.runIds) finished.delete(id);
    return true;
  }
  return false;
}

/** Reports one progress step when it changed or the heartbeat is due (the report renews the lease). */
async function reportProgress(deps: BusRunnerDeps, claim: Claim, live: readonly { runId: string; log: readonly string[] }[]): Promise<boolean> {
  const step = claim.runIds.map((id) => lastStep(live.find((r) => r.runId === id)?.log ?? [])).find((s) => s !== null) ?? null;
  const now = deps.now();
  if (step === claim.lastStep && now - claim.lastProgressAt < PROGRESS_EVERY_MS) return false;
  const r = await post(deps, `/bus/commands/${claim.command.id}/events`, { claimToken: claim.token, type: "progress", payload: { step: step ?? "run started" } });
  if (r.status === 200) {
    claim.lastProgressAt = now;
    claim.lastStep = step;
    return true;
  }
  if (r.status === 409) claims.delete(claim.command.id); // the lease is gone; the sweep will interrupt it
  return false;
}

/** Claims one command and starts its runs; false when the claim or the start failed. */
async function claimOne(deps: BusRunnerDeps, command: ClaimedCommand, projectRoot: string): Promise<boolean> {
  const claim = await post(deps, `/bus/commands/${command.id}/claim`, {});
  if (claim.status !== 200 || !isRecord(claim.body) || typeof claim.body.claimToken !== "string") {
    if (claim.status === 409 || claim.status === 403 || claim.status === 404) deps.notice?.(`The Factory command ${command.id} could not be claimed (${claim.status}).`);
    return false;
  }
  const token = claim.body.claimToken;
  const issueIds = command.args.issueIds ?? [];
  const started = await deps.sendItems(projectRoot, issueIds);
  if (started.runIds.length === 0) {
    // Nothing could start (the issues are gone, or a run was refused): finish the command so it does not hold the lease.
    const reason = started.missing.length > 0 ? `No Factory run started: ${started.missing.length} issue(s) were not found.` : "No Factory run started.";
    await post(deps, `/bus/commands/${command.id}/finish`, { claimToken: token, state: "failed", errorCode: "not_found", result: finishResult("failed", reason) });
    deps.notice?.(reason);
    return false;
  }
  claims.set(command.id, { command, token, projectRoot, runIds: started.runIds, lastProgressAt: deps.now(), lastStep: null });
  if (started.missing.length > 0) await post(deps, `/bus/commands/${command.id}/events`, { claimToken: token, type: "progress", payload: { step: `${started.missing.length} issue(s) not found` } });
  return true;
}

/**
 * One poll of the 60 s timer: finish the claims whose runs ended, heartbeat/progress the others, then claim new
 * commands for the open project within the free run slots.
 * @returns counts for the log (`claimed`, `progressed`, `finished`)
 */
export async function pollOnce(deps: BusRunnerDeps): Promise<{ claimed: number; progressed: number; finished: number }> {
  const out = { claimed: 0, progressed: 0, finished: 0 };
  const live = deps.live();
  for (const claim of [...claims.values()]) {
    if (await finishClaim(deps, claim)) { out.finished += 1; continue; }
    if (await reportProgress(deps, claim, live)) out.progressed += 1;
  }
  const projectRoot = deps.activeProject();
  if (!projectRoot) return out;
  // The cap is shared with the board's own runs: a claimed command only starts in a free slot of the open project.
  const free = Math.max(0, deps.concurrency() - live.filter((r) => r.projectRoot === projectRoot).length);
  if (free === 0) return out;
  const list = await deps.requestRaw("/bus/claimable", { method: "GET" });
  if (list.status !== 200) return out;
  const mine = decodeClaimable(list.body).filter((c) => c.projectRoot === projectRoot && !claims.has(c.id));
  for (const command of mine.slice(0, Math.min(free, MAX_PER_POLL))) {
    if (await claimOne(deps, command, projectRoot)) out.claimed += 1;
  }
  return out;
}

/** Maps the core's cached ticket rows to the work items a Factory run takes, in the command's id order. */
export function issueRowsFor(body: unknown, issueIds: readonly string[]): { rows: Record<string, unknown>[]; missing: string[] } {
  const all = isRecord(body) && Array.isArray(body.issues) ? body.issues.filter(isRecord) : [];
  const byId = new Map(all.map((r) => [typeof r.id === "string" ? r.id : "", r]));
  const rows: Record<string, unknown>[] = [];
  const missing: string[] = [];
  for (const id of issueIds) {
    const row = byId.get(id);
    if (!row || row.isPR === true || typeof row.title !== "string" || !row.title.trim()) { missing.push(id); continue; }
    rows.push(row);
  }
  return { rows, missing };
}

/** The `RunMode` a claimed command starts with. Kept here so the semantics are testable without the run manager. */
export const CLAIM_RUN_MODE: RunMode = "full";
