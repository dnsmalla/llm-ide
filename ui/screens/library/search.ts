// Full-text search state machine for the Library: debounce, cancel the previous request when the
// query changes, ignore stale answers, and degrade to "unavailable" (the local filter keeps
// working) when the core has no note search route. Pure: timers and the request are injected, so
// every transition is tested deterministically.
//
// Core contract (API 98, docs/spec/api-server.md 7d):
//   GET /kb/index/search?q=<1-200 chars>&limit=<1-50>[&projectId=<id>] -> { results: [{ noteKey, title, snippet, date, kind, projectId }] }
// scoped to the signed-in user, FTS over the derived note index. `/kb/search` cannot serve this:
// it hides kind 'note' rows (extension/kb/db.mjs) and its `kind` filter accepts no 'note'.
// A core without the route answers 404: search degrades to "unavailable" (the local filter keeps working) and asks
// again after a minute, so an updated core is picked up without a restart of the app.

export interface SearchHit {
  /** Path relative to the notes folder (the index's note key). */
  rel: string;
  title: string;
  /** Plain text, tags stripped; render as text. */
  snippet: string;
  date: string;
  /** The index kind (meeting, note, email, slack, document, repo, plan, other); absent in older answers. */
  kind?: string;
}

const HIT_KINDS: ReadonlySet<string> = new Set(["meeting", "note", "email", "slack", "document", "repo", "plan", "other"]);

export type SearchPhase = "idle" | "debouncing" | "searching" | "done" | "error" | "unavailable";

export interface SearchState {
  query: string;
  phase: SearchPhase;
  hits: SearchHit[];
  /** Short, user-facing; never the raw server message. */
  error: string | null;
}

export const IDLE_SEARCH: SearchState = { query: "", phase: "idle", hits: [], error: null };

export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 200;
export const DEFAULT_DEBOUNCE_MS = 250;
/** How long a missing route is remembered before the next search asks again. */
export const UNAVAILABLE_RETRY_MS = 60_000;

export type SearchRun = (query: string, signal: AbortSignal) => Promise<SearchHit[]>;

export interface SearchDeps {
  run: SearchRun;
  onChange: (s: SearchState) => void;
  debounceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** A request failure the controller understands (the core's HTTP status; 0 = unreachable). */
export class SearchRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`search request failed (${status})`);
    this.name = "SearchRequestError";
    this.status = status;
  }
}

export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

export class SearchController {
  private state: SearchState = IDLE_SEARCH;
  private seq = 0;
  private timer: unknown = null;
  private abort: AbortController | null = null;
  private disposed = false;
  /** Once the route is known to be missing, stop asking until `reset()`. */
  private unavailable = false;
  private unavailableAt = 0;
  private readonly deps: SearchDeps;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(deps: SearchDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get snapshot(): SearchState {
    return this.state;
  }

  setQuery(raw: string): void {
    if (this.disposed) return;
    const q = normalizeQuery(raw);
    this.cancelPending();
    this.seq += 1;
    if (q.length < MIN_QUERY_CHARS) {
      this.set({ query: q, phase: "idle", hits: [], error: null });
      return;
    }
    if (this.unavailable && (this.deps.now ?? Date.now)() - this.unavailableAt >= UNAVAILABLE_RETRY_MS) this.unavailable = false;
    if (this.unavailable) {
      this.set({ query: q, phase: "unavailable", hits: [], error: null });
      return;
    }
    // Keep the previous hits on screen while typing: no flicker between keystrokes.
    this.set({ query: q, phase: "debouncing", hits: this.state.hits, error: null });
    const mine = this.seq;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.fire(q, mine);
    }, this.debounceMs);
  }

  /** Runs now, skipping the debounce (Enter key). */
  submit(): void {
    if (this.disposed || this.state.phase !== "debouncing") return;
    this.cancelPending();
    this.seq += 1;
    void this.fire(this.state.query, this.seq);
  }

  /** Clears the query and cancels anything in flight. */
  clear(): void {
    this.cancelPending();
    this.seq += 1;
    if (!this.disposed) this.set(IDLE_SEARCH);
  }

  /** Forget a remembered "unavailable" (e.g. after the core restarted) and search again. */
  reset(): void {
    this.unavailable = false;
    this.setQuery(this.state.query);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.seq += 1;
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
  }

  private async fire(q: string, mine: number): Promise<void> {
    if (mine !== this.seq || this.disposed) return;
    const ac = new AbortController();
    this.abort = ac;
    this.set({ query: q, phase: "searching", hits: this.state.hits, error: null });
    try {
      const hits = await this.deps.run(q, ac.signal);
      if (mine !== this.seq || ac.signal.aborted || this.disposed) return;
      this.abort = null;
      this.set({ query: q, phase: "done", hits: hits.slice(0, 100), error: null });
    } catch (e) {
      if (mine !== this.seq || ac.signal.aborted || this.disposed) return; // superseded or cancelled: silent
      this.abort = null;
      const status = e instanceof SearchRequestError ? e.status : 0;
      if (status === 404 || status === 405 || status === 501) {
        this.unavailable = true;
        this.unavailableAt = (this.deps.now ?? Date.now)();
        this.set({ query: q, phase: "unavailable", hits: [], error: null });
      } else {
        const error = status === 0 ? "The core is not reachable." : status === 401 || status === 403 ? "Sign in again to search." : "Search failed. Try again.";
        this.set({ query: q, phase: "error", hits: [], error });
      }
    }
  }

  private set(next: SearchState): void {
    this.state = next;
    this.deps.onChange(next);
  }
}

// ---- adapter + decoder --------------------------------------------------------------------

export interface SearchCore {
  request(method: "GET", path: string, body: undefined, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Defensive decode: bad rows are dropped, keys must be safe relative paths, text is plain and clipped. */
export function decodeSearchHits(body: unknown): SearchHit[] {
  const rows = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  const out: SearchHit[] = [];
  for (const r of rows) {
    if (!isRecord(r) || typeof r.noteKey !== "string") continue;
    const rel = r.noteKey;
    if (rel === "" || rel.length > 512 || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) continue;
    out.push({
      rel,
      title: plain(r.title, 300) || rel.slice(rel.lastIndexOf("/") + 1),
      snippet: plain(r.snippet, 400),
      date: typeof r.date === "string" ? r.date.slice(0, 40) : "",
      ...(typeof r.kind === "string" && HIT_KINDS.has(r.kind) ? { kind: r.kind } : {}),
    });
    if (out.length >= 100) break;
  }
  return out;
}

function plain(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function searchPath(query: string, limit = 50): string {
  // The core answers 400 above 50: the cap is the route's, not ours.
  return `/kb/index/search?q=${encodeURIComponent(query)}&limit=${Math.min(50, Math.max(1, Math.floor(limit)))}`;
}

/** The request the controller runs: a non-2xx or transport failure becomes a `SearchRequestError`. */
export function makeSearchRun(core: SearchCore): SearchRun {
  return async (query, signal) => {
    let res: { status: number; body: unknown };
    try {
      res = await core.request("GET", searchPath(query), undefined, signal);
    } catch {
      throw new SearchRequestError(0);
    }
    if (res.status < 200 || res.status >= 300) throw new SearchRequestError(res.status);
    return decodeSearchHits(res.body);
  };
}
