// Loop: runs for the selected project, "Start a run" with an issue picker, and the desktop's own loop history.
// `LoopView` is pure so the gallery and tests render it without a connection.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createLoopController, canCancel, MAX_LOOP_ISSUES, type LoopRun, type LoopRunState, type LoopState } from "../loop/controller.ts";
import { friendlyDate, fullDate } from "../format.ts";
import type { SectionProps } from "../shell/registry.ts";
import { Badge, Banner, Button, Card, EmptyState, ListRow, RowList, Sheet, Skeleton, type Tone } from "../ui/index.ts";

export const LOOP_EMPTY_RUNS = "No runs from this browser yet — start one for open issues; approve it on the desktop.";
export const LOOP_NO_ISSUES = "No open issues are cached on the desktop. Sync issues there first.";
export const APPROVE_NOTICE = "Started. Approve this run on the desktop to begin.";

const STATE_TONE: Record<LoopRunState, Tone> = {
  awaiting_approval: "warning", queued: "info", running: "info", succeeded: "success", failed: "danger", cancelled: "neutral", interrupted: "warning", denied: "danger", expired: "neutral",
};
export const stateLabel = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function RunRow({ run, onCancel }: { run: LoopRun; onCancel: (id: string) => void }) {
  const bits = [friendlyDate(run.createdAt), run.step, run.state === "awaiting_approval" ? "approve on the desktop" : null].filter(Boolean);
  return (
    <li>
      <ListRow icon="repeat" title={<span title={fullDate(run.createdAt)}>{`${run.issueCount} ${run.issueCount === 1 ? "issue" : "issues"}`}</span>}
        subtitle={<><span title={fullDate(run.createdAt)}>{bits.join(" · ")}</span>{run.readyToShip ? <><br /><strong>Ready to ship on the desktop</strong></> : null}
          {run.errorCode ? <><br />{run.errorCode}</> : null}{run.summary ? <><br />{run.summary}</> : null}</>}
        trailing={<><Badge tone={STATE_TONE[run.state]} dot={run.state === "running"}>{stateLabel(run.state)}</Badge>
          {canCancel(run.state) ? <Button size="sm" variant="ghost" onClick={() => onCancel(run.id)}>Cancel</Button> : null}</>} />
    </li>
  );
}

function IssueSheet({ Shell, state, canStart, onClose, onStart }: {
  Shell: typeof Sheet; state: LoopState; canStart: boolean; onClose: () => void; onStart: (ids: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_LOOP_ISSUES ? p : [...p, id]));
  return (
    <Shell open onClose={onClose} title="Pick issues" footer={
      <Button variant="primary" loading={state.starting} disabled={!canStart || picked.length === 0} onClick={() => onStart(picked)}>Start ({picked.length})</Button>}>
      {state.issuesError ? <Banner tone="error">{state.issuesError.message}</Banner> : null}
      {!canStart ? <Banner tone="warn">Compose is off for this browser, so it cannot start runs.</Banner> : null}
      {state.issuesLoading ? <Skeleton height={18} /> : null}
      {state.issuesLoaded && !state.issuesError && state.issues.length === 0 ? <p className="ui-hint">{LOOP_NO_ISSUES}</p> : null}
      {picked.length >= MAX_LOOP_ISSUES ? <p className="ui-hint">You can pick at most {MAX_LOOP_ISSUES} issues.</p> : null}
      <ul className="ui-list" aria-label="Open issues">
        {state.issues.map((i) => {
          const on = picked.includes(i.id);
          return (
            <li key={i.id}>
              <label className="web-pick">
                <input type="checkbox" checked={on} disabled={!on && picked.length >= MAX_LOOP_ISSUES} onChange={() => toggle(i.id)} />
                <span><span className="ui-row-title">{i.title}</span>
                  <span className="ui-row-sub">{[i.repo, i.number ? `#${i.number}` : null, i.provider].filter(Boolean).join(" · ")}</span></span>
              </label>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

export interface LoopViewProps {
  state: LoopState; projectName: string | null; canStart: boolean;
  onRefresh: () => void; onOpenIssues: () => void; onStart: (ids: string[]) => Promise<boolean> | boolean; onCancel: (id: string) => void;
  onDismiss: () => void; onDismissStarted: () => void;
  /** The gallery opens the issue sheet. */
  initialSheet?: boolean;
  /** Tests swap the portal-based Sheet for a plain wrapper. */
  sheetShell?: typeof Sheet;
}
export function LoopView({ state, projectName, canStart, onRefresh, onOpenIssues, onStart, onCancel, onDismiss, onDismissStarted, initialSheet = false, sheetShell = Sheet }: LoopViewProps) {
  const [sheet, setSheet] = useState(initialSheet);
  if (!state.projectId) {
    return <div className="web-page"><Card><EmptyState icon="repeat" title="Pick a project">Loop runs belong to a project. Choose one in the project picker.</EmptyState></Card></div>;
  }
  return (
    <div className="web-page">
      {state.error ? <Banner tone={state.error.kind === "unavailable" ? "info" : "error"} action={<Button size="sm" onClick={onRefresh}>Retry</Button>}>{state.error.message}</Banner> : null}
      {state.actionError ? <Banner tone="error" onDismiss={onDismiss}>{state.actionError.message}</Banner> : null}
      {state.lastStarted ? <Banner tone="success" onDismiss={onDismissStarted}>{state.lastStarted.state === "awaiting_approval" ? APPROVE_NOTICE : `Started (${stateLabel(state.lastStarted.state)}).`}</Banner> : null}
      <Card title={projectName ? `Runs · ${projectName}` : "Runs"} flush
        action={<div className="web-actions"><Button size="sm" variant="ghost" icon="refresh-cw" onClick={onRefresh} aria-label="Refresh runs" />
          <Button size="sm" variant="primary" icon="plus" disabled={!canStart} onClick={() => { setSheet(true); onOpenIssues(); }}>Start a run</Button></div>}>
        {!state.loaded && state.loading ? <div style={{ padding: "var(--ui-s-3)" }}><Skeleton height={18} /></div>
          : state.runs.length === 0 && !state.error ? <p className="ui-hint" style={{ padding: "var(--ui-s-3)" }}>{LOOP_EMPTY_RUNS}</p>
          : <RowList label="Runs">{state.runs.map((r) => <RunRow key={r.id} run={r} onCancel={onCancel} />)}</RowList>}
      </Card>
      <Card title="Desktop Loop history" description="Runs the desktop started itself." flush>
        {state.historyError ? <p className="ui-hint" style={{ padding: "var(--ui-s-3)" }}>{state.historyError.message}</p>
          : state.history.length === 0 ? <p className="ui-hint" style={{ padding: "var(--ui-s-3)" }}>No desktop Loop runs yet.</p>
          : <RowList label="Desktop Loop history">{state.history.map((h) => (
            <li key={h.id}><ListRow icon="rotate-ccw-clock" title={h.loopName}
              subtitle={<><span title={fullDate(h.startedAt)}>{friendlyDate(h.startedAt)}</span>{[h.durationSeconds != null ? `${Math.round(h.durationSeconds)} s` : null, h.trigger, h.statusSummary].filter(Boolean).map((b) => ` · ${b}`).join("")}</>}
              trailing={<Badge>{h.statusCode}</Badge>} /></li>))}</RowList>}
      </Card>
      {sheet ? <IssueSheet Shell={sheetShell} state={state} canStart={canStart} onClose={() => setSheet(false)}
        onStart={(ids) => { void Promise.resolve(onStart(ids)).then((ok) => { if (ok) setSheet(false); }); }} /> : null}
    </div>
  );
}

export function LoopSection({ ctx }: SectionProps) {
  const link = ctx.session.connection;
  const controller = useMemo(() => createLoopController(link), [link]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const projectId = ctx.projects.selectedId;
  useEffect(() => { void controller.setProject(projectId); }, [controller, projectId]);
  useEffect(() => {
    const sync = () => controller.setActive(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { document.removeEventListener("visibilitychange", sync); controller.dispose(); };
  }, [controller]);
  const project = ctx.projects.projects.find((p) => p.id === projectId) ?? null;
  return (
    <LoopView state={state} projectName={project?.name ?? null} canStart={ctx.capabilities.has("compose")}
      onRefresh={() => void controller.refresh()} onOpenIssues={() => void controller.loadIssues()} onStart={(ids) => controller.start(ids)}
      onCancel={(id) => void controller.cancel(id)} onDismiss={controller.dismissActionError} onDismissStarted={controller.dismissStarted} />
  );
}
