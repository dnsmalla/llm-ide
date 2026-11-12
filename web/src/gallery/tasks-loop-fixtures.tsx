// Gallery fixtures for the Auto Tasks and Loop sections (pure views, no connection).
import { initialTasksState, type TasksState } from "../tasks/controller.ts";
import { initialLoopState, type LoopState } from "../loop/controller.ts";
import { TasksView } from "../screens/TasksSection.tsx";
import { LoopView } from "../screens/LoopSection.tsx";

const noop = () => undefined;
const NOW = 1762400000000;

export const TASKS_FIXTURE: TasksState = {
  ...initialTasksState, loaded: true,
  tasks: [
    { id: "triage", label: "Triage new issues", group: "Issues", description: "Label and assign issues that arrived since the last sync.", scope: "project", available: true,
      args: [{ name: "label", type: "string", maxLength: 40 }, { name: "paths", type: "string[]", maxItems: 5, maxLength: 200 }] },
    { id: "sync-issues", label: "Sync issues", group: "Issues", description: "Fetch the latest issues from the tracker.", scope: "project", available: true },
    { id: "index-repo", label: "Re-index the repository", group: "Code", description: "Rebuild the code graph.", scope: "repo", available: false, requiresRepo: true },
    { id: "backup", label: "Back up the knowledge base", group: "Maintenance", description: "Write a copy of the database.", scope: "global", available: true },
  ],
  runs: [
    { runId: "run-3", taskId: "backup", label: "Back up the knowledge base", startedAt: NOW, status: "running" },
    { runId: "run-2", taskId: "sync-issues", label: "Sync issues", startedAt: NOW - 600000, status: "completed", summary: "Fetched 12 issues", output: "fetched 12 issues\nupdated 3\nskipped 9 unchanged" },
    { runId: "run-1", taskId: "triage", label: "Triage new issues", startedAt: NOW - 3600000, status: "failed", error: "The tracker token has expired." },
  ],
};
export const TASKS_EMPTY_FIXTURE: TasksState = { ...initialTasksState, loaded: true };

export const LOOP_FIXTURE: LoopState = {
  ...initialLoopState, projectId: "p-1", loaded: true, issuesLoaded: true,
  runs: [
    { id: "loop-run-0003", state: "awaiting_approval", createdAt: "2026-11-12T09:30:00Z", issueCount: 2 },
    { id: "loop-run-0002", state: "running", createdAt: "2026-11-12T08:00:00Z", issueCount: 1, step: "Implementing" },
    { id: "loop-run-0001", state: "succeeded", createdAt: "2026-11-11T17:00:00Z", finishedAt: "2026-11-11T17:40:00Z", issueCount: 3, readyToShip: true, summary: "All checks passed." },
    { id: "loop-run-0000", state: "failed", createdAt: "2026-11-10T10:00:00Z", issueCount: 1, errorCode: "tests_failed" },
  ],
  issues: [
    { id: "i1", title: "Retry helper swallows the last error", provider: "gitlab", repo: "atlas/api", number: 41 },
    { id: "i2", title: "Nightly build is red on main", provider: "gitlab", repo: "atlas/api", number: 44 },
    { id: "i3", title: "Add a dark theme to the settings page", provider: "github", repo: "atlas/web", number: 7 },
  ],
  history: [{ id: "h1", loopName: "Nightly refactor", startedAt: "2026-11-11T02:00:00Z", durationSeconds: 1260, statusCode: "ok", statusSummary: "2 batches applied", trigger: "schedule" }],
};
export const LOOP_EMPTY_FIXTURE: LoopState = { ...initialLoopState, projectId: "p-1", loaded: true, issuesLoaded: true };

const tasks = (state: TasksState, initialSheet: string | null = null) => () =>
  <TasksView state={state} projectName="Atlas" canRun onRefresh={noop} onRun={() => true} onCancel={noop} onClear={noop} onDismiss={noop} initialSheet={initialSheet} />;
const loop = (state: LoopState, initialSheet = false) => () =>
  <LoopView state={state} projectName="Atlas" canStart onRefresh={noop} onOpenIssues={noop} onStart={() => true} onCancel={noop} onDismiss={noop} onDismissStarted={noop} initialSheet={initialSheet} />;

export const TASKS_LOOP_SCREENS = {
  "tasks": tasks(TASKS_FIXTURE),
  "tasks-sheet": tasks(TASKS_FIXTURE, "triage"),
  "tasks-empty": tasks(TASKS_EMPTY_FIXTURE),
  "loop": loop(LOOP_FIXTURE),
  "loop-issues": loop(LOOP_FIXTURE, true),
  "loop-empty": loop(LOOP_EMPTY_FIXTURE),
};
