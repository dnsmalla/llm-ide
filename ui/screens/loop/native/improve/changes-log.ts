// The accepted Loop changes log, `<project>/system/self-improvement/changes.jsonl` (plan 2026-11-19, phase 3): one
// JSON line per accept, adopt, revert or outcome, appended by the app only (agents cannot write the folder). It is the
// shareable record of what the Loop learned; the core DB keeps the bookkeeping (status, baseline, offers). Each line
// carries the decide call it was made with, so a decision the DB missed (the app quit, the core was down) is sent
// again on the next panel load instead of leaving the change applied but unrecorded.
import { redactSecrets } from "../../../chat/approvals/redact.ts";
import type { LoopFs } from "../store.ts";
import { beforeLearnedWrite, createSelfImprovementFolder } from "../lessons.ts";
import type { ImprovementChange } from "./change.ts";
import type { ImproveRow, ImproveState } from "./panel-model.ts";

export const CHANGES_FILE = "system/self-improvement/changes.jsonl";
const MAX_FILE = 4_000_000;
const MAX_EXCERPTS = 5;
const EXCERPT_CHARS = 500;
const RATIONALE_CHARS = 2000;

export type ChangeAction = "accept" | "adopt" | "revert" | "outcome";
export interface ChangeLine {
  id: string;
  action: ChangeAction;
  at: string;
  loopId: string;
  loopKey: string | null;
  stageKey: string | null;
  change?: ImprovementChange;
  rationale?: string;
  excerpts?: string[];
  scope?: string;
  origin?: string;
  /** The body sent to /kb/loop/improve/decide (without projectRoot), for the re-send. */
  decide?: Record<string, unknown>;
  verdict?: string;
}

const clip = (s: string, n: number) => redactSecrets(s).slice(0, n);

/** A line for `action` on `row`; text is redacted and capped (the folder is meant to be shared). */
export function changeLine(action: Exclude<ChangeAction, "outcome">, row: Pick<ImproveRow, "id" | "loopId" | "stageKey" | "change" | "rationale" | "evidence" | "origin"> & { templateKey?: string | null },
  decide: Record<string, unknown> | null, extra: { scope?: string; loopKey?: string | null; at?: string } = {}): ChangeLine {
  return {
    id: String(row.id), action, at: extra.at ?? new Date().toISOString(), loopId: row.loopId,
    loopKey: extra.loopKey ?? row.templateKey ?? null, stageKey: row.stageKey ?? null, change: row.change,
    rationale: clip(row.rationale ?? "", RATIONALE_CHARS),
    excerpts: (row.evidence?.excerpts ?? []).slice(0, MAX_EXCERPTS).map((e) => clip(String(e), EXCERPT_CHARS)),
    ...(extra.scope ? { scope: extra.scope } : {}), ...(row.origin ? { origin: row.origin } : {}), ...(decide ? { decide } : {}),
  };
}

const codeOf = (e: unknown): string => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "");

/** Every well-formed line, oldest first. A missing file is empty; a malformed line is skipped, never dropped from disk. */
export async function readChangeLog(fs: LoopFs): Promise<ChangeLine[]> {
  let read;
  try { read = await fs.read(CHANGES_FILE, MAX_FILE); } catch (e) {
    if (codeOf(e) === "missing" || codeOf(e) === "not_found") return [];
    throw e;
  }
  if (read.status !== "ok" || read.text === null) return [];
  return parseChangeLog(read.text);
}

export function parseChangeLog(text: string): ChangeLine[] {
  const out: ChangeLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const v = JSON.parse(raw) as ChangeLine;
      if (typeof v?.id === "string" && typeof v.action === "string" && typeof v.loopId === "string") out.push(v);
    } catch { /* a hand-damaged line is skipped */ }
  }
  return out;
}

/** Appends lines (hash-checked; one retry on a concurrent append). Creates the folder for the first line. */
export async function appendChangeLines(fs: LoopFs, lines: readonly ChangeLine[]): Promise<void> {
  if (lines.length === 0) return;
  const add = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await beforeLearnedWrite();
  for (let attempt = 0; ; attempt++) {
    let text = "";
    let hash: string | null = null;
    try {
      const read = await fs.read(CHANGES_FILE, MAX_FILE);
      if (read.status !== "ok" || read.text === null || read.hash === null) throw new Error("system/self-improvement/changes.jsonl is not readable text; fix or remove it");
      text = read.text; hash = read.hash;
    } catch (e) {
      if (codeOf(e) !== "missing" && codeOf(e) !== "not_found") throw e;
    }
    const next = text === "" || text.endsWith("\n") ? text + add : `${text}\n${add}`;
    try {
      await fs.write(CHANGES_FILE, next, { expected_hash: hash, encoding: "utf-8", bom: false });
      return;
    } catch (e) {
      if (hash === null && fs.create && attempt === 0 && codeOf(e) !== "conflict" && codeOf(e) !== "exists") {
        await createSelfImprovementFolder(fs);
        continue;
      }
      if ((codeOf(e) === "conflict" || codeOf(e) === "exists") && attempt < 2) continue;
      throw e;
    }
  }
}

/** The newest decision line per improvement id (accept/adopt/revert), ignoring outcome lines. */
function lastDecisions(log: readonly ChangeLine[]): Map<string, ChangeLine> {
  const m = new Map<string, ChangeLine>();
  for (const l of log) if (l.action !== "outcome") m.set(l.id, l);
  return m;
}

/**
 * Decide bodies the DB has not recorded yet, from the log against the DB state: an accept whose row is still a
 * proposal, an adopt whose offer is still offered, a revert whose row is still accepted.
 */
export function unrecordedDecisions(log: readonly ChangeLine[], state: ImproveState): Record<string, unknown>[] {
  const last = lastDecisions(log);
  const proposals = new Set(Object.values(state.loops).flatMap((l) => l.proposals.map((r) => String(r.id))));
  const accepted = new Set(Object.values(state.loops).flatMap((l) => l.history.filter((r) => r.status === "accepted").map((r) => String(r.id))));
  const offered = new Set(state.offers.map((r) => String(r.id)));
  const out: Record<string, unknown>[] = [];
  for (const [id, l] of last) {
    if (!l.decide) continue;
    // An adopt's line carries the new row's id; the DB still lists it under the offer's id until it is recorded.
    const offerId = String(l.decide.id ?? id);
    // Only the decide fields go out (the file is data: a `projectRoot` or anything else in it is never sent).
    const { action, id: did, scope, loopId, newId, logged } = l.decide as Record<string, unknown>;
    const body = Object.fromEntries(Object.entries({ action, id: did, scope, loopId, newId, logged }).filter(([, v]) => v !== undefined));
    if ((l.action === "accept" && proposals.has(id)) || (l.action === "adopt" && offered.has(offerId)) || (l.action === "revert" && accepted.has(id))) out.push(body);
  }
  return out;
}

/** Outcome lines for verdicts the DB reached that the log does not have yet. */
export function newOutcomeLines(log: readonly ChangeLine[], state: ImproveState, at = new Date().toISOString()): ChangeLine[] {
  const known = new Set(log.filter((l) => l.action === "outcome").map((l) => l.id));
  const out: ChangeLine[] = [];
  for (const l of Object.values(state.loops)) {
    for (const r of l.history) {
      const verdict = r.outcome?.verdict;
      if (!verdict || verdict === "not_enough_data" || known.has(String(r.id))) continue;
      out.push({ id: String(r.id), action: "outcome", at, loopId: r.loopId, loopKey: r.templateKey ?? null, stageKey: r.stageKey ?? null, verdict });
    }
  }
  return out;
}
