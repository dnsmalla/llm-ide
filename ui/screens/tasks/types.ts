// Shared task-registry types. The data itself is generated from schema/tasks/registry.json into
// registry.generated.ts; these types are the contract every surface compiles against.

export type RunnerKind = "agent" | "shell" | "core-route" | "desktop-action";
export type TaskAvailabilityStatus = "available" | "unported" | "retired" | "alias";
export type TaskGroup = "Pipeline" | "Review" | "Automation" | "Maintenance" | "Factory" | "Loop";

export interface TaskStageDef {
  kind: string;
  name?: string;
  severity?: "blocking" | "advisory";
  allowsRepair?: boolean;
  [key: string]: unknown;
}

export interface TaskEngineDef {
  mode: "read" | "write";
  provider?: string;
  providerArg?: string;
}

export interface TaskRunnerDef {
  kind: RunnerKind;
  /** Relative to schema/tasks/, e.g. "prompts/review.code.md". Agent tasks only. */
  prompt?: string;
  /** A shared frame with one {{focus}} slot; the task's prompt fills it. Agent tasks only. */
  frame?: string;
  /** Server-side resources the core route supplies to this task (e.g. "trackerCreds"); never sent by a client. */
  needs?: readonly string[];
  /** Args a caller may send to the task route; every other key is refused. */
  args?: Readonly<Record<string, { type: "string" | "string[]"; maxLength: number; maxItems?: number }>>;
  /** A fixed core adapter id, e.g. "sources-update". core-route tasks only. */
  route?: string;
  /** Loop stage metadata. shell tasks require it; agent tasks may carry it. */
  stage?: TaskStageDef;
  /** A closed desktop action id, e.g. "factory.start". desktop-action tasks only. */
  action?: string;
  /** The command-bus kind this task maps to, when one exists. */
  busKind?: string;
  /** Fixed bus args merged with the task args (e.g. { focus: "code" } for review). */
  busArgs?: Readonly<Record<string, unknown>>;
  engine?: TaskEngineDef;
  timeoutSeconds?: number;
  /** e.g. "git-conflicts"; the adapter runs this deterministic pre-check first. */
  deterministicFirst?: string;
}

export interface TaskInputDef {
  kind: "repo" | "project" | "notes" | "issues" | "doc" | "none";
  required: boolean;
  paths?: readonly string[];
  selector?: string;
}

export interface TaskOutputDef {
  kind: "text" | "file" | "fault-report" | "issue" | "pr" | "run-record" | "none";
  persist: "log" | "run-record" | "note" | "tracker" | "file" | "none";
  revertWrites: boolean;
}

export interface TaskScheduleDef {
  backend: "none" | "desktop" | "bus";
  defaultCron: string | null;
  schedulable: boolean;
}

export interface TaskAvailabilityDef {
  status: TaskAvailabilityStatus;
  reason: string | null;
}

export interface TaskDef {
  id: string;
  label: string;
  group: TaskGroup;
  description: string;
  aliases: readonly string[];
  runner: TaskRunnerDef | null;
  input: TaskInputDef;
  output: TaskOutputDef;
  schedule: TaskScheduleDef;
  scope: "project" | "app";
  readOnly: boolean;
  requiresRepo: boolean;
  requiresLocalHost: boolean;
  features: readonly string[];
  availability: TaskAvailabilityDef;
  /** Only for availability.status "alias"; the canonical task it resolves to. */
  aliasOf?: string;
  revision: number;
}

export interface LoopTemplateStageDef {
  taskId?: string;
  kind?: string;
  name?: string;
  command?: string;
  severity?: "blocking" | "advisory";
  testOp?: "structure" | "map" | "ledger";
  graphOp?: "snapshot" | "verify";
  check?: Record<string, unknown>;
  runOnce?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface LoopTemplateDef {
  id: string;
  name: string;
  summary: string;
  kind: "starter" | "recipe";
  defaultKey?: string | null;
  isPrimary?: boolean;
  goal?: string | null;
  acceptanceCriteria?: string | null;
  stages: readonly LoopTemplateStageDef[];
  config?: Record<string, unknown>;
}

export interface TaskEnv {
  /** Enabled feature keys from the host pref set; null = every feature. */
  features: ReadonlySet<string> | null;
  /** The core's /health.features; null = every feature. */
  coreFeatures: ReadonlySet<string> | null;
  hasRepo: boolean;
  localHost: boolean;
  mode: "local" | "remote";
}

export interface Availability {
  runnable: boolean;
  reason: string | null;
}
