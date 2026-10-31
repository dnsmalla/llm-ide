// The approval UI state machine and queue rules. Pure: the component holds one `QueueUi` in a reducer and the
// controller does the I/O. There is NO timeout transition anywhere: an approval never resolves by waiting
// (the core's own 15 minute deadline answers "expired", which only ever denies).
import type { PendingApproval } from "../state";
import { approvalDigest } from "./digest";
import { classifyApproval } from "./risk";

export type CardPhase = "idle" | "submitting" | "failed" | "expired";

export interface CardUi {
  phase: CardPhase;
  error: string | null;
  /** Digest of what the card showed when it was last displayed (the binding). */
  shown: string;
  /** "Always allow" is waiting for its exact-rule confirmation. */
  confirmingRule: boolean;
}

export interface QueueUi { cards: Readonly<Record<string, CardUi>> }

export const emptyQueueUi: QueueUi = { cards: {} };

export type UiAction =
  | { type: "show"; requestId: string; digest: string }
  | { type: "submitting"; requestId: string }
  | { type: "failed"; requestId: string; error: string }
  | { type: "expired"; requestId: string; error: string }
  | { type: "confirm_rule"; requestId: string; on: boolean }
  | { type: "prune"; keep: readonly string[] };

const blank = (digest: string): CardUi => ({ phase: "idle", error: null, shown: digest, confirmingRule: false });

export function reduceUi(s: QueueUi, a: UiAction): QueueUi {
  const set = (id: string, patch: Partial<CardUi>, base?: CardUi): QueueUi => {
    const cur = s.cards[id] ?? base;
    if (!cur) return s;
    return { cards: { ...s.cards, [id]: { ...cur, ...patch } } };
  };
  switch (a.type) {
    case "show": {
      const cur = s.cards[a.requestId];
      if (cur && cur.shown === a.digest) return s;
      // Shown again with different content: any earlier confirmation or in-flight state no longer applies.
      return { cards: { ...s.cards, [a.requestId]: blank(a.digest) } };
    }
    case "submitting": return set(a.requestId, { phase: "submitting", error: null });
    case "failed": return set(a.requestId, { phase: "failed", error: a.error });
    case "expired": return set(a.requestId, { phase: "expired", error: a.error, confirmingRule: false });
    case "confirm_rule": return set(a.requestId, { confirmingRule: a.on });
    case "prune": {
      const keep = new Set(a.keep);
      const ids = Object.keys(s.cards);
      if (ids.every((id) => keep.has(id))) return s;
      return { cards: Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, s.cards[id]])) };
    }
  }
}

export type Binding = { ok: true } | { ok: false; reason: "not_shown" | "changed" };

/** A decision may only be sent for what the user was shown: the pending request must still hash to the shown digest. */
export function checkBinding(ui: QueueUi, a: PendingApproval): Binding {
  const card = ui.cards[a.requestId];
  if (!card) return { ok: false, reason: "not_shown" };
  return card.shown === approvalDigest(a) ? { ok: true } : { ok: false, reason: "changed" };
}

/** The request the user answers next: the oldest one that is not expired. */
export function headOf(pending: readonly PendingApproval[], ui: QueueUi): PendingApproval | null {
  return pending.find((p) => ui.cards[p.requestId]?.phase !== "expired") ?? null;
}

export const MAX_BATCH = 50;
export const MIN_BATCH = 3;

/**
 * Requests that can be allowed together with one click: same tool, plain edits inside the project, nothing
 * destructive, no "replace all". Only offered from 3 up (below that the single cards are fast enough); at most
 * MAX_BATCH. Every member is still decided with its own request id and its own digest check.
 */
export function batchGroup(pending: readonly PendingApproval[], head: PendingApproval | null, projectRoot: string | null, ui: QueueUi): PendingApproval[] {
  if (!head || head.kind !== "ToolApproval") return [];
  const ok = (a: PendingApproval) => {
    if (a.kind !== "ToolApproval" || a.toolName !== head.toolName) return false;
    if (ui.cards[a.requestId]?.phase === "expired" || ui.cards[a.requestId]?.phase === "submitting") return false;
    const r = classifyApproval(a, projectRoot);
    return r.risk === "edit" && !r.destructive && r.reasons.length === 0;
  };
  if (!ok(head)) return [];
  const group = pending.filter(ok).slice(0, MAX_BATCH);
  return group.length >= MIN_BATCH ? group : [];
}

export interface QueueSummary {
  total: number;
  /** Count of requests that are risky or unusual (destructive, outside the project, replace-all...): reviewed one by one. */
  needsIndividualReview: number;
  questions: number;
}

export function summarize(pending: readonly PendingApproval[], projectRoot: string | null): QueueSummary {
  let needs = 0, q = 0;
  for (const a of pending) {
    if (a.kind === "AskUserQuestion") { q++; continue; }
    const r = classifyApproval(a, projectRoot);
    if (r.destructive || r.reasons.length > 0) needs++;
  }
  return { total: pending.length, needsIndividualReview: needs, questions: q };
}

/** The accessible name of the queue counter. */
export const counterText = (position: number, total: number): string => (total <= 1 ? "1 request waiting" : `Request ${position} of ${total} waiting`);

/** Focus trap: the next tab stop inside the card, wrapping both ways. */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/** Keyboard shortcuts on a focused card (Alt+key: plain letters stay free for the feedback field and for typing). */
export type CardKey = "allow" | "deny" | "rule" | "session";
export function shortcutFor(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): CardKey | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  switch (e.key.toLowerCase()) {
    case "y": return "allow";
    case "n": return "deny";
    case "a": return "rule";
    case "s": return "session";
    default: return null;
  }
}
