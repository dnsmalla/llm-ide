// The Gantt section: the Mac's timeline over repository issues, with GitHub's dates supplied by the
// /kb/issue-schedule overlay. The desktop reads cached issues (Issues imports them) and can edit the overlay's
// start/due/estimate/dependencies; there is no provider write, so nothing here changes an issue itself.
import { shellBus } from "../shell/bus";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import { issueOpenUrl, labelOptions, repoSlug, type Issue } from "../issues/issues-model.ts";
import { pagingNote, type PagingProgress, type PagingResult } from "../issues/issue-paging.ts";
import { IssueDetail, gitlabOriginFromConfig } from "../issues/IssueDetail.tsx";
import { readRepoConfig } from "../settings/repo-config.ts";
import {
  GANTT_CATEGORIES,
  GANTT_NESTED_HINT,
  loadTimeline,
  buildRows,
  countCategories,
  datedRows,
  dayNumber,
  filterRows,
  GANTT_ROW_ACTIONS,
  issueLabel,
  localToday,
  projectOptions,
  timelineRange,
  todayScrollLeft,
  enqueueShift, scheduleBody, settleShift, shiftScheduleBody, type QueuedShift,
  type GanttCategory,
  type GanttRow,
  type Schedule,
  type TimelineRange,
} from "./gantt-model.ts";
import { GanttChart, type RowTarget } from "./GanttChart.tsx";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import "./gantt.css";

export interface GanttReply {
  status: number;
  body: unknown;
}

export interface GanttDeps {
  request: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<GanttReply>;
  openExternal: (url: string) => Promise<void>;
}

type Zoom = "day" | "week" | "month";
type Phase = "idle" | "loading" | "ready" | "error";

const ZOOM_WIDTH: Record<Zoom, number> = { day: 32, week: 14, month: 5 };
const CATEGORY_LABEL: Record<GanttCategory, string> = { open: "Open", closed: "Closed", overdue: "Overdue" };

export function GanttScreen({ active, deps }: SectionProps & { deps: GanttDeps }): ReactNode {
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [repo, setRepo] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [hideUndated, setHideUndated] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "open" | "closed">("all");
  const [dateFilter, setDateFilter] = useState<"any" | "scheduled" | "unscheduled">("any");
  const [label, setLabel] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [categories, setCategories] = useState<GanttCategory[]>([...GANTT_CATEGORIES]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>("week");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GanttRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The last finished walk (its total and stop reason drive the count note) and the walk in flight.
  const [paging, setPaging] = useState<PagingResult | null>(null);
  const [progress, setProgress] = useState<PagingProgress | null>(null);
  // Each load aborts the one before it, so a superseded walk never applies its rows.
  const abortRef = useRef<AbortController | null>(null);
  const [detail, setDetail] = useState<Issue | null>(null);
  const [nestedNote, setNestedNote] = useState(false);
  const shiftingRef = useRef(false);
  const shiftQueueRef = useRef<QueuedShift[]>([]);
  // A failed move keeps its row and days so the user can retry it; the queue behind it is reported, not silently lost.
  const [shiftFailure, setShiftFailure] = useState<{ row: GanttRow; days: number; message: string; dropped: number } | null>(null);
  // The view a queued shift belongs to. Rows of another provider or repo are never saved from this queue.
  const scope = `${provider}\u0000${repo}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const detailIssue = useMemo(() => (detail ? issues.find((i) => i.id === detail.id) ?? detail : null), [issues, detail]);

  useEffect(() => {
    shiftQueueRef.current.length = 0;
    setShiftFailure(null);
  }, [provider, repo]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("loading");
    setError(null);
    setProgress(null);
    // Cleared first so a failed load or a retry never shows the previous project's hint.
    setNestedNote(false);
    const r = await loadTimeline(deps.request, provider, repo, {
      signal: ctrl.signal,
      onProgress: (p) => { if (!ctrl.signal.aborted) setProgress(p); },
    });
    if (ctrl.signal.aborted) return;
    setNestedNote(r.nestedHint);
    if (!r.ok) {
      setPhase("error");
      setError(r.error);
      // The previous walk's count note must not sit next to this failure.
      setPaging(null);
      return;
    }
    setIssues(r.issues);
    setPaging(r.paging);
    setSchedules(r.schedules);
    setError(r.warning);
    setPhase("ready");
  }, [deps, provider, repo]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(() => shellBus.subscribe("project-changed", () => { if (active) void load(); }), [active, load]);

  const filteredIssues = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((i) => {
      if (stateFilter !== "all" && i.state !== stateFilter) return false;
      if (q && !`${i.title} ${i.repo} ${i.labels.join(" ")} #${i.number ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [issues, query, stateFilter]);
  const baseRows = useMemo(() => buildRows(filteredIssues, schedules, provider, repo), [filteredIssues, schedules, provider, repo]);
  const today = localToday();
  /** Drag/keyboard shift: save the moved dates through the existing schedule overlay route. */
  const shiftRow = useCallback(async (row: GanttRow, days: number) => {
    if (shiftScheduleBody(row, days) === null) return;
    setShiftFailure(null);
    enqueueShift(shiftQueueRef.current, row, days);
    if (shiftingRef.current) return;
    shiftingRef.current = true;
    let item: QueuedShift | undefined;
    // The view the in-flight save was started in; a failure is reported only while the user is still there.
    let itemScope = "";
    // Stops the queue and keeps the failed move (with what was queued behind it) for an explicit retry.
    const failShift = (failed: QueuedShift, message: string) => {
      const dropped = Math.max(0, shiftQueueRef.current.length - 1);
      shiftQueueRef.current.length = 0;
      setShiftFailure({ row: failed.row, days: failed.days, message, dropped });
    };
    try {
      while (shiftQueueRef.current.length > 0) {
        item = shiftQueueRef.current[0]!;
        const savedDays = item.days;
        const savedScope = scopeRef.current;
        itemScope = savedScope;
        const body = scheduleBody(item.row, savedDays);
        if (body === null) { shiftQueueRef.current.shift(); continue; }
        let r: Awaited<ReturnType<typeof deps.request>>;
        try {
          r = await deps.request("PUT", "/kb/issue-schedule", body);
        } catch {
          // A network failure after the user moved to another provider or repo belongs to the old view: no banner there.
          if (scopeRef.current !== savedScope) continue;
          failShift(item, "The core is not reachable right now.");
          return;
        }
        // The provider or repo changed during the save: the queue was cleared for the old view, and its reload belongs to the new view.
        if (scopeRef.current !== savedScope) continue;
        if (r.status !== 200) {
          failShift(item, `The schedule could not be moved (${r.status}).`);
          return;
        }
        setNotice(savedDays === 0
          ? `Restored ${issueLabel(item.row.issue)} to its original dates.`
          : `Moved ${issueLabel(item.row.issue)} ${savedDays > 0 ? "+" : ""}${savedDays} day${Math.abs(savedDays) === 1 ? "" : "s"}.`);
        // Keep the item until the reload finishes: a compensating shift during the load must merge into the
        // SAME queued target, not start a new one from the stale pre-save row.
        await load();
        settleShift(shiftQueueRef.current, item, savedDays);
      }
    } catch {
      if (item && scopeRef.current === itemScope) failShift(item, "The core is not reachable right now.");
    } finally { shiftingRef.current = false; }
  }, [deps, load]);
  const onShift = useCallback((row: GanttRow, days: number) => { void shiftRow(row, days); }, [shiftRow]);

  const pageNote = phase === "loading"
    ? pagingNote({ stop: null, loaded: progress?.loaded ?? 0, total: progress?.total ?? null })
    : paging ? pagingNote({ stop: paging.stop, loaded: paging.issues.length, total: paging.total }) : "";
  const scoped = useMemo(() => baseRows.filter((r) => !hideUndated || r.start !== null || r.end !== null).filter((r) => dateFilter === "any" || (dateFilter === "scheduled" ? r.start !== null || r.end !== null : r.start === null && r.end === null)), [baseRows, dateFilter, hideUndated]);
  const fromDay = from ? dayNumber(from) : null;
  const untilDay = until ? dayNumber(until) : null;
  // Legend counts ignore the legend's own toggles, as the Mac's do, so hidden categories still show their numbers.
  const counts = useMemo(() => countCategories(filterRows(scoped, { label, categories: GANTT_CATEGORIES, from: fromDay, until: untilDay, today }), today), [scoped, label, fromDay, untilDay, today]);
  const rows = useMemo(() => filterRows(scoped, { label, categories, from: fromDay, until: untilDay, today }), [scoped, label, categories, fromDay, untilDay, today]);
  const dated = useMemo(() => datedRows(rows), [rows]);
  const range = useMemo<TimelineRange>(() => timelineRange(rows, today), [rows, today]);
  const labels = useMemo(() => labelOptions(issues), [issues]);
  // The Mac's project list is the saved repositories of this provider only (GitHubClient/GitLabClient listProjects):
  // a repo removed from Settings, or another provider's, never shows. Re-read on load so a Settings edit applies.
  const savedRepos = useMemo(() => readRepoConfig().saved[provider].map((r) => repoSlug(r.url)), [provider, issues]);
  const repos = useMemo(() => projectOptions(savedRepos, [], projectQuery, repo), [savedRepos, projectQuery, repo]);
  // Stable (only setters inside), so the memoised chart rows do not re-render when an unrelated field changes.
  const rowAction = useCallback((r: GanttRow, target: RowTarget) => {
    if (GANTT_ROW_ACTIONS[target] === "details") setDetail(r.issue);
    else setSelected(r);
  }, []);
  const openUrl = selected ? issueOpenUrl(selected.issue, gitlabOriginFromConfig()) : "";
  const dayWidth = ZOOM_WIDTH[zoom];
  const todayLeft = (today - range.start) * dayWidth;

  // The Mac scrolls the chart to today on appear and on zoom change; Today does the same on demand.
  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: todayScrollLeft(todayLeft, el.clientWidth), behavior: "auto" });
  }, [todayLeft]);
  // Re-centres on load and zoom only; a filter change should not move the viewport.
  useEffect(() => {
    if (active && phase === "ready") scrollToToday();
  }, [active, phase, zoom]);

  const toggleCategory = (c: GanttCategory) => {
    setCategories((cur) => (cur.includes(c) ? (cur.length > 1 ? cur.filter((x) => x !== c) : cur) : [...cur, c]));
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
    <div className="gnt-root" data-active={active}>
      <header className="gnt-head">
        <label className="gnt-field">
          <span className="gnt-sr">Search projects</span>
          <input type="search" value={projectQuery} placeholder="Search projects…" onChange={(e) => setProjectQuery(e.target.value)} />
        </label>
        <label className="gnt-field">
          <span className="gnt-sr">Repository</span>
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">All repositories</option>
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="gnt-field">
          <span className="gnt-sr">Provider</span>
          <select value={provider} onChange={(e) => { setProvider(e.target.value as "github" | "gitlab"); setRepo(""); }}>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <div className="gnt-zoom" role="tablist" aria-label="Zoom">
          {(["day", "week", "month"] as const).map((z) => (
            <button key={z} type="button" role="tab" aria-selected={zoom === z} className="gnt-zbtn" onClick={() => setZoom(z)}>{z[0]!.toUpperCase() + z.slice(1)}</button>
          ))}
        </div>
        <span className="gnt-spacer" />
        <div className="gnt-counts" role="group" aria-label="Legend filters">
          {GANTT_CATEGORIES.map((c) => (
            <button key={c} type="button" className="gnt-chip" data-tone={c} aria-pressed={categories.includes(c)} title={categories.includes(c) ? `Click to hide ${CATEGORY_LABEL[c].toLowerCase()} issues` : `Click to show ${CATEGORY_LABEL[c].toLowerCase()} issues`} onClick={() => toggleCategory(c)}>
              {CATEGORY_LABEL[c]} {counts[c]}
            </button>
          ))}
        </div>
        <button type="button" className="gnt-btn" onClick={scrollToToday}>Today</button>
        <button type="button" className="gnt-btn" onClick={() => void load()} disabled={phase === "loading"}>Refresh</button>
      </header>

      <div className="gnt-filters">
        <label className="gnt-field gnt-grow"><span className="gnt-sr">Search</span><input type="search" value={query} placeholder="Search issues…" onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="gnt-seg" role="tablist" aria-label="Issue state">
          {(["all", "open", "closed"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={stateFilter === v} className="gnt-zbtn" onClick={() => setStateFilter(v)}>{v[0]!.toUpperCase() + v.slice(1)}</button>)}
        </div>
        <label className="gnt-field"><span className="gnt-sr">Date</span><select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as typeof dateFilter)}><option value="any">Any date</option><option value="scheduled">Scheduled</option><option value="unscheduled">Unscheduled</option></select></label>
        <label className="gnt-field"><span>Label</span><select value={label} onChange={(e) => setLabel(e.target.value)}><option value="">All labels</option>{labels.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        <label className="gnt-field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="gnt-field"><span>Until</span><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
        <label className="gnt-check"><input type="checkbox" checked={hideUndated} onChange={(e) => setHideUndated(e.target.checked)} /><span>Hide undated</span></label>
      </div>
      {nestedNote ? <p className="gnt-hint">{GANTT_NESTED_HINT}</p> : null}
      {pageNote ? <p className="gnt-hint" role="status">{pageNote}</p> : null}

      {error ? <StatusBanner severity="error" message={error} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} /> : null}
      {shiftFailure ? (
        <div className="gnt-hint" role="alert">
          {shiftFailure.message}
          {shiftFailure.dropped > 0 ? ` ${shiftFailure.dropped} queued move${shiftFailure.dropped === 1 ? " was" : "s were"} not saved.` : ""}{" "}
          <button type="button" className="gnt-btn" onClick={() => onShift(shiftFailure.row, shiftFailure.days)}>Retry move</button>{" "}
          <button type="button" className="gnt-btn" onClick={() => setShiftFailure(null)}>Dismiss</button>
        </div>
      ) : null}

      {phase === "loading" && rows.length === 0 ? (
        <p className="gnt-empty" role="status">Loading the timeline…</p>
      ) : phase === "error" && rows.length === 0 ? (
        <p className="gnt-empty">The timeline is unavailable. Check the core, then Refresh.</p>
      ) : rows.length === 0 ? (
        <div className="gnt-empty">
          <p>No {provider === "github" ? "GitHub" : "GitLab"} issues are cached for this view.</p>
          <p className="gnt-hint">Import a repository's issues in Issues, then schedule them here.</p>
        </div>
      ) : (
        <>
          <GanttChart
            rows={rows}
            shown={rows.length}
            total={baseRows.length}
            noBars={dated.length === 0}
            range={range}
            dayWidth={dayWidth}
            zoom={zoom}
            today={today}
            selectedId={selected?.issue.id}
            onActivate={rowAction}
            onShift={onShift}
            scrollRef={scrollRef}
          />

        </>
      )}

      {selected ? (
        <ScheduleEditor
          key={`${selected.issue.id}:${selected.schedule?.updatedAt ?? ""}`}
          issue={selected.issue}
          schedule={selected.schedule}
          deps={deps}
          onClose={() => setSelected(null)}
          onSaved={(message) => { setNotice(message); setSelected(null); void load(); }}
          onOpenIssue={openUrl ? () => void deps.openExternal(openUrl).catch(() => setNotice("That issue's link could not be opened.")) : null}
          onOpenDetails={() => setDetail(selected.issue)}
        />
      ) : null}

      {detailIssue ? (
        <IssueDetail
          issue={detailIssue}
          deps={deps}
          onClose={() => setDetail(null)}
          onNotice={setNotice}
          onScheduleChanged={() => void load()}
          onChanged={() => void load()}
        />
      ) : null}

    </div>
  );
}
