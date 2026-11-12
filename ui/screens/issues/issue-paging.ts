// The Issues list walk over `GET /kb/issues`: page by offset until the core says there is no more, up to the Mac's
// 20 pages per project. Pure apart from the injected request, so node can test it; the screens own the React state.
import { CORE_LIST_CAP, MAX_LOADED, MAX_PAGES, decodeIssues, rawIssueCount, type Issue } from "./issues-model.ts";

export type PagingStop = "end" | "cap" | "aborted" | "error";

export interface PagingProgress {
  loaded: number;
  total: number | null;
}

export interface PagingResult {
  issues: Issue[];
  total: number | null;
  stop: PagingStop;
  /** The HTTP status of a failed page; null when the request itself threw (the core was not reachable). */
  status: number | null;
}

export interface IssuePage {
  issues: Issue[];
  /** Rows the core returned before any title-less row is dropped; this is what paging advances by. */
  raw: number;
  total: number | null;
  hasMore: boolean;
  nextOffset: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One page of the list. An old core that answers no total/hasMore is one final page. */
export function decodeIssuePage(body: unknown, offset = 0): IssuePage {
  const b = isRecord(body) ? body : {};
  const total = typeof b.total === "number" && Number.isInteger(b.total) && b.total >= 0 ? b.total : null;
  const nextOffset = typeof b.nextOffset === "number" && Number.isInteger(b.nextOffset) && b.nextOffset > 0 ? b.nextOffset : null;
  return {
    issues: decodeIssues(body, offset),
    raw: rawIssueCount(body),
    total,
    hasMore: b.hasMore === true,
    nextOffset,
  };
}

export type PageRequest = (method: "GET", path: string) => Promise<{ status: number; body: unknown }>;

export interface PagingOptions {
  signal?: AbortSignal;
  onProgress?: (p: PagingProgress) => void;
}

/**
 * Walk the list. The first request has no offset (the URL the core has always answered); later pages add one.
 * Stops at the last page, at the 20-page cap, when a page repeats rows already read or does not advance the
 * offset (a core that never says it is done cannot loop), on a failed page (the rows read so far are kept), or
 * when the signal is aborted (no request is sent after the abort).
 */
export async function loadIssuePages(request: PageRequest, q: { provider: string; state: string }, opts: PagingOptions = {}): Promise<PagingResult> {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  let offset = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (opts.signal?.aborted) return { issues, total, stop: "aborted", status: null };
    const qs = new URLSearchParams({ provider: q.provider, state: q.state, limit: String(CORE_LIST_CAP) });
    if (offset > 0) qs.set("offset", String(offset));
    let res: { status: number; body: unknown };
    try {
      res = await request("GET", `/kb/issues?${qs.toString()}`);
    } catch {
      return { issues, total, stop: "error", status: null };
    }
    if (opts.signal?.aborted) return { issues, total, stop: "aborted", status: null };
    if (res.status !== 200) return { issues, total, stop: "error", status: res.status };
    const p = decodeIssuePage(res.body, offset);
    total = p.total ?? total;
    let fresh = 0;
    for (const i of p.issues) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      issues.push(i);
      fresh += 1;
    }
    opts.onProgress?.({ loaded: issues.length, total });
    if (!p.hasMore) return { issues: issues.slice(0, MAX_LOADED), total, stop: "end", status: null };
    if (p.raw === 0 || fresh === 0 || p.nextOffset === null || p.nextOffset <= offset) return { issues, total, stop: "end", status: null };
    if (page === MAX_PAGES) break;
    offset = p.nextOffset;
  }
  return { issues: issues.slice(0, MAX_LOADED), total, stop: "cap", status: null };
}

/**
 * The error banner for a finished walk, or null. A first-page failure is an outright error; a later page that fails
 * keeps its rows (the count note says so), and only an expired sign-in gets a banner there too.
 */
export function issuesLoadError(r: PagingResult): string | null {
  if (r.stop !== "error") return null;
  if (r.status === 401) return "Sign in again to read issues.";
  if (r.issues.length > 0) return null;
  return r.status === null ? "The core is not reachable right now." : `The core could not list issues (${r.status}).`;
}

/**
 * The line under the filters: loading progress, the 20-page cap ("Showing the first 2,000 of 4,212"), a failed
 * later page, or an old core that reports no total at a full page. "" when the whole list was read.
 */
export function pagingNote(s: { stop: PagingStop | null; loaded: number; total: number | null }): string {
  const n = (v: number) => v.toLocaleString("en");
  if (s.stop === null) {
    if (s.total === null && s.loaded === 0) return "Loading issues…";
    return s.total === null ? `Loaded ${n(s.loaded)}` : `Loaded ${n(s.loaded)} of ${n(s.total)}`;
  }
  if (s.stop === "cap") return s.total === null ? `Showing the first ${n(s.loaded)}` : `Showing the first ${n(s.loaded)} of ${n(s.total)}`;
  if (s.stop === "error") return `Loaded ${n(s.loaded)}${s.total === null ? "" : ` of ${n(s.total)}`}; the next page could not be read.`;
  if (s.stop === "end" && s.total === null && s.loaded >= CORE_LIST_CAP) return "The core did not report a total, so this list may be incomplete.";
  // Rows re-sorted by an import running during the walk can slip between pages: say so rather than look complete.
  if (s.stop === "end" && s.total !== null && s.loaded < s.total) return `Loaded ${n(s.loaded)} of ${n(s.total)}; the list changed while it was read. Refresh to read it again.`;
  return "";
}

const STOP_RANK: Record<PagingStop, number> = { end: 0, aborted: 1, cap: 2, error: 3 };

/**
 * One result from the walks of several providers (a view over repositories on GitHub and GitLab). Rows are joined,
 * totals added (unknown if any is unknown) and the most serious stop wins, so a failing provider is reported
 * without hiding the other's rows.
 */
export function mergePaging(results: readonly PagingResult[]): PagingResult {
  if (results.length === 1) return results[0]!;
  const worst = results.reduce((a, b) => (STOP_RANK[b.stop] > STOP_RANK[a.stop] ? b : a), results[0]!);
  return {
    issues: results.flatMap((r) => r.issues),
    total: results.every((r) => r.total !== null) ? results.reduce((n, r) => n + (r.total ?? 0), 0) : null,
    stop: worst.stop,
    status: results.find((r) => r.status !== null)?.status ?? null,
  };
}
