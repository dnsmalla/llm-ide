// The read-only issue detail dialog, shared by the Issues board and the Gantt's row details (the Mac's
// RepoIssueDetailSheet, read side). For GitHub issues it also shows the schedule overlay's dates and edits them with
// the Gantt's ScheduleEditor. Writes (comment, close) stay Mac-only until the core has provider write routes.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { issueNumber, openedAgo, type Issue } from "./issues-model.ts";
import { issueDatesView, localDatesNote, readIssueSchedule, type Schedule } from "../gantt/gantt-model.ts";
import { ScheduleEditor } from "../gantt/ScheduleEditor.tsx";
import "./issues.css";

export interface IssueDetailDeps {
  request: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  openExternal: (url: string) => Promise<void>;
}

export function IssueDetail({ issue, deps, onClose, onNotice, onScheduleChanged }: {
  issue: Issue;
  deps: IssueDetailDeps;
  onClose: () => void;
  onNotice: (message: string) => void;
  onScheduleChanged?: () => void;
}): ReactNode {
  // The schedule overlay takes GitHub and GitLab rows keyed by owner/name; a nested GitLab path has no overlay key.
  const { schedulable, nestedHint } = issueDatesView(issue);
  // undefined = not read yet; null = read and no schedule row for this issue.
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const loadSchedule = useCallback(async () => {
    const r = await readIssueSchedule(deps.request, { provider: issue.provider, repo: issue.repo, number: issue.number });
    if (r.kind === "error") setScheduleError(r.error);
    else if (r.kind === "ok") {
      setSchedule(r.schedule);
      setScheduleError(null);
    }
  }, [deps, issue.provider, issue.repo, issue.number]);

  useEffect(() => { void loadSchedule(); }, [loadSchedule]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openLink = () => {
    if (!issue.url) return;
    void deps.openExternal(issue.url).catch(() => onNotice("That issue's link could not be opened."));
  };
  const ago = openedAgo(issue.createdAt);

  return (
    <div className="iss-detail-backdrop" role="presentation" onClick={onClose}>
      <section className="iss-detail" role="dialog" aria-modal="true" aria-label="Issue details" onClick={(e) => e.stopPropagation()}>
        <header className="iss-detail-head">
          <div className="iss-grow">
            <h2>{issueNumber(issue)} {issue.title}</h2>
            <p className="iss-hint">
              {issue.repo} · {issue.state}{issue.author ? ` · ${issue.author}` : ""}
              {ago ? <> · Opened <time dateTime={issue.createdAt ?? undefined} title={issue.createdAt ?? undefined}>{ago}</time></> : null}
            </p>
          </div>
          <button type="button" className="iss-btn" onClick={onClose}>Close</button>
        </header>
        {issue.labels.length ? <div className="iss-labels">{issue.labels.map((l) => <span key={l} className="iss-label">{l}</span>)}</div> : null}
        <pre className="iss-body">{issue.body || "No description."}</pre>

        {schedulable ? (
          <section className="iss-dates" aria-label="Dates">
            <h3 className="iss-col-title">Dates</h3>
            {localDatesNote(issue) ? <p className="iss-hint" role="note">{localDatesNote(issue)}</p> : null}
            {scheduleError ? <p className="iss-hint">{scheduleError}</p> : schedule === undefined ? <p className="iss-hint">Loading dates…</p> : (
              <p className="iss-dates-line">
                Start {schedule?.startDate ?? "None"} · Due {schedule?.dueDate ?? "None"}
                {schedule?.estimateDays ? ` · ${schedule.estimateDays} days` : ""}
                {schedule?.dependsOn.length ? ` · Depends on #${schedule.dependsOn.join(", #")}` : ""}
              </p>
            )}
            {schedule !== undefined && !editing ? <button type="button" className="iss-btn" onClick={() => setEditing(true)}>Edit schedule</button> : null}
            {editing && schedule !== undefined ? (
              <ScheduleEditor
                issue={issue}
                schedule={schedule}
                deps={deps}
                onClose={() => setEditing(false)}
                onSaved={(message) => {
                  setEditing(false);
                  onNotice(message);
                  void loadSchedule();
                  onScheduleChanged?.();
                }}
              />
            ) : null}
          </section>
        ) : null}

        <div className="iss-detail-actions">
          <button type="button" className="iss-btn iss-primary" disabled={!issue.url} onClick={openLink}>{issue.provider === "gitlab" ? "Open on GitLab" : "Open on GitHub"}</button>
          <button type="button" className="iss-btn" disabled title="Creating, commenting and closing are Mac-only until the core has provider write routes">Comment</button>
          <button type="button" className="iss-btn" disabled title="Closing is Mac-only until the core has provider write routes">Close issue</button>
        </div>
        {nestedHint ? <p className="iss-hint">{nestedHint}</p> : null}
        <p className="iss-hint">Read-only detail from the cached issue. Comments, edits and state changes stay in the Mac app until the core gains provider write routes.</p>
      </section>
    </div>
  );
}
