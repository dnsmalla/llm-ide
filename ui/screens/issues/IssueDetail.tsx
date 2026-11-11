// The read-only issue detail dialog, shared by the Issues board and the Gantt's row details (the Mac's
// RepoIssueDetailSheet, read side). It also shows the schedule overlay's dates and edits them with the Gantt's
// ScheduleEditor. Comments, settings and close use the core's issue routes for GitHub and GitLab.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatDueDate, issueNumber, issueOpenUrl, openedAgo, type Issue } from "./issues-model.ts";
import { DETAIL_NESTED_HINT, issueDatesView, localDatesNote, readIssueSchedule, type Schedule } from "../gantt/gantt-model.ts";
import { normalizeBase, readRepoConfig } from "../settings/repo-config.ts";
import { ScheduleEditor } from "../gantt/ScheduleEditor.tsx";
import "./issues.css";

/** The saved GitLab base's origin (Settings -> Repositories), the only origin a GitLab issue link may open on. */
export function gitlabOriginFromConfig(): string | null {
  try {
    const u = new URL(normalizeBase(readRepoConfig().gitlabBaseUrl));
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export interface IssueDetailView {
  issue?: { state?: string | null; title?: string; body?: string; labels?: string[]; milestone?: { title?: string; dueOn?: string | null } | null; assignees?: string[]; author?: string | null; createdAt?: string | null; updatedAt?: string | null; webUrl?: string | null } | null;
  comments?: { id?: number | null; author: string; body: string; at?: string | null }[];
}

export interface IssueDetailDeps {
  request: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  openExternal: (url: string) => Promise<void>;
}

export function IssueDetail({ issue, deps, onClose, onNotice, onScheduleChanged, onChanged, onSendToFactory }: {
  issue: Issue;
  deps: IssueDetailDeps;
  onClose: () => void;
  onNotice: (message: string) => void;
  onScheduleChanged?: () => void;
  /** Reload the board after a successful comment/close. */
  onChanged?: () => void;
  /** Present when the Factory is usable (the Issues board passes it, the Gantt does not): adds this issue to the Factory. */
  onSendToFactory?: () => void;
}): ReactNode {
  // The overlay keys GitHub owner/name and GitLab paths up to the core's limits; a key it refuses gets the hint, no dates.
  const view = issueDatesView(issue);
  // An older core answered 400 for this nested key: the Dates section goes and the hint says why.
  const [refused, setRefused] = useState(false);
  const schedulable = view.schedulable && !refused;
  const nestedHint = view.nestedHint ?? (refused ? DETAIL_NESTED_HINT : null);
  // undefined = not read yet; null = read and no schedule row for this issue.
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [detail, setDetail] = useState<IssueDetailView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (!issue.number) return;
    const q = new URLSearchParams({ provider: issue.provider, repo: issue.repo, number: String(issue.number) });
    try {
      const r = await deps.request("GET", `/kb/issues/detail?${q.toString()}`);
      if (r.status === 200 && r.body && typeof r.body === "object") {
        setDetail(r.body as IssueDetailView);
        setDetailError(null);
      } else setDetailError("Comments are not available for this issue.");
    } catch { setDetailError("The core could not be reached for comments."); }
  }, [deps, issue.provider, issue.repo, issue.number]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const loadSchedule = useCallback(async () => {
    const r = await readIssueSchedule(deps.request, { provider: issue.provider, repo: issue.repo, number: issue.number });
    if (r.kind === "unsupported") setRefused(true);
    else if (r.kind === "error") setScheduleError(r.error);
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

  const openUrl = issueOpenUrl(issue, gitlabOriginFromConfig());
  const openLink = () => {
    if (!openUrl) return;
    void deps.openExternal(openUrl).catch(() => onNotice("That issue's link could not be opened."));
  };
  const ago = openedAgo(issue.createdAt);
  const write = async (path: string, body: Record<string, unknown>, done: string) => {
    if (!issue.number || writeBusy) return;
    setWriteBusy(true);
    setWriteError(null);
    try {
      const r = await deps.request("POST", path, { provider: issue.provider, repo: issue.repo, number: issue.number, ...body });
      if (r.status >= 200 && r.status < 300) {
        onNotice(done);
        onChanged?.();
        return true;
      }
      const b = r.body && typeof r.body === "object" ? r.body as { error?: { message?: unknown } } : {};
      setWriteError(typeof b.error?.message === "string" ? b.error.message : `The write failed (${r.status}).`);
      return false;
    } catch {
      setWriteError("The core could not be reached.");
      return false;
    } finally { setWriteBusy(false); }
  };

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
        <div className="iss-detail-grid">
          <div className="iss-detail-main">
            <pre className="iss-body">{detail?.issue?.body ?? issue.body ?? "No description."}</pre>
            <section className="iss-comments" aria-label="Comments">
              <h3 className="iss-col-title">Comments</h3>
              {detailError ? <p className="iss-hint">{detailError}</p> : null}
              {detail === null && !detailError ? <p className="iss-hint">Loading comments…</p> : null}
              {detail?.comments?.length ? (
                <ol className="iss-comment-list">
                  {detail.comments.map((c, i) => (
                    <li key={c.id ?? i} className="iss-comment">
                      <span className="iss-comment-avatar" aria-hidden="true">{c.author.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <p className="iss-comment-head"><strong>{c.author}</strong>{c.at ? <time dateTime={c.at}>{openedAgo(c.at)}</time> : null}</p>
                        <pre className="iss-comment-body">{c.body}</pre>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : detail?.comments?.length === 0 ? <p className="iss-hint">No comments yet.</p> : null}
            </section>
            {writeError ? <p className="iss-error" role="alert">{writeError}</p> : null}
            {issue.state !== "closed" ? (
              <section className="iss-write" aria-label="Comment on this issue">
                <label className="iss-field"><span>Comment</span><textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} disabled={writeBusy} placeholder="Write a comment…" /></label>
                <div className="iss-detail-actions">
                  <button type="button" className="iss-btn iss-primary" disabled={writeBusy || comment.trim() === ""} onClick={() => { const body = comment.trim(); void write("/kb/issues/comment", { body }, "Comment posted.").then((ok) => { if (ok) { setComment(""); void loadDetail(); } }); }}>{writeBusy ? "Posting…" : "Comment"}</button>
                </div>
              </section>
            ) : <p className="iss-hint">This issue is closed.</p>}
          </div>
          <aside className="iss-detail-side" aria-label="Issue settings">
            <h3 className="iss-col-title">Issue settings</h3>
            <div className="iss-side-block"><span className="iss-side-label">Status</span><span className="iss-state" data-state={issue.state}>{issue.state === "closed" ? "Closed" : "Open"}</span></div>
            <div className="iss-side-block"><span className="iss-side-label">Labels</span><div className="iss-labels">{(detail?.issue?.labels ?? issue.labels).length ? (detail?.issue?.labels ?? issue.labels).map((l) => <span key={l} className="iss-label">{l}</span>) : <span className="iss-hint">None</span>}</div></div>
            <div className="iss-side-block"><span className="iss-side-label">Milestone</span><span>{detail?.issue?.milestone?.title ?? issue.milestone?.title ?? "None"}</span>{formatDueDate(detail?.issue?.milestone?.dueOn ?? issue.milestone?.dueOn ?? null) ? <span className="iss-hint">due {formatDueDate(detail?.issue?.milestone?.dueOn ?? issue.milestone?.dueOn ?? null)}</span> : null}</div>
            <div className="iss-side-block"><span className="iss-side-label">Assignees</span><span>{(detail?.issue?.assignees ?? issue.assignees).length ? (detail?.issue?.assignees ?? issue.assignees).join(", ") : "None"}</span></div>
            <div className="iss-side-block"><span className="iss-side-label">Author</span><span>{detail?.issue?.author ?? issue.author ?? "Unknown"}{ago ? ` · ${ago}` : ""}</span></div>
            <div className="iss-side-block"><span className="iss-side-label">Repository</span><span>{issue.repo}</span></div>

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
              <button type="button" className="iss-btn iss-primary" disabled={!openUrl} onClick={openLink}>{issue.provider === "gitlab" ? "Open on GitLab" : "Open on GitHub"}</button>
              {onSendToFactory ? <button type="button" className="iss-btn" onClick={onSendToFactory}>Send to Factory</button> : null}
            </div>
            {issue.state !== "closed" ? (!confirmClose ? <button type="button" className="iss-btn" disabled={writeBusy} onClick={() => setConfirmClose(true)}>Close issue</button> : (
              <div className="iss-side-confirm">
                <span className="iss-hint">Close this issue on {issue.provider === "gitlab" ? "GitLab" : "GitHub"}?</span>
                <button type="button" className="iss-btn iss-danger" disabled={writeBusy} onClick={() => void write("/kb/issues/close", {}, "Issue closed.").then((ok) => { if (ok) { onChanged?.(); onClose(); } })}>Close issue</button>
                <button type="button" className="iss-btn" disabled={writeBusy} onClick={() => setConfirmClose(false)}>Cancel</button>
              </div>
            )) : null}
          </aside>
        </div>
        {nestedHint ? <p className="iss-hint">{nestedHint}</p> : null}
        <p className="iss-hint">Writes use the token saved in Settings → Built-in keys for the issue’s provider.</p>
      </section>
    </div>
  );
}
