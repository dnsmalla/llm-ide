// The Factory board: one card per work item, in lanes that follow the process (Backlog, each step, MR open, Done).
// A card's lane and status badge are derived from facts every time the board is read (run records, live runs,
// worktrees, PR/MR status) and are never stored. Runs live in the module-level run manager,
// so they survive section and project switches; this view reads and starts them.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { createHostFs } from "../explorer/fs";
import { invokeHost } from "../shell/host";
import { core } from "../shell/runtime";
import { setRunRecordShip } from "../loop/native/history.ts";
import { LOOP_PAGE_NOTE, cancelRun, concurrency, liveRuns, setConcurrency, startRun, subscribe as subscribeRuns, takeRunNotice, type LiveRun } from "../loop/native/run-manager.ts";
import { installRunManagerHost } from "../loop/native/run-manager-host.ts";
import { ShipPanel } from "../loop/native/ShipPanel.tsx";
import { decodeWorktreeDiff } from "../loop/native/ship-model.ts";
import { repoPrefixFor } from "../loop/native/worktree-run.ts";
import "../loop/native/native-loop.css";
import { attachRun, readItems, removeItem, type WorkItemRecord } from "./items.ts";
import { type Column, type ItemFacts, type RunRecordFacts, type ShipStatus } from "./columns.ts";
import { EMPTY_FACTS, STATUS_REFRESH_MS, assembleFacts, cleanupPlan, nextCardKey, stageTimeline, type CleanupPlan, buildBoard, buildLanes, openIssueCard, markerStage, boardSummary, LANE_DONE, chunkShipRequests, decodeShipResults, decodeWorktreeList, lastKnownFrom, latestRecords, otherProjectsNote, safeRequestUrl, sendBackAllowed, shipRequestsFor, toWorkItem, type CardAction, type WorktreeInfo } from "./board-model.ts";
import { finishChecksAllowed, runPlanFor, sendSummary, sendToFactory, workItemFromIssue, workItemFromText } from "./intake.ts";
import { isFactoryLoop, pickerIssues, repoForIssue, type PickerIssue } from "../loop/native/factory.ts";
import { processHasIntake, processSteps } from "../loop/native/factory-template.ts";
import { loadLoops } from "../loop/native/store.ts";
import { readRepoConfig } from "../settings/repo-config.ts";
import { answerDecision, sendBack } from "./send-back.ts";
import { Card } from "./Card.tsx";
import { LaneBoard } from "./LaneBoard.tsx";
import { LoopRuns } from "./LoopRuns.tsx";


// Wire the run manager to the real host once, when this chunk loads: startRun throws without it, and runs must
// outlive this component (the Issues entry installs it the same way before it starts an intake run).
installRunManagerHost();

/** The status route rides the core's `dispatch` rate-limit bucket (burst 4, one more per 10 s): never refresh more often. */
const STATUS_MIN_GAP_MS = 10_000;

/**
 * Open issues the Factory can work on: imported issues (GET /kb/issues) of every provider with a saved repository,
 * kept only when Settings → Repositories maps their repository to a clone inside this project (else a run cannot start).
 */
async function loadOpenIssues(projectRoot: string): Promise<PickerIssue[]> {
  const saved = readRepoConfig().saved;
  const providers = (["gitlab", "github"] as const).filter((p) => saved[p].some((r) => r.clonePath.trim() !== ""));
  // Page by offset (the core caps a page at 100), up to 10 pages per provider.
  const walk = async (p: string): Promise<PickerIssue[]> => {
    const out: PickerIssue[] = [];
    for (let page = 0; page < 10; page++) {
      const r = await core.requestRaw(`/kb/issues?provider=${p}&state=open&limit=100&offset=${page * 100}`, { method: "GET" }).catch(() => null);
      if (r?.status !== 200) break;
      const rows = (r.body as { issues?: unknown[] } | null)?.issues;
      out.push(...pickerIssues(r.body));
      if (!Array.isArray(rows) || rows.length < 100) break;
    }
    return out;
  };
  const lists = await Promise.all(providers.map(walk));
  return lists.flat().filter((i) => repoForIssue({ provider: i.provider, repo: i.repo }, saved, projectRoot) !== null);
}

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
  const [interruptedStages, setInterruptedStages] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [ship, setShip] = useState<Map<string, ShipStatus | "error">>(() => new Map());
  const [live, setLive] = useState<readonly LiveRun[]>(() => liveRuns());
  // One board timer for “4m 12s”, not one per card.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [offline, setOffline] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [cap, setCap] = useState(() => concurrency());
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // The Factory works from open issues (llm-doc specs become issues first, via Sources → Issue); free text stays for odd jobs.
  const [addKind, setAddKind] = useState<"issue" | "text">("issue");
  const [openIssues, setOpenIssues] = useState<PickerIssue[] | null>(null);
  const [issuePick, setIssuePick] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [addIntake, setAddIntake] = useState(false);
  // Whether the project's process has an Intake step; null = not known yet (Run intake stays offered, the run manager refuses it).
  const [hasIntake, setHasIntake] = useState<boolean | null>(null);
  // The process steps in order (the board's lanes); null = not known yet.
  const [steps, setSteps] = useState<string[] | null>(null);
  useEffect(() => {
    setHasIntake(null);
    setSteps(null);
    if (!projectRoot || !active) return;
    let live = true;
    const factoryLoop = async () => (await loadLoops(fs).then((r) => (r.kind === "ok" ? r.store.loops.find(isFactoryLoop) ?? null : null), () => null));
    void processHasIntake(fs, factoryLoop).then((v) => { if (live) setHasIntake(v); });
    void processSteps(fs, factoryLoop).then((v) => { if (live) setSteps(v); });
    return () => { live = false; };
  }, [fs, projectRoot, active]);
  const [notice, setNotice] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<CleanupPlan | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    const onSelect = (e: Event) => { const name = (e as CustomEvent<unknown>).detail; if (typeof name === "string" && name) setScope(name); };
    window.addEventListener("llmide-loop-selected", onSelect);
    return () => window.removeEventListener("llmide-loop-selected", onSelect);
  }, []);
  const [scope, setScope] = useState(() => { try { return localStorage.getItem("llmide.loopBoardScope") || "Factory"; } catch { return "Factory"; } });
  const panelRef = useRef<HTMLElement | null>(null);
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
      const markStages = new Map<string, string>();
      await Promise.all([...wts].map(async ([runId, wt]) => {
        const prefix = repoPrefixFor(projectRoot, wt.worktree);
        try {
          const r = await fs.read(`${prefix}/.factory/RUN.json`);
          if (r.status !== "ok") return;
          marks.add(runId);
          const stage = markerStage(r.text);
          if (stage) markStages.set(runId, stage);
        } catch { /* no marker */ }
      }));
      itemsRef.current = next;
      recordsRef.current = recs;
      setItems(next);
      setRecords(recs);
      setWorktrees(wts);
      setInterrupted(marks);
      setInterruptedStages(markStages);
      setError(null);
      setOffline(false);
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
    let retryAfterMs: number | null = null;
    for (const chunk of chunkShipRequests(requests)) {
      try {
        const r = await core.requestRaw("/kb/loop/ship-status", { method: "POST", body: { requests: chunk } });
        if (r.status === 429) { rateLimited = true; retryAfterMs = r.retryAfterSeconds ? r.retryAfterSeconds * 1000 : null; break; }
        if (r.status === 200) { setOffline(false); for (const [url, s] of decodeShipResults(r.body)) next.set(url, s); }
      } catch {
        // Core unreachable: these cards keep their last known column (columnFor), never Inbox.
        setOffline(true);
      }
      for (const q of chunk) if (!next.has(q.url)) next.set(q.url, "error");
    }
    // Rate limited: keep the statuses already shown instead of marking every card "status unavailable".
    if (!rateLimited) { setShip(next); setRetryAt(null); }
    else setRetryAt(Date.now() + (retryAfterMs ?? STATUS_MIN_GAP_MS));
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
    if (!selectedKey) return;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [selectedKey]);

  // Open issues fill the Backlog (and the Add picker): loaded when the board is shown and on Refresh.
  const [issuesTick, setIssuesTick] = useState(0);
  useEffect(() => {
    if (!active || !projectRoot) return;
    let live = true;
    setOpenIssues(null);
    void loadOpenIssues(projectRoot).then((list) => { if (live) setOpenIssues(list); });
    return () => { live = false; };
  }, [active, projectRoot, issuesTick]);

  useEffect(() => {
    if (!selectedKey) return;
    document.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const facts = useMemo(() => {
    const m = new Map<string, ItemFacts>();
    for (const item of items) m.set(item.key, assembleFacts(item, { projectRoot: projectRoot ?? "", live, records, worktrees, interrupted, interruptedStages, ship, lastKnown: lastKnown.current }));
    return m;
  }, [items, live, records, worktrees, interrupted, interruptedStages, ship, projectRoot]);
  useEffect(() => {
    if (!live.some((r) => r.state === "running" || r.state === "paused") && retryAt === null) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, retryAt]);

  const board = useMemo(() => buildBoard(items, facts, nowMs, { intake: hasIntake ?? undefined, steps }), [items, facts, nowMs, hasIntake, steps]);
  // Open issues not on the board yet, keyed like a stored issue item so a started one becomes the same card.
  const openIssueItems = useMemo(() => new Map((openIssues ?? []).map((i) => { const it = workItemFromIssue(i); return [it.key, it] as const; })), [openIssues]);
  const lanes = useMemo(() => buildLanes(board, steps ?? [], [...openIssueItems.values()].map(openIssueCard)), [board, steps, openIssueItems]);
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
  const summary = boardSummary(lanes, live.filter((r) => r.projectRoot === projectRoot).length, LANE_DONE);

  const startingKeys = useRef(new Set<string>());
  const [startingTick, setStartingTick] = useState(0);
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
    if (addKind === "issue") {
      const picked = openIssues?.find((i) => i.id === issuePick);
      if (!picked) throw new Error("Choose an open issue first.");
      item = workItemFromIssue(picked);
    } else {
      item = workItemFromText(textTitle, textBody);
    }
    const res = await sendToFactory(fs, [item], { runIntake: addIntake && hasIntake !== false, projectRoot, start: startRun });
    setNotice(sendSummary(res.added, res.existing.length));
    setSelectedKey(item.key);
    setAddOpen(false);
    setIssuePick("");
    setTextTitle("");
    setTextBody("");
  });

  const onAction = (item: WorkItemRecord, action: CardAction, note?: string) => {
    if (!projectRoot) return;
    const root = projectRoot;
    switch (action) {
      case "start":
      case "intake": {
        const plan = runPlanFor(action, item, facts.get(item.key) ?? EMPTY_FACTS);
        void act(async () => {
          const runId = startRun(root, item, plan.mode, plan.runId ? { runId: plan.runId } : undefined);
          if (!plan.runId) await attachRun(fs, item.key, runId);
        });
        return;
      }
      case "finishChecks": {
        const f = facts.get(item.key) ?? EMPTY_FACTS;
        const runId = item.runIds.at(-1) ?? null;
        const wt = runId ? worktrees.get(runId) : undefined;
        void act(async () => {
          const changed = runId && wt ? await invokeHost<unknown>("loop_worktree_diff", { runId }).then((raw) => decodeWorktreeDiff(raw).files.length, () => 0) : 0;
          const hasPlan = wt ? await fs.read(`${repoPrefixFor(root, wt.worktree)}/.factory/PLAN.md`, 200_000).then((r) => r.status === "ok", () => false) : false;
          const ok = finishChecksAllowed({ changedFiles: changed, hasPlan });
          const plan = ok ? runPlanFor("finishChecks", item, f) : runPlanFor("resume", item, f);
          if (!ok) setNotice("The run stopped before its work was written, so there is nothing to check yet. It resumes instead.");
          const started = startRun(root, item, plan.mode, plan.runId ? { runId: plan.runId } : undefined);
          if (!plan.runId) await attachRun(fs, item.key, started);
        });
        return;
      }
      case "resume":
      case "rerun": {
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
      case "answer":
        void act(async () => { await answerDecision({ fs, start: startRun, projectRoot: root }, item, note ?? ""); });
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
  // An open issue not on the board yet opens a details panel too: its text and Start.
  const selOpen = selectedKey && !byKey.has(selectedKey) ? openIssueItems.get(selectedKey) ?? null : null;
  const selected = selectedKey ? byKey.get(selectedKey) ?? selOpen : null;
  const startOpenIssue = (open: WorkItemRecord) => {
    // The add is awaited before the run starts; a second click meanwhile must not add and start the issue again.
    // The ref guards the card's button (checked synchronously), the state disables the details panel's.
    if (startingKeys.current.has(open.key)) return;
    startingKeys.current.add(open.key);
    setStartingTick((n) => n + 1);
    void act(async () => {
      if (!projectRoot) return;
      await sendToFactory(fs, [open], { runIntake: false, projectRoot, start: startRun });
      onAction(open, "start");
      setSelectedKey(open.key);
    }).finally(() => { startingKeys.current.delete(open.key); setStartingTick((n) => n + 1); });
  };
  const selFacts = selected ? facts.get(selected.key) ?? null : null;
  const selLive = selFacts?.live ?? null;
  const selRunId = selected?.runIds.at(-1) ?? null;
  const selInfo = selRunId ? worktrees.get(selRunId) ?? null : null;

  if (scope !== "Factory" && projectRoot) {
    return <LoopRuns projectRoot={projectRoot} scope={scope} />;
  }
  return (
    <div className="fx-board-root">
      <header className="fx-head">
        <div className="fx-head-title">
          <h2>Factory</h2>
          <p className="fx-summary">{summary}</p>
        </div>
        {elsewhere ? <span className="fx-hint" role="status">{elsewhere}</span> : null}
        <span className="fx-spacer" />
        <label className="fx-field fx-field-inline">
          <span>Parallel runs</span>
          <select value={cap} onChange={(e) => { setConcurrency(Number(e.target.value)); setCap(concurrency()); }}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" className="fx-btn" onClick={() => void (cleanup ? setCleanup(null) : openCleanup())} aria-expanded={cleanup !== null} disabled={worktrees.size === 0}>Clean up…</button>
        <button type="button" className="fx-btn" onClick={() => { setIssuesTick((n) => n + 1); void loadFacts().then(() => refreshStatus(true)); }}>Refresh</button>
        <button type="button" className="fx-btn fx-primary" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}>Add</button>
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
      {offline ? <StatusBanner severity="warning" message="The core is not reachable; the board is showing the last known state." onDismiss={() => setOffline(false)} /> : null}
      {retryAt ? <p className="fx-hint" role="status">PR/MR status paused; retrying in {Math.max(0, Math.ceil((retryAt - nowMs) / 1000))}s.</p> : null}
      {error ? <StatusBanner severity="error" message={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <StatusBanner severity="info" message={notice} onDismiss={() => setNotice(null)} /> : null}
      {addOpen ? (
        <form className="fx-form" aria-label="Add a work item" onSubmit={(e) => { e.preventDefault(); submitAdd(); }}>
          <label className="fx-field"><span>From</span>
            <select value={addKind} onChange={(e) => setAddKind(e.target.value as "issue" | "text")}>
              <option value="issue">Open issue</option>
              <option value="text">Free text (no issue comments)</option>
            </select>
          </label>
          {addKind === "issue" ? (
            <label className="fx-field fx-grow"><span>Issue</span>
              <select value={issuePick} onChange={(e) => setIssuePick(e.target.value)} disabled={openIssues === null}>
                <option value="">{openIssues === null ? "Loading open issues…" : openIssues.length ? "Choose an issue…" : "No open issues from a repository with a clone (Settings → Repositories); import them on the Issues screen"}</option>
                {(openIssues ?? []).map((i) => <option key={i.id} value={i.id}>{`${i.repo}${i.number !== null ? ` #${i.number}` : ""} ${i.title}`.slice(0, 160)}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label className="fx-field fx-grow"><span>Title</span><input value={textTitle} maxLength={500} onChange={(e) => setTextTitle(e.target.value)} /></label>
              <label className="fx-field fx-grow"><span>Description</span><textarea rows={3} value={textBody} onChange={(e) => setTextBody(e.target.value)} /></label>
            </>
          )}
          {hasIntake !== false ? <label className="fx-check"><input type="checkbox" checked={addIntake} onChange={(e) => setAddIntake(e.target.checked)} /> Run intake now</label> : null}
          <button type="submit" className="fx-btn fx-primary" disabled={addKind === "issue" ? issuePick === "" : textTitle.trim() === ""}>Add to Factory</button>
          <button type="button" className="fx-btn" onClick={() => setAddOpen(false)}>Cancel</button>
        </form>
      ) : null}
      <div className="fx-body">
        <LaneBoard
          lanes={lanes}
          onKeyDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("input, textarea, select, [contenteditable=true]")) return;
          const map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const;
          const cardKey = t.closest("[data-key]")?.getAttribute("data-key") ?? selectedKey;
          const dir = map[e.key as keyof typeof map];
          // Enter/Space are left alone: the card title is a button that opens the panel, and every other button keeps its own click.
          if (!dir) return;
          const next = nextCardKey(lanes, cardKey, dir);
          if (!next) return;
          e.preventDefault();
          requestAnimationFrame(() => (document.querySelector(`[data-key="${CSS.escape(next)}"] .fx-card-title`) as HTMLElement | null)?.focus());
        }}
          renderCard={(view) => {
                  const open = byKey.has(view.key) ? null : openIssueItems.get(view.key) ?? null;
                  if (open) {
                    return (
                      <Card key={view.key} view={view} selected={view.key === selectedKey} onOpen={() => setSelectedKey(view.key)} onAction={() => startOpenIssue(open)} />
                    );
                  }
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
}}
        />
        {selected ? (
          <aside className="fx-panel" ref={panelRef} tabIndex={-1} aria-label={`Details for ${selected.title}`}>
            <header className="fx-panel-head">
              <h3 className="fx-panel-title">{selected.title}</h3>
              <button type="button" className="fx-btn" onClick={() => { const key = selectedKey; setSelectedKey(null); requestAnimationFrame(() => (document.querySelector(`[data-key="${CSS.escape(key ?? "")}"] .fx-card-title`) as HTMLElement | null)?.focus()); }}>Close</button>
            </header>
            {selLive ? (
              <>
                <p className="fx-hint">Run {selLive.runId} · {selLive.state}</p>
                {selLive.note === LOOP_PAGE_NOTE ? null : <button type="button" className="fx-btn" onClick={() => cancelRun(selLive.runId)}>Stop run</button>}
                <ul className="fx-timeline" aria-label="Stage timeline">
                  {stageTimeline(selLive).map((row) => <li key={row.id} className={`fx-stage fx-stage-${row.state}`}>{row.name} <span>{row.state}</span></li>)}
                </ul>
                <pre className="fx-log" role="log" aria-live="polite" aria-label="Run log">{selLive.log.slice(-200).join("\n")}</pre>
              </>
            ) : selFacts?.lastRecord ? (
              <p className="fx-hint">Last run {selFacts.lastRecord.runId}: {selFacts.lastRecord.statusCode}{selFacts.lastRecord.needsDecision ? ` — ${selFacts.lastRecord.needsDecision}` : ""}</p>
            ) : selOpen ? (
              <>
                <p className="fx-hint">Open issue, not on the board yet. Start adds it and runs the process.</p>
                {selOpen.body.trim() ? <pre className="fx-log">{selOpen.body.slice(0, 4000)}</pre> : null}
                <div className="fx-actions"><button type="button" className="fx-btn fx-primary" onClick={() => startOpenIssue(selOpen)} disabled={startingTick >= 0 && startingKeys.current.has(selOpen.key)}>Start</button></div>
              </>
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
