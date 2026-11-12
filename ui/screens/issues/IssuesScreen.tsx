// The Issues section, read + import: the Mac's kanban shape (columns from the label namespace, else Open/Closed)
// over the core's cached tickets. Creating, editing and closing issues needs the provider write clients the Mac app
// has; the desktop core has no such routes yet, and the card says so rather than showing dead buttons.
import { shellBus } from "../shell/bus";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { AssigneeAvatars } from "./AssigneeAvatars.tsx";
import type { SectionProps } from "../shell/sections";
import {
  columnsFor,
  createFingerprint,
  errorMessageOf,
  filterIssues,
  createKeyAfter,
  idemKeyFor,
  issueNumber,
  labelOptions,
  type Issue,
  type IssueFilters,
} from "./issues-model.ts";
import { issuesLoadError, loadIssuePages, mergePaging, pagingNote, type PagingProgress, type PagingResult } from "./issue-paging.ts";
import { missingChoices, repoChoices, resolveScope, syncRepos, type SyncOutcome } from "./repo-scope.ts";
import "./issues.css";
import { readRepoConfig } from "../settings/repo-config.ts";
import { IssueDetail, type IssueDetailDeps } from "./IssueDetail.tsx";

export interface IssuesReply {
  status: number;
  body: unknown;
}

export interface IssuesDeps extends IssueDetailDeps {
  request: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<IssuesReply>;
  /** Present only when the Factory is usable here (a project open, Loop on). Resolves to the notice to show. */
  sendToFactory?: (issues: Issue[], runIntake: boolean) => Promise<string>;
}

type Phase = "idle" | "loading" | "ready" | "error";

export function IssuesScreen({ active, deps }: SectionProps & { deps: IssuesDeps }): ReactNode {
  // Only the state, label and search are chosen here: the provider and repository come from the saved repositories.
  const [filters, setFilters] = useState<IssueFilters>({ state: "open", repo: "", label: "", query: "" });
  const [repoKey, setRepoKey] = useState("");
  const [rows, setRows] = useState<Issue[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  // One key per distinct create (repo, title, body): a double click or a retry after a lost answer replays, never
  // duplicates; an edited retry gets its own key, so it is not refused as a 409 against the old content.
  const createKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const [createRepo, setCreateRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Issue | null>(null);
  // Cards picked for "Send to Factory" (by id); rows that leave the list are simply not sent.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickIntake, setPickIntake] = useState(true);
  const togglePick = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sendIssues = async (list: Issue[], runIntake: boolean) => {
    if (!deps.sendToFactory || list.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await deps.sendToFactory(list, runIntake));
      setPicked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "The issues could not be sent to the Factory.");
    } finally {
      setBusy(false);
    }
  };
  const sendPicked = () => {
    const list = rows.filter((r) => picked.has(r.id));
    void sendIssues(list, pickIntake);
  };
  // The last finished walk (its total and stop reason drive the count note) and the walk in flight.
  const [paging, setPaging] = useState<PagingResult | null>(null);
  const [progress, setProgress] = useState<PagingProgress | null>(null);
  // Each load aborts the one before it: a page of a superseded load is never applied (the sequence guard).
  const abortRef = useRef<AbortController | null>(null);
  // Re-read when the screen opens, so a repository added in Settings shows without a restart.
  const choices = useMemo(() => repoChoices(readRepoConfig()), [active]);
  const scope = useMemo(() => resolveScope(choices, repoKey), [choices, repoKey]);
  // Repositories already tried this session: an empty one is imported once, not on every visit.
  const tried = useRef<Set<string>>(new Set());
  const scopeFilters = useMemo<IssueFilters>(
    () => ({ ...filters, provider: scope.selected?.provider, repo: scope.selected?.slug ?? "", repoExact: scope.selected !== null }),
    [filters, scope.selected],
  );

  const load = useCallback(async (opts: { sync?: boolean } = {}) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("loading");
    setError(null);
    setProgress(null);
    const inView = scope.selected ? [scope.selected] : choices;
    // One walk per provider in view (a single repository reads just its own), joined into one list.
    const read = async (): Promise<PagingResult> => mergePaging(await Promise.all(scope.providers.map((p) =>
      loadIssuePages(deps.request, { provider: p, state: filters.state }, {
        signal: ctrl.signal,
        onProgress: (pr) => { if (!ctrl.signal.aborted) setProgress(pr); },
      }))));
    /** False when the walk failed with nothing to show. */
    const apply = (r: PagingResult): boolean => {
      if (r.stop === "error" && r.issues.length === 0) {
        setPhase("error");
        setError(issuesLoadError(r));
        // The previous walk's count note must not sit next to this failure.
        setPaging(null);
        return false;
      }
      setRows(r.issues);
      setPaging(r);
      setError(issuesLoadError(r));
      setPhase("ready");
      return true;
    };
    const report = (out: SyncOutcome) => {
      if (out.problems.length > 0) setError(out.problems.join(" · "));
      else if (out.imported > 0) setNotice(`Imported ${out.imported} issue${out.imported === 1 ? "" : "s"}.`);
    };
    // Refresh brings the saved repositories up to date first.
    if (opts.sync && inView.length > 0) {
      report(await syncRepos(deps.request, inView));
      if (ctrl.signal.aborted) return;
    }
    let r = await read();
    if (ctrl.signal.aborted || !apply(r)) return;
    // A saved repository with no cached issue is imported once, without the user asking.
    const todo = opts.sync ? [] : missingChoices(choices, scope, r.issues, tried.current);
    if (todo.length > 0) {
      for (const c of todo) tried.current.add(c.key);
      setNotice(`Importing issues from ${todo.map((c) => c.slug).join(", ")}…`);
      const out = await syncRepos(deps.request, todo);
      if (ctrl.signal.aborted) return;
      setNotice(null);
      report(out);
      if (out.imported > 0) {
        r = await read();
        if (!ctrl.signal.aborted) apply(r);
      }
    }
  }, [deps, filters.state, scope, choices]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(() => shellBus.subscribe("project-changed", () => { if (active) void load(); }), [active, load]);

  // The repository a new issue goes to: the one being shown, the only saved one, or the one picked in the form.
  const createChoice = scope.selected ?? choices.find((c) => c.key === createRepo) ?? null;
  const createIssue = async () => {
    if (!createChoice || !createTitle.trim()) { setError("Pick a repository and enter a title."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      createKey.current = idemKeyFor(createKey.current, createFingerprint(createChoice.provider, createChoice.slug, createTitle, createBody), () => crypto.randomUUID());
      const r = await deps.request("POST", "/kb/issues/create", { provider: createChoice.provider, repo: createChoice.slug, title: createTitle.trim(), body: createBody, idem: createKey.current.key });
      if (r.status !== 200) {
        // A 409 means the key belongs to other content; anything else keeps it so a retry replays the same create.
        createKey.current = createKeyAfter(createKey.current, r.status === 409 ? "conflict" : "failed");
        setError(errorMessageOf(r.body, `The issue could not be created (${r.status}).`));
        return;
      }
      createKey.current = createKeyAfter(createKey.current, "created");
      setNotice("Issue created.");
      setCreateOpen(false); setCreateTitle(""); setCreateBody(""); setCreateRepo("");
      await load({ sync: true });
    } catch {
      // Ambiguous: the create may have reached the core. The key is kept (see createKeyAfter).
      setError("The core could not be reached.");
    }
    finally { setBusy(false); }
  };

  const pageNote = phase === "loading"
    ? pagingNote({ stop: null, loaded: progress?.loaded ?? 0, total: progress?.total ?? null })
    : paging ? pagingNote({ stop: paging.stop, loaded: paging.issues.length, total: paging.total }) : "";
  const visible = useMemo(() => filterIssues(rows, scopeFilters), [rows, scopeFilters]);
  const columns = useMemo(() => columnsFor(visible), [visible]);
  const labels = useMemo(() => labelOptions(rows), [rows]);
  const closeDetail = useCallback(() => setSelected(null), []);
  // The dialog shows the row as the latest reload has it (by id), so a changed or closed issue is not a stale snapshot.
  const detailIssue = useMemo(() => (selected ? rows.find((r) => r.id === selected.id) ?? selected : null), [rows, selected]);

  const openCreate = () => {
    setCreateRepo(choices[0]?.key ?? "");
    setCreateOpen(true);
  };

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
        {scope.picker ? (
          <label className="iss-field">
            <span>Repository</span>
            <select value={scope.selected?.key ?? ""} onChange={(e) => setRepoKey(e.target.value)}>
              <option value="">All repositories</option>
              {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        ) : scope.selected ? <span className="iss-count" title="The repository added in Settings → Repositories">{scope.selected.label}</span> : null}
        <label className="iss-field">
          <span>State</span>
          <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as IssueFilters["state"] }))}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        {labels.length > 0 ? (
          <label className="iss-field">
            <span>Label</span>
            <select value={filters.label} onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}>
              <option value="">All labels</option>
              {labels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        ) : null}
        <label className="iss-field iss-grow">
          <span>Search</span>
          <input type="search" value={filters.query} placeholder="Title, label, #number" onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))} />
        </label>
        <span className="iss-count" role="status">{visible.length.toLocaleString("en")} issue{visible.length === 1 ? "" : "s"}</span>
        {pageNote ? <span className="iss-hint" role="status">{pageNote}</span> : null}
        <button type="button" className="iss-btn" onClick={() => void load({ sync: true })} disabled={phase === "loading" || busy} title="Fetch the latest issues from the provider">Refresh</button>
        <button type="button" className="iss-btn iss-primary" onClick={openCreate} disabled={busy || choices.length === 0}>New issue</button>
      </header>

      {createOpen ? (
        <form className="iss-import" onSubmit={(e) => { e.preventDefault(); void createIssue(); }}>
          {scope.selected || choices.length === 1 ? null : (
            <label className="iss-field"><span>Repository</span>
              <select value={createRepo} onChange={(e) => setCreateRepo(e.target.value)} disabled={busy}>{choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            </label>
          )}
          <label className="iss-field iss-grow"><span>Title</span><input value={createTitle} placeholder="Issue title" onChange={(e) => setCreateTitle(e.target.value)} disabled={busy} autoFocus maxLength={500} /></label>
          <label className="iss-field iss-grow"><span>Description</span><textarea rows={3} value={createBody} placeholder="Optional description" onChange={(e) => setCreateBody(e.target.value)} disabled={busy} /></label>
          <button type="submit" className="iss-btn iss-primary" disabled={busy || createTitle.trim() === "" || !createChoice}>{busy ? "Creating…" : "Create issue"}</button>
          <button type="button" className="iss-btn" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
          <p className="iss-hint">Creates the issue in {createChoice?.slug ?? "the repository"}, then reloads the board.</p>
        </form>
      ) : null}

      {error ? <StatusBanner severity="error" message={error} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} /> : null}
      {deps.sendToFactory && picked.size > 0 ? (
        <div className="iss-import" role="region" aria-label="Selected issues">
          <span className="iss-count">{picked.size} selected</span>
          <label className="iss-check"><input type="checkbox" checked={pickIntake} onChange={(e) => setPickIntake(e.target.checked)} /> Run intake now</label>
          <button type="button" className="iss-btn iss-primary" onClick={sendPicked} disabled={busy}>Send to Factory</button>
          <button type="button" className="iss-btn" onClick={() => setPicked(new Set())} disabled={busy}>Clear</button>
        </div>
      ) : null}

      {phase === "loading" && rows.length === 0 ? (
        <p className="iss-empty" role="status">Loading issues…</p>
      ) : phase === "error" && rows.length === 0 ? (
        <p className="iss-empty">Issues are unavailable. Check the core, then Refresh.</p>
      ) : phase === "ready" && rows.length === 0 ? (
        <div className="iss-empty">
          {choices.length === 0 ? (
            <>
              <p>No repository yet.</p>
              <p className="iss-hint">Add one in Settings → Repositories; its issues appear here on their own.</p>
            </>
          ) : (
            <>
              <p>No issues in {scope.selected?.slug ?? "your repositories"} yet.</p>
              <p className="iss-hint">They are fetched when you open this page. Press Refresh to fetch again; the token is the one saved in Settings → Repositories.</p>
            </>
          )}
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
                    {deps.sendToFactory ? <label className="iss-check"><input type="checkbox" className="iss-pick" checked={picked.has(i.id)} onChange={() => togglePick(i.id)} aria-label={`Select ${i.title} for the Factory`} /> Select</label> : null}
                    <button type="button" className="iss-card-title" onClick={() => setSelected(i)} title="Open issue details">
                      {i.title}
                    </button>
                    <div className="iss-meta">
                      <span>{i.repo}</span>
                      {i.number !== null ? <span>{issueNumber(i)}</span> : null}
                      <span>{i.state}</span>
                    </div>
                    {i.labels.length ? <div className="iss-labels">{i.labels.slice(0, 4).map((l) => <span key={l} className="iss-label">{l}</span>)}</div> : null}
                    {i.assignees.length ? <div className="iss-meta"><span title="Assignees"><AssigneeAvatars names={i.assignees} size={18} max={3} /></span></div> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {detailIssue ? (
        <IssueDetail issue={detailIssue} deps={deps} onClose={closeDetail} onNotice={setNotice} onScheduleChanged={() => void load()} onChanged={() => void load()} onSendToFactory={deps.sendToFactory ? () => void sendIssues([detailIssue], false) : undefined} />
      ) : null}

      <p className="iss-hint iss-foot">Issues come from the repositories you added in Settings → Repositories, using their saved token.</p>
    </div>
  );
}
