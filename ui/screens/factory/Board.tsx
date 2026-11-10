// The Factory board: one card per work item. A card's column is derived from facts every time the board is read
// (run records, live runs, worktrees, PR/MR status) and is never stored. Runs live in the module-level run manager,
// so they survive section and project switches; this view reads and starts them.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { createHostFs } from "../explorer/fs";
import { invokeHost } from "../shell/host";
import { core } from "../shell/runtime";
import { setRunRecordShip } from "../loop/native/history.ts";
import { cancelRun, concurrency, liveRuns, setConcurrency, startRun, subscribe as subscribeRuns, takeRunNotice, type LiveRun } from "../loop/native/run-manager.ts";
import { installRunManagerHost } from "../loop/native/run-manager-host.ts";
import { ShipPanel } from "../loop/native/ShipPanel.tsx";
import { repoPrefixFor } from "../loop/native/worktree-run.ts";
import "../loop/native/native-loop.css";
import { attachRun, readItems, removeItem, type WorkItemRecord } from "./items.ts";
import { COLUMNS, COLUMN_LABELS, type Column, type ItemFacts, type RunRecordFacts, type ShipStatus } from "./columns.ts";
import { EMPTY_FACTS, STATUS_REFRESH_MS, assembleFacts, cleanupPlan, stageTimeline, type CleanupPlan, buildBoard, chunkShipRequests, decodeShipResults, decodeWorktreeList, lastKnownFrom, latestRecords, otherProjectsNote, safeRequestUrl, sendBackAllowed, shipRequestsFor, toWorkItem, type CardAction, type WorktreeInfo } from "./board-model.ts";
import { listSpecFiles, runPlanFor, sendSummary, sendToFactory, workItemFromSpec, workItemFromText } from "./intake.ts";
import { sendBack } from "./send-back.ts";
import { Card } from "./Card.tsx";

// Wire the run manager to the real host once, when this chunk loads: startRun throws without it, and runs must
// outlive this component (the Issues entry installs it the same way before it starts an intake run).
installRunManagerHost();

/** The status route rides the core's `dispatch` rate-limit bucket (burst 4, one more per 10 s): never refresh more often. */
const STATUS_MIN_GAP_MS = 10_000;

export interface BoardProps {
  /** True only while the section is shown AND the Board tab is selected. */
  active: boolean;
  projectRoot: string | null;
  /** A "focus this card" request from the shell bus; `n` changes on every request. */
  focus: { key: string | null; n: number };
}

export default function Board({ active, projectRoot, focus }: BoardProps): ReactNode {
  const fs = useMemo(() => createHostFs(), []);
  const [items, setItems] = useState<WorkItemRecord[]>([]);
  const [records, setRecords] = useState<Map<string, RunRecordFacts>>(() => new Map());
  const [worktrees, setWorktrees] = useState<Map<string, WorktreeInfo>>(() => new Map());
  const [interrupted, setInterrupted] = useState<ReadonlySet<string>>(() => new Set());
  const [ship, setShip] = useState<Map<string, ShipStatus | "error">>(() => new Map());
  const [live, setLive] = useState<readonly LiveRun[]>(() => liveRuns());
  // One board timer for “4m 12s”, not one per card.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [cap, setCap] = useState(() => concurrency());
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<"spec" | "text">("spec");
  const [specFiles, setSpecFiles] = useState<string[]>([]);
  const [specPath, setSpecPath] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [addIntake, setAddIntake] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<CleanupPlan | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Refs so the 5-minute timer reads the latest facts without being re-created on every load.
  const itemsRef = useRef<WorkItemRecord[]>([]);
  const recordsRef = useRef<Map<string, RunRecordFacts>>(new Map());
  // The last column each card had (memory only, never written): kept while the PR/MR status is unavailable.
  const lastKnown = useRef<Map<string, Column>>(new Map());
  const liveIds = useRef("");
  const lastStatusAt = useRef(0);

  // Another project: nothing of the previous one (items, facts, last known columns) may leak into this board.
  useEffect(() => {
    lastKnown.current = new Map();
    itemsRef.current = [];
    recordsRef.current = new Map();
    lastStatusAt.current = 0;
    setItems([]);
    setRecords(new Map());
    setWorktrees(new Map());
    setShip(new Map());
    setSelectedKey(null);
  }, [projectRoot]);

  const loadFacts = useCallback(async () => {
    if (!projectRoot) return;
    try {
      const next = await readItems(fs);
      const runIds = new Set(next.flatMap((i) => i.runIds.slice(-1)));
      const [recs, wts] = await Promise.all([
        latestRecords(fs, runIds),
        invokeHost<unknown>("loop_worktree_list").then(decodeWorktreeList, () => new Map<string, WorktreeInfo>()),
      ]);
      const marks = new Set<string>();
      await Promise.all([...wts].map(async ([runId, wt]) => {
        const prefix = repoPrefixFor(projectRoot, wt.worktree);
        try { const r = await fs.read(`${prefix}/.factory/RUN.json`); if (r.status === "ok") marks.add(runId); } catch { /* no marker */ }
      }));
      itemsRef.current = next;
      recordsRef.current = recs;
      setItems(next);
      setRecords(recs);
      setWorktrees(wts);
      setInterrupted(marks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The Factory items could not be read.");
    }
  }, [fs, projectRoot]);

  // `force` (the Refresh button, right after a Ship) skips the minimum gap.
  const refreshStatus = useCallback(async (force = false) => {
    const requests = shipRequestsFor(itemsRef.current, recordsRef.current);
    if (requests.length === 0) return;
    const now = Date.now();
    if (!force && now - lastStatusAt.current < STATUS_MIN_GAP_MS) return;
    lastStatusAt.current = now;
    const next = new Map<string, ShipStatus | "error">();
    let rateLimited = false;
    for (const chunk of chunkShipRequests(requests)) {
      try {
        const r = await core.requestRaw("/kb/loop/ship-status", { method: "POST", body: { requests: chunk } });
        if (r.status === 429) { rateLimited = true; break; }
        if (r.status === 200) for (const [url, s] of decodeShipResults(r.body)) next.set(url, s);
      } catch {
        // Core unreachable: these cards keep their last known column (columnFor), never Inbox.
      }
      for (const q of chunk) if (!next.has(q.url)) next.set(q.url, "error");
    }
    // Rate limited: keep the statuses already shown instead of marking every card "status unavailable".
    if (!rateLimited) setShip(next);
  }, []);

  // Shown: read the facts, then the PR/MR status, and again every 5 minutes while shown. Hidden or unmounted: no timer.
  useEffect(() => {
    if (!active) return;
    void loadFacts().then(() => refreshStatus());
    const timer = setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, loadFacts, refreshStatus]);

  // The run manager notifies on every log line; facts are re-read only when the set of runs or a run's state changes.
  useEffect(() => subscribeRuns(() => {
    const now = liveRuns();
    setLive(now);
    const why = takeRunNotice();
    if (why) setNotice(why);
    const ids = now.map((r) => `${r.runId}:${r.state}`).join(",");
    if (ids !== liveIds.current) {
      liveIds.current = ids;
      void loadFacts();
    }
  }), [loadFacts]);

  useEffect(() => {
    if (focus.key) setSelectedKey(focus.key);
  }, [focus.key, focus.n]);

  useEffect(() => {
    if (addOpen && addKind === "spec") void listSpecFiles(fs).then(setSpecFiles);
  }, [addOpen, addKind, fs]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const facts = useMemo(() => {
    const m = new Map<string, ItemFacts>();
    for (const item of items) m.set(item.key, assembleFacts(item, { projectRoot: projectRoot ?? "", live, records, worktrees, interrupted, ship, lastKnown: lastKnown.current }));
    return m;
  }, [items, live, records, worktrees, ship, projectRoot]);
  useEffect(() => {
    if (!live.some((r) => r.state === "running" || r.state === "paused")) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const board = useMemo(() => buildBoard(items, facts, nowMs), [items, facts, nowMs]);
  const openCleanup = async () => {
    const merged = new Set(items.filter((i) => facts.get(i.key)?.ship?.state === "merged").flatMap((i) => i.runIds));
    const statuses = new Map();
    for (const runId of worktrees.keys()) {
      try { statuses.set(runId, await invokeHost("loop_worktree_status", { runId })); } catch { /* status missing -> kept */ }
    }
    setCleanup(cleanupPlan(items, worktrees, live, interrupted, merged, statuses));
  };

  useEffect(() => {
    lastKnown.current = lastKnownFrom(board);
  }, [board]);
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const elsewhere = otherProjectsNote(live, projectRoot);

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      void loadFacts();
    }
  };

  const submitAdd = () => void act(async () => {
    if (!projectRoot) return;
    let item: WorkItemRecord;
    if (addKind === "spec") {
      const r = await fs.read(specPath, 200_000);
      if (r.status !== "ok" || r.text === null) throw new Error(`${specPath} is not readable text.`);
      item = workItemFromSpec(specPath, r.text);
    } else {
      item = workItemFromText(textTitle, textBody);
    }
    const res = await sendToFactory(fs, [item], { runIntake: addIntake, projectRoot, start: startRun });
    setNotice(sendSummary(res.added, res.existing.length));
    setSelectedKey(item.key);
    setAddOpen(false);
    setSpecPath("");
    setTextTitle("");
    setTextBody("");
  });

  const onAction = (item: WorkItemRecord, action: CardAction, note?: string) => {
    if (!projectRoot) return;
    const root = projectRoot;
    switch (action) {
      case "start":
      case "intake":
      case "resume": {
        const plan = runPlanFor(action, item, facts.get(item.key) ?? EMPTY_FACTS);
        void act(async () => {
          const runId = startRun(root, item, plan.mode, plan.runId ? { runId: plan.runId } : undefined);
          // A reused run id is already on the item; only a new run is attached.
          if (!plan.runId) await attachRun(fs, item.key, runId);
        });
        return;
      }
      case "openDiff":
      case "ship":
        setSelectedKey(item.key);
        return;
      case "openRequest": {
        const url = safeRequestUrl(facts.get(item.key)?.lastRecord?.ship?.url ?? null);
        if (url) void invokeHost("open_external_url", { url }).catch(() => setError("The PR/MR link could not be opened."));
        return;
      }
      case "discard":
        void act(async () => {
          for (const runId of item.runIds) if (worktrees.has(runId)) await invokeHost("loop_worktree_remove", { runId });
          await removeItem(fs, item.key);
          setSelectedKey((k) => (k === item.key ? null : k));
        });
        return;
      case "sendBack": {
        const f = facts.get(item.key);
        const status = f?.ship ?? null;
        if (!f || !status || !sendBackAllowed(f)) {
          setError("Send back needs the PR/MR status (failing CI or new comments) and the card's worktree. Refresh and try again.");
          return;
        }
        void act(async () => { await sendBack({ fs, start: startRun, projectRoot: root }, item, status, note ?? ""); });
        return;
      }
    }
  };

  if (!projectRoot) return <p className="fx-empty">Open a project to use the Factory.</p>;
  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;
  const selFacts = selected ? facts.get(selected.key) ?? null : null;
  const selLive = selFacts?.live ?? null;
  const selRunId = selected?.runIds.at(-1) ?? null;
  const selInfo = selRunId ? worktrees.get(selRunId) ?? null : null;

  return (
    <div className="fx-board-root">
      <header className="fx-head">
        <label className="fx-field">
          <span>Parallel runs</span>
          <select value={cap} onChange={(e) => { setConcurrency(Number(e.target.value)); setCap(concurrency()); }}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {elsewhere ? <span className="fx-hint" role="status">{elsewhere}</span> : null}
        <span className="fx-spacer" />
        <button type="button" className="fx-btn fx-primary" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}>Add</button>
        <button type="button" className="fx-btn" onClick={() => void (cleanup ? setCleanup(null) : openCleanup())} aria-expanded={cleanup !== null} disabled={worktrees.size === 0}>Clean up…</button>
        <button type="button" className="fx-btn" onClick={() => void loadFacts().then(() => refreshStatus(true))}>Refresh</button>
      </header>
      {cleanup ? (
        <div className="loop-confirm" role="alertdialog" aria-label="Confirm worktree clean-up">
          <p>Remove {cleanup.remove.length} worktree{cleanup.remove.length === 1 ? "" : "s"}? Kept: {cleanup.keep.length} (unshipped changes, a card waiting for Ship, a live run or an unreadable status).</p>
          <ul>{cleanup.remove.map((id) => <li key={id}><code>{worktrees.get(id)?.branch ?? id}</code></li>)}</ul>
          <div className="fx-actions">
            <button type="button" className="fx-btn" onClick={() => setCleanup(null)}>Cancel</button>
            <button type="button" className="fx-btn fx-primary" disabled={cleanup.remove.length === 0} onClick={() => void act(async () => {
              for (const runId of cleanup.remove) await invokeHost("loop_worktree_remove", { runId });
              setNotice(`Removed ${cleanup.remove.length} worktree${cleanup.remove.length === 1 ? "" : "s"}; kept ${cleanup.keep.length}.`);
              setCleanup(null);
              await loadFacts();
            })}>Remove</button>
          </div>
        </div>
      ) : null}
      {error ? <StatusBanner severity="error" message={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} onDismiss={() => setNotice(null)} /> : null}
      {addOpen ? (
        <form className="fx-form" aria-label="Add a work item" onSubmit={(e) => { e.preventDefault(); submitAdd(); }}>
          <label className="fx-field"><span>From</span>
            <select value={addKind} onChange={(e) => setAddKind(e.target.value as "spec" | "text")}>
              <option value="spec">Spec from llm-doc/</option>
              <option value="text">Free text</option>
            </select>
          </label>
          {addKind === "spec" ? (
            <label className="fx-field fx-grow"><span>Spec file</span>
              <select value={specPath} onChange={(e) => setSpecPath(e.target.value)}>
                <option value="">{specFiles.length ? "Choose a spec…" : "No .md files under llm-doc/"}</option>
                {specFiles.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label className="fx-field fx-grow"><span>Title</span><input value={textTitle} maxLength={500} onChange={(e) => setTextTitle(e.target.value)} /></label>
              <label className="fx-field fx-grow"><span>Description</span><textarea rows={3} value={textBody} onChange={(e) => setTextBody(e.target.value)} /></label>
            </>
          )}
          <label className="fx-check"><input type="checkbox" checked={addIntake} onChange={(e) => setAddIntake(e.target.checked)} /> Run intake now</label>
          <button type="submit" className="fx-btn fx-primary" disabled={addKind === "spec" ? specPath === "" : textTitle.trim() === ""}>Add to Factory</button>
          <button type="button" className="fx-btn" onClick={() => setAddOpen(false)}>Cancel</button>
        </form>
      ) : null}
      <div className="fx-body">
        <div className="fx-board" role="list" aria-label="Factory board">
          {COLUMNS.map((col) => (
            <section key={col} className="fx-col" aria-label={`${COLUMN_LABELS[col]} (${board[col].length})`}>
              <h3 className="fx-col-title">{COLUMN_LABELS[col]} <span>{board[col].length}</span></h3>
              <ul className="fx-cards">
                {board[col].map((view) => {
                  const it = byKey.get(view.key) ?? null;
                  return (
                    <Card
                      key={view.key}
                      view={view}
                      selected={view.key === selectedKey}
                      onOpen={() => setSelectedKey(view.key)}
                      onAction={(a, note) => { if (it) onAction(it, a, note); }}
                      requestProvider={it ? facts.get(it.key)?.lastRecord?.ship?.provider ?? null : null}
                      onDiscardStatus={it ? async () => {
                        const runId = it.runIds.at(-1);
                        if (!runId || !worktrees.has(runId)) return null;
                        return invokeHost<unknown>("loop_worktree_status", { runId });
                      } : undefined}
                    />
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        {selected ? (
          <aside className="fx-panel" aria-label={`Details for ${selected.title}`}>
            <header className="fx-panel-head">
              <h3 className="fx-panel-title">{selected.title}</h3>
              <button type="button" className="fx-btn" onClick={() => setSelectedKey(null)}>Close</button>
            </header>
            {selLive ? (
              <>
                <p className="fx-hint">Run {selLive.runId} · {selLive.state}</p>
                <button type="button" className="fx-btn" onClick={() => cancelRun(selLive.runId)}>Stop run</button>
                <ul className="fx-timeline" aria-label="Stage timeline">
                  {stageTimeline(selLive).map((row) => <li key={row.name} className={`fx-stage fx-stage-${row.state}`}>{row.name} <span>{row.state}</span></li>)}
                </ul>
                <pre className="fx-log">{selLive.log.slice(-200).join("\n")}</pre>
              </>
            ) : selFacts?.lastRecord ? (
              <p className="fx-hint">Last run {selFacts.lastRecord.runId}: {selFacts.lastRecord.statusCode}{selFacts.lastRecord.needsDecision ? ` — ${selFacts.lastRecord.needsDecision}` : ""}</p>
            ) : (
              <p className="fx-hint">No run yet.</p>
            )}
            {selInfo && !selLive ? (
              <ShipPanel
                key={selInfo.runId}
                info={selInfo}
                item={toWorkItem(selected)}
                passed={selFacts?.lastRecord?.statusCode === "success"}
                reviewedPatchId={selFacts?.lastRecord?.reviewedPatchId ?? null}
                requestProvider={selFacts?.lastRecord?.ship?.provider ?? null}
                fs={fs}
                runPrefix={repoPrefixFor(projectRoot, selInfo.worktree)}
                onShipped={(r) => {
                  // Ship does not touch the run record; without this the card would stay in Ready to ship.
                  const entry = selFacts?.lastRecord?.entry ?? null;
                  void (entry ? setRunRecordShip(fs, entry, r) : Promise.resolve(false))
                    .catch(() => false)
                    .then((ok) => { if (!ok) setError("Shipped, but the run record could not be updated, so the card may not move."); })
                    .then(() => loadFacts())
                    .then(() => refreshStatus(true));
                }}
                onDiscarded={() => { void act(async () => { await removeItem(fs, selected.key); setSelectedKey(null); }); }}
                onClose={() => setSelectedKey(null)}
              />
            ) : null}
            {selFacts?.lastRecord?.ship ? <button type="button" className="fx-btn" onClick={() => onAction(selected, "openRequest")}>Open PR/MR</button> : null}
          </aside>
        ) : null}
      </div>
      {items.length === 0 ? <p className="fx-hint fx-foot">No work items yet. Send issues here from the Issues section, or use Add for a spec or free text.</p> : null}
    </div>
  );
}
