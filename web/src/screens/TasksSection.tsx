// Auto Tasks: the desktop's task registry, a Run sheet with the declared arguments, and this browser's recent runs.
// `TasksView` is pure (state in, callbacks out) so the gallery and tests render it without a connection.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { browserStorage, desktopKeys } from "../host-api/storage.ts";
import { createTasksController, type TaskDef, type TaskRun, type TasksState, type TaskStatus } from "../tasks/controller.ts";
import { friendlyDate, fullDate } from "../format.ts";
import type { SectionProps } from "../shell/registry.ts";
import { Badge, Banner, Button, Card, EmptyState, ListRow, RowList, Sheet, Skeleton, TextArea, TextField, type Tone } from "../ui/index.ts";

export type SheetShell = typeof Sheet;
export const TASKS_EMPTY = "No tasks are available on this desktop. Update the desktop and check that Read + Compose are enabled in Phone and browser.";
export const NOT_AVAILABLE = "Not available on this desktop";

const STATUS_TONE: Record<TaskStatus, Tone> = { running: "info", completed: "success", failed: "danger", cancelled: "neutral" };
const STATUS_LABEL: Record<TaskStatus, string> = { running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
const SCOPE_LABEL = { project: "Project", repo: "Repository", global: "Global" } as const;

export function groupTasks(tasks: readonly TaskDef[]): { group: string; tasks: TaskDef[] }[] {
  const by = new Map<string, TaskDef[]>();
  for (const t of tasks) { const g = t.group.trim() || "Other"; by.set(g, [...(by.get(g) ?? []), t]); }
  return [...by].map(([group, list]) => ({ group, tasks: list }));
}

/** string[] arguments are typed one per line. Returns an error text or null. */
export function validateArg(arg: NonNullable<TaskDef["args"]>[number], value: string): string | null {
  if (arg.type === "string[]") {
    const items = value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (arg.maxItems && items.length > arg.maxItems) return `At most ${arg.maxItems} items.`;
    if (arg.maxLength && items.some((s) => s.length > arg.maxLength!)) return `Each item is at most ${arg.maxLength} characters.`;
    return null;
  }
  if (arg.maxLength && value.length > arg.maxLength) return `At most ${arg.maxLength} characters.`;
  return null;
}
const normalize = (arg: { type: string }, value: string) => (arg.type === "string[]" ? value.split("\n").map((s) => s.trim()).filter(Boolean).join("\n") : value);

function RunSheet({ task, projectName, canRun, starting, onClose, onRun, Shell }: {
  Shell: SheetShell; task: TaskDef; projectName: string | null; canRun: boolean; starting: boolean; onClose: () => void; onRun: (args: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const args = task.args ?? [];
  const errors = Object.fromEntries(args.map((a) => [a.name, validateArg(a, values[a.name] ?? "")]));
  const needsProject = task.scope === "project" && !projectName;
  const blocked = !canRun || needsProject || Object.values(errors).some(Boolean);
  return (
    <Shell open onClose={onClose} title="Run task" footer={
      <Button variant="primary" loading={starting} disabled={blocked}
        onClick={() => onRun(Object.fromEntries(args.map((a) => [a.name, normalize(a, values[a.name] ?? "")])))}>Run on desktop</Button>}>
      <h3 style={{ margin: 0 }}>{task.label}</h3>
      {task.description ? <p className="ui-hint">{task.description}</p> : null}
      {task.scope === "project" ? (projectName ? <p className="ui-hint">Project: {projectName}</p> : <Banner tone="warn">Pick a project first. This task runs in a project.</Banner>) : null}
      {!canRun ? <Banner tone="warn">Compose is off for this browser, so it cannot start tasks. Turn it on in Phone and browser on the desktop.</Banner> : null}
      {args.map((a) => {
        const common = {
          label: a.name, value: values[a.name] ?? "", error: errors[a.name],
          onChange: (e: { target: { value: string } }) => setValues({ ...values, [a.name]: e.target.value }),
        };
        return a.type === "string[]"
          ? <TextArea key={a.name} {...common} rows={3} hint={`One per line${a.maxItems ? `, up to ${a.maxItems}` : ""}.`} autoCapitalize="none" spellCheck={false} />
          : <TextField key={a.name} {...common} hint={a.maxLength ? `Up to ${a.maxLength} characters.` : undefined} autoCapitalize="none" autoCorrect="off" spellCheck={false} />;
      })}
    </Shell>
  );
}

function RunRow({ run, onCancel }: { run: TaskRun; onCancel: (id: string) => void }) {
  const detail = run.output || run.error || run.summary;
  return (
    <li className="web-task-run">
      <ListRow title={run.label || run.taskId} subtitle={<span title={fullDate(run.startedAt)}>{`${friendlyDate(run.startedAt)}${run.summary ? ` · ${run.summary}` : ""}`}</span>}
        trailing={<><Badge tone={STATUS_TONE[run.status]} dot={run.status === "running"}>{STATUS_LABEL[run.status]}</Badge>
          {run.status === "running" ? <Button size="sm" variant="ghost" onClick={() => onCancel(run.runId)}>Cancel</Button> : null}</>} />
      {run.error ? <p className="ui-error" role="alert">{run.error}</p> : null}
      {run.output || (run.summary && run.summary.length > 80) ? (
        <details className="web-task-output"><summary>Output</summary><pre className="web-mono">{detail}</pre></details>
      ) : null}
    </li>
  );
}

export interface TasksViewProps {
  state: TasksState; projectName: string | null; canRun: boolean;
  onRefresh: () => void; onRun: (task: TaskDef, args: Record<string, string>) => Promise<boolean> | boolean; onCancel: (runId: string) => void;
  onClear: () => void; onDismiss: () => void;
  /** The gallery opens the Run sheet for this task id. */
  initialSheet?: string | null;
  /** Tests swap the portal-based Sheet for a plain wrapper (static markup has no document). */
  sheetShell?: SheetShell;
}
export function TasksView({ state, projectName, canRun, onRefresh, onRun, onCancel, onClear, onDismiss, initialSheet = null, sheetShell = Sheet }: TasksViewProps) {
  const [sheetId, setSheetId] = useState<string | null>(initialSheet);
  const sheetTask = state.tasks.find((t) => t.id === sheetId) ?? null;
  const groups = groupTasks(state.tasks);
  const finished = state.runs.some((r) => r.status !== "running");
  return (
    <div className="web-page">
      {state.error ? <Banner tone={state.error.kind === "unavailable" ? "info" : "error"} action={<Button size="sm" onClick={onRefresh}>Retry</Button>}>{state.error.message}</Banner> : null}
      {state.actionError ? <Banner tone="error" onDismiss={onDismiss}>{state.actionError.message}</Banner> : null}
      {!state.loaded && state.loading ? <Card><Skeleton height={18} /><Skeleton width="60%" /></Card> : null}
      {state.loaded && !state.error && state.tasks.length === 0 ? (
        <Card><EmptyState icon="list-checks" title="No tasks yet" action={<Button icon="refresh-cw" onClick={onRefresh} loading={state.loading}>Refresh</Button>}>{TASKS_EMPTY}</EmptyState></Card>
      ) : null}
      {groups.map((g) => (
        <Card key={g.group} title={g.group} flush>
          <RowList label={g.group}>
            {g.tasks.map((t) => (
              <li key={t.id}>
                <ListRow icon="list-checks" title={t.label} disabled={!t.available}
                  subtitle={<>{t.available ? t.description : NOT_AVAILABLE}<br />{SCOPE_LABEL[t.scope]}{t.requiresRepo ? " · needs a repository" : ""}</>}
                  trailing={<Button size="sm" variant="secondary" disabled={!t.available} onClick={() => setSheetId(t.id)} aria-label={`Run ${t.label}`}>Run</Button>} />
              </li>
            ))}
          </RowList>
        </Card>
      ))}
      <Card title="Recent runs" description="Runs started from this browser." flush
        action={finished ? <Button size="sm" variant="ghost" onClick={onClear}>Clear finished</Button> : undefined}>
        {state.runs.length === 0 ? <p className="ui-hint" style={{ padding: "var(--ui-s-3)" }}>No runs yet.</p>
          : <RowList label="Recent runs">{state.runs.map((r) => <RunRow key={r.runId} run={r} onCancel={onCancel} />)}</RowList>}
      </Card>
      {sheetTask ? (
        <RunSheet Shell={sheetShell} task={sheetTask} projectName={projectName} canRun={canRun} starting={state.starting} onClose={() => setSheetId(null)}
          onRun={(args) => { void Promise.resolve(onRun(sheetTask, args)).then((ok) => { if (ok) setSheetId(null); }); }} />
      ) : null}
    </div>
  );
}

export function TasksSection({ ctx }: SectionProps) {
  const link = ctx.session.connection;
  const url = ctx.session.url;
  const controller = useMemo(() => {
    const storage = browserStorage();
    const id = desktopKeys(storage, url, null);
    return createTasksController(link, { storage, desktopKey: id.id, legacyKeys: [url, ...id.legacy] });
  }, [link, url]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    void controller.load();
    const sync = () => controller.setActive(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { document.removeEventListener("visibilitychange", sync); controller.dispose(); };
  }, [controller]);
  const project = ctx.projects.projects.find((p) => p.id === ctx.projects.selectedId) ?? null;
  return (
    <TasksView state={state} projectName={project?.name ?? null} canRun={ctx.capabilities.has("compose")}
      onRefresh={() => void controller.load()} onRun={(t, args) => controller.run(t, project?.id ?? null, args)}
      onCancel={(id) => void controller.cancel(id)} onClear={controller.clearFinished} onDismiss={controller.dismissActionError} />
  );
}
