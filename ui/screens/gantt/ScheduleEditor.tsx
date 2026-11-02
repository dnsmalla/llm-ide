// The schedule overlay editor (`PUT/DELETE /kb/issue-schedule`), shared by the Gantt and the Issues detail. It is
// the Mac's IssueScheduleEditorSheet for GitHub: start, due, estimate and dependencies, with the same validation
// (due before start is rejected) and Cmd/Ctrl+Enter to save.
import { useState, type ReactNode } from "react";
import type { Issue } from "../issues/issues-model.ts";
import { isSaveShortcut, issueLabel, scheduleSaveBody, type Schedule } from "./gantt-model.ts";
import "./gantt.css";

export interface ScheduleDeps {
  request: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
}

export function ScheduleEditor({ issue, schedule, deps, onClose, onSaved, onOpenIssue, onOpenDetails }: {
  issue: Issue;
  schedule: Schedule | null;
  deps: ScheduleDeps;
  onClose: () => void;
  onSaved: (message: string) => void;
  onOpenIssue?: (() => void) | null;
  onOpenDetails?: (() => void) | null;
}): ReactNode {
  const s = schedule;
  const [start, setStart] = useState(s?.startDate ?? "");
  const [due, setDue] = useState(s?.dueDate ?? "");
  const [estimate, setEstimate] = useState(s?.estimateDays !== null && s?.estimateDays !== undefined ? String(s.estimateDays) : "");
  const [depends, setDepends] = useState((s?.dependsOn ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (clear = false) => {
    if (issue.number === null) return;
    const key = { provider: issue.provider, repo: issue.repo, issueNumber: issue.number };
    let body: unknown = key;
    if (!clear) {
      const checked = scheduleSaveBody({ start, due, estimate, depends }, key);
      if (!checked.ok) {
        setError(checked.error);
        return;
      }
      body = checked.body;
    }
    setBusy(true);
    setError(null);
    try {
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
        <strong>{issueLabel(issue)}</strong>
        <span className="gnt-hint">{issue.repo}</span>
        <span className="gnt-spacer" />
        {onOpenDetails ? <button type="button" className="gnt-link" onClick={onOpenDetails}>Open details</button> : null}
        {onOpenIssue ? <button type="button" className="gnt-link" onClick={onOpenIssue}>Open issue</button> : null}
        <button type="button" className="gnt-btn" onClick={onClose}>Close</button>
      </div>
      <div className="gnt-editor-grid">
        <label className="gnt-field"><span>Start</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="gnt-field"><span>Due</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label className="gnt-field"><span>Estimate (days)</span><input type="number" min={0} max={365} step={0.5} value={estimate} onChange={(e) => setEstimate(e.target.value)} /></label>
        <label className="gnt-field"><span>Depends on (#numbers)</span><input value={depends} placeholder="12, 15" onChange={(e) => setDepends(e.target.value)} /></label>
      </div>
      {error ? <p className="gnt-error" role="alert">{error}</p> : null}
      <div className="gnt-editor-actions">
        <button type="button" className="gnt-btn gnt-primary" disabled={busy || issue.number === null} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="gnt-btn" disabled={busy || !schedule} onClick={() => void save(true)}>Clear dates</button>
      </div>
    </div>
  );
}
