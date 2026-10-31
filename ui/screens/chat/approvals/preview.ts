// What a card shows of a tool call's arguments: redacted, hidden characters escaped, size capped. The structure
// (diff / write / command / json) is decided here so the component only lays it out. Pure.
import type { PendingApproval } from "../state";
import { redactSecretsCounted, redactValueDetailed } from "./redact";
import { sanitizeText, type Sanitized } from "./sanitize";

/** Shown text per block before "Show all"; and the hard ceiling once expanded. */
export const PREVIEW_COLLAPSED_CHARS = 2_000;
export const PREVIEW_MAX_CHARS = 40_000;
/** Lines shown before a block is collapsed behind "Show all". */
export const PREVIEW_COLLAPSED_LINES = 12;

export type Block = Sanitized & {
  caption: string;
  tone?: "removed" | "added";
  /** Secret-shaped spans replaced by [REDACTED] in this block (shown as "N secrets redacted"). */
  redactions: number;
  /** Things cut by a bound, in plain words ("3 more items hidden"); never empty when something was hidden. */
  hidden: string[];
};

export type Preview =
  | { kind: "diff"; file: Sanitized | null; blocks: Block[]; replaceAll: boolean }
  | { kind: "write"; file: Sanitized | null; block: Block; exists: boolean; totalChars: number | null }
  | { kind: "command"; block: Block }
  | { kind: "json"; block: Block }
  | { kind: "summary"; block: Block }
  | { kind: "none" };

const clean = (v: unknown, cap: number): Sanitized => {
  if (typeof v !== "string") return sanitizeText(v, cap);
  // Redact the whole value first, then cut: a cut could otherwise split a secret and leave half of it showing.
  return sanitizeText(redactSecretsCounted(v).text, cap);
};
const block = (caption: string, v: unknown, tone?: Block["tone"], extra: { redactions?: number; hidden?: string[] } = {}): Block => {
  const red = typeof v === "string" ? redactSecretsCounted(v).count : 0;
  return { ...clean(v, PREVIEW_MAX_CHARS), caption, tone, redactions: red + (extra.redactions ?? 0), hidden: extra.hidden ?? [] };
};

export function buildPreview(a: Pick<PendingApproval, "args" | "argsSummary" | "toolName">): Preview {
  const args = a.args;
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    const file = typeof o.filePath === "string" ? clean(o.filePath, 1_000) : typeof o.file_path === "string" ? clean(o.file_path, 1_000) : null;
    if (typeof o.oldString === "string" || typeof o.newString === "string") {
      const blocks: Block[] = [];
      if (typeof o.oldString === "string") blocks.push(block("Removed", o.oldString, "removed"));
      if (typeof o.newString === "string") blocks.push(block("Replacement", o.newString, "added"));
      return { kind: "diff", file, blocks, replaceAll: o.replaceAll === true };
    }
    if (typeof o.contentPreview === "string") {
      return { kind: "write", file, block: block("New content", o.contentPreview, "added"), exists: o.exists === true, totalChars: typeof o.totalChars === "number" ? o.totalChars : null };
    }
    if (typeof o.command === "string") return { kind: "command", block: { ...block("Command", o.command), truncated: o.truncated === true || o.command.length > PREVIEW_MAX_CHARS } };
    let text = "";
    let extra: { redactions: number; hidden: string[] } = { redactions: 0, hidden: [] };
    try {
      const rv = redactValueDetailed(o);
      text = JSON.stringify(rv.value, null, 2);
      const hidden: string[] = [];
      if (rv.hiddenItems) hidden.push(`${rv.hiddenItems} more items hidden`);
      if (rv.hiddenKeys) hidden.push(`${rv.hiddenKeys} keys hidden`);
      if (rv.omittedNested) hidden.push(`${rv.omittedNested} nested values omitted`);
      extra = { redactions: rv.redactions, hidden };
    } catch { text = "[arguments could not be shown]"; }
    // `text` is already redacted: block() would count nothing new unless the JSON text still held a secret shape.
    if (text && text !== "{}") return { kind: "json", block: block("Arguments", text, undefined, extra) };
  }
  if (a.argsSummary) return { kind: "summary", block: block("Summary", a.argsSummary) };
  return { kind: "none" };
}

const lines = (v: unknown): number => (typeof v === "string" && v.length > 0 ? v.split("\n").length : 0);
const len = (v: unknown): number => (typeof v === "string" ? v.length : 0);

/** Size of an edit for a one-line summary: lines removed/added and characters touched. MultiEdit sums its `edits`. */
export function editStats(args: unknown): { removed: number; added: number; chars: number } {
  const o = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const parts: Record<string, unknown>[] = Array.isArray(o.edits) ? (o.edits.filter((e) => e && typeof e === "object") as Record<string, unknown>[]) : [o];
  let removed = 0, added = 0, chars = 0;
  for (const e of parts) {
    const oldS = e.oldString ?? e.old_string, newS = e.newString ?? e.new_string;
    removed += lines(oldS); added += lines(newS); chars += len(oldS) + len(newS);
  }
  return { removed, added, chars };
}
