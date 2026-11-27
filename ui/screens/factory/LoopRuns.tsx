// A board for every non-Factory loop: the loop's stages are the lanes, each run is a card placed at the stage it
// reached (or Done). Facts come from system/loop-runs. The run bar only REQUESTS a run (shell bus "run-loop"): the
// Loop page owns execution (approval dialog, worktree, queue, ship), so this board never runs or edits anything.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shellBus } from "../shell/bus";
import { invokeHost } from "../shell/host";
import { pickInputPath } from "../loop/native/pick-input-path.ts";
import { createHostFs } from "../explorer/fs";
import { loadLoops, saveLoops } from "../loop/native/store.ts";
import { setReviewMode } from "../loop/native/review-ui.ts";
import { shipHeldRun } from "../loop/native/run-manager.ts";
import { FinalReviewToggle } from "./FinalReviewToggle.tsx";
import { decodeFactoryFields, loadRunRecord, readRecentRuns, type LoopRunIndexEntry } from "../loop/native/history.ts";
import type { RunInfo } from "../loop/native/worktree-run.ts";
import type { LoopDefinition } from "../loop/native/model.ts";
import { afterSend, buildRunEvent, discardTarget, heldState, loopRunCardView, loopRunLanes, type HeldState, loadHiddenRunIds, loadRunBarInput, runBarState, saveHiddenRunIds, saveRunBarInput, type RunBarInput } from "./loop-board-run.ts";
import { RUN_COMMAND_MAX } from "../loop/native/run-command.ts";
import { liveCardNote, readLiveCard, type LiveLoopCard } from "../loop/native/live-card.ts";
import { LaneBoard } from "./LaneBoard.tsx";
import { Card, type DiscardCheck } from "./Card.tsx";
import type { CardAction } from "./board-model.ts";

export interface LoopRunsProps {
  projectRoot: string;
  scope: string;
  /** The selected loop's id when known; names are not unique, so it wins over `scope`. */
  scopeId?: string | null;
  active: boolean;
}

interface RunCard { run: LoopRunIndexEntry; record: Record<string, unknown> | null; held: HeldState | null }

const storage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

// A loop board lists at most 41 cards (40 journal runs + the live one), under LaneBoard's default page of 100, so "Show more" never appears.
const NO_CAP: Readonly<Record<string, number>> = {};
const noop = (): void => undefined;

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
  // Run ids this viewer discarded: hidden here only, the journal entry itself is never deleted.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setHidden(loadHiddenRunIds(scope, storage())), [scope]);
  // A ref, not state: a confirm callback made in an earlier render must still see a removal that started since.
  const discardBusy = useRef(false);
  const [discardMsg, setDiscardMsg] = useState<{ text: string; kind: "error" | "info" } | null>(null);
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
          // A held record changes when it ships (here or in the Loop page's Ship panel), so it is re-read each tick.
          if (r.statusCode !== "running" && r.statusCode !== "awaiting_review" && rec !== null) records.set(r.id, rec);
          return rec;
        }));
        if (!alive) return;
        setError(null);
        setCards(shown.map((run, i) => {
          const held = heldState(run, loaded[i], shown);
          return { run, record: loaded[i], held };
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

  const liveRun: LoopRunIndexEntry | null = live && live.loopName === scope ? {
    id: live.runId, loopId: scope, loopName: live.loopName, startedAt: live.startedAt,
    durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(live.startedAt)) / 1000)),
    iterationsUsed: 1, statusCode: "running", statusSummary: "Running now", trigger: "manual",
  } : null;

  const shownCards = cards.filter((c) => !hidden.has(c.run.id));
  const listed = shownCards.filter((c) => c.run.id !== liveRun?.id);
  const runById = new Map<string, LoopRunIndexEntry>([...(liveRun ? [liveRun] : []), ...listed.map((c) => c.run)].map((r) => [r.id, r]));
  const liveView = liveRun && live ? loopRunCardView({ run: liveRun, record: null, steps, held: null, live: { lane: live.stageName || steps[0] || "Running", note: liveCardNote(live) } }) : null;
  const views = [...(liveView ? [liveView] : []), ...listed.map((c) => loopRunCardView({ ...c, steps }))];
  const lanes = loopRunLanes(steps, views);

  const openRun = async (id: string, startedAt: string) => {
    try {
      const rec = await loadRunRecord(fs, id, startedAt);
      const path = rec?.summaryPath;
      if (typeof path === "string" && path) shellBus.publish({ type: "open-file", path });
      else setError("This run has no archived run.md yet; it was recorded before run archives existed.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  /** Hides one card from this board's view (the journal entry itself is never deleted). */
  const hideRun = (entryId: string) => {
    setHidden((h) => {
      const next = new Set(h);
      next.add(entryId);
      saveHiddenRunIds(scope, next, storage());
      return next;
    });
  };

  /** Opens the inline confirm for one card's Discard, after checking it is actually safe to offer (a worktree
   *  exists, and this is the loop's newest run so its shared branch is not still needed by another one).
   *  The worktree's own runId is the loop's slug for a non-Factory run (loop_worktree_prepare's `runId` argument,
   *  NativeLoopScreen's executeLoop), never the journal entry's own id (a fresh UUID per run) — it has to be read
   *  from the run's record (`decodeFactoryFields(record).worktree.runId`), the same field reopenWorktree reads.
   *  A non-Factory loop reuses ONE worktree for every run (same slug), so discarding the newest run's card removes
   *  it for every older card of that same loop too: the next one of those finds no worktree left (`"gone"`, not
   *  `"refused"` — that check only runs once a worktree is actually found). There is nothing left to revert there,
   *  so Discard still does its other half — hide the card — right away, with no confirm needed.
   *  A failed record or worktree-list read ("unreadable") and a run with no worktree at all ("no-worktree", it
   *  worked on the main tree) are NEVER auto-hidden: the former because the real state is unknown, the latter
   *  because its edits may still be sitting live, uncommitted, in the main tree — both need the person to say so.
   *  `loadRunRecord` never rejects: a missing OR an unreadable/corrupt record both resolve to `null` alike
   *  (history.ts), so `null` has to be treated as "unreadable" here, not as "no worktree" — the record genuinely
   *  having no `worktree` field (decodeFactoryFields(record).worktree === null for a record that DID load) is the
   *  only thing that means "no-worktree". */
  const openDiscard: (run: LoopRunIndexEntry) => ReturnType<DiscardCheck> = async (run) => {
    setDiscardMsg(null);
    const record = await loadRunRecord(fs, run.id, run.startedAt).catch(() => null);
    const fields = record === null ? { ok: false as const } : { ok: true as const, ...decodeFactoryFields(record) };
    const worktrees = await invokeHost<RunInfo[]>("loop_worktree_list")
      .then((list) => ({ ok: true as const, list }))
      .catch(() => ({ ok: false as const }));
    const runningLoopId = live && live.loopName === run.loopName ? run.loopId : null;
    const target = discardTarget(run, fields, worktrees, cards.map((c) => c.run), runningLoopId);
    if (target.kind === "unreadable") { setDiscardMsg({ text: "Could not check this run's worktree; try again.", kind: "error" }); return { kind: "stop" }; }
    if (target.kind === "refused") { setDiscardMsg({ text: target.reason, kind: "error" }); return { kind: "stop" }; }
    if (target.kind === "gone") {
      hideRun(run.id);
      setDiscardMsg({ text: "Nothing to revert for this run — its worktree is already gone (removed by discarding another run of the same loop). The card is hidden.", kind: "info" });
      return { kind: "stop" };
    }
    if (target.kind === "no-worktree") {
      // No worktree at all (it worked on the main tree): Discard only hides the card, after saying so — never auto-hidden.
      return { kind: "confirm", label: "Hide card", onConfirm: () => confirmHide(run.id), text: "This run worked directly on the main tree: Discard cannot revert it through a worktree, and any uncommitted edits it left are still there. This only hides the card." };
    }
    const worktreeRunId = target.info.runId;
    return {
      kind: "confirm",
      onConfirm: () => confirmDiscard(run.id, worktreeRunId),
      text: "Remove this run's worktree and branch? This reverts every change it made that is not already shipped.",
      readStatus: () => invokeHost<unknown>("loop_worktree_status", { runId: worktreeRunId }),
      provider: fields.ok ? fields.ship?.provider ?? null : null,
    };
  };

  /** This run never had a worktree (it worked directly on the main tree): Discard can only hide the card, after
   *  saying so in the confirm bar — any uncommitted edits it left are untouched. */
  const confirmHide = (entryId: string) => {
    setDiscardMsg({ text: "The card is hidden. Its edits, if any, are still in the working tree — Discard did not revert anything.", kind: "info" });
    hideRun(entryId);
  };

  /** Removes the run's worktree and branch (reverting every change it made that was never shipped), then hides its
   *  card: the Loop journal is append-only, so there is nothing to delete there. */
  const confirmDiscard = async (entryId: string, worktreeRunId: string) => {
    if (discardBusy.current) { setDiscardMsg({ text: "Another worktree is still being removed; confirm again when it is done.", kind: "info" }); return; }
    discardBusy.current = true;
    setDiscardMsg({ text: "Removing the worktree…", kind: "info" });
    try {
      await invokeHost("loop_worktree_remove", { runId: worktreeRunId });
      setDiscardMsg(null);
      hideRun(entryId);
    } catch (e) {
      setDiscardMsg({ text: `The worktree could not be removed: ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      discardBusy.current = false;
    }
  };

  const onAction = (run: LoopRunIndexEntry, action: CardAction) => {
    if (action === "approve") void approve(run);
    else if (action === "openLog") void openRun(run.id, run.startedAt);
  };

  /** Final review: the same Auto / Human switch as the Factory board, saved in this loop's own setting. An open
   *  Loop page takes the change through the bus, so its next save of loop.json does not conflict. */
  const [modeBusy, setModeBusy] = useState(false);
  const chooseReviewMode = async (mode: "auto" | "human") => {
    // boardLoop, not loop: with two loops of the same name, `loop` may not be the one whose runs are shown.
    if (!boardLoop || modeBusy) return;
    setModeBusy(true);
    try {
      const r = await loadLoops(fs);
      if (r.kind !== "ok") throw new Error("the loop file could not be read");
      const target = r.store.loops.find((l) => l.id === boardLoop.id);
      if (!target) throw new Error("this loop is no longer in the loop file");
      setReviewMode(target.config, mode);
      const saved = await saveLoops(fs, r.store, r.hash);
      shellBus.publish({ type: "loop-review-mode", loopId: boardLoop.id, mode, fromHash: r.hash, hash: saved.hash });
      setLoop(target);
    } catch (e) {
      setError(`Final review was not changed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setModeBusy(false);
    }
  };

  /** Ships a run held for your approval through the same shipper as a run that ends in Auto mode (secret scan, CI/hook
   *  files, diff size, repository setup). Only the loop's newest run, and never while the loop runs: every run of a
   *  loop shares one branch, so an older card would ship a newer run's work. */
  const [approving, setApproving] = useState<string | null>(null);
  const approve = async (run: LoopRunIndexEntry) => {
    if (approving !== null || !projectRoot) return;
    setDiscardMsg(null);
    setApproving(run.id);
    try {
      // Fresh reads, not the board's 5 s snapshot: a newer run of this loop may have taken the shared branch since.
      const record = await loadRunRecord(fs, run.id, run.startedAt).catch(() => null);
      const runs = await readRecentRuns(fs, 100).catch(() => null);
      if (runs === null) { setDiscardMsg({ text: "Could not read this loop's runs; try again.", kind: "error" }); return; }
      const runsOfLoop = runs.filter((r) => r.loopId === run.loopId);
      const held = heldState(run, record, runsOfLoop);
      if (held?.kind !== "waiting" || record === null) { setDiscardMsg({ text: "This run is no longer waiting for approval. Refresh the board.", kind: "error" }); return; }
      const worktrees = await invokeHost<RunInfo[]>("loop_worktree_list").then((list) => ({ ok: true as const, list })).catch(() => ({ ok: false as const }));
      const runningLoopId = live && live.loopName === run.loopName ? run.loopId : null;
      const target = discardTarget(run, { ok: true, worktree: decodeFactoryFields(record).worktree }, worktrees, runsOfLoop, runningLoopId);
      if (target.kind === "unreadable") { setDiscardMsg({ text: worktrees.ok ? "Could not check this run's worktree; try again." : "This run's worktree could not be listed (in SSH mode, approve it on the Loop page).", kind: "error" }); return; }
      if (target.kind === "refused") { setDiscardMsg({ text: target.reason, kind: "error" }); return; }
      if (target.kind !== "ok") { setDiscardMsg({ text: "Not approved: this run's worktree was removed, so there is nothing to ship.", kind: "error" }); return; }
      const info = target.info;
      // The same Approve as the Factory board: shipHeldRun, through the one shipper with all its blocks.
      const line = await shipHeldRun(projectRoot, { source: "text", id: null, title: `${run.loopName} run ${info.runId}`, body: "", repo: null, key: `loop:${info.runId}`, provider: null }, {
        runId: info.runId, entry: run, statusCode: run.statusCode, shipped: false,
        awaiting: { held: "success", kind: "passed", failedStage: null }, processName: run.loopName, mergedMr: held.mergedMr,
      });
      setDiscardMsg({ text: line || "Not approved: nothing was shipped.", kind: line.startsWith("Draft MR:") ? "info" : "error" });
      setReload((n) => n + 1);
    } catch (e) {
      setDiscardMsg({ text: `Not approved: ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      setApproving(null);
    }
  };

  return (
    <div className="fx-board-root">
      <header className="fx-head">
        <div className="fx-head-title">
          <h2>{scope} board</h2>
          <p className="fx-summary">{shownCards.length} run{shownCards.length === 1 ? "" : "s"}</p>
        </div>
        <span className="fx-spacer" />
        <FinalReviewToggle mode={boardLoop ? (boardLoop.config.reviewMode === "human" ? "human" : "auto") : null} busy={modeBusy} onChoose={(mode) => void chooseReviewMode(mode)} />
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
      {discardMsg ? <p className={discardMsg.kind === "error" ? "fx-error" : "fx-hint"} role="status">{discardMsg.text}</p> : null}
      <div className="fx-body">
        <LaneBoard
          label={`${scope} board`}
          emptyText="No runs."
          lanes={lanes}
          shown={NO_CAP}
          onShowMore={noop}
          renderCard={(view) => {
            const run = runById.get(view.key);
            if (!run) return null;
            const isLive = run.id === liveRun?.id;
            return (
              <Card
                key={view.key}
                view={view}
                selected={false}
                onOpen={isLive ? noop : () => void openRun(run.id, run.startedAt)}
                onAction={(action) => onAction(run, action)}
                busy={approving === run.id}
                discardCheck={() => openDiscard(run)}
              />
            );
          }}
        />
      </div>
    </div>
  );
}
