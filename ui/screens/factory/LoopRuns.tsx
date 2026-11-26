// A board for every non-Factory loop: the loop's stages are the lanes, each run is a card placed at the stage it
// reached (or Done). Facts come from system/loop-runs. The run bar only REQUESTS a run (shell bus "run-loop"): the
// Loop page owns execution (approval dialog, worktree, queue, ship), so this board never runs or edits anything.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shellBus } from "../shell/bus";
import { invokeHost } from "../shell/host";
import { pickInputPath } from "../loop/native/pick-input-path.ts";
import { createHostFs } from "../explorer/fs";
import { loadLoops } from "../loop/native/store.ts";
import { loadRunRecord, readRecentRuns, type LoopRunIndexEntry } from "../loop/native/history.ts";
import type { LoopDefinition } from "../loop/native/model.ts";
import { afterSend, buildRunEvent, loadRunBarInput, runBarState, saveRunBarInput, type RunBarInput } from "./loop-board-run.ts";
import { RUN_COMMAND_MAX } from "../loop/native/run-command.ts";
import { liveCardNote, readLiveCard, type LiveLoopCard } from "../loop/native/live-card.ts";

export interface LoopRunsProps {
  projectRoot: string;
  scope: string;
  /** The selected loop's id when known; names are not unique, so it wins over `scope`. */
  scopeId?: string | null;
  active: boolean;
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
const statusWord = (code: string): string => code === "success" ? "passed" : code.startsWith("blocked") ? "blocked" : code.startsWith("stopped") ? "stopped" : code === "aborted" ? "cancelled" : code === "awaiting_review" ? "awaiting review" : code === "running" ? "running" : "failed";

interface RunCard { run: LoopRunIndexEntry; lane: string; note: string; failed: boolean; live?: boolean }

const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

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

export function LoopRuns({ projectRoot, scope, scopeId = null, active }: LoopRunsProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [steps, setSteps] = useState<string[]>([]);
  const [cards, setCards] = useState<RunCard[]>([]);
  const [live, setLive] = useState<LiveLoopCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped only by the Refresh button; the 5 s interval refreshes inside the effect without re-running it.
  const [reload, setReload] = useState(0);
  const [loop, setLoop] = useState<LoopDefinition | null>(null);
  const [input, setInput] = useState<RunBarInput>({ inputPath: "", task: "" });
  const [runNote, setRunNote] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  // The loaded loop only counts for this board when it is the one named by the scope.
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingTimer = useRef<number | null>(null);
  const clearPending = () => { if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current); pendingTimer.current = null; setPending(false); };
  const boardLoop = loop !== null && (scopeId ? loop.id === scopeId : loop.name === scope && !ambiguous) ? loop : null;
  const loopId = boardLoop?.id ?? null;

  useEffect(() => {
    if (!active) return;
    // One effect owns both the first load and the refresh interval, so a tick never tears the effect down and
    // re-reads from scratch; `alive` (not React state) guards against late results after unmount or scope change.
    let alive = true;
    // A slow read must not stack with the next 5 s tick: overlapping refreshes could land out of order.
    let inFlight = false;
    // A finished run's record never changes: read it once per effect (a run still "running" is re-read every tick).
    const records = new Map<string, Record<string, unknown> | null>();
    const refresh = (): void => {
      if (inFlight) return;
      inFlight = true;
      setLive(readLiveCard());
      void Promise.all([
        readRecentRuns(fs, 100),
        loadLoops(fs).then((r) => {
          if (r.kind !== "ok") return { loop: null, same: 0 };
          // Id first; the name only when no id is known, and then a shared name cannot be resolved.
          if (scopeId) return { loop: r.store.loops.find((l) => l.id === scopeId) ?? null, same: 1 };
          const named = r.store.loops.filter((l) => l.name === scope);
          return { loop: named[0] ?? null, same: named.length };
        }, () => ({ loop: null, same: 0 })),
      ]).then(async ([rows, found]) => {
        if (!alive) return;
        const loop = found.loop;
        setAmbiguous(found.same > 1);
        const names = loop ? loop.config.stages.filter((s) => s.enabled).map((s) => s.name) : [];
        setSteps(names);
        setLoop(loop);
        const shown = rows.filter((r) => (loop && r.loopId ? r.loopId === loop.id : r.loopName === scope)).slice(0, 40);
        const loaded = await Promise.all(shown.map(async (r) => {
          if (records.has(r.id)) return records.get(r.id)!;
          const rec = await loadRunRecord(fs, r.id, r.startedAt).catch(() => null);
          if (r.statusCode !== "running" && rec !== null) records.set(r.id, rec);
          return rec;
        }));
        if (!alive) return;
        setError(null);
        setCards(shown.map((run, i) => {
          const at = laneOf(run, loaded[i], names);
          return { run, lane: at.lane, note: at.note, failed: run.statusCode !== "success" };
        }));
      }, (e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { inFlight = false; });
    };
    setError(null);
    refresh();
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 5_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [fs, projectRoot, scope, scopeId, active, reload]);

  useEffect(() => {
    const onLive = () => setLive(readLiveCard());
    window.addEventListener("llmide-loop-live", onLive);
    return () => window.removeEventListener("llmide-loop-live", onLive);
  }, []);

  // Restore what was typed for this loop last time; `typed` stops a refresh from overwriting a draft.
  // Drop the previous loop at once: until the refresh answers, the bar must not send the old loop's id for this scope.
  useEffect(() => { setTyped(false); setRunNote(null); setPickError(null); setLoop(null); setAmbiguous(false); clearPending(); }, [scope, scopeId]);
  useEffect(() => () => { if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current); }, []);
  // The saved path changed on the Loop page: the field follows it (typing holds only until then).
  const savedPath = loop?.inputPath;
  useEffect(() => { if (savedPath !== undefined) { setPickError(null); setInput((i) => ({ ...i, inputPath: savedPath })); } }, [savedPath]);
  useEffect(() => {
    if (!loop || typed) return;
    setInput(loadRunBarInput(loop, scope, storage()));
  }, [loop, scope, typed]);
  useEffect(() => {
    const onNote = (e: Event) => {
      const d = (e as CustomEvent<{ loopName?: unknown; loopId?: unknown; message?: unknown; started?: unknown }>).detail;
      if (!d || !(d.loopName === scope || (loopId !== null && d.loopId === loopId)) || typeof d.message !== "string") return;
      setRunNote(d.message);
      if (d.started !== true) { clearPending(); return; }
      // "Started" arrives synchronously inside the click that sent the request, so clearing here would re-enable
      // ▶ Run at once and a double click would queue a duplicate. Stay disabled until the live card appears or a
      // refusal arrives; the approval dialog can take a while, so the fallback is long and changes no text.
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
      pendingTimer.current = window.setTimeout(() => { pendingTimer.current = null; setPending(false); }, 120_000);
    };
    window.addEventListener("llmide-loop-board-notice", onNote);
    return () => window.removeEventListener("llmide-loop-board-notice", onNote);
  }, [scope, loopId]);
  // The started run is on the board now; ▶ Run may queue another one deliberately.
  useEffect(() => { if (pending && live?.loopName === scope) clearPending(); }, [pending, live, scope]);
  const edit = (next: RunBarInput) => { setTyped(true); setPickError(null); setInput(next); saveRunBarInput(scope, next, storage()); };
  // The picker is async: what was typed while it was open must survive the pick.
  const inputRef = useRef(input);
  inputRef.current = input;
  const pickFolder = async () => {
    setPickError(null);
    // Same root as the Loop page (the repository loops run in), so both "+" buttons accept the same folders.
    const root = await invokeHost<string>("loop_work_root").catch(() => projectRoot);
    const r = await pickInputPath(root);
    if (!r) return;
    if ("error" in r) { setPickError(r.error); return; }
    edit({ ...inputRef.current, inputPath: r.path });
  };
  const bar = boardLoop ? runBarState(boardLoop, input) : null;
  const sendRun = () => {
    const ev = boardLoop ? buildRunEvent(boardLoop, input) : null;
    if (!ev) return;
    setRunNote("Sent to the Loop page…");
    // Disabled until the Loop page answers, so a double click cannot queue a duplicate; no answer in 15 s means the
    // page is not reachable (not mounted, or busy loading).
    setPending(true);
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null;
      setPending(false);
      setRunNote("The Loop page did not answer. Open the Loop page and try again.");
    }, 15_000);
    shellBus.publish(ev);
    // A remembered task would silently turn every later run into a one-item run.
    const next = afterSend(input);
    setInput(next);
    saveRunBarInput(scope, next, storage());
  };

  const liveCard: RunCard | null = live && live.loopName === scope ? {
    lane: live.stageName || steps[0] || "Running",
    note: liveCardNote(live),
    failed: false,
    live: true,
    run: {
      id: live.runId, loopId: scope, loopName: live.loopName, startedAt: live.startedAt,
      durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(live.startedAt)) / 1000)),
      iterationsUsed: 1, statusCode: "running", statusSummary: "Running now", trigger: "manual",
    },
  } : null;

  const allCards = liveCard ? [liveCard, ...cards.filter((c) => c.run.id !== liveCard.run.id)] : cards;

  const lanes = useMemo(() => {
    const out = [...steps];
    for (const c of allCards) if (!out.includes(c.lane)) out.push(c.lane);
    if (allCards.some((c) => c.lane === DONE) && !out.includes(DONE)) out.push(DONE);
    return out.length ? out : [DONE];
  }, [steps, allCards]);

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
        <button type="button" className="fx-btn" onClick={() => setReload((n) => n + 1)}>Refresh</button>
      </header>
      {boardLoop && bar ? (
        <form className="fx-form" aria-label={`Run ${scope}`} onSubmit={(e) => { e.preventDefault(); sendRun(); }}>
          {bar.showInputPath ? (
            <div className="fx-field fx-grow"><span>Input path</span>
              <div className="fx-input-pick">
                <input aria-label="Input path" value={input.inputPath} placeholder="(whole repository)" aria-invalid={bar.inputError !== null} onChange={(e) => edit({ ...input, inputPath: e.target.value })} />
                <button type="button" className="fx-btn" title="Choose the folder to work on" aria-label="Choose the input folder" onClick={() => void pickFolder()}>+</button>
              </div>
              {bar.inputError ?? pickError ? <small className="fx-error">{bar.inputError ?? pickError}</small> : null}
            </div>
          ) : <p className="fx-hint">{bar.reads}</p>}
          <label className="fx-field fx-grow"><span>Task{bar.taskRequired ? " (required)" : " (optional)"}</span>
            <textarea rows={2} value={input.task} maxLength={RUN_COMMAND_MAX} placeholder="One item, one line" onChange={(e) => edit({ ...input, task: e.target.value })} />
          </label>
          <button type="submit" className="fx-btn fx-primary" disabled={bar.blocked !== null || pending} title={bar.blocked ?? undefined}>▶ Run</button>
          {bar.blocked && !bar.inputError ? <p className="fx-hint">{bar.blocked}</p> : null}
          {runNote ? <p className="fx-hint" role="status">{runNote}</p> : null}
        </form>
      ) : ambiguous && !scopeId ? <p className="fx-hint">Two loops share this name; select one on the Loop page.</p> : null}
      {error ? <p className="fx-error" role="status">{error}</p> : null}
      <div className="fx-lanes" role="list" aria-label={`${scope} board`}>
        {lanes.map((lane) => {
          const inLane = allCards.filter((c) => c.lane === lane);
          return (
            <section className="fx-lane" key={lane} role="listitem" aria-label={`${lane} runs`}>
              <header className="fx-lane-head"><h3>{lane}</h3><span>{inLane.length}</span></header>
              <div className="fx-lane-cards">
                {inLane.length === 0 ? <p className="fx-empty">No runs.</p> : null}
                {inLane.map(({ run, note, failed, live: isLive }) => (
                  <article key={run.id} className="fx-run" data-status={isLive ? "running" : failed ? "failed" : "success"} data-live={isLive || undefined}>
                    <header className="fx-run-head"><strong>{run.loopName}</strong><span className="fx-run-status">{statusWord(run.statusCode)}</span><span className="fx-run-time">{when(run.startedAt)}</span></header>
                    <p className="fx-run-summary">{note}</p>
                    <p className="fx-run-meta">{run.durationSeconds ? `${run.durationSeconds}s` : "—"} · {run.iterationsUsed} iteration{run.iterationsUsed === 1 ? "" : "s"}</p>
                    {isLive ? null : <div className="fx-actions"><button type="button" className="fx-btn" onClick={() => void openRun(run.id, run.startedAt)}>Open run log & plan</button></div>}
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
