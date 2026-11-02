// The Issues section, read + import: the Mac's kanban shape (columns from the label namespace, else Open/Closed)
// over the core's cached tickets. Creating, editing and closing issues needs the provider write clients the Mac app
// has; the desktop core has no such routes yet, and the card says so rather than showing dead buttons.
import { shellBus } from "../shell/bus";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import {
  CORE_LIST_CAP,
  columnsFor,
  decodeIssues,
  filterIssues,
  isCapped,
  issueNumber,
  labelOptions,
  rawIssueCount,
  repoOptions,
  repoSlug,
  type Issue,
  type IssueFilters,
} from "./issues-model.ts";
import "./issues.css";
import { readRepoConfig } from "../settings/repo-config.ts";
import { IssueDetail, type IssueDetailDeps } from "./IssueDetail.tsx";

export interface IssuesReply {
  status: number;
  body: unknown;
}

export interface IssuesDeps extends IssueDetailDeps {
  request: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<IssuesReply>;
}

type Phase = "idle" | "loading" | "ready" | "error";

const REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;

export function IssuesScreen({ active, deps }: SectionProps & { deps: IssuesDeps }): ReactNode {
  const [filters, setFilters] = useState<IssueFilters>({ provider: "github", state: "open", repo: "", label: "", query: "" });
  const [rows, setRows] = useState<Issue[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [repoDraft, setRepoDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Issue | null>(null);
  // The core's row count before any title-less row is dropped; the "First N only" hint is about the core's cap.
  const [rawCount, setRawCount] = useState(0);
  const configuredRepos = useMemo(() => {
    const c = readRepoConfig();
    return [
      ...c.saved.github.map((r) => ({ ...r, provider: "github" as const, slug: repoSlug(r.url) })),
      ...c.saved.gitlab.map((r) => ({ ...r, provider: "gitlab" as const, slug: repoSlug(r.url) })),
    ];
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const qs = new URLSearchParams({ provider: filters.provider, state: filters.state, limit: String(CORE_LIST_CAP) });
      const r = await deps.request("GET", `/kb/issues?${qs.toString()}`);
      if (r.status !== 200) {
        setPhase("error");
        setError(r.status === 401 ? "Sign in again to read issues." : `The core could not list issues (${r.status}).`);
        return;
      }
      setRows(decodeIssues(r.body));
      setRawCount(rawIssueCount(r.body));
      setPhase("ready");
    } catch {
      setPhase("error");
      setError("The core is not reachable right now.");
    }
  }, [deps, filters.provider, filters.state]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(() => shellBus.subscribe("project-changed", () => { if (active) void load(); }), [active, load]);

  const importIssues = async () => {
    const repo = repoDraft.trim();
    if (!REPO_SHAPE.test(repo)) {
      setError("Enter a repository as owner/name.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await deps.request("POST", "/kb/connect-github-issues", { repo, state: filters.state });
      if (r.status !== 200) {
        setError(r.status === 401 ? "Sign in again to import issues." : `The GitHub import failed (${r.status}).`);
        return;
      }
      const body = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
      const n = typeof body.count === "number" ? body.count : typeof body.imported === "number" ? body.imported : null;
      setNotice(n !== null ? `Imported ${n.toLocaleString("en")} issue${n === 1 ? "" : "s"}.` : "Issues imported.");
      setImportOpen(false);
      setRepoDraft("");
      await load();
    } catch {
      setError("The GitHub import could not reach the core.");
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => filterIssues(rows, filters), [rows, filters]);
  const columns = useMemo(() => columnsFor(visible), [visible]);
  const repos = useMemo(() => repoOptions(rows), [rows]);
  const labels = useMemo(() => labelOptions(rows), [rows]);
  const closeDetail = useCallback(() => setSelected(null), []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") { e.preventDefault(); void load(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, load]);

  return (
    <div className="iss-root" data-active={active}>
      <header className="iss-head">
        <h2 className="iss-title">Issues</h2>
        <label className="iss-field">
          <span>Provider</span>
          <select value={filters.provider} onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value as "github" | "gitlab" }))}>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <label className="iss-field">
          <span>State</span>
          <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as IssueFilters["state"] }))}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="iss-field iss-grow">
          <span>Search</span>
          <input type="search" value={filters.query} placeholder="Title, label, repo, #number" onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))} />
        </label>
        <button type="button" className="iss-btn" onClick={() => void load()} disabled={phase === "loading"}>Refresh</button>
        <button type="button" className="iss-btn iss-primary" onClick={() => setImportOpen((v) => !v)} disabled={filters.provider !== "github" || busy}>
          Import GitHub issues
        </button>
      </header>

      <div className="iss-sub">
        <label className="iss-field">
          <span>Saved repository</span>
          <select value={configuredRepos.some((r) => r.provider === filters.provider && r.slug === filters.repo) ? filters.repo : ""} onChange={(e) => setFilters((f) => ({ ...f, repo: e.target.value }))}>
            <option value="">All repositories</option>
            {configuredRepos.filter((r) => r.provider === filters.provider).map((r) => <option key={r.id} value={r.slug}>{r.displayName || r.slug}</option>)}
          </select>
        </label>
        <label className="iss-field iss-grow">
          <span>Repository filter</span>
          <input list="iss-repos" value={filters.repo} placeholder="owner/name" onChange={(e) => setFilters((f) => ({ ...f, repo: e.target.value }))} />
          <datalist id="iss-repos">{repos.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        <label className="iss-field">
          <span>Label</span>
          <select value={filters.label} onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}>
            <option value="">All labels</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <span className="iss-count" role="status">{visible.length.toLocaleString("en")} issue{visible.length === 1 ? "" : "s"}</span>
        {isCapped(rawCount) ? <span className="iss-hint" title="The core returns at most this many issues per list">First {CORE_LIST_CAP} only</span> : null}
      </div>

      {importOpen ? (
        <form className="iss-import" onSubmit={(e) => { e.preventDefault(); void importIssues(); }}>
          <label className="iss-field iss-grow">
            <span>GitHub repository</span>
            <input value={repoDraft} placeholder="owner/name" onChange={(e) => setRepoDraft(e.target.value)} disabled={busy} autoFocus />
          </label>
          <button type="submit" className="iss-btn iss-primary" disabled={busy || repoDraft.trim() === ""}>{busy ? "Importing…" : "Import"}</button>
          <button type="button" className="iss-btn" onClick={() => setImportOpen(false)} disabled={busy}>Cancel</button>
          <p className="iss-hint">
            Uses the GitHub token saved in Settings → Repositories. The import fetches the repository's issues into the
            local KB; no issue is created or changed on GitHub.
          </p>
        </form>
      ) : null}

      {error ? <StatusBanner severity="error" message={error} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} /> : null}

      {phase === "loading" && rows.length === 0 ? (
        <p className="iss-empty" role="status">Loading issues…</p>
      ) : phase === "error" && rows.length === 0 ? (
        <p className="iss-empty">Issues are unavailable. Check the core, then Refresh.</p>
      ) : phase === "ready" && rows.length === 0 ? (
        <div className="iss-empty">
          <p>No {filters.provider === "github" ? "GitHub" : "GitLab"} issues are cached yet.</p>
          <p className="iss-hint">
            {configuredRepos.length === 0
              ? "Add a repository in Settings → Repositories first; that is also where the provider token lives."
              : filters.provider === "github"
                ? "Import a repository's issues above; the GitHub token lives in Settings → Repositories."
                : "GitLab issue import is not available in the desktop yet. The Mac app imports GitLab issues through its provider client."}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <p className="iss-empty">No issue matches these filters.</p>
      ) : (
        <div className="iss-board" role="list" aria-label="Issue board">
          {columns.map((col) => (
            <section key={col.id} className="iss-col" aria-label={`${col.title} (${col.issues.length})`}>
              <h3 className="iss-col-title">{col.title} <span>{col.issues.length}</span></h3>
              <ul className="iss-cards">
                {col.issues.map((i) => (
                  <li key={i.id} className="iss-card">
                    <button type="button" className="iss-card-title" onClick={() => setSelected(i)} title="Open issue details">
                      {i.title}
                    </button>
                    <div className="iss-meta">
                      <span>{i.repo}</span>
                      {i.number !== null ? <span>{issueNumber(i)}</span> : null}
                      <span>{i.state}</span>
                    </div>
                    {i.labels.length ? <div className="iss-labels">{i.labels.slice(0, 4).map((l) => <span key={l} className="iss-label">{l}</span>)}</div> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {selected ? (
        <IssueDetail issue={selected} deps={deps} onClose={closeDetail} onNotice={setNotice} onScheduleChanged={() => void load()} />
      ) : null}

      <p className="iss-hint iss-foot">
        Reading and importing are real. Creating, editing, commenting on or closing issues is not in the desktop core
        yet; the Mac app does those through its provider write clients.
      </p>
    </div>
  );
}
