// The Issues data as the core returns it (`GET /kb/issues`) plus the board's column derivation. The Mac's board
// uses the label namespace shared by the most issues as its columns, falling back to Open/Closed; the same rule is
// applied here so the desktop board cannot invent a different shape from the same rows.
//
// Pure: decode and group only. No fetch and no DOM, so the model is tested with node.
export interface Issue {
  id: string;
  title: string;
  body: string;
  url: string;
  provider: string;
  repo: string;
  number: number | null;
  state: string;
  labels: string[];
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isPR: boolean;
}

export interface IssueFilters {
  provider: "github" | "gitlab";
  state: "open" | "closed" | "all";
  repo: string;
  query: string;
}

export const MAX_ISSUES = 500;
const MAX_LABELS = 20;
const MAX_TEXT = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 400): string => (typeof v === "string" ? v.slice(0, max) : "");

function httpUrl(v: unknown): string {
  const t = text(v, 2048);
  if (!t) return "";
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

/** `{ issues: [...] }`; malformed rows are dropped, labels bounded, URLs restricted to http(s). */
export function decodeIssues(body: unknown): Issue[] {
  const list = isRecord(body) && Array.isArray(body.issues) ? body.issues : [];
  const out: Issue[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const title = text(row.title, 500);
    if (!title) continue;
    const labels = Array.isArray(row.labels)
      ? row.labels.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.slice(0, 80)).slice(0, MAX_LABELS)
      : [];
    out.push({
      id: text(row.id, 200) || String(row.number ?? out.length),
      title,
      body: text(row.body, MAX_TEXT),
      url: httpUrl(row.url),
      provider: text(row.provider, 40) || "github",
      repo: text(row.repo, 200),
      number: typeof row.number === "number" && Number.isInteger(row.number) ? row.number : null,
      state: text(row.state, 20) || "open",
      labels,
      author: text(row.author, 120) || null,
      createdAt: text(row.createdAt, 40) || null,
      updatedAt: text(row.updatedAt, 40) || null,
      isPR: row.isPR === true,
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/** The label namespace shared by the most issues, e.g. `status` from `status::in-progress`. */
export function labelNamespace(issues: readonly Issue[]): string | null {
  const counts = new Map<string, number>();
  for (const i of issues) {
    const seen = new Set<string>();
    for (const l of i.labels) {
      const m = /^([^:/]{1,60})\s*(?:::|:)\s*\S/.exec(l);
      if (!m) continue;
      const ns = m[1]!.trim().toLowerCase();
      if (!seen.has(ns)) {
        seen.add(ns);
        counts.set(ns, (counts.get(ns) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [ns, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && ns < best)) {
      best = ns;
      bestCount = n;
    }
  }
  return best;
}

/** The value of `label` in `ns`, or null. */
export function labelValue(label: string, ns: string): string | null {
  const m = /^([^:/]{1,60})\s*(?:::|:)\s*(.+)$/.exec(label);
  if (!m || m[1]!.trim().toLowerCase() !== ns) return null;
  return m[2]!.trim() || null;
}

export interface IssueColumn {
  id: string;
  title: string;
  issues: Issue[];
}

const NO_STATUS = "__no_status";

/**
 * Board columns: the most common label namespace's values, or Open/Closed when no issue carries a namespaced
 * label. Issues with no value in that namespace go to "No status" (only when such issues exist). Empty columns
 * are kept for the two state columns so the board always reads as a board.
 */
export function columnsFor(issues: readonly Issue[]): IssueColumn[] {
  const ns = labelNamespace(issues);
  if (ns !== null) {
    const values = new Map<string, string>(); // lower -> display
    for (const i of issues) {
      for (const l of i.labels) {
        const v = labelValue(l, ns);
        if (v) values.set(v.toLowerCase(), v);
      }
    }
    const cols: IssueColumn[] = [...values.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], "en"))
      .map(([id, title]) => ({ id, title, issues: [] }));
    const loose: Issue[] = [];
    for (const i of issues) {
      const v = i.labels.map((l) => labelValue(l, ns)).find((x): x is string => x !== null);
      const col = v ? cols.find((c) => c.id === v.toLowerCase()) : undefined;
      if (col) col.issues.push(i);
      else loose.push(i);
    }
    if (loose.length) cols.push({ id: NO_STATUS, title: "No status", issues: loose });
    return cols;
  }
  return [
    { id: "open", title: "Open", issues: issues.filter((i) => i.state !== "closed") },
    { id: "closed", title: "Closed", issues: issues.filter((i) => i.state === "closed") },
  ];
}

/** The client-side filters on top of the server's provider/state query. Pull requests are not issues. */
export function filterIssues(issues: readonly Issue[], f: IssueFilters): Issue[] {
  const q = f.query.trim().toLowerCase();
  return issues.filter((i) => {
    if (i.isPR) return false;
    if (i.provider !== f.provider) return false;
    if (f.state !== "all" && i.state !== f.state) return false;
    if (f.repo && !i.repo.toLowerCase().includes(f.repo.trim().toLowerCase())) return false;
    if (q && !`${i.title} ${i.body} ${i.labels.join(" ")} #${i.number ?? ""} ${i.repo}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Distinct repositories of the loaded rows, for the filter datalist. */
export function repoOptions(issues: readonly Issue[]): string[] {
  return [...new Set(issues.filter((i) => !i.isPR).map((i) => i.repo).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

/** A safe label for a card's number (`#12`), or "" when unknown. */
export function issueNumber(i: Issue): string {
  return i.number !== null ? `#${i.number}` : "";
}
