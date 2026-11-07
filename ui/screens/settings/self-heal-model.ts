// The Self-Heal group's data (plan A: list, Ignore, Clear; plan B: proposals and the host answers of a fix run). Pure:
// decodes GET /kb/self-heal/incidents defensively and builds the display text. Incident text is untrusted data: it is
// cleaned (safeText) and rendered as text only.
import { safeText } from "../shell/safe-text.ts";
import type { SelfHealDiff, SelfHealPrepared, SelfHealVerified } from "./host.ts";

export type IncidentStatus = "new" | "fixing" | "proposed" | "ignored" | "needsHuman" | "fixed";
export type IncidentSource = "ui" | "log" | "crash" | "server";

export interface IncidentView {
  id: string;
  source: IncidentSource;
  category: string;
  message: string;
  stack: string[];
  environmental: string | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  attempts: number;
  status: IncidentStatus;
  note: string | null;
  /** Set on a `proposed` row only. */
  proposal: ProposalRef | null;
}

export interface ProposalRef {
  runId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
}

/** One fix proposal: a run's worktree and the incidents it fixes. */
export interface ProposalView {
  runId: string;
  worktreePath: string;
  incidentIds: string[];
  notes: string[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BRANCH = /^self-heal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

function decodeProposal(v: unknown): ProposalRef | null {
  if (!isRec(v) || typeof v.branch !== "string" || typeof v.worktreePath !== "string" || typeof v.baseCommit !== "string") return null;
  const m = BRANCH.exec(v.branch);
  return m && COMMIT.test(v.baseCommit) ? { runId: m[1], branch: v.branch, worktreePath: safeText(v.worktreePath, 1024), baseCommit: v.baseCommit } : null;
}

export const STATUS_TEXT: Readonly<Record<IncidentStatus, string>> = {
  new: "New",
  fixing: "Fixing",
  proposed: "Fix proposed",
  ignored: "Ignored",
  needsHuman: "Needs you",
  fixed: "Fixed",
};

export const SOURCE_TEXT: Readonly<Record<IncidentSource, string>> = { ui: "App", log: "Core log", crash: "Crash", server: "Core" };

const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_TEXT));
const SOURCES: ReadonlySet<string> = new Set(Object.keys(SOURCE_TEXT));
const ID = /^[0-9a-f]{16}$/;
const nat = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function decodeIncidents(raw: unknown): IncidentView[] {
  const list = raw && typeof raw === "object" ? (raw as { incidents?: unknown }).incidents : undefined;
  if (!Array.isArray(list)) return [];
  const out: IncidentView[] = [];
  for (const it of list.slice(0, 200)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const firstSeen = nat(o.firstSeen);
    const lastSeen = nat(o.lastSeen);
    const count = nat(o.count);
    const attempts = nat(o.attempts);
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.source !== "string" || !SOURCES.has(o.source)) continue;
    if (typeof o.status !== "string" || !STATUSES.has(o.status)) continue;
    if (firstSeen === null || lastSeen === null || count === null || attempts === null) continue;
    out.push({
      id: o.id,
      source: o.source as IncidentSource,
      status: o.status as IncidentStatus,
      category: safeText(o.category, 200),
      message: safeText(o.message, 2100),
      stack: typeof o.stack === "string" ? o.stack.split("\n").slice(0, 40).map((l) => safeText(l, 500)) : [],
      environmental: typeof o.environmental === "string" ? safeText(o.environmental, 40) : null,
      firstSeen,
      lastSeen,
      count,
      attempts,
      note: typeof o.note === "string" ? safeText(o.note, 600) : null,
      proposal: o.status === "proposed" ? decodeProposal(o.proposal) : null,
    });
  }
  return out;
}

export function incidentSummary(list: readonly IncidentView[]): string {
  if (list.length === 0) return "No incidents recorded.";
  const env = list.filter((i) => i.environmental !== null).length;
  const n = `${list.length} incident${list.length === 1 ? "" : "s"}`;
  return env > 0 ? `${n}, ${env} environmental (not app bugs).` : `${n}.`;
}

export function proposalsOf(list: readonly IncidentView[]): ProposalView[] {
  const by = new Map<string, ProposalView>();
  for (const i of list) {
    if (i.status !== "proposed" || !i.proposal) continue;
    const p = by.get(i.proposal.runId) ?? { runId: i.proposal.runId, worktreePath: i.proposal.worktreePath, incidentIds: [], notes: [] };
    p.incidentIds.push(i.id);
    if (i.note) p.notes.push(i.note);
    by.set(p.runId, p);
  }
  return [...by.values()];
}

export function decodePrepared(raw: unknown): SelfHealPrepared | null {
  if (!isRec(raw)) return null;
  const { mainRepo, worktreePath, branch, baseCommit } = raw;
  if (typeof mainRepo !== "string" || !mainRepo || typeof worktreePath !== "string" || !worktreePath) return null;
  if (typeof branch !== "string" || !BRANCH.test(branch) || typeof baseCommit !== "string" || !COMMIT.test(baseCommit)) return null;
  return { mainRepo, worktreePath, branch, baseCommit };
}

export function decodeVerified(raw: unknown): SelfHealVerified | null {
  if (!isRec(raw) || typeof raw.batch !== "string" || typeof raw.passed !== "boolean" || typeof raw.timedOut !== "boolean" || typeof raw.hasChanges !== "boolean") return null;
  return {
    batch: raw.batch.slice(0, 1_048_576),
    passed: raw.passed,
    timedOut: raw.timedOut,
    hasChanges: raw.hasChanges,
    reverted: Array.isArray(raw.reverted) ? raw.reverted.filter((p): p is string => typeof p === "string").slice(0, 100) : [],
    output: typeof raw.output === "string" ? raw.output.slice(-4000) : "",
  };
}

// Bidi and zero-width marks could make a reviewed line read differently from what applies: they show as U+FFFD.
const HIDDEN = /[​-‏‪-‮⁦-⁩﻿]/g;

export function decodeDiff(raw: unknown): SelfHealDiff | null {
  if (!isRec(raw) || typeof raw.text !== "string" || typeof raw.truncated !== "boolean" || typeof raw.patchId !== "string" || !/^[0-9a-f]{64}$/.test(raw.patchId)) return null;
  const files = Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 400).slice(0, 100) : [];
  return { text: raw.text.replace(HIDDEN, "�"), truncated: raw.truncated, patchId: raw.patchId, files };
}

/** Test files are allowed to change (a fix often needs it) but must be called out in the review. */
export function isTestFile(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return /(^|\/)tests?\//.test(p) || /\.test\.[^/]+$/.test(p) || /(^|\/)__tests__\//.test(p);
}
