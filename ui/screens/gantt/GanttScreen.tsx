// The Gantt section: the Mac's timeline over repository issues, with GitHub's dates supplied by the
// /kb/issue-schedule overlay. The desktop reads cached issues (Issues imports them) and can edit the overlay's
// start/due/estimate/dependencies; there is no provider write, so nothing here changes an issue itself.
import { shellBus } from "../shell/bus";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import { CORE_LIST_CAP, decodeIssues, isCapped, labelOptions, type Issue } from "../issues/issues-model.ts";
import {
  GANTT_CATEGORIES,
  barGeometry,
  buildRows,
  countCategories,
  datedRows,
  dayNumber,
  dayString,
  decodeSchedules,
  dependencyLines,
  filterRows,
  isSaveShortcut,
  isWeekend,
  localToday,
  timelineRange,
  todayScrollLeft,
  issueLabel,
  issueTitleBody,
  type GanttCategory,
  type GanttRow,
  type Schedule,
  type TimelineRange,
} from "./gantt-model.ts";
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

const ZOOM_WIDTH: Record<Zoom, number> = { day: 26, week: 12, month: 4 };
const LABEL_WIDTH = 240;
// Mirror gantt.css: the month band (20px) + day header (32px) above the rows, and each track's height.
const HEAD_H = 52;
const ROW_H = 44;
const CATEGORY_LABEL: Record<GanttCategory, string> = { open: "Open", closed: "Closed", overdue: "Overdue" };

export function GanttScreen({ active, deps }: SectionProps & { deps: GanttDeps }): ReactNode {
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [repo, setRepo] = useState("");
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

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const qs = new URLSearchParams({ provider, state: "all", limit: String(CORE_LIST_CAP) });
      const [i, s] = await Promise.all([
        deps.request("GET", `/kb/issues?${qs.toString()}`),
        deps.request("GET", `/kb/issue-schedule?${new URLSearchParams({ provider, repo }).toString()}`),
      ]);
      if (i.status !== 200 || s.status !== 200) {
        setPhase("error");
        setError(i.status === 401 || s.status === 401 ? "Sign in again to read the timeline." : "The core could not load the issues or their schedule.");
        return;
      }
      setIssues(decodeIssues(i.body));
      setSchedules(decodeSchedules(s.body));
      setPhase("ready");
    } catch {
      setPhase("error");
      setError("The core is not reachable right now.");
    }
  }, [deps, provider, repo]);

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
  const scoped = useMemo(() => baseRows.filter((r) => !hideUndated || r.start !== null || r.end !== null).filter((r) => dateFilter === "any" || (dateFilter === "scheduled" ? r.start !== null || r.end !== null : r.start === null && r.end === null)), [baseRows, dateFilter, hideUndated]);
  const fromDay = from ? dayNumber(from) : null;
  const untilDay = until ? dayNumber(until) : null;
  // Legend counts ignore the legend's own toggles, as the Mac's do, so hidden categories still show their numbers.
  const counts = useMemo(() => countCategories(filterRows(scoped, { label, categories: GANTT_CATEGORIES, from: fromDay, until: untilDay, today }), today), [scoped, label, fromDay, untilDay, today]);
  const rows = useMemo(() => filterRows(scoped, { label, categories, from: fromDay, until: untilDay, today }), [scoped, label, categories, fromDay, untilDay, today]);
  const dated = useMemo(() => datedRows(rows), [rows]);
  const range = useMemo<TimelineRange>(() => timelineRange(rows, today), [rows, today]);
  const labels = useMemo(() => labelOptions(issues), [issues]);
  const repos = useMemo(() => [...new Set(issues.filter((i) => !i.isPR).map((i) => i.repo).filter(Boolean))].sort(), [issues]);
  const dayWidth = ZOOM_WIDTH[zoom];
  const timelineWidth = range.days * dayWidth;
  const todayLeft = (today - range.start) * dayWidth;
  const depLines = useMemo(() => dependencyLines(rows, range, dayWidth, (i) => HEAD_H + i * ROW_H + ROW_H / 2), [rows, range, dayWidth]);

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
      {isCapped(issues.length) ? <p className="gnt-hint">Showing the first {CORE_LIST_CAP} issues; the core returns at most that many per list.</p> : null}

      {error ? <StatusBanner severity="error" message={error} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} /> : null}

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
          <div className="gnt-chart" style={{ ["--gnt-label" as string]: `${LABEL_WIDTH}px` }}>
            {dated.length === 0 ? <div className="gnt-no-bars" style={{ left: LABEL_WIDTH }}><strong>No scheduled issues</strong><span>Select an issue and choose Set dates to place it on the timeline.</span></div> : null}
            <div className="gnt-labels">
              <div className="gnt-labels-head"><span>ISSUES</span><span className="gnt-count">{rows.length} / {baseRows.length}</span></div>
              <div className="gnt-month-pad" aria-hidden="true" />
              {rows.map((r) => (
                <button key={r.issue.id} type="button" className="gnt-rowlabel" data-on={selected?.issue.id === r.issue.id || undefined} onClick={() => setSelected(r)} title={r.issue.title}>
                  <span className="gnt-status" data-state={r.issue.state === "closed" ? "closed" : "open"} aria-hidden="true">{r.issue.state === "closed" ? "✓" : "○"}</span>
                  <span className="gnt-rowtext"><span className="gnt-num">{r.issue.number !== null ? `#${r.issue.number}` : ""}</span> {issueTitleBody(r.issue)}</span>
                </button>
              ))}
            </div>
            <div className="gnt-scroll" ref={scrollRef}>
              <div className="gnt-timeline" style={{ width: timelineWidth }}>
                {todayLeft >= 0 && todayLeft <= timelineWidth ? <div className="gnt-today" style={{ left: todayLeft }} aria-hidden="true" /> : null}
                {depLines.length ? (
                  <svg className="gnt-deps" width={timelineWidth} height={HEAD_H + rows.length * ROW_H} aria-hidden="true">
                    <defs>
                      <marker id="gnt-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
                        <path d="M0 0 L6 3 L0 6 z" />
                      </marker>
                    </defs>
                    {depLines.map((l) => {
                      const mid = (l.x1 + l.x2) / 2;
                      return <path key={`${l.blocker}>${l.dependent}`} d={`M${l.x1} ${l.y1} H${mid} V${l.y2} H${l.x2}`} markerEnd="url(#gnt-arrow)" />;
                    })}
                  </svg>
                ) : null}
                <div className="gnt-months" aria-hidden="true">
                {monthSpans(range, dayWidth).map((m) => <span key={m.label} className="gnt-month" style={{ width: m.width }}>{m.label}</span>)}
              </div>
              <div className="gnt-header">
                  {Array.from({ length: range.days }, (_, k) => {
                    const day = range.start + k;
                    const dt = new Date(day * 86_400_000);
                    const label = zoom === "day" ? String(dt.getUTCDate()) : zoom === "week" ? (dt.getUTCDay() === 1 ? String(dt.getUTCDate()) : "") : "";
                    return <div key={day} className="gnt-day" data-weekend={isWeekend(day) || undefined} data-today={day === today || undefined} style={{ width: dayWidth }}>{label}</div>;
                  })}
                </div>
                {rows.map((r) => {
                  const g = barGeometry(r, range, dayWidth);
                  return (
                    <div key={r.issue.id} className="gnt-track" data-on={selected?.issue.id === r.issue.id || undefined}>
                      {Array.from({ length: range.days }, (_, k) => <div key={k} className="gnt-grid" data-weekend={isWeekend(range.start + k) || undefined} style={{ width: dayWidth }} />)}
                      {g ? (
                        <button
                          type="button"
                          className="gnt-bar"
                          style={{ left: g.left, width: g.width }}
                          data-selected={selected?.issue.id === r.issue.id || undefined}
                          title={`${r.issue.title}\n${r.start !== null ? dayString(r.start) : ""} → ${r.end !== null ? dayString(r.end) : ""}`}
                          onClick={() => setSelected(r)}
                        >
                          {r.dependsOn.length ? <span className="gnt-dep" title={`Depends on #${r.dependsOn.join(", #")}`}>⤷</span> : null}
                          {issueLabel(r.issue)}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

        </>
      )}

      {selected ? (
        <ScheduleEditor
          key={`${selected.issue.id}:${selected.schedule?.updatedAt ?? ""}`}
          row={selected}
          deps={deps}
          onClose={() => setSelected(null)}
          onSaved={(message) => { setNotice(message); setSelected(null); void load(); }}
          onOpenIssue={selected.issue.url ? () => void deps.openExternal(selected.issue.url).catch(() => setNotice("That issue's link could not be opened.")) : null}
        />
      ) : null}

    </div>
  );
}

function monthSpans(range: TimelineRange, dayWidth: number): { label: string; width: number }[] {
  const out: { label: string; width: number }[] = [];
  const fmt = new Intl.DateTimeFormat("en", { month: "short", year: "numeric" });
  for (let i = 0; i < range.days; i++) {
    const d = new Date((range.start + i) * 86_400_000);
    const label = fmt.format(d);
    const last = out[out.length - 1];
    if (last?.label === label) last.width += dayWidth; else out.push({ label, width: dayWidth });
  }
  return out;
}

function ScheduleEditor({ row, deps, onClose, onSaved, onOpenIssue }: {
  row: GanttRow;
  deps: GanttDeps;
  onClose: () => void;
  onSaved: (message: string) => void;
  onOpenIssue: (() => void) | null;
}): ReactNode {
  const s = row.schedule;
  const [start, setStart] = useState(s?.startDate ?? "");
  const [due, setDue] = useState(s?.dueDate ?? "");
  const [estimate, setEstimate] = useState(s?.estimateDays !== null && s?.estimateDays !== undefined ? String(s.estimateDays) : "");
  const [depends, setDepends] = useState((s?.dependsOn ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (clear = false) => {
    if (row.issue.number === null) return;
    const parseDeps = (): number[] | null => {
      const bits = depends.split(",").map((x) => x.trim()).filter(Boolean);
      const out: number[] = [];
      for (const b of bits) {
        const n = Number(b.replace(/^#/, ""));
        if (!Number.isInteger(n) || n <= 0) return null;
        if (!out.includes(n)) out.push(n);
      }
      return out;
    };
    const depsList = parseDeps();
    if (!clear && depsList === null) {
      setError("Dependencies must be issue numbers, separated by commas.");
      return;
    }
    if (!clear && ((start && dayNumber(start) === null) || (due && dayNumber(due) === null))) {
      setError("Dates are YYYY-MM-DD or empty.");
      return;
    }
    if (!clear && start && due && (dayNumber(due)! < dayNumber(start)!)) {
      setError("Due cannot be before start.");
      return;
    }
    const est = estimate.trim() === "" ? null : Number(estimate);
    if (!clear && est !== null && (!Number.isFinite(est) || est < 0)) {
      setError("Estimate must be a non-negative number of days.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = clear
        ? { provider: row.issue.provider, repo: row.issue.repo, issueNumber: row.issue.number }
        : { provider: row.issue.provider, repo: row.issue.repo, issueNumber: row.issue.number, startDate: start || null, dueDate: due || null, estimateDays: est, dependsOn: depsList };
      const r = await deps.request(clear ? "DELETE" : "PUT", "/kb/issue-schedule", body);
      if (r.status !== 200) {
        setError(`The schedule could not be saved (${r.status}).`);
        return;
      }
      onSaved(clear ? "Dates cleared." : "Schedule saved.");
    } catch {
      setError("The core is not reachable right now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gnt-editor" role="dialog" aria-modal="false" aria-label="Schedule issue" onKeyDown={(e) => { if (isSaveShortcut(e)) { e.preventDefault(); if (!busy) void save(); } }}>
      <div className="gnt-editor-head">
        <strong>{issueLabel(row.issue)}</strong>
        <span className="gnt-hint">{row.issue.repo}</span>
        <span className="gnt-spacer" />
        {onOpenIssue ? <button type="button" className="gnt-link" onClick={onOpenIssue}>Open issue</button> : null}
        <button type="button" className="gnt-btn" onClick={onClose}>Close</button>
      </div>
      <div className="gnt-editor-grid">
        <label className="gnt-field"><span>Start</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="gnt-field"><span>Due</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label className="gnt-field"><span>Estimate (days)</span><input type="number" min={0} step={1} value={estimate} onChange={(e) => setEstimate(e.target.value)} /></label>
        <label className="gnt-field"><span>Depends on (#numbers)</span><input value={depends} placeholder="12, 15" onChange={(e) => setDepends(e.target.value)} /></label>
      </div>
      {error ? <p className="gnt-error" role="alert">{error}</p> : null}
      <div className="gnt-editor-actions">
        <button type="button" className="gnt-btn gnt-primary" disabled={busy || row.issue.number === null} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="gnt-btn" disabled={busy || !row.schedule} onClick={() => void save(true)}>Clear dates</button>
      </div>
    </div>
  );
}
