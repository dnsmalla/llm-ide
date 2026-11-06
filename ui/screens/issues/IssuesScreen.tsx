// The Issues section, read + import: the Mac's kanban shape (columns from the label namespace, else Open/Closed)
// over the core's cached tickets. Creating, editing and closing issues needs the provider write clients the Mac app
// has; the desktop core has no such routes yet, and the card says so rather than showing dead buttons.
import { shellBus } from "../shell/bus";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import {
  assigneeSummary,
  columnsFor,
  filterIssues,
  issueNumber,
  labelOptions,
  repoOptions,
  repoSlug,
  type Issue,
  type IssueFilters,
} from "./issues-model.ts";
import { issuesLoadError, loadIssuePages, pagingNote, type PagingProgress, type PagingResult } from "./issue-paging.ts";
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

const REPO_SHAPE = /^[\w.-]+(?:\/[\w.-]+)+$/;

export function IssuesScreen({ active, deps }: SectionProps & { deps: IssuesDeps }): ReactNode {
  const [filters, setFilters] = useState<IssueFilters>({ provider: "github", state: "open", repo: "", label: "", query: "" });
  const [rows, setRows] = useState<Issue[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  // One key per issue the user means to create: a double click or a retry after a lost answer replays, never duplicates.
  const createIdem = useRef<string | null>(null);
  const [createRepo, setCreateRepo] = useState("");
  const [repoDraft, setRepoDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Issue | null>(null);
  // The last finished walk (its total and stop reason drive the count note) and the walk in flight.
  const [paging, setPaging] = useState<PagingResult | null>(null);
  const [progress, setProgress] = useState<PagingProgress | null>(null);
  // Each load aborts the one before it: a page of a superseded load is never applied (the sequence guard).
  const abortRef = useRef<AbortController | null>(null);
  const configuredRepos = useMemo(() => {
    const c = readRepoConfig();
    return [
      ...c.saved.github.map((r) => ({ ...r, provider: "github" as const, slug: repoSlug(r.url) })),
      ...c.saved.gitlab.map((r) => ({ ...r, provider: "gitlab" as const, slug: repoSlug(r.url) })),
    ];
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("loading");
    setError(null);
    setProgress(null);
    const r = await loadIssuePages(deps.request, { provider: filters.provider, state: filters.state }, {
      signal: ctrl.signal,
      onProgress: (p) => { if (!ctrl.signal.aborted) setProgress(p); },
    });
    if (ctrl.signal.aborted) return;
    if (r.stop === "error" && r.issues.length === 0) {
      setPhase("error");
      setError(issuesLoadError(r));
      // The previous walk's count note must not sit next to this failure.
      setPaging(null);
      return;
    }
    setRows(r.issues);
    setPaging(r);
    setError(issuesLoadError(r));
    setPhase("ready");
  }, [deps, filters.provider, filters.state]);

  useEffect(() => () => abortRef.current?.abort(), []);

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

  const createIssue = async () => {
    const repo = (createRepo || filters.repo).trim();
    if (!REPO_SHAPE.test(repo) || !createTitle.trim()) { setError("Enter an owner/name repository and a title."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      createIdem.current ??= crypto.randomUUID();
      const r = await deps.request("POST", "/kb/issues/create", { provider: filters.provider, repo, title: createTitle.trim(), body: createBody, idem: createIdem.current });
      if (r.status !== 200) {
        if (r.status === 409) createIdem.current = null;
        const b = r.body && typeof r.body === "object" ? r.body as { error?: { message?: unknown } } : {};
        setError(typeof b.error?.message === "string" ? b.error.message : `The issue could not be created (${r.status}).`);
        return;
      }
      createIdem.current = null;
      setNotice("Issue created.");
      setCreateOpen(false); setCreateTitle(""); setCreateBody(""); setCreateRepo("");
      await load();
    } catch { setError("The core could not be reached."); }
    finally { setBusy(false); }
  };

  const pageNote = phase === "loading"
    ? pagingNote({ stop: null, loaded: progress?.loaded ?? 0, total: progress?.total ?? null })
    : paging ? pagingNote({ stop: paging.stop, loaded: paging.issues.length, total: paging.total }) : "";
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
        <button type="button" className="iss-btn iss-primary" onClick={() => setCreateOpen(true)} disabled={busy}>New issue</button>
        <button type="button" className="iss-btn" onClick={() => setImportOpen((v) => !v)} disabled={filters.provider !== "github" || busy}>
          Import GitHub issues
        </button>
      </header>

      <div className="iss-sub">
        <label className="iss-field">
          <span>Saved repository</span>
          <select value={configuredRepos.some((r) => r.provider === filters.provider && r.slug === filters.repo) ? filters.repo : ""} onChange={(e) => setFilters((f) => ({ ...f, repo: e.target.value, repoExact: true }))}>
            <option value="">All repositories</option>
            {configuredRepos.filter((r) => r.provider === filters.provider).map((r) => <option key={r.id} value={r.slug}>{r.displayName || r.slug}</option>)}
          </select>
        </label>
        <label className="iss-field iss-grow">
          <span>Repository filter</span>
          <input list="iss-repos" value={filters.repo} placeholder="owner/name" onChange={(e) => setFilters((f) => ({ ...f, repo: e.target.value, repoExact: false }))} />
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
        {pageNote ? <span className="iss-hint" role="status">{pageNote}</span> : null}
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

      {createOpen ? (
        <form className="iss-import" onSubmit={(e) => { e.preventDefault(); void createIssue(); }}>
          <label className="iss-field"><span>Repository</span><input value={createRepo} placeholder="owner/name" onChange={(e) => setCreateRepo(e.target.value)} disabled={busy} /></label>
          <label className="iss-field iss-grow"><span>Title</span><input value={createTitle} placeholder="Issue title" onChange={(e) => setCreateTitle(e.target.value)} disabled={busy} autoFocus maxLength={500} /></label>
          <label className="iss-field iss-grow"><span>Description</span><textarea rows={3} value={createBody} placeholder="Optional description" onChange={(e) => setCreateBody(e.target.value)} disabled={busy} /></label>
          <button type="submit" className="iss-btn iss-primary" disabled={busy || createTitle.trim() === ""}>{busy ? "Creating…" : "Create issue"}</button>
          <button type="button" className="iss-btn" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
          <p className="iss-hint">Creates the issue on the selected provider, then reloads the board.</p>
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
                    {i.assignees.length ? <div className="iss-meta"><span title="Assignees">{assigneeSummary(i.assignees)}</span></div> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {selected ? (
        <IssueDetail issue={selected} deps={deps} onClose={closeDetail} onNotice={setNotice} onScheduleChanged={() => void load()} onChanged={() => void load()} />
      ) : null}

      <p className="iss-hint iss-foot">
Create, comment and close use the core's provider write routes and the saved GitHub/GitLab token.
      </p>
    </div>
  );
}
