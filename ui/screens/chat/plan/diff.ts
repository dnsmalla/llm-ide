// Edit previews from tool calls: counts ("+N -M lines", the Mac's `DiffStats`) and a lazily built line diff.
// Bounded: the DP table is capped, anything bigger degrades to "replaced block" instead of freezing the UI, and
// the rendered diff is capped in lines. Pure.

export const SPLIT = /\r\n|\r|\n/;
/** DP cells allowed for an exact diff (about 8 MB as Uint16 rows). */
export const MAX_DP_CELLS = 4_000_000;
export const PREVIEW_LINES = 3;
export const MAX_DIFF_ROWS = 400;

export type DiffOp = " " | "+" | "-";
export interface DiffRow { op: DiffOp; text: string }

export interface DiffStats {
  added: number;
  removed: number;
  /** First changed lines as "+ x" / "- y" (the Mac's chip preview). */
  previewLines: string[];
  /** The middle was too big for an exact diff: counts are the size of the replaced block. */
  approximate: boolean;
}

/** Diff rows for two texts (full, no context trimming). */
export function diffRows(oldText: string, newText: string): { rows: DiffRow[]; approximate: boolean } {
  const a = oldText === "" ? [] : oldText.split(SPLIT);
  const b = newText === "" ? [] : newText.split(SPLIT);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const head: DiffRow[] = a.slice(0, lo).map((t) => ({ op: " ", text: t }));
  const tail: DiffRow[] = a.slice(ea).map((t) => ({ op: " ", text: t }));
  const ma = a.slice(lo, ea), mb = b.slice(lo, eb);
  let mid: DiffRow[];
  let approximate = false;
  if (ma.length === 0 || mb.length === 0 || (ma.length + 1) * (mb.length + 1) <= MAX_DP_CELLS) {
    mid = lcsRows(ma, mb);
  } else {
    approximate = true;
    mid = [...ma.map((t): DiffRow => ({ op: "-", text: t })), ...mb.map((t): DiffRow => ({ op: "+", text: t }))];
  }
  return { rows: head.concat(mid, tail), approximate };
}

function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length, m = b.length;
  if (n === 0) return b.map((t) => ({ op: "+", text: t }));
  if (m === 0) return a.map((t) => ({ op: "-", text: t }));
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

export function diffStats(oldText: string, newText: string, previewCount = PREVIEW_LINES): DiffStats {
  const { rows, approximate } = diffRows(oldText, newText);
  let added = 0, removed = 0;
  const previewLines: string[] = [];
  for (const r of rows) {
    if (r.op === " ") continue;
    if (r.op === "+") added++; else removed++;
    if (previewLines.length < previewCount) previewLines.push(`${r.op} ${r.text.slice(0, 200)}`);
  }
  return { added, removed, previewLines, approximate };
}

/** Rows with `context` unchanged lines around each change, capped; gaps become a "skip" marker row. */
export interface HunkView { rows: Array<DiffRow | { op: "skip"; count: number }>; hiddenChanges: number }

export function hunkView(rows: readonly DiffRow[], context = 3, maxRows = MAX_DIFF_ROWS): HunkView {
  const keep = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) if (rows[i].op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = 1;
  const out: HunkView["rows"] = [];
  let skipped = 0, shown = 0, hidden = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) { skipped++; continue; }
    if (skipped) { out.push({ op: "skip", count: skipped }); skipped = 0; }
    if (shown >= maxRows) { if (rows[i].op !== " ") hidden++; continue; }
    out.push(rows[i]); shown++;
  }
  if (skipped) out.push({ op: "skip", count: skipped });
  return { rows: out, hiddenChanges: hidden };
}

// --- tool calls -----------------------------------------------------------------------------------

export interface EditSpec { old: string; new: string }
export interface EditCall {
  path: string;
  kind: "edit" | "write";
  /** Edit / MultiEdit: replacement pairs. Write: one pair with an empty `old` (the previous content is not known). */
  edits: EditSpec[];
}

/** Tool names carry an optional `mcp__server__` prefix. */
const bare = (name: string): string => name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "");

/** The file edit a tool call makes, or null for any other tool or unreadable arguments (truncated JSON). */
export function editFromTool(name: string | null, argsJson: string, argsTruncated: boolean): EditCall | null {
  if (!name || argsTruncated) return null;
  const n = bare(name);
  if (n !== "Edit" && n !== "Write" && n !== "MultiEdit") return null;
  let a: unknown;
  try { a = JSON.parse(argsJson); } catch { return null; }
  if (typeof a !== "object" || a === null) return null;
  const o = a as Record<string, unknown>;
  const path = typeof o.file_path === "string" ? o.file_path : typeof o.path === "string" ? o.path : null;
  if (!path) return null;
  if (n === "Write") return typeof o.content === "string" ? { path, kind: "write", edits: [{ old: "", new: o.content }] } : null;
  if (n === "Edit") return typeof o.old_string === "string" && typeof o.new_string === "string" ? { path, kind: "edit", edits: [{ old: o.old_string, new: o.new_string }] } : null;
  if (!Array.isArray(o.edits)) return null;
  const edits: EditSpec[] = [];
  for (const e of o.edits.slice(0, 200)) {
    const x = e as Record<string, unknown>;
    if (typeof x?.old_string === "string" && typeof x.new_string === "string") edits.push({ old: x.old_string, new: x.new_string });
  }
  return edits.length ? { path, kind: "edit", edits } : null;
}

/** Totals for a call (all edits summed). A Write has no known "before", so only additions are counted. */
export function callStats(c: EditCall): DiffStats {
  let added = 0, removed = 0, approximate = false;
  const previewLines: string[] = [];
  for (const e of c.edits) {
    const s = diffStats(e.old, e.new, PREVIEW_LINES - previewLines.length > 0 ? PREVIEW_LINES - previewLines.length : 0);
    added += s.added; removed += s.removed; approximate = approximate || s.approximate;
    previewLines.push(...s.previewLines);
  }
  return { added, removed, previewLines: previewLines.slice(0, PREVIEW_LINES), approximate };
}
