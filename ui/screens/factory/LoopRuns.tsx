// A board for every non-Factory loop: the loop's stages are the lanes, each run is a card placed at the stage it
// reached (or Done). Facts come from system/loop-runs; nothing here can start or change a run.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { shellBus } from "../shell/bus";
import { createHostFs } from "../explorer/fs";
import { loadLoops } from "../loop/native/store.ts";
import { loadRunRecord, readRecentRuns, type LoopRunIndexEntry } from "../loop/native/history.ts";

export interface LoopRunsProps {
  projectRoot: string;
  scope: string;
}

const DONE = "Done";
const when = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const statusWord = (code: string): string => code === "success" ? "passed" : code.startsWith("blocked") ? "blocked" : code === "aborted" ? "cancelled" : "failed";

interface RunCard { run: LoopRunIndexEntry; lane: string; note: string; failed: boolean }

/** The lane a run belongs to: Done on success, else its last executed or failed stage. */
function laneOf(run: LoopRunIndexEntry, record: Record<string, unknown> | null, steps: readonly string[]): { lane: string; note: string } {
  if (run.statusCode === "success") return { lane: DONE, note: run.statusSummary };
  const rows = Array.isArray(record?.stages) ? record.stages : [];
  let last: string | null = null;
  let failed: string | null = null;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const name = (row as { stageName?: unknown }).stageName;
    if (typeof name === "string" && name.trim()) last = name.trim();
    const exit = ((row as { run?: { exitCode?: unknown } }).run?.exitCode);
    if (typeof exit === "number" && exit !== 0) failed = last;
  }
  const name = failed ?? last ?? steps[0] ?? DONE;
  return { lane: name, note: run.statusSummary };
}

export function LoopRuns({ projectRoot, scope }: LoopRunsProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [steps, setSteps] = useState<string[]>([]);
  const [cards, setCards] = useState<RunCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void Promise.all([
      readRecentRuns(fs, 100),
      loadLoops(fs).then((r) => r.kind === "ok" ? r.store.loops.find((l) => l.name === scope) ?? null : null, () => null),
    ]).then(async ([rows, loop]) => {
      if (!live) return;
      const names = loop ? loop.config.stages.filter((s) => s.enabled).map((s) => s.name) : [];
      setSteps(names);
      const shown = rows.filter((r) => r.loopName === scope).slice(0, 40);
      const loaded = await Promise.all(shown.map((r) => loadRunRecord(fs, r.id, r.startedAt).catch(() => null)));
      if (!live) return;
      setCards(shown.map((run, i) => {
        const at = laneOf(run, loaded[i], names);
        return { run, lane: at.lane, note: at.note, failed: run.statusCode !== "success" };
      }));
    }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [fs, projectRoot, scope, tick]);

  const lanes = useMemo(() => {
    const out = [...steps];
    for (const c of cards) if (!out.includes(c.lane)) out.push(c.lane);
    if (cards.some((c) => c.lane === DONE) && !out.includes(DONE)) out.push(DONE);
    return out.length ? out : [DONE];
  }, [steps, cards]);

  const openRun = async (id: string, startedAt: string) => {
    try {
      const rec = await loadRunRecord(fs, id, startedAt);
      const path = rec?.summaryPath;
      if (typeof path === "string" && path) shellBus.publish({ type: "open-file", path });
      else setError("This run has no archived run.md yet; it was recorded before run archives existed.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="fx-board-root">
      <header className="fx-head">
        <div className="fx-head-title">
          <h2>{scope} board</h2>
          <p className="fx-summary">{cards.length} run{cards.length === 1 ? "" : "s"}</p>
        </div>
        <span className="fx-spacer" />
        <button type="button" className="fx-btn" onClick={() => setTick((n) => n + 1)}>Refresh</button>
      </header>
      {error ? <p className="fx-error" role="status">{error}</p> : null}
      <div className="fx-lanes" role="list" aria-label={`${scope} board`}>
        {lanes.map((lane) => {
          const inLane = cards.filter((c) => c.lane === lane);
          return (
            <section className="fx-lane" key={lane} role="listitem" aria-label={`${lane} runs`}>
              <header className="fx-lane-head"><h3>{lane}</h3><span>{inLane.length}</span></header>
              <div className="fx-lane-cards">
                {inLane.length === 0 ? <p className="fx-empty">No runs.</p> : null}
                {inLane.map(({ run, note, failed }) => (
                  <article key={run.id} className="fx-run" data-status={failed ? "failed" : "success"}>
                    <header className="fx-run-head"><strong>{run.loopName}</strong><span className="fx-run-status">{statusWord(run.statusCode)}</span><span className="fx-run-time">{when(run.startedAt)}</span></header>
                    <p className="fx-run-summary">{note}</p>
                    <p className="fx-run-meta">{run.durationSeconds ? `${run.durationSeconds}s` : "—"} · {run.iterationsUsed} iteration{run.iterationsUsed === 1 ? "" : "s"}</p>
                    <div className="fx-actions"><button type="button" className="fx-btn" onClick={() => void openRun(run.id, run.startedAt)}>Open run log & plan</button></div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
