// The Improvements panel of the Loop page: suggestions for the selected loop, offers from other projects, and what
// was accepted. Applying/reverting goes through panel-model.ts; this file only renders and wires events.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FsApi } from "../../../explorer/fs";
import type { LoopDefinition, LoopProjectStore } from "../model.ts";
import type { CoreFetch } from "../stage-exec.ts";
import { improveAvailable, loadCoreApiVersion } from "./signals.ts";
import { runReview } from "./review.ts";
import { shareableScope, type ImprovementChange } from "./change.ts";
import {
  acceptImprovement, decideSimple, improveErrorLine, loadImproveState, outcomeLabel, revertImprovement, reviewStatusLine, shouldAutoReview,
  type ApplyResult, type ImproveRow, type ImproveState,
} from "./panel-model.ts";

export interface ImprovementsPanelProps {
  fs: Pick<FsApi, "read" | "write">;
  core: CoreFetch;
  projectRoot: string;
  loop: LoopDefinition;
  load: { store: LoopProjectStore; hash: string };
  /** Unsaved edits on the page: applying would write them too, so it waits for Save. */
  dirty: boolean;
  runningLoopIds: ReadonlySet<string>;
  /** Changes after a run finished on this page; triggers the background review check. */
  refreshKey: number;
  onApplied(result: ApplyResult): void;
  /** Suggestion counts per loop id, for the loop list badge. */
  onCounts(counts: Record<string, number>): void;
  onNotice(text: string): void;
}

const v = (x: unknown): string => (x === null || x === undefined || x === "" ? "none" : String(x));

/** "Before → after" in plain words for one change. */
export function describeChange(c: ImprovementChange): { what: string; before: string; after: string } {
  if (c.op === "setConfig") return { what: `Setting: ${c.field}`, before: v(c.before), after: v(c.after) };
  if (c.op === "setStageField") return { what: `${c.stageName}: ${c.field}`, before: v(c.before), after: v(c.after) };
  if (c.op === "moveStage") return { what: `Move ${c.stageName}`, before: `position ${c.beforeIndex + 1}`, after: `position ${c.afterIndex + 1}` };
  return { what: `${c.stageName}: extra instructions`, before: v(c.before), after: v(c.after) };
}

function ChangeView({ change }: { change: ImprovementChange }): ReactNode {
  const d = describeChange(change);
  return (
    <div className="loop-imp-change">
      <strong>{d.what}</strong>
      <div className="loop-imp-diff"><span className="loop-imp-before">{d.before}</span><span aria-hidden="true">→</span><span className="loop-imp-after">{d.after}</span></div>
    </div>
  );
}

function ProposalCard({ row, loop, busy, blocked, onAccept, onReject }: { row: ImproveRow; loop: LoopDefinition; busy: boolean; blocked: string | null; onAccept(scope: "project" | "general"): void; onReject(): void }): ReactNode {
  const projectOnly = shareableScope(row.change, loop) === "projectOnly";
  const [scope, setScope] = useState<"project" | "general">(projectOnly ? "project" : row.suggestedScope);
  const excerpts = row.evidence?.excerpts ?? [];
  return (
    <li className="loop-imp-card">
      <ChangeView change={row.change} />
      {row.rationale ? <p className="loop-native-hint">{row.rationale}</p> : null}
      {excerpts.length ? <ul className="loop-imp-evidence" aria-label="Evidence">{excerpts.map((e, i) => <li key={i}>{e}</li>)}</ul> : null}
      {row.evidence?.signalIds.length ? <p className="loop-native-hint">Based on {row.evidence.signalIds.length} recorded signal{row.evidence.signalIds.length === 1 ? "" : "s"}.</p> : null}
      <div className="loop-imp-scope" role="radiogroup" aria-label="Where to keep this">
        <label><input type="radio" name={`scope-${row.id}`} checked={scope === "project"} onChange={() => setScope("project")} /> This project only</label>
        <label title={projectOnly ? "This step is not shared between projects" : undefined}><input type="radio" name={`scope-${row.id}`} disabled={projectOnly} checked={scope === "general"} onChange={() => setScope("general")} /> All my projects</label>
      </div>
      <div className="loop-imp-actions">
        <button type="button" className="loop-btn loop-btn-primary" disabled={busy || blocked !== null} title={blocked ?? undefined} onClick={() => onAccept(scope)}>Accept</button>
        <button type="button" className="loop-btn" disabled={busy} onClick={onReject}>Reject</button>
        {blocked ? <span className="loop-native-hint">{blocked}</span> : null}
      </div>
    </li>
  );
}

export function ImprovementsPanel(props: ImprovementsPanelProps): ReactNode {
  const { fs, core, projectRoot, loop, load, dirty, runningLoopIds, refreshKey, onApplied, onCounts, onNotice } = props;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<ImproveState | null>(null);
  const [unavailableText, setUnavailableText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busyId, setBusyId] = useState<string | number | null>(null);
  const attempted = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const storeRef = useRef(load.store);
  storeRef.current = load.store;

  useEffect(() => { void loadCoreApiVersion(core).then((ver) => { if (live.current) setAvailable(improveAvailable(ver)); }); }, [core]);

  const refresh = useCallback(async (): Promise<ImproveState | null> => {
    try {
      const next = await loadImproveState(core, projectRoot, storeRef.current);
      if (!live.current) return null;
      setState(next); setErrorText(null); setUnavailableText(null);
      onCounts(Object.fromEntries(Object.entries(next.loops).map(([id, l]) => [id, l.proposals.length])));
      return next;
    } catch (e) {
      const line = improveErrorLine(e);
      if (live.current) { if (line.unavailable) setUnavailableText(line.text); else setErrorText(line.text); }
      return null;
    }
  }, [core, projectRoot, onCounts]);

  const review = useCallback(async (manual: boolean) => {
    setReviewing(true); setStatus("Reviewing recent runs…");
    try {
      const r = await runReview({ core, projectRoot, loop });
      if (!live.current) return;
      setStatus(reviewStatusLine(r));
      await refresh();
    } catch (e) {
      if (live.current) setStatus(manual ? `Review failed: ${improveErrorLine(e).text}` : null);
    } finally { if (live.current) setReviewing(false); }
  }, [core, projectRoot, loop, refresh]);

  // Page load, loop switch and after a run: read the state, then review in the background when it is due. Never awaited by a run or a save.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void refresh().then((next) => {
      const mine = next?.loops[loop.id];
      if (cancelled || !mine || !shouldAutoReview(mine.finishedRunsSinceReview, loop)) return;
      const key = `${loop.id}:${mine.finishedRunsSinceReview}`;
      if (attempted.current.has(key)) return;
      attempted.current.add(key);
      void review(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loop` changes on every edit; reload on switch, run end and availability only.
  }, [available, loop.id, refreshKey, projectRoot]);

  if (!available) return null;
  if (unavailableText) return <section className="loop-card loop-imp" aria-label="Improvements"><h2>Improvements</h2><p className="loop-native-hint">{unavailableText}</p></section>;

  const mine = state?.loops[loop.id];
  const blocked = runningLoopIds.has(loop.id) ? "Finish or stop the run first" : dirty ? "Save your changes first" : null;
  const offers = (state?.offers ?? []).filter((o) => o.forLoopId === undefined || o.forLoopId === loop.id);
  const accepted = (mine?.history ?? []).filter((h) => h.status === "accepted" || h.status === "reverted");
  const deps = () => ({ fs, core, projectRoot, load, runningLoopIds });

  const act = async (row: ImproveRow, run: () => Promise<ApplyResult | void>) => {
    setBusyId(row.id);
    try {
      const result = await run();
      if (result) { onApplied(result); if (result.notice) onNotice(result.notice); }
      await refresh();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "That did not work.");
    } finally { if (live.current) setBusyId(null); }
  };

  return (
    <section className="loop-card loop-imp" aria-label="Improvements">
      <div className="loop-imp-head">
        <h2>Improvements</h2>
        <button type="button" className="loop-btn" disabled={reviewing} onClick={() => void review(true)}>{reviewing ? "Reviewing…" : "Review now"}</button>
      </div>
      <p className="loop-native-hint" role="status">{status ?? (mine ? `${mine.finishedRunsSinceReview} finished run${mine.finishedRunsSinceReview === 1 ? "" : "s"} since the last review.` : "")}</p>
      {errorText ? <p className="loop-native-hint loop-imp-error">{errorText}</p> : null}

      <h3>Suggestions</h3>
      {mine && mine.proposals.length > 0 ? (
        <ul className="loop-imp-list">
          {mine.proposals.map((row) => (
            <ProposalCard key={row.id} row={row} loop={loop} busy={busyId === row.id} blocked={blocked}
              onAccept={(scope) => void act(row, () => acceptImprovement(deps(), { id: row.id, loopId: loop.id, change: row.change, kind: "proposal" }, scope))}
              onReject={() => void act(row, () => decideSimple(core, projectRoot, { action: "reject", id: row.id }))} />
          ))}
        </ul>
      ) : <p className="loop-native-hint">No suggestions yet.</p>}

      {offers.length > 0 ? (
        <>
          <h3>From your other projects</h3>
          <ul className="loop-imp-list">
            {offers.map((row) => (
              <li key={row.id} className="loop-imp-card">
                <ChangeView change={row.change} />
                <p className="loop-native-hint">From {row.fromProjectName ?? "another project"}{outcomeLabel(row.outcome) ? ` · ${outcomeLabel(row.outcome)}` : ""}</p>
                <div className="loop-imp-actions">
                  <button type="button" className="loop-btn loop-btn-primary" disabled={busyId === row.id || blocked !== null} title={blocked ?? undefined}
                    onClick={() => void act(row, () => acceptImprovement(deps(), { id: row.id, loopId: loop.id, change: row.change, kind: "offer" }, "project"))}>Apply</button>
                  <button type="button" className="loop-btn" disabled={busyId === row.id} onClick={() => void act(row, () => decideSimple(core, projectRoot, { action: "dismiss", id: row.id }))}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {accepted.length > 0 ? (
        <>
          <h3>Accepted</h3>
          <ul className="loop-imp-list">
            {accepted.map((row) => {
              const label = outcomeLabel(row.outcome) ?? (row.status === "accepted" ? "Not enough data yet" : null);
              return (
                <li key={row.id} className="loop-imp-card">
                  <ChangeView change={row.change} />
                  <div className="loop-imp-actions">
                    {row.status === "reverted" ? <span className="loop-imp-badge">Undone</span> : label ? <span className="loop-imp-badge" data-verdict={row.outcome?.verdict ?? "not_enough_data"}>{label}</span> : null}
                    {row.status === "accepted" ? (
                      <button type="button" className="loop-btn" disabled={busyId === row.id || blocked !== null} title={blocked ?? undefined}
                        onClick={() => void act(row, () => revertImprovement(deps(), { id: row.id, loopId: loop.id, change: row.change }))}>Undo</button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
