// Run cards for the non-Factory loops (Test, Refactoring, …). The Factory board stays item/worktree based; these loops
// are run-based, so their cards come from the run index under system/loop-runs.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { shellBus } from "../shell/bus";
import { createHostFs } from "../explorer/fs";
import { loadRunRecord, readRecentRuns, type LoopRunIndexEntry } from "../loop/native/history.ts";

export interface LoopRunsProps {
  projectRoot: string;
  scope: string;
  loops: readonly string[];
  onScope(name: string): void;
}

const when = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

const statusWord = (code: string): string => code === "success" ? "passed" : code.startsWith("blocked") ? "blocked" : code === "aborted" ? "cancelled" : code === "running" ? "running" : "failed";

export function LoopRuns({ projectRoot, scope, loops, onScope }: LoopRunsProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [runs, setRuns] = useState<LoopRunIndexEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    void readRecentRuns(fs, 100).then((rows) => { if (live) setRuns(rows); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [fs, projectRoot, scope]);

  const shown = runs.filter((r) => r.loopName === scope);
  const openRun = async (id: string, startedAt: string) => {
    setOpening(id);
    try {
      const rec = await loadRunRecord(fs, id, startedAt);
      const path = rec?.summaryPath;
      if (typeof path === "string" && path) shellBus.publish({ type: "open-file", path });
      else setError("This run has no archived run.md yet; it was recorded before run archives existed.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setOpening(null); }
  };

  return (
    <div className="fx-board-root">
      <header className="fx-head">
        <div className="fx-head-title">
          <h2>Loop runs</h2>
          <p className="fx-summary">{shown.length} run{shown.length === 1 ? "" : "s"} · {scope}</p>
        </div>
        <span className="fx-spacer" />
        <label className="fx-field fx-field-inline">
          <span>Loop</span>
          <select value={scope} onChange={(e) => onScope(e.target.value)}>
            <option value="Factory">Factory</option>
            {loops.filter((n) => n !== "Factory").map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" className="fx-btn" onClick={() => void readRecentRuns(fs, 100).then(setRuns, (e) => setError(e instanceof Error ? e.message : String(e)))}>Refresh</button>
      </header>
      {error ? <p className="fx-error" role="status">{error}</p> : null}
      <div className="fx-runs" role="list" aria-label={`${scope} runs`}>
        {shown.length === 0 ? <p className="fx-empty">No {scope} runs yet. Start one from the Loop editor.</p> : null}
        {shown.map((r) => (
          <article key={r.id} className="fx-run" role="listitem" data-status={r.statusCode}>
            <header className="fx-run-head">
              <strong>{r.loopName}</strong>
              <span className="fx-run-status">{statusWord(r.statusCode)}</span>
              <span className="fx-run-time">{when(r.startedAt)}</span>
            </header>
            <p className="fx-run-summary">{r.statusSummary}</p>
            <p className="fx-run-meta">{r.durationSeconds ? `${r.durationSeconds}s` : "—"} · {r.iterationsUsed} iteration{r.iterationsUsed === 1 ? "" : "s"} · {r.trigger}</p>
            <div className="fx-actions">
              <button type="button" className="fx-btn" disabled={opening === r.id} onClick={() => void openRun(r.id, r.startedAt)}>{opening === r.id ? "Opening…" : "Open run log & plan"}</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
