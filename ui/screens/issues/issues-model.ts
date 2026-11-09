// The Issues data as the core returns it (`GET /kb/issues`) plus the board's column derivation. The Mac's board
// uses the label namespace shared by the most issues as its columns, falling back to Open/Closed; the same rule is
// applied here so the desktop board cannot invent a different shape from the same rows.
//
// Pure: decode and group only. No fetch and no DOM, so the model is tested with node.
export interface IssueMilestone {
  title: string;
  /** The milestone's due day as the core sent it (ISO 8601), or null. */
  dueOn: string | null;
}

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
  milestone: IssueMilestone | null;
  /** Assignee logins, plain text; never a link. */
  assignees: string[];
}

export interface IssueFilters {
  provider: "github" | "gitlab";
  state: "open" | "closed" | "all";
  repo: string;
  /**
   * True when `repo` came from the saved-repository select: the row's repo must then equal it exactly and
   * case-sensitively, as the core stores and matches it (and as the Gantt's buildRows compares), so `acme/web`
   * never also lists `acme/web-api` or `acme/web/sub`. False or absent: the free-text box's substring match.
   */
  repoExact?: boolean;
  label: string;
  query: string;
}

/** The core caps `GET /kb/issues` at this many rows a page whatever `limit` asks for (routes/router.mjs). */
export const CORE_LIST_CAP = 100;
/** The Mac's page budget per project (GanttViewModel maxIssuePages). */
export const MAX_PAGES = 20;
/** Most issues one list walk keeps: the page budget times the page size. */
export const MAX_LOADED = MAX_PAGES * CORE_LIST_CAP;
export const MAX_ISSUES = MAX_LOADED;
const MAX_LABELS = 20;
const MAX_ASSIGNEES = 50;
const MAX_TEXT = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 400): string => (typeof v === "string" ? v.slice(0, max) : "");

function httpUrl(v: unknown): string {
  // An over-long URL is dropped, not cut: a truncated link would open a different page.
  if (typeof v !== "string" || v.length > 2048) return "";
  const t = v;
  if (!t) return "";
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

const validDate = (v: unknown): string | null => {
  const t = text(v, 40);
  // ISO 8601 only: Date.parse alone accepts strings like "1" (year 2001).
  return t && /^\d{4}-\d{2}-\d{2}/.test(t) && Number.isFinite(Date.parse(t)) ? t : null;
};

/**
 * `{ issues: [...] }`; malformed rows are dropped, labels and assignees bounded, URLs restricted to http(s). A row
 * with neither id nor number is keyed by its position in the walk (`base` is the page's offset), so pages never collide.
 */
export function decodeIssues(body: unknown, base = 0): Issue[] {
  const list = isRecord(body) && Array.isArray(body.issues) ? body.issues : [];
  const out: Issue[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    let title = text(row.title, 500);
    if (!title) continue;
    const number = typeof row.number === "number" && Number.isInteger(row.number) ? row.number : null;
    if (number !== null) title = title.replace(new RegExp(`^#\\s*${number}\\b[\\s:.-]*`), "") || title;
    const labels = Array.isArray(row.labels)
      ? row.labels.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.slice(0, 80)).slice(0, MAX_LABELS)
      : [];
    const ms = isRecord(row.milestone) ? text(row.milestone.title, 200) : "";
    const assignees = Array.isArray(row.assignees)
      ? row.assignees.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.slice(0, 120)).slice(0, MAX_ASSIGNEES)
      : [];
    out.push({
      id: text(row.id, 200) || String(row.number ?? `row-${base + out.length}`),
      title,
      body: text(row.body, MAX_TEXT),
      url: httpUrl(row.url),
      provider: text(row.provider, 40) || "github",
      repo: text(row.repo, 200),
      number,
      state: text(row.state, 20) || "open",
      labels,
      author: text(row.author, 120) || null,
      createdAt: text(row.createdAt, 40) || null,
      updatedAt: text(row.updatedAt, 40) || null,
      isPR: row.isPR === true,
      milestone: ms ? { title: ms, dueOn: isRecord(row.milestone) ? validDate(row.milestone.dueOn) : null } : null,
      assignees,
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
    // The Mac puts "No status" FIRST and hides columns with no issues.
    if (loose.length) cols.unshift({ id: NO_STATUS, title: "No status", issues: loose });
    return cols.filter((c) => c.issues.length > 0);
  }
  return [
    { id: "open", title: "Open", issues: issues.filter((i) => i.state !== "closed") },
    { id: "closed", title: "Closed", issues: issues.filter((i) => i.state === "closed") },
  ].filter((c) => c.issues.length > 0);
}

/** The client-side filters on top of the server's provider/state query. Pull requests are not issues. */
export function filterIssues(issues: readonly Issue[], f: IssueFilters): Issue[] {
  const q = f.query.trim().toLowerCase();
  return issues.filter((i) => {
    if (i.isPR) return false;
    if (i.provider !== f.provider) return false;
    if (f.state !== "all" && i.state !== f.state) return false;
    if (f.repo && !repoMatches(i.repo, f.repo, f.repoExact === true)) return false;
    if (f.label && !i.labels.some((l) => l.toLowerCase() === f.label.trim().toLowerCase())) return false;
    if (q && !`${i.title} ${i.body} ${i.labels.join(" ")} #${i.number ?? ""} ${i.repo}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** The repo filter: exact (case-sensitive) for a chosen saved repository, else a case-insensitive substring. */
export function repoMatches(repo: string, filter: string, exact: boolean): boolean {
  return exact ? repo === filter : repo.toLowerCase().includes(filter.trim().toLowerCase());
}

/** Distinct labels of the loaded rows, for the label filter. */
export function labelOptions(issues: readonly Issue[]): string[] {
  return [...new Set(issues.filter((i) => !i.isPR).flatMap((i) => i.labels))].sort((a, b) => a.localeCompare(b, "en"));
}

/** Distinct repositories of the loaded rows, for the filter datalist. */
export function repoOptions(issues: readonly Issue[]): string[] {
  return [...new Set(issues.filter((i) => !i.isPR).map((i) => i.repo).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

/** A safe label for a card's number (`#12`), or "" when unknown. */
export function issueNumber(i: Issue): string {
  return i.number !== null ? `#${i.number}` : "";
}

/** The number of rows the core returned, before any row is dropped for lacking a title. Paging advances by this. */
export function rawIssueCount(body: unknown): number {
  return isRecord(body) && Array.isArray(body.issues) ? body.issues.length : 0;
}

const PAGE_SEGMENTS = new Set(["-", "tree", "blob", "issues", "merge_requests", "pulls", "pull", "commits", "wiki"]);

/**
 * The project path from a repository URL (https, optional .git and trailing slash), at any depth: `owner/name`, or a
 * GitLab nested group `group/subgroup/project`. The input itself when it has fewer than two path segments.
 */
export function repoSlug(url: string): string {
  const raw = url.trim();
  // https/ssh URLs (credentials dropped) and the scp form `git@host:group/project`, as the Mac's remoteKey reads them.
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.*)$/i.exec(raw) ?? /^(?:[^@/:\s]+@)?[^/:\s]+:(?!\/)(.*)$/.exec(raw);
  const segs = (m ? m[1]! : raw).split(/[?#]/)[0]!.split("/").filter((s) => s !== "");
  // A pasted web-page URL carries a page suffix (`/-/tree/main`, `/issues`, ...): cut at the first marker segment
  // after group/project, whole segments only (Mac ChangeShipping.remoteKey), so it is not read as a nested group.
  const cut = segs.findIndex((s, i) => i >= 2 && PAGE_SEGMENTS.has(s.toLowerCase()));
  if (cut >= 0) segs.length = cut;
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1]!.replace(/\.git$/i, "");
  if (segs.length < 2 || segs.some((s) => s === "" || s === "." || s === "..")) return raw;
  return segs.join("/");
}

const OVERLAY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * True when the core's schedule overlay (`/kb/issue-schedule`) accepts this repository for this provider. Mirrors
 * kb/issue-schedule.mjs assertRepo: GitHub is exactly owner/name; GitLab is 2 to 20 segments; every segment is
 * [A-Za-z0-9._-]+ and never "." or ".."; the whole repo is at most 255 characters. A key the core would 400 is false.
 */
export function overlayRepoSupported(repo: string, provider: string): boolean {
  if (provider !== "github" && provider !== "gitlab") return false;
  const segs = repo.split("/");
  const maxSegs = provider === "gitlab" ? 20 : 2;
  return repo.length <= 255
    && segs.length >= 2 && segs.length <= maxSegs
    && (provider === "gitlab" || segs.length === 2)
    && segs.every((s) => OVERLAY_SEGMENT.test(s) && s !== "." && s !== "..");
}

/**
 * A relative age as the Mac's RelativeDateTimeFormatter (.short, numeric) words it: the largest whole elapsed unit,
 * truncated — "1 day ago", "2 wk. ago", "3 mo. ago", "in 2 hr."; "" when the timestamp is missing or malformed.
 */
export function openedAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = t - now.getTime();
  const sign = ms < 0 ? -1 : 1;
  const sec = Math.floor(Math.abs(ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "short" });
  const days = Math.floor(sec / 86_400);
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] =
    sec < 60 ? [sec, "second"]
    : sec < 3_600 ? [Math.floor(sec / 60), "minute"]
    : sec < 86_400 ? [Math.floor(sec / 3_600), "hour"]
    : days < 7 ? [days, "day"]
    : days < 30 ? [Math.floor(days / 7), "week"]
    : days < 365 ? [Math.floor(days / 30), "month"]
    : [Math.floor(days / 365), "year"];
  return rtf.format(sign * n, unit);
}

/**
 * The URL behind "Open on GitHub/GitLab": the core's stored issue URL only when its origin (scheme, host, port) is
 * exactly https://github.com (GitHub; the Mac and the core importer support no other GitHub host) or the saved
 * GitLab base's origin (the user's own server, which may be http or a private address), with no credentials.
 * "" otherwise, and the button stays disabled.
 */
export function issueOpenUrl(issue: Pick<Issue, "url" | "provider">, gitlabOrigin: string | null): string {
  if (!issue.url) return "";
  let u: URL;
  try {
    u = new URL(issue.url);
  } catch {
    return "";
  }
  const expected = issue.provider === "gitlab" ? gitlabOrigin : "https://github.com";
  if (!expected || u.username || u.password || u.origin !== expected) return "";
  return u.toString();
}

/** A milestone's due day in the Mac's short form (`Nov 30, 2026`), local calendar; "" when absent or malformed. */
export function formatDueDate(iso: string | null): string {
  if (!iso) return "";
  // A bare day is a local calendar day (the Mac's parseDateOnly), not UTC midnight, so it never shows a day early.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(Date.parse(iso));
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** The create form's content as one string: the same repo, title and body always give the same fingerprint. */
export function createFingerprint(provider: string, repo: string, title: string, body: string): string {
  return JSON.stringify([provider, repo, title.trim(), body]);
}

/**
 * The idempotency key for a create. The key minted for this exact content is kept; an edited form (or a new one)
 * gets a fresh key, so a fixed retry is never replayed as a 409 IDEM_CONFLICT against the old content.
 */
export function idemKeyFor(
  prev: { fingerprint: string; key: string } | null,
  fingerprint: string,
  mint: () => string,
): { fingerprint: string; key: string } {
  return prev && prev.fingerprint === fingerprint ? prev : { fingerprint, key: mint() };
}

/**
 * What the create-issue key becomes after an attempt. Only a created issue or a 409 (the key is bound to other
 * content) ends it. A thrown error, a 5xx or any other failure is ambiguous: the server may have created the issue
 * before the answer was lost, so the same key must survive for the retry, even across Cancel and a reopened form.
 */
export type CreateOutcome = "created" | "conflict" | "failed";

export function createKeyAfter<K>(prev: K | null, outcome: CreateOutcome): K | null {
  return outcome === "created" || outcome === "conflict" ? null : prev;
}

/**
 * The banner for a finished GitHub import. The core upserts what it fetched and deletes nothing when it stops early
 * (page cap, row cap, time budget or a secondary limit), so a truncated import says so instead of reading "Imported N".
 */
export function importSummary(body: unknown): string {
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const n = typeof b.count === "number" ? b.count : typeof b.imported === "number" ? b.imported : null;
  const head = n !== null ? `Imported ${n.toLocaleString("en")} issue${n === 1 ? "" : "s"}` : "Issues imported";
  if (b.truncated !== true) return `${head}.`;
  const wait = typeof b.retryAfter === "number" && Number.isFinite(b.retryAfter) && b.retryAfter > 0
    ? ` GitHub asked to wait ${Math.ceil(b.retryAfter)} s before more requests.`
    : "";
  return `${head}, but the import stopped early, so the rest of the repository was not read.${wait} Import again to continue.`;
}

/** The banner for a failed request: the core's own `{ error: { message } }` when it sent one, else the fallback. */
export function errorMessageOf(body: unknown, fallback: string): string {
  const e = body && typeof body === "object" ? (body as { error?: { message?: unknown } }).error : undefined;
  return typeof e?.message === "string" && e.message.trim() !== "" ? e.message : fallback;
}

/** The card's assignee line: the first three logins, then how many more. Plain text. */
export function assigneeSummary(logins: readonly string[], shown = 3): string {
  const head = logins.slice(0, shown).join(", ");
  const more = logins.length - shown;
  return more > 0 ? `${head} +${more}` : head;
}
