// The Gantt section: the Mac's timeline over repository issues, with GitHub's dates supplied by the
// /kb/issue-schedule overlay. The desktop reads cached issues (Issues imports them) and can edit the overlay's
// start/due/estimate/dependencies; there is no provider write, so nothing here changes an issue itself.
import { shellBus } from "../shell/bus";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import { decodeIssues, type Issue } from "../issues/issues-model.ts";
import {
  barGeometry,
  buildRows,
  datedRows,
  dayNumber,
  dayString,
  decodeSchedules,
  isWeekend,
  timelineRange,
  undatedRows,
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

type Zoom = "day" | "week";
type Phase = "idle" | "loading" | "ready" | "error";

const ZOOM_WIDTH: Record<Zoom, number> = { day: 26, week: 12 };
const LABEL_WIDTH = 240;

export function GanttScreen({ active, deps }: SectionProps & { deps: GanttDeps }): ReactNode {
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [repo, setRepo] = useState("");
  const [hideUndated, setHideUndated] = useState(false);
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
      const qs = new URLSearchParams({ provider, state: "all", limit: "200" });
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

  const rows = useMemo(() => buildRows(issues, schedules, provider, repo), [issues, schedules, provider, repo]);
  const dated = useMemo(() => datedRows(rows), [rows]);
  const undated = useMemo(() => undatedRows(rows), [rows]);
  const range = useMemo<TimelineRange>(() => timelineRange(rows), [rows]);
  const repos = useMemo(() => [...new Set(issues.filter((i) => !i.isPR).map((i) => i.repo).filter(Boolean))].sort(), [issues]);
  const dayWidth = ZOOM_WIDTH[zoom];
  const timelineWidth = range.days * dayWidth;

  return (
    <div className="gnt-root" data-active={active}>
      <header className="gnt-head">
        <h2 className="gnt-title">Gantt</h2>
        <label className="gnt-field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => { setProvider(e.target.value as "github" | "gitlab"); setRepo(""); }}>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <label className="gnt-field">
          <span>Repository</span>
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">All repositories</option>
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="gnt-check">
          <input type="checkbox" checked={hideUndated} onChange={(e) => setHideUndated(e.target.checked)} />
          <span>Hide undated</span>
        </label>
        <div className="gnt-zoom" role="tablist" aria-label="Zoom">
          {(["day", "week"] as const).map((z) => (
            <button key={z} type="button" role="tab" aria-selected={zoom === z} className="gnt-zbtn" onClick={() => setZoom(z)}>{z === "day" ? "Day" : "Week"}</button>
          ))}
        </div>
        <button type="button" className="gnt-btn" onClick={() => void load()} disabled={phase === "loading"}>Refresh</button>
      </header>

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
            <div className="gnt-labels" aria-hidden="true">
              <div className="gnt-labels-head">Issue</div>
              {dated.map((r) => (
                <button key={r.issue.id} type="button" className="gnt-rowlabel" data-on={selected?.issue.id === r.issue.id || undefined} onClick={() => setSelected(r)} title={r.issue.title}>
                  <span className="gnt-num">{r.issue.number !== null ? `#${r.issue.number}` : ""}</span> {r.issue.title}
                </button>
              ))}
            </div>
            <div className="gnt-scroll">
              <div className="gnt-timeline" style={{ width: timelineWidth }}>
                <div className="gnt-header">
                  {Array.from({ length: range.days }, (_, k) => {
                    const day = range.start + k;
                    const label = zoom === "day" || new Date(day * 86_400_000).getUTCDay() === 1 ? dayString(day).slice(5) : "";
                    return <div key={day} className="gnt-day" data-weekend={isWeekend(day) || undefined} data-today={day === Math.floor(Date.now() / 86_400_000) || undefined} style={{ width: dayWidth }}>{label}</div>;
                  })}
                </div>
                {dated.map((r) => {
                  const g = barGeometry(r, range, dayWidth);
                  return (
                    <div key={r.issue.id} className="gnt-track">
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
                          {r.issue.number !== null ? `#${r.issue.number} ` : ""}{r.issue.title}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {!hideUndated && undated.length ? (
            <section className="gnt-undated" aria-label="Issues without dates">
              <h3 className="gnt-sub">No dates ({undated.length})</h3>
              <ul className="gnt-ulist">
                {undated.map((r) => (
                  <li key={r.issue.id}>
                    <button type="button" className="gnt-link" onClick={() => setSelected(r)}>
                      {r.issue.number !== null ? `#${r.issue.number} ` : ""}{r.issue.title}
                    </button>
                    <span className="gnt-hint"> {r.issue.repo}</span>
                  </li>
                ))}
              </ul>
              <p className="gnt-hint">Give these a start/due date here; GitHub issues have no dates of their own.</p>
            </section>
          ) : null}
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

      <p className="gnt-hint gnt-foot">The timeline reads cached issues and the scheduling overlay. Only the overlay is written here; the issue itself is unchanged.</p>
    </div>
  );
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
    <div className="gnt-editor" role="dialog" aria-modal="false" aria-label="Schedule issue">
      <div className="gnt-editor-head">
        <strong>{row.issue.number !== null ? `#${row.issue.number} ` : ""}{row.issue.title}</strong>
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
