// GENERATED - do not edit.
// Source: schema/http/*.schema.json (+ schema/agent-v2 event schema).
// Regenerate with `node scripts/gen-api-types.mjs` (or `make api-types`).
// Check with `node scripts/gen-api-types.mjs --check` (part of `make contract-gates`).

/** The error envelope every failing /kb/* and legacy route returns (extension/core/errors.mjs, sendError). code is a stable identifier clients switch on; message is prose; details is optional structured context (e.g. the guardrail report on GUARDRAIL_FAILED). */
export type CommonError = {
  error: {
    code: string;
    message: string;
    /** Code-specific structured detail (e.g. guardrail report) */
    details?: unknown;
  };
};

export type AgentOk = {
  ok: true;
};

/** The legacy single-persona surface (GET and PUT /kb/agent/persona): the stored fields only, no id. */
export type LegacyPersona = {
  name: string | null;
  promptSuffix: string | null;
  autoDispatch: boolean;
};

/** A row of the multi-persona registry (kb/personas.mjs). id 'default' is the migrated legacy persona. */
export type Persona = {
  id: string;
  name: string | null;
  promptSuffix: string | null;
  autoDispatch: boolean;
  /** ISO 8601 timestamp */
  createdAt: string;
};

export type PersonaList = {
  personas: Persona[];
  /** the active persona's id */
  active: string | null;
  count: number;
};

/** A unified chat session (kb/chat-sessions.mjs). createdAt and updatedAt are epoch seconds with a fraction. */
export type ChatSession = {
  id: string;
  title: string;
  /** mac, extension or any */
  surface: string;
  /** ask, agent or transcript */
  mode: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  seq: number;
  /** user, assistant or system */
  role: string;
  content: string;
  /** Caller-supplied metadata stored as sent; the server does not interpret it. */
  meta: Record<string, unknown> | null;
  createdAt: number;
};

export type AskMessage = {
  seq: number;
  /** user or assistant */
  role: string;
  content: string;
  /** epoch seconds with a fraction */
  created_at: number;
};

export type SkillEntry = {
  name: string;
  kind: "read" | "write";
  description: string;
};

/** A kit template or command (generation-library). surface divides the Doc Gen and Visual menus. */
export type LibraryEntry = {
  /** <family>/<file-stem> */
  id: string;
  family: string;
  name: string;
  description: string;
  surface: "doc" | "visual";
  /** the Markdown body the app seeds into the project */
  body: string;
  path: string;
  sourceId: string;
  sourceName: string;
};

export type SkillLibraryEntry = {
  id: string;
  family: string;
  name: string;
  description: string;
  path: string;
  sourceId: string;
  sourceName: string;
};

export type TaskFeedback = {
  planTaskId: string;
  total: number;
  byVerdict: VerdictCounts;
  usefulRate: number | null;
  avgScoreUseful: number | null;
  avgScoreNoise: number | null;
};

export type VerdictCounts = {
  useful: number;
  noise: number;
  later: number;
};

export type ToolRule = {
  /** Absolute workspace root the rule applies to */
  projectRoot: string;
  /** `Bash`, `run-bash`, or an act tool name */
  toolName: string;
  /** Command prefix for shell tools; empty = the whole tool */
  pattern: string;
  /** ISO-8601 timestamp */
  grantedAt: string;
};

export type ToolApprovalListing = {
  rules: ToolRule[];
  /** pre-0034 global grants, no longer honoured by either engine, still listed and revocable */
  approvals: ApprovalGrant[];
};

export type ApprovalGrant = {
  toolName: string;
  grantedAt: string;
};

/** One chat's route (K1 Phase 6b). `enabled` is false when the server runs without LLMIDE_ROUTER=on: the record then reads as the empty default and PUT answers 409 ROUTER_DISABLED. `capEnforced` says whether LLMIDE_ROUTER_CAP=on, i.e. whether tokenLimit is enforced or only stored. provider '' and model '' = not pinned: the client's own pick governs. */
export type RouteState = {
  enabled: boolean;
  capEnforced: boolean;
  chatSessionId: string;
  /** anthropic, custom:<id>, or '' when not pinned */
  provider: string;
  model: string;
  pinned: boolean;
  pinnedBy: "user" | "router";
  /** billable tokens for the chat; null = no cap */
  tokenLimit: number | null;
  used: {
    in: number;
    out: number;
    cacheWrite: number;
    /** shown, never counted against the cap */
    cacheRead: number;
    /** input + output + cache write: what the session cap counts */
    billable: number;
  };
  remaining: number | null;
  /** UTC ISO; the time the last turn's prompt cache is expected to expire */
  stickyUntil: string | null;
  /** '<provider>|<model>' to the last cache touch (UTC ISO) */
  warm: Record<string, string>;
  /** compare-and-set version: send it back as ifSeq */
  switchSeq: number;
  /** a provider/model change made during a turn, applied at the next turn start */
  pending: {
    provider?: string;
    model?: string;
    pinnedBy?: string;
    requestedAt?: string;
  } | null;
  updatedAt: string | null;
};

export type RouteEvent = {
  id: number;
  at: string;
  kind: "switch" | "cap_reached" | "cap_changed" | "cooldown" | "handoff_built";
  fromProvider: string | null;
  fromModel: string | null;
  toProvider: string | null;
  toModel: string | null;
  /** user | rate_limit | error | cap, or the handoff source (client | extractive) */
  reason: string | null;
  coldPrefillTokens: number | null;
  handoffChars: number | null;
};

/** One data group of the Storage hub. agent_history carries bytes (approximate) and the clear/compact actions; the main-DB groups carry rows per user and no bytes (SQLite sizes whole files, not users). */
export type AgentHistoryStorageGroup = {
  key: "agent_history" | "search_index" | "code_graph" | "sources" | "meetings";
  label: string;
  /** Rows for this user. agent_history: runs, tool events and composition rows (the rows Clear can delete; the activity feed is not counted). search_index: indexed chunks. code_graph: repos. sources: distinct source kinds. meetings: meetings. */
  rows: number;
  /** Approximate bytes for agent_history; null for the main-DB groups. */
  bytes: number | null;
  bytesApprox: boolean | null;
  /** ISO time of the last clear (agent_history only). */
  lastCleanedAt: string | null;
  /** Raw-row retention (agent_history only). */
  retentionDays: number | null;
  /** Actions the page may offer. Only agent_history has any. */
  actions: ("clear" | "compact")[];
};

/** Null when the agent store is down. */
export type AgentHistoryAgentHistorySummary = {
  /** Oldest raw day (YYYY-MM-DD, local). */
  rawFromDay: string | null;
  rawRows: number;
  rolledDays: number;
  /** Oldest rolled-up day. */
  oldestDay: string | null;
  /** When the store was reset after damage, if it was. */
  quarantinedAt: string | null;
  /** Rows dropped by the write queue (bounded queue or failed batch), counted since the store was created. */
  droppedRows: number;
  /** The last day folded into the daily rollups. */
  watermark: string | null;
} | null;

export type AgentHistoryStorageReport = {
  generatedAt: string;
  groups: AgentHistoryStorageGroup[];
  agentHistory: AgentHistoryAgentHistorySummary;
  agentStore: {
    health: "ok" | "degraded" | "down";
    state: "closed" | "ok" | "down";
  };
  /** Counts from the last shadow comparisons (usage ledger vs agent.db, note index vs legacy search). No query text, no row content. Absent when the store could not be read. */
  shadow?: {
    /** The last usage ledger compare; null when none has run. */
    usage: {
      state: "ok" | "mismatch";
      at: string;
      scope: "all" | "user";
      mismatches: number;
      windows: Record<string, {
          ledgerRows: number;
          shadowRows: number;
          mismatchedKeys: number;
        }>;
    } | null;
    /** The last note-index compare; null when none has run. */
    noteIndex: {
      state: "ok" | "not-evaluated" | "stale" | "mismatch";
      at: string;
      pairs: number;
      stalePairs: number;
      scoredQueries: number;
      meanOverlap: number;
      mismatchedQueries: number;
      mismatchedPairs: number;
    } | null;
  };
};

/** One agent run for the System view. No prompt, message or error text: codes only. */
export type AgentHistoryAgentRun = {
  id: string;
  source: "chat" | "loop" | "meeting" | "autotask" | "dispatch" | "review";
  engine: string | null;
  status: "running" | "ok" | "error" | "cancelled" | "aborted";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Input plus output tokens of the run. */
  tokens: number;
  toolCalls: number;
  model: string | null;
  errorCode: string | null;
};

export type task = {
  id: string;
  title: string;
  status: string;
};

/** One `data:` payload on GET/POST /agent/v2/stream. Every variant sets additionalProperties:false ON PURPOSE — a field added server-side must be added here in the same edit, which is what makes scripts/conformance-agent-v2.mjs able to notice that the Mac does not decode it. See SCHEMA.md. */
export type AgentV2Event = {
  type: "init";
  sessionId: string | null;
  claudeCodeVersion: string | null;
  model: string | null;
  tools: string[];
  capabilities: string[];
  mcpServers: ({
    name?: string | null;
    status?: string | null;
  })[];
} | {
  type: "delta";
  text: string;
} | {
  type: "tool_use_start";
  index: number;
  id: string | null;
  name: string | null;
} | {
  type: "tool_args_delta";
  index: number;
  partialJson: string;
} | {
  type: "tool_result";
  toolUseId: string | null;
  isError: boolean;
  text: string;
  truncated: boolean;
} | {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | {
  type: "memory";
  sessionFacts: number;
  chars: number;
  approxTokens: number;
} | {
  type: "context_usage";
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: {
    name: string;
    kind: string;
    tokens: number;
  }[];
} | {
  type: "result";
  subtype: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  sessionId: string | null;
  stopReason: string | null;
} | {
  type: "sdk";
  sdkType: string | null;
  subtype: string | null;
  raw: unknown;
} | {
  type: "notice";
  kind: string;
  level: "info" | "warning" | "error";
  text: string;
  data?: unknown;
} | {
  type: "approval_request";
  requestId: string;
  kind: "ToolApproval";
  toolName: string;
  argsSummary: string | null;
  /** Only for Bash / Edit / Write — engine.mjs approvalArgsFor. Absent for every other gated tool. */
  args?: {
    command?: string;
    filePath?: string;
    oldString?: string;
    newString?: string;
    replaceAll?: boolean;
    contentPreview?: string;
    totalChars?: number;
    exists?: boolean;
    truncated?: boolean;
  };
} | {
  type: "approval_request";
  requestId: string;
  kind: "AskUserQuestion";
  /** PASSED THROUGH FROM THE SDK VERBATIM (engine.mjs:906). This is the one place the wire IS the SDK's shape, so an SDK rename lands here first — see SCHEMA.md. */
  questions: {
    question: string;
    header?: string;
    multiSelect: boolean;
    options: {
      label: string;
      description?: string;
      preview?: string;
    }[];
  }[];
} | {
  type: "approval_resolved";
  requestId: string;
  outcome: string;
} | {
  type: "mode_set";
  mode: string;
} | {
  type: "tasks";
  tasks: task[];
  continueNeeded: boolean;
} | {
  type: "tasks_progress";
  tasks: task[];
} | {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
};

export type Template = {
  /** Stable UUID for the folder (SHA-256 of llmide.doc-template.<folder>, uppercase). */
  id: string;
  /** The '# Title' line, or the humanized folder name. */
  name: string;
  /** The '## ' headings, or ['Content'] when there are none. */
  sections: string[];
  /** The file text exactly as stored. */
  rawContent: string;
  isBuiltin: false;
  folderName: string;
  isProjectTemplate: true;
  surface: "doc" | "visual";
};

export type Command = {
  /** Stable UUID for the folder (SHA-256 of llmide.doc-command.<folder>, uppercase). */
  id: string;
  /** The first '# ' line, or the humanized folder name. */
  name: string;
  /** The body without the first '# ' line and the marker line. */
  instruction: string;
  rawContent: string;
  isBuiltin: false;
  folderName: string;
  isProjectCommand: true;
  surface: "doc" | "visual";
};

export type ProjectQuery = {
  /** A registered project id (1 to 128 letters, digits, _ or -). Required: a request without it answers 400 VALIDATION_FAILED. */
  project?: string;
};

export type TemplateWrite = {
  /** Title, at most 200 characters. Defaults to the folder name. */
  name?: string;
  /** Section headings, at most 100 of 200 characters each. Used when rawContent is absent. */
  sections?: string[];
  /** doc (default) or visual. Any other value answers 400 VALIDATION_FAILED. */
  surface?: string;
  /** The whole file text. When present it is written as-is (the Swift renderedMarkdown rule), and it wins over rewrite. */
  rawContent?: string;
  /** Apply name and sections to the existing file and keep its body text (DocTemplate.rewriting). Precedence: rawContent wins. When rawContent is present it is written as-is and rewrite is ignored. */
  rewrite?: boolean;
};

export type CommandWrite = {
  /** Title, at most 200 characters. Defaults to the folder name. */
  name?: string;
  /** Instruction text, at most 20 000 characters. */
  instruction?: string;
  /** doc (default) or visual. Any other value answers 400 VALIDATION_FAILED. */
  surface?: string;
  /** The whole file text. When present it is written as-is. */
  rawContent?: string;
};

export type DeleteResult = {
  deleted: true;
  /** The true directory entry name (case may differ from the request). */
  folderName: string;
  /** True when the folder was empty after the template or command file was removed and was removed too. False when user files remain in it. */
  folderRemoved: boolean;
};

export type SeedResult = {
  /** Relative paths created by this call (templates/README.md, templates/<folder>/template.md, ...). Files that already exist are not listed. */
  written: string[];
  count: number;
};

export type RegisterRequest = {
  /** The project id (1 to 128 letters, digits, _ or -). */
  id?: string;
  /** Absolute path of the project folder. Must be an existing directory that is not a symlink, is not a system folder (/, /Users, /private, /etc, /var, /usr, /System, /Library, /Applications, /Volumes, /opt, /bin, /sbin and their /private twins), is not the home directory or an ancestor of it, has no .git, .ssh, .gnupg, .aws, .kube or .docker component, and contains system/project.json. Any refusal answers the same INVALID_ROOT 400. */
  root?: string;
};

export type RegisterResult = {
  id: string;
  /** The validated realpath the server stored. */
  root: string;
};

export type ExtensionsFinding = {
  severity: string;
  rule: string;
  file: string;
  line?: number;
  detail: string;
  excerpt?: string;
};

export type Member = {
  memberId: string;
  type: string;
  name: string;
  executable: boolean;
};

export type Item = {
  id: string;
  kind: "skill" | "plugin" | "mcp" | "llm-source";
  name: string;
  description: string;
  version: string | null;
  publisher: {
    id: string;
    trust: string;
  };
  source: {
    kind: string;
    url: string;
    ref?: string;
    commit: string;
  };
  subpath?: string;
  pinnedCommit: string;
  installedAt: string;
  updatedAt?: string;
  members: Member[];
  declared: {
    executableKinds: string[];
  };
  permissions: {
    type: string;
    executable: boolean;
    text: string;
  }[];
  scan: {
    count: number;
    byRule?: Record<string, number>;
    findings?: ExtensionsFinding[];
  };
  consents?: Record<string, {
      grantedAt: string;
      commit: string;
    }>;
  integrity?: string;
  storeDir: string;
  update?: {
    latest: string;
    checkedAt: string;
  };
  previous?: {
    pinnedCommit: string;
    version: string | null;
    installedAt: string | null;
  };
  state: {
    enabled: boolean;
    disabledMembers: string[];
  };
};

export type Entry = {
  indexId: string;
  kind: string;
  name: string;
  description: string;
  publisher: string;
  version?: string;
  source: {
    url?: string;
    path?: string;
  };
  remote?: boolean;
  installable: boolean;
  reason?: string;
  installed: boolean;
};

export type ExtensionsSource = {
  id: string;
  title: string;
  kind: string;
  status: string;
  count: number;
  fetchedAt: string | null;
  error?: string;
};

export type TrustItem = {
  path: string;
  trusted: boolean;
  updatedAt: string;
};

/** operator: the operator's own list; ceiling: what a user may add (null = no ceiling); user: the user's saved additions; ignored: saved additions the current ceiling no longer covers; effective: operator + active user additions. */
export type Allowlist = {
  operator: string[];
  ceiling: string[] | null;
  user: string[];
  ignored: string[];
  effective: string[];
};

export type User = {
  id: string;
  email: string;
  displayName: string;
  /** admin | user */
  role: string;
  status: string;
  /** SQLite datetime, YYYY-MM-DD HH:MM:SS (UTC), not ISO 8601 */
  createdAt: string;
  /** SQLite datetime, or null before the first login */
  lastLoginAt: string | null;
};

export type Session = {
  user: User;
  /** HS256 JWT, valid 15 min by default */
  accessToken: string;
  /** Opaque, hashed in DB; rotate via /auth/refresh */
  refreshToken: string;
  accessTokenTTLSec: number;
};

export type HealthAuthOk = {
  ok: true;
};

export type Health = {
  /** ok when the DB, the Claude CLI probe and .skills all pass; degraded otherwise */
  status: "ok" | "degraded";
  /** SERVER_API_VERSION */
  apiVersion: number;
  /** current migration number */
  schemaVersion: number;
  uptimeSec: number;
  /** Endpoints this process serves; a feature disabled by LLMIDE_FEATURES drops its paths (v74). */
  endpoints: string[];
  /** Null means every feature is enabled; otherwise the sorted enabled feature keys, with agent_chat always included. */
  features: string[] | null;
  /** Where the global data lives (core/data-dir.mjs): location is 'system' (LLMIDE_DATA_DIR, the Mac app's Application Support dir) or 'repo-kb' (the checkout's kb/); migration is the boot copy outcome (kb/data-dir-migration.mjs: migrated | skipped | fallback). No paths. */
  storage?: {
    /** system: LLMIDE_DATA_DIR; repo-kb: the checkout's kb/; custom: an explicit LLMIDE_DB_PATH */
    location: "system" | "repo-kb" | "custom";
    /** migrated | skipped | fallback */
    migration: string;
    /** true when the legacy <repo>/kb/data.db exists again after the move to the data dir (an older server recreated it, a fork) */
    legacyDiverged?: boolean;
    /** What the boot migration left in place (backups/, an agent-sdk/ over the cap). Strings carry no paths. */
    notes?: string[];
  };
  checks: {
    db: boolean;
    claude: boolean;
    /** present only while claude is false */
    claudeError?: string;
    skills: boolean;
    /** present only while skills is false */
    skillsError?: string;
  };
};

export type WellKnown = {
  issuer: string;
  registrationOpen: boolean;
  /** names of the secrets a user may store */
  vaultKeys: string[];
  accessTokenTTLSec: number;
};

/** Per-user UI preferences. A key the user never set is absent. */
export type Prefs = {
  language?: string;
  bilingual?: boolean;
  nativePlugins?: boolean;
};

export type Secret = {
  key: string;
  updatedAt: string;
};

export type OAuthStart = {
  authUrl: string;
  /** poll with the matching /status route */
  state: string;
};

export type GoogleStatus = {
  /** unknown: the state is expired or was never issued */
  status: "pending" | "complete" | "error" | "unknown";
  email?: string;
  message?: string;
};

export type SlackStatus = {
  /** unknown: the state is expired or was never issued */
  status: "pending" | "complete" | "error" | "unknown";
  teamName?: string;
  channels?: Record<string, unknown>[];
  message?: string;
};

/** One registered MCP server, with this user's consent and enable state. */
export type McpPlugin = {
  id: string;
  name: string;
  /** claude | codex | catalog | manual */
  source: string;
  /** stdio | http | sse */
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  /** values are redacted by the server; names are real */
  env?: Record<string, string>;
  /** values are redacted by the server */
  headers?: Record<string, string>;
  catalogId?: string;
  sourceName?: string;
  builtin: boolean;
  enabled: boolean;
  consented: boolean;
  /** the plugin declares a credential the vault has no value for */
  credentialMissing: boolean;
  /** enabled AND consented AND (for a plugin-declared server) its plugin enabled for this user */
  effective?: boolean;
  package?: {
    runner: string;
    name: string;
    version: string | null;
    tag?: string | null;
  };
};

export type McpAdded = {
  id: string;
  name: string;
  source: string;
  builtin: boolean;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  catalogId?: string;
};

export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  docsUrl: string;
  /** a trailing argument the server cannot work without */
  requiresArg?: {
    label: string;
    placeholder?: string;
  };
  /** the vault key a credential-bearing server reads; values never leave the server */
  credential?: {
    vaultKey?: string;
    target?: string;
    name?: string;
    label?: string;
    template?: string;
  };
  oauth?: boolean;
  /** already in this install's registry */
  registered: boolean;
};

/** A server scanned from the operator's ~/.claude.json (CLAUDE_CONFIG_PATH), read-only. */
export type ClaudeSource = {
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** values redacted to bullets */
  headers?: Record<string, string>;
};

/** A server scanned from the operator's ~/.codex/config.toml (CODEX_CONFIG_PATH), read-only. */
export type CodexSource = {
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
};

export type McpUpdate = {
  id: string;
  runner: string;
  name: string;
  current?: string;
  latest?: string;
  /** e.g. up-to-date */
  status: string;
  reason?: string;
};

export type ConnectorEntry = {
  id: string;
  name: string;
  description: string;
  /** SF Symbol name */
  icon: string;
  /** google-oauth | slack-oauth | box-ccg | miro-oauth */
  authKind: string;
  docsUrl: string;
  /** false while the connector's fetch pipeline does not exist yet */
  pipelineReady: boolean;
  /** set only on the catalog endpoint */
  selected?: boolean;
};

export type LlmSource = {
  id: string;
  name: string;
  /** builtin | git | local */
  origin: string;
  /** absolute path, or null if never resolved */
  location?: string | null;
  builtin: boolean;
  version?: string | null;
  /** git ref, git sources only */
  ref?: string;
  installed: boolean;
  skillCount: number;
  agentCount: number;
  commandCount: number;
  templateCount: number;
  hookCount: number;
  mcpCount: number;
  enabled: boolean;
  /** skills/agents/commands/templates this user unchecked inside the source */
  disabledItemCount: number;
  /** the last update's diff; present only after an update ran */
  lastUpdate?: {
    at: string;
    fromRev: string | null;
    toRev: string | null;
    /** kind:name keys added */
    added: string[];
    /** kind:name keys removed */
    removed: string[];
  } | null;
  /** kind:name keys of the source's items as of the last scan; written for local sources only */
  knownItems?: string[];
};

export type LlmSourceUpdate = {
  id: string;
  checkedAt?: string;
  /** up-to-date | update-available | local | error */
  status: string;
  localRev?: string | null;
  remoteRev?: string | null;
  message?: string;
};

export type DiscoveryItem = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  isNew: boolean;
};

export type DiscoveryHook = {
  event: string;
  matcher?: string;
  command: string;
};

export type Discovery = {
  skills: DiscoveryItem[];
  agents: DiscoveryItem[];
  commands: DiscoveryItem[];
  templates: DiscoveryItem[];
  hooks: DiscoveryHook[];
  mcpServers: Record<string, unknown>[];
};

/** Deliberately a bare {code} body, not the {error:{...}} envelope: on this route bare bodies are the update outcome protocol the Mac decodes (PluginUpdateOutcome.decode → .notFound), while an envelope means the route itself is missing (older server). Do not wrap it — PluginUpdatePresentationTests.updateOutcomeDecoding guards this. */
export type ClaudeUpdateNotFound = {
  code: string;
  detail?: string;
};

export type PluginRows = {
  plugins: Record<string, unknown>[];
};

export type Note = {
  /** Relative path under the project root, forward slashes. No leading slash, no .. segments. */
  noteKey: string;
  /** Optional; defaults to the batch projectId. */
  projectId?: string;
  /** meeting (default) is the Mac's meeting notes; the others let the Library index its other sources. Any other value is refused with 400. */
  kind?: "meeting" | "note" | "email" | "slack" | "document" | "repo" | "plan" | "other";
  title: string;
  /** Note start, ISO. */
  date: string;
  durationSec?: number;
  participants?: string[];
  /** The note body. Redacted and capped on write. */
  body?: string;
  /** SHA-256 of the Mac file bytes. */
  contentHash: string;
  mtimeMs?: number;
  /** true: counted in skippedHidden and not stored. */
  hidden?: boolean;
  meta?: Record<string, unknown>;
};

export type ManifestEntry = {
  noteKey: string;
  contentHash: string;
};

export type KbSourcesOk = {
  ok: true;
};

/** Entity with kind, title, body, metadata */
export type Entity = {
  id: string;
  meetingId: string;
  /** null when the parent meeting row is gone */
  meetingTitle: string | null;
  /** meeting date (YYYY-MM-DD as stored) */
  date: string | null;
  /** decision | action | blocker | ... */
  kind: string;
  text: string;
  quote: string | null;
  /** kind-specific metadata; open set (owner, due, ...) */
  meta: Record<string, unknown>;
};

export type MeetingEntity = {
  id: string;
  kind: string;
  text: string;
  quote: string | null;
  /** kind-specific metadata; open set */
  meta: Record<string, unknown>;
};

/** Meeting with entities, transcript, metadata */
export type Meeting = {
  id: string;
  title: string;
  date: string;
  durationSec: number;
  language: string | null;
  participants: string[];
  entities: MeetingEntity[];
  /** present only with ?include=transcript */
  transcript?: string;
};

export type SearchHit = {
  /** meeting | decision | action | blocker | code | ticket | qa | doc | plan | task | outcome */
  kind: string;
  meetingId: string | null;
  entityId: string | null;
  title: string;
  body: string;
  /** FTS5 bm25 rank (lower is a better match); set on full-text hits only, absent on the empty-query listing and the entity/outcome fallbacks */
  rank?: number;
  /** tickets: the source URL or id */
  ref?: string;
  /** tickets: provider, repo, state, number, labels, author, dates, isPR */
  meta?: Record<string, unknown>;
  /** meeting-linked hits */
  meetingTitle?: string;
  /** meeting date, or the index time for tickets */
  date?: string;
  /** meetings, empty-query listing only */
  durationSec?: number;
};

export type Issue = {
  id: string;
  title: string;
  body: string;
  /** empty when the ticket had no ref */
  url: string;
  provider: string;
  repo?: string;
  number?: number;
  state?: string;
  labels: string[];
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  isPR?: boolean;
};

export type ProjectExport = {
  projectId: string;
  /** ISO 8601 UTC */
  exportedAt: string;
  meetingCount: number;
  planCount: number;
  meetings: Record<string, unknown>[];
  plans: Record<string, unknown>[];
};

export type Reviews = {
  pending: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
  expired: number;
};

export type Stats = {
  meetings: number;
  entities: number;
  /** one count per indexed source kind; the open set includes code, ticket and qa and any kind added later */
  sources: {
    code: number;
    ticket: number;
    qa: number;
    /** last index time per kind, SQLite datetime (UTC) */
    lastIndexed: Record<string, string>;
    [key: string]: unknown;
  };
  plans: number;
  tasks: number;
  reviews: Reviews;
  outcomes: Outcomes;
};

export type SystemStatus = {
  stats: Stats;
  flow: {
    capture: {
      activeCount: number;
      sessions: Record<string, unknown>[];
    };
    agent: {
      activeCount: number;
      runs: Record<string, unknown>[];
    };
    review: {
      pendingCount: number;
      byStatus: Reviews;
      pendingItems: Record<string, unknown>[];
    };
    outcomes: Outcomes;
  };
};

export type IngestResult = {
  ok: true;
  meetingId: string;
  /** entities in the request, before the allowed-kind filter */
  entityCount: number;
};

export type GitIndex = {
  ok: true;
  repo: string;
  filesScanned: number;
  filesIndexed: number;
  filesWritten: number;
  unchanged: number;
  removed: number;
  chunks: number;
};

export type TicketIndex = {
  ok: true;
  count: number;
  chunks: number;
};

export type QaIndex = {
  ok: true;
  source: string;
  total: number;
  failed: number;
  chunks: number;
};

export type ActivityItem = {
  id: number;
  kind: string;
  title: string;
  /** kind-specific detail; open set */
  detail: Record<string, unknown> | null;
  link: string | null;
  /** SQLite datetime (UTC) */
  created_at: string;
};

export type Outcomes = {
  total: number;
  /** outcome count per state; open set, empty when no outcomes exist */
  byState: Record<string, unknown>;
};

export type WorkingChat = {
  /** The Mac chat UUID. */
  chatSessionId: string;
  /** The Agent SDK session the chat resumes, when one is mapped. */
  sdkSession: string | null;
  /** Session-memory facts kept for the chat. */
  factCount: number;
  /** ISO time the chat's SDK mapping was last used; null when only facts remain. */
  updatedAt: string | null;
};

export type ArchiveMessage = {
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  /** The message metadata the chat store kept, or null. */
  meta: Record<string, unknown> | null;
  /** Seconds since the epoch, as the chat store records it. */
  createdAt: number;
};

export type LiveCaption = {
  seq: number;
  speaker: string;
  text: string;
  ts: number;
  source: string;
  meta?: {
    planTaskId?: string;
    score?: number;
    reason?: string;
  };
};

export type LiveSession = {
  sessionId: string;
  meetingTitle: string;
  /** Unix ms timestamp when session was created */
  startedAt: number;
  /** Unix ms timestamp of last caption append */
  lastWrite: number;
  captionCount: number;
  /** Highest sequence number written so far */
  sequence: number;
};

export type RateLimited = {
  error: {
    code: "RATE_LIMITED";
    retryAfterSec: number;
  };
};

/** 404 body for a path owned by a feature the server was started without (LLMIDE_FEATURES). Deliberately not the Error envelope: a client can tell it from an unknown route without parsing a message. */
export type FeatureDisabled = {
  error: "feature_disabled";
  feature: string;
};

export type ScheduleItem = {
  provider: string;
  repo: string;
  issueNumber: number;
  startDate?: string | null;
  dueDate?: string | null;
  estimateDays?: number | null;
  dependsOn: number[];
  updatedAt: string;
};

export type LoopUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
};

export type CodeGraphNode = {
  /** Required by the server: a node without an id is dropped and counted in droppedNodes. */
  id?: string;
  title?: string;
  /** CGNodeKind raw value, e.g. file / function / classType */
  kind?: string;
  metadata?: {
    /** Repo-relative path; absolute or ..-bearing values are discarded */
    source_file?: string;
    /** Mac sends it as a string (CodeGraph metadata is [String:String]); the server normalises with String(). */
    line?: number | string;
    language?: string;
    doc?: string;
  };
};

export type CodeGraphEdge = {
  fromId?: string;
  toId?: string;
  /** CGEdgeKind raw value, e.g. imports / calls / contains */
  kind?: string;
  confidence?: string;
};

export type AuditItem = {
  id: number;
  action: string;
  resource: string | null;
  outcome: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
};

/** One prior chat turn. role is 'user' or 'assistant'; the server maps any other role to 'Assistant' in the /chat prompt. */
export type Turn = {
  role?: string;
  content?: string;
};

/** One selected source for /generate-doc. name is the display name (sanitized to one line, 80 chars); content is the source text, budgeted by packSources. */
export type NotesGenerationSource = {
  name?: string;
  content?: string;
};

/** One file attached to a Code Assistant turn. A content starting with '[binary:<media type>]' followed by a newline marks a binary file; an image media type is replaced by a one-line note on the legacy engine. */
export type Attachment = {
  path?: string;
  content?: string;
};

/** The Mac client's agent context. The server forwards only these keys (buildEnrichedAgentContext, extension/server/ai-routes.mjs); any other key is dropped. activeProject, indexedRepos entries and recentIssues entries are opaque to this route, so they are open objects. */
export type AgentContext = {
  sessionId?: string | null;
  chatSessionId?: string | null;
  /** The active project as the Mac sends it; opaque here and forwarded unchanged. */
  activeProject?: Record<string, unknown> | null;
  indexedRepos?: Record<string, unknown>[];
  recentIssues?: Record<string, unknown>[];
  workspaceRoot?: string | null;
  activeRepoRoot?: string | null;
  /** The active repo's branch, capped at 200 characters. */
  currentBranch?: string | null;
  /** Staged and unstaged file counts and the upstream position (the Mac's GitStatus). Rendered per turn as the Git state block. */
  gitStatus?: {
    staged?: number;
    unstaged?: number;
    ahead?: number;
    behind?: number;
    hasUpstream?: boolean;
  } | null;
};

/** A session task (llm_agent/tools/handlers/session-tasks.mjs). status is one of pending, in_progress, completed, skipped, failed; a model-written status is stored as given, so it is typed as a string. */
export type NotesGenerationTask = {
  id?: string;
  title?: string;
  status?: string;
  /** Epoch milliseconds (Date.now()). */
  createdAt?: number;
};

/** usage of the legacy (no agentContext) /code-assist reply, and the attachment accounting of every /code-assist reply. */
export type LegacyUsage = {
  attachmentCount?: number;
  attachmentChars?: number;
  paths?: string[];
  truncatedPaths?: string[];
};

/** usage of an agent-path /code-assist reply: LegacyUsage plus the memory block size (route.mjs memoryUsage) and, when every model call of the turn reported tokens, the summed turn tokens (kb/usage.mjs turnTokenUsageFields). The memory fields and the token fields are absent in some turns, so they are x-optional. */
export type AgentUsage = {
  attachmentCount?: number;
  attachmentChars?: number;
  paths?: string[];
  truncatedPaths?: string[];
  memoryChars?: number;
  memoryApproxTokens?: number;
  memoryHasChatMemory?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  modelCalls?: number;
};

export type EntityAction = {
  /** Sanitized to one line, 500 chars. */
  text: string;
  /** Sanitized to one line, 50 chars; null when unknown. */
  owner: string | null;
  /** YYYY-MM-DD, or null (the server checks the shape with a regex; the keyword is not supported here). */
  due: string | null;
  /** Verbatim phrase from the transcript, 200 chars. */
  quote: string;
};

export type EntityDecision = {
  text: string;
  participants: string[];
  quote: string;
};

export type EntityBlocker = {
  text: string;
  /** Any other model value is coerced to med. */
  severity: "low" | "med" | "high";
  quote: string;
};

export type NotesGenerationOk = {
  ok: true;
};

/** How to stop the item: method and path of the existing route, and the JSON body to send. null for an item with no cancel route (a live capture session). */
export type Cancel = {
  method?: "POST";
  path?: "/agent/v2/cancel" | "/kb/agent/stop";
  body?: {
    chatSessionId?: string;
    sessionId?: string;
  };
} | null;

export type KitStatus = {
  id: string;
  /** The LLMIDE_FEATURES keys this kit depends on; empty = always on. */
  requires: string[];
  enabled: boolean;
};

export type UsageCounts = {
  calls: number;
  runs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  billable: number;
};

/** One data group of the Storage hub. agent_history carries bytes (approximate) and the clear/compact actions; the main-DB groups carry rows per user and no bytes (SQLite sizes whole files, not users). */
export type OsStorageGroup = {
  key: "agent_history" | "search_index" | "code_graph" | "sources" | "meetings";
  label: string;
  /** Rows for this user. agent_history: runs, tool events and composition rows (the rows Clear can delete; the activity feed is not counted). search_index: indexed chunks. code_graph: repos. sources: distinct source kinds. meetings: meetings. */
  rows: number;
  /** Approximate bytes for agent_history; null for the main-DB groups. */
  bytes: number | null;
  bytesApprox: boolean | null;
  /** ISO time of the last clear (agent_history only). */
  lastCleanedAt: string | null;
  /** Raw-row retention (agent_history only). */
  retentionDays: number | null;
  /** Actions the page may offer. Only agent_history has any. */
  actions: ("clear" | "compact")[];
};

/** Null when the agent store is down. */
export type OsAgentHistorySummary = {
  /** Oldest raw day (YYYY-MM-DD, local). */
  rawFromDay: string | null;
  rawRows: number;
  rolledDays: number;
  /** Oldest rolled-up day. */
  oldestDay: string | null;
  /** When the store was reset after damage, if it was. */
  quarantinedAt: string | null;
  /** Rows dropped by the write queue (bounded queue or failed batch), counted since the store was created. */
  droppedRows: number;
  /** The last day folded into the daily rollups. */
  watermark: string | null;
} | null;

/** The storage report (same as GET /kb/storage). null when the store could not be read; the rest of the OS state is unaffected. */
export type OsStorageReport = {
  generatedAt: string;
  groups: OsStorageGroup[];
  agentHistory: OsAgentHistorySummary;
  agentStore: {
    health: "ok" | "degraded" | "down";
    state: "closed" | "ok" | "down";
  };
  /** Counts from the last shadow comparisons (usage ledger vs agent.db, note index vs legacy search). No query text, no row content. Absent when the store could not be read. */
  shadow?: {
    /** The last usage ledger compare; null when none has run. */
    usage: {
      state: "ok" | "mismatch";
      at: string;
      scope: "all" | "user";
      mismatches: number;
      windows: Record<string, {
          ledgerRows: number;
          shadowRows: number;
          mismatchedKeys: number;
        }>;
    } | null;
    /** The last note-index compare; null when none has run. */
    noteIndex: {
      state: "ok" | "not-evaluated" | "stale" | "mismatch";
      at: string;
      pairs: number;
      stalePairs: number;
      scoredQueries: number;
      meanOverlap: number;
      mismatchedQueries: number;
      mismatchedPairs: number;
    } | null;
  };
} | null;

/** One agent run for the System view. No prompt, message or error text: codes only. */
export type OsAgentRun = {
  id: string;
  source: "chat" | "loop" | "meeting" | "autotask" | "dispatch" | "review";
  engine: string | null;
  status: "running" | "ok" | "error" | "cancelled" | "aborted";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Input plus output tokens of the run. */
  tokens: number;
  toolCalls: number;
  model: string | null;
  errorCode: string | null;
};

/** One data: payload on GET /kb/os/stream (os-kit OS-2). Events carry only the type and the time, never data: they tell the System view when to re-fetch GET /kb/os/state. The stream opens with one hello event. The SSE event: line equals type. Every variant sets additionalProperties:false, so a field added server-side must be added here in the same edit. */
export type OsEventsEvent = {
  type: "hello";
  /** ISO 8601 time the stream opened. */
  at: string;
} | {
  type: "activity";
  /** ISO 8601 time the change was published to the stream. */
  at: string;
} | {
  type: "usage";
  /** ISO 8601 time the change was published to the stream. */
  at: string;
} | {
  type: "turn-start";
  /** ISO 8601 time the change was published to the stream. */
  at: string;
} | {
  type: "turn-end";
  /** ISO 8601 time the change was published to the stream. */
  at: string;
} | {
  type: "agent-run";
  /** ISO 8601 time the change was published to the stream. */
  at: string;
} | {
  type: "live-session";
  /** ISO 8601 time the change was published to the stream. */
  at: string;
};

/** A plan task. Stored tasks (getPlan, getTaskById) carry every field; a draft task returned by analyze-risks or code-sync carries the fields the client sent, plus risk and files/symbols. */
export type PlanningTask = {
  id: string;
  planId?: string;
  position?: number;
  milestone?: string | null;
  title: string;
  description?: string | null;
  owner?: string | null;
  due?: string | null;
  estimateDays?: number | null;
  dependsOn?: string[];
  status: string;
  risk?: string | null;
  riskReason?: string | null;
  files?: {
    ref?: string;
    title?: string;
    bodyExcerpt?: string;
    rank?: number;
  }[];
  symbols?: {
    symbol_id?: string;
    title?: string;
    kind?: string;
    repo_id?: string;
    source_file?: string;
    line?: number;
  }[];
  /** Free-form task meta (dispatched, dispatchRetry, outcome, code, snapshots). */
  meta?: Record<string, unknown>;
};

export type CodeFile = {
  path: string;
  kind: "create" | "modify";
  language?: string;
  content: string;
};

/** A stored plan task, as getPlan and getTaskById return it: every column, always present (null when unset). Status is one of ALLOWED_TASK_STATUS (kb/plans.mjs); risk is low|med|high or null. Drafts from analyze-risks and code-sync use the looser Task def. */
export type PlanTask = {
  id: string;
  planId: string;
  position: number;
  milestone?: string | null;
  title: string;
  description?: string | null;
  owner?: string | null;
  due?: string | null;
  estimateDays?: number | null;
  dependsOn: string[];
  status: "planned" | "in_progress" | "done" | "blocked" | "cancelled";
  risk: "low" | "med" | "high" | null;
  riskReason?: string | null;
  files: {
    ref?: string;
    title?: string;
    bodyExcerpt?: string;
    rank?: number;
  }[];
  symbols: {
    symbol_id?: string;
    title?: string;
    kind?: string;
    repo_id?: string;
    source_file?: string;
    line?: number;
  }[];
  /** Free-form task meta (dispatched, dispatchRetry, outcome, code, snapshots), or null. */
  meta?: Record<string, unknown> | null;
};

export type Connection = {
  /** cat-<catalog id>[-<slug>]; also the vault key stem */
  id: string;
  /** The provider id dispatch uses: custom:<id> */
  provider: string;
  catalogId: string;
  name: string;
  baseURL: string;
  /** Loopback and private-network hosts are allowed (Ollama, a gateway on the user's own network); link-local never is */
  allowPrivate: boolean;
  enabled: boolean;
  /** A key is stored. The key itself is never returned */
  hasKey: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  /** Empty for the generic endpoint, which takes the user's own */
  baseURL: string;
  keyRequired: boolean;
  local: boolean;
  customBaseURL: boolean;
  /** The entry may be connected to a private-network address (with the user's explicit opt-in unless local) */
  allowPrivate: boolean;
  docsUrl: string;
  notes: string;
  connections: Connection[];
};

export type FallbackEntry = {
  /** custom:cat-... of the caller's own connection */
  provider: string;
  /** Absent: the first tool-capable catalog model */
  model?: string;
};

export type Settings = {
  /** Tool-capable chat on non-Anthropic models; default false */
  toolsEnabled: boolean;
  /** Cross-provider fallback at the start of a turn; default false */
  fallbackEnabled: boolean;
  fallbackOrder: FallbackEntry[];
  /** '<connection id>/<model id>' to the user's own tools yes/no */
  toolOverrides: Record<string, boolean>;
  /** false (default): fetch-url and web-search ask for approval in a provider turn, because a hostile page can steer a model into leaking through them; true restores Claude parity */
  egressAutoApprove: boolean;
};

export type SettingsPatch = {
  toolsEnabled?: boolean;
  fallbackEnabled?: boolean;
  fallbackOrder?: FallbackEntry[];
  toolOverrides?: Record<string, boolean>;
  egressAutoApprove?: boolean;
};

export type ModelCapability = {
  id: string;
  toolsSupported: boolean;
  /** Where the flag came from; pattern = the id matches a family third-party guides say supports tools, unverified against the vendor's docs (shown as "tools (assumed)"); unknown counts as not supported */
  toolsSource: "catalog" | "provider" | "inferred" | "pattern" | "override" | "unknown";
  streaming: boolean;
  contextWindow: number | null;
};

export type ConnectionId = {
  /** A connection id (cat-...) or its provider string (custom:cat-...) */
  id?: string;
};

export type ModelLimit = {
  provider: string;
  model: string;
  label: string;
  priority: number;
  enabled: boolean;
  limit_value: number;
  unit: "runs" | "tokens";
  window_kind: "daily" | "monthly";
  threshold_pct: number;
  custom: boolean;
};

/** The resolver verdict (kb/usage.mjs resolveModel). used, limit, pct and unit are present only when a model was picked (ok or degraded); a paused or unconfigured verdict has no pick. */
export type Resolution = {
  provider: string;
  /** null when paused or unconfigured */
  model: string | null;
  status: "ok" | "degraded" | "paused" | "unconfigured";
  /** ISO-8601 window reset; null when there is no chain */
  resetAt: string | null;
  reason: string;
  used?: number;
  limit?: number;
  pct?: number;
  unit?: string;
  engaged: boolean;
};

export type ModelStat = {
  model: string;
  label: string;
  enabled: boolean;
  custom: boolean;
  priority: number;
  unit: string;
  window_kind: string;
  limit: number;
  threshold_pct: number;
  used: number;
  pct: number | null;
  state: "ok" | "warning" | "exhausted";
  quota: boolean;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    totalInput: number;
    cacheHitPct: number | null;
    unknownRows: number;
  };
  resetAt: string;
};

export type TokenBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  totalInput: number;
  cacheHitPct: number | null;
  unknownRows: number;
};

export type RouteRef = {
  /** anthropic | openai | google | deepseek | jev | custom:<id> */
  provider: string;
  model: string;
};

/** One guardrail finding (extension/guardrails/rules.mjs check()). severity is blocking (fails the gate), warning (shown, does not fail) or info. details, when present, carries the matched snippets of a secret or PII finding; snippets are redacted before they are stored. */
export type ReviewFinding = {
  ruleId: string;
  severity: "blocking" | "warning" | "info";
  message: string;
  details?: Record<string, unknown>[];
};

/** The guardrail report runGuardrails returns for the item, as stored at submit and re-run at approval time. passed is false when any finding has severity blocking. findings is the full list; the server also sends blocking, warnings and info, which are the same findings partitioned by severity (open keys, so not declared here). */
export type Guardrails = {
  passed: boolean;
  findings: ReviewFinding[];
  [key: string]: unknown;
};

/** The kind-specific payload, open because its shape depends on kind. Submit keeps only the keys listed for the kind (kb/review-payload.mjs REVIEW_PAYLOAD_KEYS) and removes credential-looking keys (token, apiKey, secret, password, credential, auth, bearer, authorization) at every depth; every review response returns the payload scrubbed the same way. dispatch: target (github, backlog or linear; preview never reaches review), planId, taskIds, config (tracker credentials and settings: repo, space, projectId, issueTypeId, teamId; credential keys are stripped), and items, which the server replaces with the plan's tasks at submit and approve (title, body). codegen-apply: repoPath, taskId, summary, files and tests (each {path, content}), pr (ghRepo, baseBranch; credential keys are stripped), and allowedRepos, which the server sets from the user's allow-list at submit and approve. The server never trusts a client-sent allowedRepos or items. */
export type Payload = Record<string, unknown>;

/** A review item as the GET, submit, approve and reject routes send it (redactReviewItem: the payload has no credentials). result is {} while the item is undecided, the apply result after codegen-apply (baseDir, files, count), or {error} after a failed execution. decidedAt is null until the item is decided. */
export type ReviewItem = {
  id: string;
  kind: "dispatch" | "codegen-apply";
  planId?: string | null;
  taskId?: string | null;
  title: string;
  payload: Payload;
  guardrails: Guardrails;
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  reviewerNote?: string | null;
  result?: Record<string, unknown>;
  createdAt: string;
  decidedAt?: string | null;
};

/** One row of the list route: the item without payload, guardrails or result (kb.listReviews). */
export type ReviewSummary = {
  id: string;
  kind: "dispatch" | "codegen-apply";
  planId?: string | null;
  taskId?: string | null;
  title: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  createdAt: string;
  decidedAt?: string | null;
};

/** The 422 body of approve. CREDENTIAL_REQUIRED: the only blocking finding is dispatch.creds; the item stays pending and nothing is sent. GUARDRAILS_FAILED: the guardrails fail at approval time; the item is auto-rejected (item.status is rejected, with the reviewer note 'Auto-rejected: guardrails fail at approval time.'). */
export type GuardrailRejection = {
  error: {
    code: "CREDENTIAL_REQUIRED" | "GUARDRAILS_FAILED";
    message: string;
  };
  guardrails: Guardrails;
  item: ReviewItem;
};

/** The 500 body of approve when execution throws. The item is already marked failed, and result.error holds the message. */
export type ExecutionFailure = {
  error: {
    code: "REVIEW_EXECUTION_FAILED";
    message: string;
  };
  item: ReviewItem;
};

export type ReviewOk = {
  ok: true;
};

/** Request parts for `GET /kb/storage` (schema/http/agent-history.schema.json). */
export type GetKbStorageRequest = Record<string, never>;

export type GetKbStorageResponse200 = AgentHistoryStorageReport;

/** Request parts for `GET /kb/agent-history/settings` (schema/http/agent-history.schema.json). */
export type GetKbAgentHistorySettingsRequest = Record<string, never>;

export type GetKbAgentHistorySettingsResponse200 = {
  /** Raw-row retention in days, clamped to min..max. */
  retentionDays: number;
  /** Daily rollups are kept this long. */
  rollupKeepDays: number;
  min: number;
  max: number;
};

/** Request parts for `PUT /kb/agent-history/settings` (schema/http/agent-history.schema.json). */
export type PutKbAgentHistorySettingsRequest = {
  body: {
    /** A whole number of days, clamped to 7..365. Any other value is a 400 VALIDATION_FAILED. */
    retentionDays: unknown;
  };
};

export type PutKbAgentHistorySettingsResponse200 = {
  /** Raw-row retention in days, clamped to min..max. */
  retentionDays: number;
  /** Daily rollups are kept this long. */
  rollupKeepDays: number;
  min: number;
  max: number;
};

export type PutKbAgentHistorySettingsResponse400 = CommonError;

export type PutKbAgentHistorySettingsResponse503 = unknown;

/** Request parts for `POST /kb/agent-history/clear` (schema/http/agent-history.schema.json). */
export type PostKbAgentHistoryClearRequest = {
  body: {
    scope: "raw" | "all";
    /** Only rows older than this many days; omit for all. */
    beforeDays?: number | null;
    /** Default true: a dry run. false performs the clear and needs previewId. */
    dryRun?: boolean;
    /** From a dry run of the same scope and cutoff. */
    previewId?: string;
  };
};

export type PostKbAgentHistoryClearResponse200 = {
  dryRun: true;
  scope: "raw" | "all";
  beforeDays: number | null;
  wouldDelete: {
    agent_runs: number;
    agent_tool_events: number;
    turn_composition: number;
    agent_daily: number;
    agent_daily_tools: number;
  };
  total: number;
  /** Signed by the server; valid five minutes for this user, scope and cutoff. */
  previewId: string;
  expiresAt: string;
} | {
  dryRun: false;
  scope: "raw" | "all";
  beforeDays: number | null;
  deleted: {
    agent_runs: number;
    agent_tool_events: number;
    turn_composition: number;
    agent_daily: number;
    agent_daily_tools: number;
  };
  total: number;
};

export type PostKbAgentHistoryClearResponse400 = CommonError;

export type PostKbAgentHistoryClearResponse409 = CommonError;

export type PostKbAgentHistoryClearResponse503 = unknown;

/** Request parts for `POST /kb/agent-history/compact` (schema/http/agent-history.schema.json). */
export type PostKbAgentHistoryCompactRequest = Record<string, never>;

export type PostKbAgentHistoryCompactResponse200 = {
  ok: true;
  mode: "incremental" | "full";
  pagesFreed: number;
  bytesBefore: number;
  bytesAfter: number;
  ms: number;
};

export type PostKbAgentHistoryCompactResponse409 = CommonError;

export type PostKbAgentHistoryCompactResponse503 = unknown;

export type PostKbAgentHistoryCompactResponse507 = unknown;

/** Request parts for `POST /agent/v2/stream` (schema/http/agent.schema.json). */
export type PostAgentV2StreamRequest = {
  body: {
    /** User message. Fence sentinels are neutralised, then capped at 120 000 chars; the message and attachments share one 150 000-char turn budget, message first. An over-cap message is truncated and the model is told so in-band, not rejected. */
    message: string;
    agentContext: {
      /** Mac chat session id — the mapping key */
      chatSessionId: string;
      /** Workspace the engine roots its reads in */
      workspaceRoot: string;
    };
    /** Chat mode; plan/assist_plan map to SDK plan permission mode; ask = read-only quick chat (menu bar / sheet / phone): no file edits, no shell, no git actions */
    mode?: string;
    language?: string;
    /** Model id from the picker, passed to the SDK verbatim (an Anthropic id, or the custom provider's own id on a gateway turn); omitted = config default */
    model?: string;
    /** Provider the turn runs on (server v43+): `anthropic` (default when omitted) or an Anthropic-compatible custom provider `custom:<uuid>` registered with an `anthropicBaseURL`. The engine points the Agent SDK at that endpoint with the provider's own key and meters the turn under this id. Any other value fails before the SDK spawns with a terminal error event coded `PROVIDER_NOT_AGENT_CAPABLE` (no Anthropic-compatible endpoint) or `PROVIDER_UNAVAILABLE` (unregistered / disabled / no key). */
    provider?: string;
    effort?: string;
    /** Invoked skill ids (max 5); bodies are prompt-injected */
    skills?: string[];
    /** Set only by the Mac saved-plan card's "Execute plan" action: this Execute turn is working an already-approved plan, so the server injects the plan-execution skill (subagent-driven-development when the user has subagents, executing-plans otherwise). Omitted on every other request. */
    planExecute?: boolean;
    planWrite?: boolean;
    /** Claude Code's modes. `ask` (default; `manual` is its old spelling): prompt-tier calls park an approval unless a saved project rule covers them. `accept-edits`: in-workspace Edit/Write run unasked, shell still asks. `bypass`: nothing that would park asks. No mode lifts the blocklist or write containment. */
    permissionMode?: string;
    /** File attachments (max 30 files, 80 000 chars each, 200 000 total) */
    attachments?: Record<string, unknown>[];
    /** Skip the recorded SDK session id and start a new one */
    fresh?: boolean;
    /** read only when fresh is true */
    history?: Record<string, unknown>[];
    /** The client's own copy of the chat's route (session router, K1 P6b): the server re-creates a missing route row from it before the cap check. It can only restore or raise, never lower an existing row. Ignored with the router off. */
    routeSeed?: {
      tokenLimit?: number;
      tokensUsed?: number;
      provider?: string;
      model?: string;
    };
  };
};

export type PostAgentV2StreamResponse200 = ReadonlyArray<AgentV2Event>;

export type PostAgentV2StreamResponse400 = CommonError;

export type PostAgentV2StreamResponse402 = CommonError;

export type PostAgentV2StreamResponse409 = CommonError;

export type PostAgentV2StreamResponse503 = CommonError;

/** Request parts for `POST /agent/v2/decision` (schema/http/agent.schema.json). */
export type PostAgentV2DecisionRequest = {
  body: {
    /** Id from the approval_request event */
    requestId: string;
    sdkSessionId: string;
    /** allow, deny or answer; may be omitted when answers is sent (the server then answers) */
    action?: string;
    /** question to answer (AskUserQuestion approval): question text to chosen answer */
    answers?: Record<string, string>;
    /** With `deny`: the user's instruction, handed to the model as the denial reason (max 2000 chars) */
    feedback?: string;
  };
};

export type PostAgentV2DecisionResponse200 = AgentOk;

export type PostAgentV2DecisionResponse404 = CommonError;

/** Request parts for `DELETE /agent/v2/session` (schema/http/agent.schema.json). */
export type DeleteAgentV2SessionRequest = {
  body: {
    chatSessionId?: string;
  };
};

export type DeleteAgentV2SessionResponse200 = {
  ok: true;
  /** the SDK session the chat was bound to, or null when it had none */
  sdkSessionId: string | null;
};

export type DeleteAgentV2SessionResponse400 = CommonError;

/** Request parts for `POST /agent/v2/cancel` (schema/http/agent.schema.json). */
export type PostAgentV2CancelRequest = {
  body: {
    chatSessionId?: string;
  };
};

export type PostAgentV2CancelResponse200 = {
  /** false when no turn was in flight for the chat */
  cancelled: boolean;
};

export type PostAgentV2CancelResponse400 = CommonError;

/** Request parts for `GET /agent/v2/turns` (schema/http/agent.schema.json). */
export type GetAgentV2TurnsRequest = Record<string, never>;

export type GetAgentV2TurnsResponse200 = {
  /** The caller's running turns, oldest first. Another user's turns are never listed. */
  turns: ({
    /** The chatSessionId the turn runs on */
    sessionId: string;
    /** ISO 8601 */
    startedAt: string;
    /** The turn's resolved mode */
    mode: string | null;
  })[];
};

/** Request parts for `GET /agent/v2/turns/stream` (schema/http/agent.schema.json). */
export type GetAgentV2TurnsStreamRequest = {
  query: {
    /** The chat session of the running turn (max 200 characters) */
    sessionId: string;
    /** Count of events already received (integer >= 0, default 0). Replay resumes after the after-th event. */
    after?: string;
  };
};

/** text/event-stream. One frame per event: `id: <seq>` then `data: <json>`; the data are the same events as POST /agent/v2/stream (schema/agent-v2), plus `replay_info` {gap, dropped, ended} first when the bounded ring dropped events the reader asked for, and `replay_truncated` {originalType} in place of an event larger than 256 KB. The stream ends when the turn ends. A turn that ended less than 60 seconds ago replays and closes. Memory only: nothing is stored on disk. */
export type GetAgentV2TurnsStreamResponse200 = string;

export type GetAgentV2TurnsStreamResponse400 = CommonError;

export type GetAgentV2TurnsStreamResponse404 = CommonError;

export type GetAgentV2TurnsStreamResponse429 = CommonError;

/** Request parts for `POST /kb/agent/dispatch` (schema/http/agent.schema.json). */
export type PostKbAgentDispatchRequest = {
  body: {
    sessionId?: string;
    planId?: string | null;
    persona?: string | null;
    language?: string | null;
    meetingUrl?: string | null;
  };
};

export type PostKbAgentDispatchResponse200 = {
  sessionId: string;
  planId: string | null;
  /** false when the session already had a loop attached */
  attached: boolean;
  /** set only when attached is false: already-attached */
  reason?: string;
};

/** Request parts for `POST /kb/agent/stop` (schema/http/agent.schema.json). */
export type PostKbAgentStopRequest = {
  body: {
    sessionId?: string;
  };
};

export type PostKbAgentStopResponse200 = {
  stopped: boolean;
  /** set only when stopped is false: unknown-session or forbidden */
  reason?: string;
};

export type PostKbAgentStopResponse400 = CommonError;

/** Request parts for `GET /kb/agent/runs` (schema/http/agent.schema.json). */
export type GetKbAgentRunsRequest = Record<string, never>;

export type GetKbAgentRunsResponse200 = {
  runs: ({
    sessionId: string;
    planId: string | null;
    /** epoch milliseconds */
    startedAt: number;
    lastTickAt: number | null;
    /** the loop's last candidate decision (agents/meeting-agent.mjs recordDecision); null until the loop has judged one */
    lastDecision: {
      reason: string;
      score: number | null;
      asked: boolean;
    } | null;
  })[];
};

/** Request parts for `POST /kb/agent/feedback` (schema/http/agent.schema.json). */
export type PostKbAgentFeedbackRequest = {
  body: {
    sessionId?: string;
    captionSeq?: number;
    /** useful, noise or later */
    verdict?: string;
    planTaskId?: string;
    score?: number;
  };
};

export type PostKbAgentFeedbackResponse200 = AgentOk;

export type PostKbAgentFeedbackResponse400 = CommonError;

/** Request parts for `GET /kb/agent/feedback/stats` (schema/http/agent.schema.json). */
export type GetKbAgentFeedbackStatsRequest = {
  query: {
    /** The window in days; the default is 30. */
    sinceDays?: string;
  };
};

export type GetKbAgentFeedbackStatsResponse200 = {
  total: number;
  byVerdict: VerdictCounts;
  usefulRate: number | null;
  /** mean score per verdict, keyed by verdict */
  avgScore: Record<string, number | null>;
  sinceDays: number;
};

/** Request parts for `GET /kb/agent/feedback/by-task` (schema/http/agent.schema.json). */
export type GetKbAgentFeedbackByTaskRequest = {
  query: {
    /** The window in days; the default is 30. */
    sinceDays?: string;
  };
};

export type GetKbAgentFeedbackByTaskResponse200 = {
  tasks: TaskFeedback[];
};

/** Request parts for `GET /kb/agent/persona` (schema/http/agent.schema.json). */
export type GetKbAgentPersonaRequest = Record<string, never>;

export type GetKbAgentPersonaResponse200 = {
  /** the stored persona, or null when none is set */
  persona: {
    name?: string | null;
    promptSuffix?: string | null;
    autoDispatch?: boolean;
  } | null;
};

/** Request parts for `PUT /kb/agent/persona` (schema/http/agent.schema.json). */
export type PutKbAgentPersonaRequest = {
  body: {
    name?: string;
    promptSuffix?: string;
    autoDispatch?: boolean;
  };
};

export type PutKbAgentPersonaResponse200 = {
  persona: LegacyPersona;
};

/** Request parts for `GET /kb/agent/personas` (schema/http/agent.schema.json). */
export type GetKbAgentPersonasRequest = Record<string, never>;

export type GetKbAgentPersonasResponse200 = PersonaList;

/** Request parts for `POST /kb/agent/personas` (schema/http/agent.schema.json). */
export type PostKbAgentPersonasRequest = {
  body: {
    name?: string;
    promptSuffix?: string;
    autoDispatch?: boolean;
  };
};

export type PostKbAgentPersonasResponse200 = {
  persona: Persona;
  personas: Persona[];
  active: string | null;
  count: number;
};

/** Request parts for `PUT /kb/agent/personas/active` (schema/http/agent.schema.json). */
export type PutKbAgentPersonasActiveRequest = {
  body: {
    id?: string;
  };
};

export type PutKbAgentPersonasActiveResponse200 = PersonaList;

export type PutKbAgentPersonasActiveResponse404 = CommonError;

/** Request parts for `PUT /kb/agent/personas/:id` (schema/http/agent.schema.json). */
export type PutKbAgentPersonasIdRequest = {
  params: {
    id: string;
  };
  body: {
    name?: string;
    promptSuffix?: string;
    autoDispatch?: boolean;
  };
};

export type PutKbAgentPersonasIdResponse200 = {
  persona: Persona;
};

export type PutKbAgentPersonasIdResponse404 = CommonError;

/** Request parts for `DELETE /kb/agent/personas/:id` (schema/http/agent.schema.json). */
export type DeleteKbAgentPersonasIdRequest = {
  params: {
    id: string;
  };
};

export type DeleteKbAgentPersonasIdResponse200 = {
  removed: boolean;
  active: string | null;
};

export type DeleteKbAgentPersonasIdResponse400 = CommonError;

/** Request parts for `GET /kb/agent/catalog` (schema/http/agent.schema.json). */
export type GetKbAgentCatalogRequest = Record<string, never>;

export type GetKbAgentCatalogResponse200 = {
  skills: {
    global: SkillEntry[];
    internal: SkillEntry[];
    plugins: {
      pluginName: string;
      pluginDisplayName: string;
      skills: SkillEntry[];
    }[];
  };
  subagents: {
    plugins: Record<string, unknown>[];
  };
};

/** Request parts for `GET /kb/agent/commands` (schema/http/agent.schema.json). */
export type GetKbAgentCommandsRequest = Record<string, never>;

export type GetKbAgentCommandsResponse200 = unknown;

/** Request parts for `GET /kb/agent/generation-library` (schema/http/agent.schema.json). */
export type GetKbAgentGenerationLibraryRequest = Record<string, never>;

export type GetKbAgentGenerationLibraryResponse200 = {
  /** Built-in skills repo path */
  repo: string | null;
  templates: LibraryEntry[];
  commands: LibraryEntry[];
};

/** Request parts for `GET /kb/agent/skill-library` (schema/http/agent.schema.json). */
export type GetKbAgentSkillLibraryRequest = Record<string, never>;

export type GetKbAgentSkillLibraryResponse200 = {
  /** Central skills repo path */
  repo: string | null;
  skills: SkillLibraryEntry[];
};

/** Request parts for `GET /kb/agent/project-memory` (schema/http/agent.schema.json). */
export type GetKbAgentProjectMemoryRequest = {
  query: {
    /** an indexed repo path; resolved against the allow-list */
    repo?: string;
    /** the open workspace folder */
    workspaceRoot?: string;
  };
};

export type GetKbAgentProjectMemoryResponse200 = {
  facts: string[];
  /** the resolved absolute root, or null when no candidate is allow-listed */
  repo: string | null;
};

/** Request parts for `DELETE /kb/agent/project-memory` (schema/http/agent.schema.json). */
export type DeleteKbAgentProjectMemoryRequest = {
  body: {
    /** Absolute root from the GET above */
    repo: string;
    workspaceRoot?: string;
    /** one fact to remove, by its identity */
    fact?: string;
    /** true clears every fact of the repo */
    all?: boolean;
  };
};

export type DeleteKbAgentProjectMemoryResponse200 = {
  facts: string[];
};

export type DeleteKbAgentProjectMemoryResponse404 = CommonError;

/** Request parts for `GET /kb/agent/tool-approvals` (schema/http/agent.schema.json). */
export type GetKbAgentToolApprovalsRequest = Record<string, never>;

export type GetKbAgentToolApprovalsResponse200 = ToolApprovalListing;

/** Request parts for `DELETE /kb/agent/tool-approvals` (schema/http/agent.schema.json). */
export type DeleteKbAgentToolApprovalsRequest = {
  body: {
    /** with toolName and pattern: one project rule */
    projectRoot?: string;
    /** alone: one legacy global grant */
    toolName?: string;
    pattern?: string;
    /** Revoke every rule and legacy grant */
    all?: boolean;
  };
};

export type DeleteKbAgentToolApprovalsResponse200 = {
  rules: ToolRule[];
  approvals: ApprovalGrant[];
  removed: number;
};

export type DeleteKbAgentToolApprovalsResponse400 = CommonError;

/** Request parts for `GET /kb/agent/session-memory` (schema/http/agent.schema.json). */
export type GetKbAgentSessionMemoryRequest = {
  query: {
    /** the chat's id; a blank value answers 400 */
    sessionId: string;
  };
};

export type GetKbAgentSessionMemoryResponse200 = {
  facts: string[];
};

export type GetKbAgentSessionMemoryResponse400 = CommonError;

/** Request parts for `DELETE /kb/agent/session-memory` (schema/http/agent.schema.json). */
export type DeleteKbAgentSessionMemoryRequest = {
  body: {
    /** Chat session UUID (AgentContext.chatSessionId) */
    sessionId: string;
  };
};

export type DeleteKbAgentSessionMemoryResponse200 = {
  removed: number;
};

export type DeleteKbAgentSessionMemoryResponse400 = CommonError;

/** Request parts for `POST /kb/agent/ask` (schema/http/agent.schema.json). */
export type PostKbAgentAskRequest = {
  body: {
    /** User message (max 8 000 chars after sanitization) */
    message?: string;
    /** one base64 image, capped per image; not exercised offline */
    image?: Record<string, unknown>;
    /** the prior turns of this chat; only the last 10 are sent to the model */
    history?: {
      /** user or assistant */
      role: string;
      content: string;
    }[];
    provider?: string;
    model?: string;
  };
};

export type PostKbAgentAskResponse200 = {
  reply: string;
};

export type PostKbAgentAskResponse400 = CommonError;

/** Request parts for `GET /kb/agent/ask/history` (schema/http/agent.schema.json). */
export type GetKbAgentAskHistoryRequest = {
  query: {
    /** Returns the newest N messages, oldest first; the default is 50, and reads are capped at 500. */
    limit?: string;
  };
};

export type GetKbAgentAskHistoryResponse200 = {
  messages: AskMessage[];
};

/** Request parts for `DELETE /kb/agent/ask/history` (schema/http/agent.schema.json). */
export type DeleteKbAgentAskHistoryRequest = Record<string, never>;

export type DeleteKbAgentAskHistoryResponse200 = {
  removed: number;
};

/** Request parts for `GET /kb/chat/sessions` (schema/http/agent.schema.json). */
export type GetKbChatSessionsRequest = {
  query: {
    /** mac, extension or any */
    surface?: string;
    /** ask, agent or transcript */
    mode?: string;
    /** The default is 50, with a minimum of 1 and a cap of 200. */
    limit?: string;
    /** Skip this many rows (newest first, ties by id): page through every chat with limit. */
    offset?: string;
  };
};

export type GetKbChatSessionsResponse200 = {
  sessions: ChatSession[];
};

/** Request parts for `POST /kb/chat/sessions` (schema/http/agent.schema.json). */
export type PostKbChatSessionsRequest = {
  body: {
    title?: string;
    /** mac, extension or any; default any */
    surface?: string;
    /** ask, agent or transcript; default ask */
    mode?: string;
    /** the server also accepts project_id */
    projectId?: string;
  };
};

export type PostKbChatSessionsResponse201 = {
  session: ChatSession;
};

/** Request parts for `GET /kb/chat/sessions/:id` (schema/http/agent.schema.json). */
export type GetKbChatSessionsIdRequest = {
  query: {
    /** Maximum messages returned; the default is 200, with a minimum of 1 and a cap of 2000. */
    limit?: string;
    /** Page older history: only messages with seq below this (integer >= 1) are considered and the newest `limit` of those return. Absent: the newest page, as before. */
    beforeSeq?: string;
  };
  params: {
    id: string;
  };
};

export type GetKbChatSessionsIdResponse200 = {
  session: {
    id: string;
    title: string;
    surface: string;
    mode: string;
    projectId: string | null;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
    /** true when messages older than the first returned one remain; page again with beforeSeq set to that message's seq. */
    hasMore: boolean;
  };
};

export type GetKbChatSessionsIdResponse400 = CommonError;

export type GetKbChatSessionsIdResponse404 = CommonError;

/** Request parts for `PATCH /kb/chat/sessions/:id` (schema/http/agent.schema.json). */
export type PatchKbChatSessionsIdRequest = {
  params: {
    id: string;
  };
  body: {
    title?: string;
  };
};

export type PatchKbChatSessionsIdResponse200 = AgentOk;

export type PatchKbChatSessionsIdResponse400 = CommonError;

export type PatchKbChatSessionsIdResponse404 = CommonError;

/** Request parts for `DELETE /kb/chat/sessions/:id` (schema/http/agent.schema.json). */
export type DeleteKbChatSessionsIdRequest = {
  params: {
    id: string;
  };
};

export type DeleteKbChatSessionsIdResponse200 = AgentOk;

export type DeleteKbChatSessionsIdResponse404 = CommonError;

/** Request parts for `POST /kb/chat/sessions/:id/messages` (schema/http/agent.schema.json). */
export type PostKbChatSessionsIdMessagesRequest = {
  params: {
    id: string;
  };
  body: {
    /** user, assistant or system */
    role?: string;
    content?: string;
    /** caller-supplied metadata, stored as sent */
    meta?: Record<string, unknown> | null;
  };
};

export type PostKbChatSessionsIdMessagesResponse201 = {
  seq: number;
  createdAt: number;
};

export type PostKbChatSessionsIdMessagesResponse400 = CommonError;

export type PostKbChatSessionsIdMessagesResponse404 = CommonError;

/** Request parts for `DELETE /kb/chat/sessions/:id/messages` (schema/http/agent.schema.json). */
export type DeleteKbChatSessionsIdMessagesRequest = {
  params: {
    id: string;
  };
};

export type DeleteKbChatSessionsIdMessagesResponse200 = {
  cleared: number;
};

/** Request parts for `GET /agent/v2/session/route` (schema/http/agent.schema.json). */
export type GetAgentV2SessionRouteRequest = {
  query: {
    chatSessionId?: string;
  };
};

export type GetAgentV2SessionRouteResponse200 = RouteState;

export type GetAgentV2SessionRouteResponse400 = CommonError;

/** Request parts for `PUT /agent/v2/session/route` (schema/http/agent.schema.json). */
export type PutAgentV2SessionRouteRequest = {
  body: {
    chatSessionId: string;
    /** anthropic or custom:<id>; sent with model, '' with '' unpins */
    provider?: string;
    model?: string;
    /** whole billable tokens; null or 0 clears; negative, fractional or above 1e12 is 400 */
    tokenLimit?: number | null;
    /** re-seeds the counter of a chat whose route was purged at quit; ignored while the row already has usage */
    tokensUsed?: number;
    /** the switchSeq last read; a stale value is 409 ROUTE_CONFLICT */
    ifSeq?: number | null;
  };
};

/** One chat's route (K1 Phase 6b). `enabled` is false when the server runs without LLMIDE_ROUTER=on: the record then reads as the empty default and PUT answers 409 ROUTER_DISABLED. `capEnforced` says whether LLMIDE_ROUTER_CAP=on, i.e. whether tokenLimit is enforced or only stored. provider '' and model '' = not pinned: the client's own pick governs. */
export type PutAgentV2SessionRouteResponse200 = {
  enabled: boolean;
  capEnforced: boolean;
  chatSessionId: string;
  /** anthropic, custom:<id>, or '' when not pinned */
  provider: string;
  model: string;
  pinned: boolean;
  pinnedBy: "user" | "router";
  /** billable tokens for the chat; null = no cap */
  tokenLimit: number | null;
  used: {
    in: number;
    out: number;
    cacheWrite: number;
    /** shown, never counted against the cap */
    cacheRead: number;
    /** input + output + cache write: what the session cap counts */
    billable: number;
  };
  remaining: number | null;
  /** UTC ISO; the time the last turn's prompt cache is expected to expire */
  stickyUntil: string | null;
  /** '<provider>|<model>' to the last cache touch (UTC ISO) */
  warm: Record<string, string>;
  /** compare-and-set version: send it back as ifSeq */
  switchSeq: number;
  /** a provider/model change made during a turn, applied at the next turn start */
  pending: {
    provider?: string;
    model?: string;
    pinnedBy?: string;
    requestedAt?: string;
  } | null;
  updatedAt: string | null;
  appliesAt: "now" | "next_turn";
  changed: boolean;
  /** present when the pick changed: the new side's cache is cold */
  coldSwitch?: boolean;
  /** about what the next turn pays to prefill the handoff */
  estimatedPrefillTokens?: number;
};

export type PutAgentV2SessionRouteResponse400 = CommonError;

export type PutAgentV2SessionRouteResponse409 = CommonError;

export type PutAgentV2SessionRouteResponse503 = CommonError;

/** Request parts for `GET /agent/v2/session/route/history` (schema/http/agent.schema.json). */
export type GetAgentV2SessionRouteHistoryRequest = {
  query: {
    chatSessionId?: string;
  };
};

export type GetAgentV2SessionRouteHistoryResponse200 = {
  events: RouteEvent[];
  /** true when agent.db is down: the list is empty, routing is unaffected */
  degraded: boolean;
};

export type GetAgentV2SessionRouteHistoryResponse400 = CommonError;

/** Request parts for `GET /kb/docs/templates` (schema/http/docs.schema.json). */
export type GetKbDocsTemplatesRequest = {
  query: ProjectQuery;
};

export type GetKbDocsTemplatesResponse200 = {
  templates: Template[];
  count: number;
  /** True when the templates/ family holds more than 2000 folder entries; only the first 2000 by name were examined. */
  truncated: boolean;
  /** Folder entries examined, at most 2000. */
  scannedFolders: number;
};

export type GetKbDocsTemplatesResponse400 = CommonError;

export type GetKbDocsTemplatesResponse404 = CommonError;

/** Request parts for `GET /kb/docs/commands` (schema/http/docs.schema.json). */
export type GetKbDocsCommandsRequest = {
  query: ProjectQuery;
};

export type GetKbDocsCommandsResponse200 = {
  commands: Command[];
  count: number;
  /** True when the commands/ family holds more than 2000 folder entries; only the first 2000 by name were examined. */
  truncated: boolean;
  /** Folder entries examined, at most 2000. */
  scannedFolders: number;
};

export type GetKbDocsCommandsResponse400 = CommonError;

export type GetKbDocsCommandsResponse404 = CommonError;

/** Request parts for `PUT /kb/docs/templates/:folder` (schema/http/docs.schema.json). */
export type PutKbDocsTemplatesFolderRequest = {
  query: ProjectQuery;
  params: {
    /** A folder name: a letter or digit first, then letters, digits, _ or - (max 80). Not auto_task. */
    folder: string;
  };
  body: TemplateWrite;
};

export type PutKbDocsTemplatesFolderResponse200 = {
  template: Template;
};

export type PutKbDocsTemplatesFolderResponse400 = CommonError;

export type PutKbDocsTemplatesFolderResponse404 = CommonError;

/** RESERVED_FOLDER: the folder holds an ingest layout. */
export type PutKbDocsTemplatesFolderResponse409 = CommonError;

/** Request parts for `DELETE /kb/docs/templates/:folder` (schema/http/docs.schema.json). */
export type DeleteKbDocsTemplatesFolderRequest = {
  query: ProjectQuery;
  params: {
    /** A folder name: a letter or digit first, then letters, digits, _ or - (max 80). Not auto_task. */
    folder: string;
  };
};

export type DeleteKbDocsTemplatesFolderResponse200 = DeleteResult;

export type DeleteKbDocsTemplatesFolderResponse400 = CommonError;

export type DeleteKbDocsTemplatesFolderResponse404 = CommonError;

/** RESERVED_FOLDER: the template file is an ingest layout; nothing is removed. */
export type DeleteKbDocsTemplatesFolderResponse409 = CommonError;

/** Request parts for `PUT /kb/docs/commands/:folder` (schema/http/docs.schema.json). */
export type PutKbDocsCommandsFolderRequest = {
  query: ProjectQuery;
  params: {
    /** A folder name: a letter or digit first, then letters, digits, _ or - (max 80). Not auto_task. */
    folder: string;
  };
  body: CommandWrite;
};

export type PutKbDocsCommandsFolderResponse200 = {
  command: Command;
};

export type PutKbDocsCommandsFolderResponse400 = CommonError;

export type PutKbDocsCommandsFolderResponse404 = CommonError;

/** Request parts for `DELETE /kb/docs/commands/:folder` (schema/http/docs.schema.json). */
export type DeleteKbDocsCommandsFolderRequest = {
  query: ProjectQuery;
  params: {
    /** A folder name: a letter or digit first, then letters, digits, _ or - (max 80). Not auto_task. */
    folder: string;
  };
};

export type DeleteKbDocsCommandsFolderResponse200 = DeleteResult;

export type DeleteKbDocsCommandsFolderResponse400 = CommonError;

export type DeleteKbDocsCommandsFolderResponse404 = CommonError;

/** Request parts for `POST /kb/docs/seed` (schema/http/docs.schema.json). */
export type PostKbDocsSeedRequest = {
  query: ProjectQuery;
};

export type PostKbDocsSeedResponse200 = SeedResult;

export type PostKbDocsSeedResponse400 = CommonError;

export type PostKbDocsSeedResponse404 = CommonError;

/** Request parts for `POST /kb/projects/register` (schema/http/docs.schema.json). */
export type PostKbProjectsRegisterRequest = {
  body: RegisterRequest;
};

export type PostKbProjectsRegisterResponse200 = RegisterResult;

/** INVALID_PROJECT_ID, or INVALID_ROOT for every refused root (one message, no existence or type oracle). */
export type PostKbProjectsRegisterResponse400 = CommonError;

/** TOO_MANY_PROJECTS: the user already holds 200 registered projects. */
export type PostKbProjectsRegisterResponse409 = CommonError;

/** Request parts for `GET /auth/me/extensions/installed` (schema/http/extensions.schema.json). */
export type GetAuthMeExtensionsInstalledRequest = Record<string, never>;

export type GetAuthMeExtensionsInstalledResponse200 = {
  corrupt: boolean;
  items: Item[];
};

export type GetAuthMeExtensionsInstalledResponse401 = CommonError;

/** Request parts for `POST /auth/me/extensions/install` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsInstallRequest = {
  body: {
    url?: string;
    ref?: string;
    commit?: string;
    path?: string;
  };
};

export type PostAuthMeExtensionsInstallResponse200 = {
  ok: boolean;
  alreadyInstalled?: boolean;
  item: Item;
};

export type PostAuthMeExtensionsInstallResponse400 = CommonError;

export type PostAuthMeExtensionsInstallResponse401 = CommonError;

export type PostAuthMeExtensionsInstallResponse403 = CommonError;

export type PostAuthMeExtensionsInstallResponse404 = CommonError;

export type PostAuthMeExtensionsInstallResponse409 = CommonError;

export type PostAuthMeExtensionsInstallResponse422 = CommonError;

/** Request parts for `POST /auth/me/extensions/toggle` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsToggleRequest = {
  body: {
    id?: string;
    enabled?: boolean | string;
    consents?: string[];
    members?: string[];
  };
};

export type PostAuthMeExtensionsToggleResponse200 = {
  ok: boolean;
  item: Item;
};

export type PostAuthMeExtensionsToggleResponse400 = CommonError;

export type PostAuthMeExtensionsToggleResponse401 = CommonError;

export type PostAuthMeExtensionsToggleResponse404 = CommonError;

export type PostAuthMeExtensionsToggleResponse409 = CommonError;

/** Request parts for `POST /auth/me/extensions/uninstall` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsUninstallRequest = {
  body: {
    id?: string;
  };
};

export type PostAuthMeExtensionsUninstallResponse200 = {
  ok: boolean;
};

export type PostAuthMeExtensionsUninstallResponse401 = CommonError;

export type PostAuthMeExtensionsUninstallResponse404 = CommonError;

/** Request parts for `GET /auth/me/extensions/catalog` (schema/http/extensions.schema.json). */
export type GetAuthMeExtensionsCatalogRequest = {
  query: {
    q?: string;
    kind?: string;
    limit?: string;
    offset?: string;
  };
};

export type GetAuthMeExtensionsCatalogResponse200 = {
  query: string;
  total: number;
  offset: number;
  results: Entry[];
  sources: ExtensionsSource[];
};

export type GetAuthMeExtensionsCatalogResponse400 = CommonError;

export type GetAuthMeExtensionsCatalogResponse401 = CommonError;

/** Request parts for `POST /auth/me/extensions/catalog/refresh` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsCatalogRefreshRequest = {
  body: {
    source?: string | number;
    force?: boolean;
  };
};

export type PostAuthMeExtensionsCatalogRefreshResponse200 = {
  results: {
    id: string;
    status: string;
    count?: number;
    error?: string;
  }[];
};

export type PostAuthMeExtensionsCatalogRefreshResponse400 = CommonError;

export type PostAuthMeExtensionsCatalogRefreshResponse401 = CommonError;

export type PostAuthMeExtensionsCatalogRefreshResponse404 = CommonError;

/** Request parts for `GET /auth/me/extensions/active` (schema/http/extensions.schema.json). */
export type GetAuthMeExtensionsActiveRequest = Record<string, never>;

export type GetAuthMeExtensionsActiveResponse200 = {
  fingerprint: string;
  failClosed: boolean;
  items: {
    id: string;
    kind: string;
    trust: string;
  }[];
  skills: {
    id: string;
    name: string;
    description: string;
    sourceId: string;
  }[];
  pluginSkills?: {
    name: string;
    plugin: string;
  }[];
  commands?: {
    trigger: string;
    plugin: string;
  }[];
  subagents?: {
    name: string;
    plugin: string;
  }[];
  sdkPlugins: number;
  mcpServers: string[];
  excluded?: {
    kind: string;
    name: string;
    reason: string;
  }[];
  warnings: string[];
};

export type GetAuthMeExtensionsActiveResponse401 = CommonError;

/** Request parts for `GET /auth/me/extensions/updates` (schema/http/extensions.schema.json). */
export type GetAuthMeExtensionsUpdatesRequest = Record<string, never>;

export type GetAuthMeExtensionsUpdatesResponse200 = {
  corrupt: boolean;
  items: ({
    id: string;
    name: string;
    kind: string;
    current: string;
    latest: string;
    checkedAt: string | null;
    ref?: string;
    hasPrevious: boolean;
  })[];
};

export type GetAuthMeExtensionsUpdatesResponse401 = CommonError;

/** Request parts for `POST /auth/me/extensions/updates/check` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsUpdatesCheckRequest = {
  body: {
    id?: string;
  };
};

export type PostAuthMeExtensionsUpdatesCheckResponse200 = {
  checkedAt: string;
  results: {
    id: string;
    current: string;
    latest?: string;
    updateAvailable: boolean;
    error?: string;
  }[];
};

export type PostAuthMeExtensionsUpdatesCheckResponse401 = CommonError;

export type PostAuthMeExtensionsUpdatesCheckResponse404 = CommonError;

/** Request parts for `POST /auth/me/extensions/update/preview` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsUpdatePreviewRequest = {
  body: {
    id?: string;
    commit?: string | number;
  };
};

export type PostAuthMeExtensionsUpdatePreviewResponse200 = {
  id: string;
  from: string;
  to: string;
  version: {
    from: string | null;
    to: string | null;
  };
  files: {
    counts: {
      added: number;
      removed: number;
      changed: number;
    };
    added: {
      path: string;
      size: number;
    }[];
    removed?: {
      path: string;
      size: number;
    }[];
    changed: {
      path: string;
      before: number;
      after: number;
    }[];
    truncated: boolean;
  };
  scan: {
    before: {
      count: number;
      byRule?: Record<string, number>;
    };
    after: {
      count: number;
      byRule: Record<string, number>;
    };
    newFindings: ExtensionsFinding[];
    resolvedCount: number;
  };
  executable: {
    newKinds: string[];
    newMembers: {
      memberId: string;
      type: string;
      name: string;
    }[];
    kinds: string[];
  };
  members: {
    added: string[];
    removed?: string[];
  };
  consent: {
    required: boolean;
    kinds: string[];
  };
  wasEnabled: boolean;
  staysEnabledWithoutConsent: boolean;
  flags: string[];
};

export type PostAuthMeExtensionsUpdatePreviewResponse400 = CommonError;

export type PostAuthMeExtensionsUpdatePreviewResponse401 = CommonError;

export type PostAuthMeExtensionsUpdatePreviewResponse404 = CommonError;

export type PostAuthMeExtensionsUpdatePreviewResponse409 = CommonError;

export type PostAuthMeExtensionsUpdatePreviewResponse422 = CommonError;

/** Request parts for `POST /auth/me/extensions/update` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsUpdateRequest = {
  body: {
    id?: string;
    commit?: string;
    consents?: string[];
  };
};

export type PostAuthMeExtensionsUpdateResponse200 = {
  ok: boolean;
  item: Item;
  update: {
    from: string;
    to: string;
    enabled: boolean;
    wasEnabled: boolean;
    reason?: string;
    kinds: string[];
  };
};

export type PostAuthMeExtensionsUpdateResponse400 = CommonError;

export type PostAuthMeExtensionsUpdateResponse401 = CommonError;

export type PostAuthMeExtensionsUpdateResponse404 = CommonError;

export type PostAuthMeExtensionsUpdateResponse409 = CommonError;

export type PostAuthMeExtensionsUpdateResponse422 = CommonError;

/** Request parts for `POST /auth/me/extensions/rollback` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsRollbackRequest = {
  body: {
    id?: string;
  };
};

export type PostAuthMeExtensionsRollbackResponse200 = {
  ok: boolean;
  item: Item;
  rollback: {
    from: string;
    to: string;
    enabled: boolean;
    wasEnabled: boolean;
    reason?: string;
    kinds: string[];
  };
};

export type PostAuthMeExtensionsRollbackResponse401 = CommonError;

export type PostAuthMeExtensionsRollbackResponse404 = CommonError;

export type PostAuthMeExtensionsRollbackResponse409 = CommonError;

/** Request parts for `POST /auth/me/extensions/repair` (schema/http/extensions.schema.json). */
export type PostAuthMeExtensionsRepairRequest = {
  body: {
    id?: string;
  };
};

export type PostAuthMeExtensionsRepairResponse200 = {
  ok: boolean;
  repaired: boolean;
  status: string;
  was?: string;
  item: Item;
};

export type PostAuthMeExtensionsRepairResponse401 = CommonError;

export type PostAuthMeExtensionsRepairResponse404 = CommonError;

export type PostAuthMeExtensionsRepairResponse409 = CommonError;

/** Request parts for `GET /auth/me/workspace-trust` (schema/http/extensions.schema.json). */
export type GetAuthMeWorkspaceTrustRequest = Record<string, never>;

export type GetAuthMeWorkspaceTrustResponse200 = {
  enforced: boolean;
  items: TrustItem[];
};

export type GetAuthMeWorkspaceTrustResponse401 = CommonError;

/** Request parts for `PUT /auth/me/workspace-trust` (schema/http/extensions.schema.json). */
export type PutAuthMeWorkspaceTrustRequest = {
  body: {
    path: string;
    trusted: boolean;
  };
};

export type PutAuthMeWorkspaceTrustResponse200 = {
  ok: boolean;
  item: TrustItem;
};

export type PutAuthMeWorkspaceTrustResponse400 = CommonError;

export type PutAuthMeWorkspaceTrustResponse401 = CommonError;

export type PutAuthMeWorkspaceTrustResponse404 = CommonError;

/** Request parts for `GET /auth/me/extensions/allowlist` (schema/http/extensions.schema.json). */
export type GetAuthMeExtensionsAllowlistRequest = Record<string, never>;

export type GetAuthMeExtensionsAllowlistResponse200 = Allowlist;

export type GetAuthMeExtensionsAllowlistResponse401 = CommonError;

/** Request parts for `PUT /auth/me/extensions/allowlist` (schema/http/extensions.schema.json). */
export type PutAuthMeExtensionsAllowlistRequest = {
  body: {
    sources?: string[];
  };
};

export type PutAuthMeExtensionsAllowlistResponse200 = Allowlist;

export type PutAuthMeExtensionsAllowlistResponse400 = CommonError;

export type PutAuthMeExtensionsAllowlistResponse401 = CommonError;

export type PutAuthMeExtensionsAllowlistResponse403 = CommonError;

/** Request parts for `GET /` (schema/http/health-auth.schema.json). */
export type GetRequest = Record<string, never>;

export type GetResponse200 = Health;

/** Request parts for `GET /health` (schema/http/health-auth.schema.json). */
export type GetHealthRequest = Record<string, never>;

export type GetHealthResponse200 = Health;

/** Request parts for `GET /launch-app` (schema/http/health-auth.schema.json). */
export type GetLaunchAppRequest = {
  query: {
    /** transcript | plan | review | history | settings; any other value falls back to transcript */
    to?: string;
    /** appended to the llmide:// target */
    session?: string;
  };
};

/** HTML page with a meta refresh to llmide://<tab>; the Location header carries the same target */
export type GetLaunchAppResponse302 = string;

/** Request parts for `GET /auth/well-known` (schema/http/health-auth.schema.json). */
export type GetAuthWellKnownRequest = Record<string, never>;

export type GetAuthWellKnownResponse200 = WellKnown;

/** Request parts for `POST /auth/register` (schema/http/health-auth.schema.json). */
export type PostAuthRegisterRequest = {
  body: {
    email: string;
    /** 10 to 200 characters */
    password: string;
    displayName?: string;
  };
};

export type PostAuthRegisterResponse201 = {
  user: User;
};

export type PostAuthRegisterResponse400 = CommonError;

export type PostAuthRegisterResponse403 = CommonError;

export type PostAuthRegisterResponse409 = CommonError;

export type PostAuthRegisterResponse429 = CommonError;

/** Request parts for `POST /auth/login` (schema/http/health-auth.schema.json). */
export type PostAuthLoginRequest = {
  body: {
    email: string;
    password: string;
  };
};

export type PostAuthLoginResponse200 = Session;

export type PostAuthLoginResponse401 = CommonError;

export type PostAuthLoginResponse429 = CommonError;

/** Request parts for `POST /auth/refresh` (schema/http/health-auth.schema.json). */
export type PostAuthRefreshRequest = {
  body: {
    refreshToken: string;
  };
};

export type PostAuthRefreshResponse200 = Session;

export type PostAuthRefreshResponse401 = CommonError;

export type PostAuthRefreshResponse429 = CommonError;

/** Request parts for `POST /auth/logout` (schema/http/health-auth.schema.json). */
export type PostAuthLogoutRequest = {
  body: {
    /** revokes that one session; without it every refresh token of the user is revoked */
    refreshToken?: string;
    /** revokes every session */
    allDevices?: boolean;
  };
};

export type PostAuthLogoutResponse200 = HealthAuthOk;

export type PostAuthLogoutResponse401 = CommonError;

/** Request parts for `POST /auth/reset-request` (schema/http/health-auth.schema.json). */
export type PostAuthResetRequestRequest = {
  body: {
    email?: string;
  };
};

export type PostAuthResetRequestResponse200 = {
  ok: true;
  /** single-use reset token, 1 hour TTL */
  token: string;
  expiresAt: string;
} | {
  ok: true;
  message: string;
};

export type PostAuthResetRequestResponse429 = CommonError;

/** Request parts for `POST /auth/reset-confirm` (schema/http/health-auth.schema.json). */
export type PostAuthResetConfirmRequest = {
  body: {
    token?: string;
    newPassword?: string;
  };
};

export type PostAuthResetConfirmResponse200 = HealthAuthOk;

export type PostAuthResetConfirmResponse400 = CommonError;

export type PostAuthResetConfirmResponse401 = CommonError;

export type PostAuthResetConfirmResponse429 = CommonError;

/** Request parts for `POST /auth/google/start` (schema/http/health-auth.schema.json). */
export type PostAuthGoogleStartRequest = {
  body: {
    /** bring-your-own client: both fields, or neither for the hosted client */
    clientId?: string;
    clientSecret?: string;
  };
};

export type PostAuthGoogleStartResponse200 = OAuthStart;

export type PostAuthGoogleStartResponse401 = CommonError;

export type PostAuthGoogleStartResponse503 = CommonError;

/** Request parts for `GET /auth/google/status` (schema/http/health-auth.schema.json). */
export type GetAuthGoogleStatusRequest = {
  query: {
    state?: string;
  };
};

export type GetAuthGoogleStatusResponse200 = GoogleStatus;

export type GetAuthGoogleStatusResponse401 = CommonError;

/** Request parts for `GET /auth/google/callback` (schema/http/health-auth.schema.json). */
export type GetAuthGoogleCallbackRequest = {
  query: {
    code?: string;
    state?: string;
  };
};

/** HTML page; no bearer token on this route (Google's redirect) */
export type GetAuthGoogleCallbackResponse200 = string;

/** HTML page when the per-IP OAuth-callback bucket is empty */
export type GetAuthGoogleCallbackResponse429 = string;

/** Request parts for `POST /auth/slack/start` (schema/http/health-auth.schema.json). */
export type PostAuthSlackStartRequest = {
  body: Record<string, unknown>;
};

export type PostAuthSlackStartResponse200 = OAuthStart;

export type PostAuthSlackStartResponse401 = CommonError;

export type PostAuthSlackStartResponse503 = CommonError;

/** Request parts for `GET /auth/slack/status` (schema/http/health-auth.schema.json). */
export type GetAuthSlackStatusRequest = {
  query: {
    state?: string;
  };
};

export type GetAuthSlackStatusResponse200 = SlackStatus;

export type GetAuthSlackStatusResponse401 = CommonError;

/** Request parts for `GET /auth/slack/callback` (schema/http/health-auth.schema.json). */
export type GetAuthSlackCallbackRequest = {
  query: {
    code?: string;
    state?: string;
  };
};

/** HTML page; no bearer token on this route (Slack's redirect) */
export type GetAuthSlackCallbackResponse200 = string;

/** Request parts for `GET /auth/mcp-connector/callback` (schema/http/health-auth.schema.json). */
export type GetAuthMcpConnectorCallbackRequest = {
  query: {
    code?: string;
    state?: string;
  };
};

/** HTML page; no bearer token on this route (the remote MCP server's redirect) */
export type GetAuthMcpConnectorCallbackResponse200 = string;

/** Request parts for `GET /auth/me` (schema/http/health-auth.schema.json). */
export type GetAuthMeRequest = Record<string, never>;

export type GetAuthMeResponse200 = User;

export type GetAuthMeResponse401 = CommonError;

/** Request parts for `POST /auth/me/password` (schema/http/health-auth.schema.json). */
export type PostAuthMePasswordRequest = {
  body: {
    currentPassword?: string;
    newPassword?: string;
  };
};

export type PostAuthMePasswordResponse200 = HealthAuthOk;

export type PostAuthMePasswordResponse400 = CommonError;

export type PostAuthMePasswordResponse401 = CommonError;

/** Request parts for `GET /auth/me/prefs` (schema/http/health-auth.schema.json). */
export type GetAuthMePrefsRequest = Record<string, never>;

export type GetAuthMePrefsResponse200 = {
  prefs: Prefs;
};

export type GetAuthMePrefsResponse401 = CommonError;

/** Request parts for `PUT /auth/me/prefs` (schema/http/health-auth.schema.json). */
export type PutAuthMePrefsRequest = {
  body: Prefs;
};

export type PutAuthMePrefsResponse200 = {
  prefs: Prefs;
};

export type PutAuthMePrefsResponse401 = CommonError;

/** Request parts for `GET /auth/me/secrets` (schema/http/health-auth.schema.json). */
export type GetAuthMeSecretsRequest = Record<string, never>;

export type GetAuthMeSecretsResponse200 = {
  /** keys this user has set; values never leave the server */
  secrets: Secret[];
  /** every key a user may store */
  available: string[];
};

export type GetAuthMeSecretsResponse401 = CommonError;

/** Request parts for `POST /auth/me/secrets` (schema/http/health-auth.schema.json). */
export type PostAuthMeSecretsRequest = {
  body: {
    key: string;
    /** null/empty deletes */
    value?: string;
  };
};

export type PostAuthMeSecretsResponse200 = HealthAuthOk;

export type PostAuthMeSecretsResponse400 = CommonError;

export type PostAuthMeSecretsResponse401 = CommonError;

/** Request parts for `POST /auth/me/repos` (schema/http/health-auth.schema.json). */
export type PostAuthMeReposRequest = {
  body: {
    /** an absolute local path, registered as allowed for git connect */
    path?: string;
    label?: string;
  };
};

export type PostAuthMeReposResponse200 = {
  ok: true;
  /** the canonical absolute path stored */
  path: string;
};

export type PostAuthMeReposResponse400 = CommonError;

export type PostAuthMeReposResponse401 = CommonError;

/** Request parts for `GET /auth/me/plugins` (schema/http/health-auth.schema.json). */
export type GetAuthMePluginsRequest = Record<string, never>;

export type GetAuthMePluginsResponse200 = {
  pluginDir: string;
  plugins: ({
    /** plugin slug */
    name?: string;
    /** manifest version; null when the manifest declares none */
    version?: string | null;
    displayName?: string | null;
    description?: string | null;
    author?: string | null;
    /** this user's enable state */
    enabled?: boolean;
    /** true when the Agent SDK can load the plugin from its .claude-plugin manifest */
    sdkReadable?: boolean;
    /** this user's nativePlugins preference */
    nativePluginsOn?: boolean;
    skillCount?: number;
    /** {trigger, description} rows */
    commands?: unknown[];
    /** {name, description, allowedTools} rows */
    subagents?: unknown[];
    /** llmide | claude | codex */
    format?: string;
    /** 'claude' | 'codex' when a vendor bridge imported it, else null */
    origin?: string | null;
    sourceVersion?: string | null;
    /** where git/marketplace/zip installs came from */
    installSource?: string | null;
    unsupportedComponents?: unknown[];
    pendingComponents?: unknown[];
    /** runnable hook handlers the plugin declares */
    hookCount?: number;
    declaresHooks?: boolean;
    /** hook kinds llm-ide will run */
    executableKinds?: unknown[];
    hookNotes?: unknown[];
    /** effective trust */
    hooksTrusted?: boolean;
    trustOutdated?: boolean;
    trustOutdatedKinds?: unknown[];
    nativeDelivery?: boolean;
    mcpServerCount?: number;
  })[];
};

export type GetAuthMePluginsResponse401 = CommonError;

/** Request parts for `POST /auth/me/plugins/toggle` (schema/http/health-auth.schema.json). */
export type PostAuthMePluginsToggleRequest = {
  body: {
    name?: string;
    enabled?: boolean;
  };
};

export type PostAuthMePluginsToggleResponse200 = unknown;

export type PostAuthMePluginsToggleResponse400 = CommonError;

export type PostAuthMePluginsToggleResponse401 = CommonError;

/** Request parts for `POST /auth/me/plugins/hook-trust` (schema/http/health-auth.schema.json). */
export type PostAuthMePluginsHookTrustRequest = {
  body: {
    name?: string;
    trusted?: boolean;
    kinds?: string[];
  };
};

export type PostAuthMePluginsHookTrustResponse200 = unknown;

export type PostAuthMePluginsHookTrustResponse400 = CommonError;

export type PostAuthMePluginsHookTrustResponse401 = CommonError;

/** Request parts for `POST /auth/me/plugins/reload` (schema/http/health-auth.schema.json). */
export type PostAuthMePluginsReloadRequest = {
  body: Record<string, unknown>;
};

export type PostAuthMePluginsReloadResponse200 = {
  pluginDir: string;
  count: number;
  warnings: string[];
};

export type PostAuthMePluginsReloadResponse401 = CommonError;

/** Request parts for `POST /auth/me/plugins/install` (schema/http/health-auth.schema.json). */
export type PostAuthMePluginsInstallRequest = {
  query: {
    /** 1 replaces an installed plugin of the same name */
    replace?: string;
    /** the plugin name the upload must carry */
    expect?: string;
  };
};

export type PostAuthMePluginsInstallResponse200 = unknown;

export type PostAuthMePluginsInstallResponse400 = CommonError;

export type PostAuthMePluginsInstallResponse401 = CommonError;

/** Request parts for `DELETE /auth/me/plugins/uninstall/:name` (schema/http/health-auth.schema.json). */
export type DeleteAuthMePluginsUninstallNameRequest = {
  params: {
    name: string;
  };
};

export type DeleteAuthMePluginsUninstallNameResponse200 = {
  ok: true;
  /** false when no plugin of that name was installed */
  removed: boolean;
};

export type DeleteAuthMePluginsUninstallNameResponse401 = CommonError;

/** Request parts for `GET /auth/me/claude-plugins/installed` (schema/http/health-auth.schema.json). */
export type GetAuthMeClaudePluginsInstalledRequest = Record<string, never>;

export type GetAuthMeClaudePluginsInstalledResponse200 = PluginRows;

export type GetAuthMeClaudePluginsInstalledResponse401 = CommonError;

/** Request parts for `GET /auth/me/claude-plugins/marketplace` (schema/http/health-auth.schema.json). */
export type GetAuthMeClaudePluginsMarketplaceRequest = Record<string, never>;

export type GetAuthMeClaudePluginsMarketplaceResponse200 = PluginRows;

export type GetAuthMeClaudePluginsMarketplaceResponse401 = CommonError;

/** Request parts for `POST /auth/me/claude-plugins/import` (schema/http/health-auth.schema.json). */
export type PostAuthMeClaudePluginsImportRequest = {
  body: {
    name?: string;
    source?: string;
  };
};

export type PostAuthMeClaudePluginsImportResponse200 = unknown;

export type PostAuthMeClaudePluginsImportResponse400 = CommonError;

export type PostAuthMeClaudePluginsImportResponse401 = CommonError;

export type PostAuthMeClaudePluginsImportResponse404 = CommonError;

/** Request parts for `POST /auth/me/claude-plugins/refresh` (schema/http/health-auth.schema.json). */
export type PostAuthMeClaudePluginsRefreshRequest = {
  body: Record<string, unknown>;
};

export type PostAuthMeClaudePluginsRefreshResponse200 = {
  installed: number;
  marketplace: number;
};

export type PostAuthMeClaudePluginsRefreshResponse401 = CommonError;

/** Request parts for `GET /auth/me/claude-plugins/updates` (schema/http/health-auth.schema.json). */
export type GetAuthMeClaudePluginsUpdatesRequest = Record<string, never>;

export type GetAuthMeClaudePluginsUpdatesResponse200 = {
  /** true when the claude CLI answered the check; false for the local scan */
  cli: boolean;
  checkedAt: string;
  updates: Record<string, unknown>[];
};

export type GetAuthMeClaudePluginsUpdatesResponse401 = CommonError;

/** Request parts for `POST /auth/me/claude-plugins/update` (schema/http/health-auth.schema.json). */
export type PostAuthMeClaudePluginsUpdateRequest = {
  body: {
    name?: string;
    /** hex digest of the hook command the user accepted */
    acceptCommand?: string;
  };
};

export type PostAuthMeClaudePluginsUpdateResponse200 = unknown;

export type PostAuthMeClaudePluginsUpdateResponse401 = CommonError;

export type PostAuthMeClaudePluginsUpdateResponse404 = ClaudeUpdateNotFound;

/** Request parts for `GET /auth/me/codex-plugins/installed` (schema/http/health-auth.schema.json). */
export type GetAuthMeCodexPluginsInstalledRequest = Record<string, never>;

export type GetAuthMeCodexPluginsInstalledResponse200 = PluginRows;

export type GetAuthMeCodexPluginsInstalledResponse401 = CommonError;

/** Request parts for `GET /auth/me/codex-plugins/marketplace` (schema/http/health-auth.schema.json). */
export type GetAuthMeCodexPluginsMarketplaceRequest = Record<string, never>;

export type GetAuthMeCodexPluginsMarketplaceResponse200 = PluginRows;

export type GetAuthMeCodexPluginsMarketplaceResponse401 = CommonError;

/** Request parts for `POST /auth/me/codex-plugins/import` (schema/http/health-auth.schema.json). */
export type PostAuthMeCodexPluginsImportRequest = {
  body: {
    name?: string;
    source?: string;
  };
};

export type PostAuthMeCodexPluginsImportResponse200 = unknown;

export type PostAuthMeCodexPluginsImportResponse400 = CommonError;

export type PostAuthMeCodexPluginsImportResponse401 = CommonError;

export type PostAuthMeCodexPluginsImportResponse404 = CommonError;

/** Request parts for `POST /auth/me/codex-plugins/refresh` (schema/http/health-auth.schema.json). */
export type PostAuthMeCodexPluginsRefreshRequest = {
  body: Record<string, unknown>;
};

export type PostAuthMeCodexPluginsRefreshResponse200 = {
  installed: number;
  marketplace: number;
};

export type PostAuthMeCodexPluginsRefreshResponse401 = CommonError;

/** Request parts for `GET /auth/me/codex-plugins/updates` (schema/http/health-auth.schema.json). */
export type GetAuthMeCodexPluginsUpdatesRequest = Record<string, never>;

export type GetAuthMeCodexPluginsUpdatesResponse200 = {
  cli: boolean;
  checkedAt: string;
  updates: Record<string, unknown>[];
};

export type GetAuthMeCodexPluginsUpdatesResponse401 = CommonError;

/** Request parts for `GET /auth/me/llm-sources` (schema/http/health-auth.schema.json). */
export type GetAuthMeLlmSourcesRequest = Record<string, never>;

export type GetAuthMeLlmSourcesResponse200 = {
  sources: LlmSource[];
};

export type GetAuthMeLlmSourcesResponse401 = CommonError;

/** Request parts for `GET /auth/me/llm-sources/updates` (schema/http/health-auth.schema.json). */
export type GetAuthMeLlmSourcesUpdatesRequest = Record<string, never>;

export type GetAuthMeLlmSourcesUpdatesResponse200 = {
  sources: LlmSourceUpdate[];
};

export type GetAuthMeLlmSourcesUpdatesResponse401 = CommonError;

/** Request parts for `POST /auth/me/llm-sources/toggle` (schema/http/health-auth.schema.json). */
export type PostAuthMeLlmSourcesToggleRequest = {
  body: {
    id?: string;
    enabled?: boolean;
  };
};

export type PostAuthMeLlmSourcesToggleResponse200 = {
  ok: true;
  enabled: boolean;
};

export type PostAuthMeLlmSourcesToggleResponse400 = CommonError;

export type PostAuthMeLlmSourcesToggleResponse401 = CommonError;

/** Request parts for `POST /auth/me/llm-sources/items` (schema/http/health-auth.schema.json). */
export type PostAuthMeLlmSourcesItemsRequest = {
  body: {
    sourceId?: string;
    kind?: "skill" | "agent" | "command" | "template";
    names?: string[];
    enabled?: boolean;
  };
};

export type PostAuthMeLlmSourcesItemsResponse200 = {
  ok: true;
  /** kind:name of every item this user has unchecked in the source */
  disabled: string[];
};

export type PostAuthMeLlmSourcesItemsResponse401 = CommonError;

/** Request parts for `POST /auth/me/llm-sources/add` (schema/http/health-auth.schema.json). */
export type PostAuthMeLlmSourcesAddRequest = {
  body: {
    url?: string;
    path?: string;
    ref?: string;
    name?: string;
  };
};

export type PostAuthMeLlmSourcesAddResponse200 = unknown;

export type PostAuthMeLlmSourcesAddResponse400 = CommonError;

export type PostAuthMeLlmSourcesAddResponse401 = CommonError;

/** Request parts for `POST /auth/me/llm-sources/update` (schema/http/health-auth.schema.json). */
export type PostAuthMeLlmSourcesUpdateRequest = {
  body: {
    id?: string;
  };
};

export type PostAuthMeLlmSourcesUpdateResponse200 = unknown;

export type PostAuthMeLlmSourcesUpdateResponse401 = CommonError;

export type PostAuthMeLlmSourcesUpdateResponse404 = CommonError;

/** Request parts for `DELETE /auth/me/llm-sources/:id` (schema/http/health-auth.schema.json). */
export type DeleteAuthMeLlmSourcesIdRequest = {
  params: {
    id: string;
  };
};

export type DeleteAuthMeLlmSourcesIdResponse200 = unknown;

export type DeleteAuthMeLlmSourcesIdResponse400 = CommonError;

export type DeleteAuthMeLlmSourcesIdResponse401 = CommonError;

/** Request parts for `GET /auth/me/llm-sources/:id/discovery` (schema/http/health-auth.schema.json). */
export type GetAuthMeLlmSourcesIdDiscoveryRequest = {
  params: {
    id: string;
  };
};

export type GetAuthMeLlmSourcesIdDiscoveryResponse200 = Discovery;

export type GetAuthMeLlmSourcesIdDiscoveryResponse401 = CommonError;

export type GetAuthMeLlmSourcesIdDiscoveryResponse404 = CommonError;

/** Request parts for `GET /auth/me/mcp-plugins` (schema/http/health-auth.schema.json). */
export type GetAuthMeMcpPluginsRequest = Record<string, never>;

export type GetAuthMeMcpPluginsResponse200 = {
  plugins: McpPlugin[];
};

export type GetAuthMeMcpPluginsResponse401 = CommonError;

/** Request parts for `GET /auth/me/mcp-plugins/catalog` (schema/http/health-auth.schema.json). */
export type GetAuthMeMcpPluginsCatalogRequest = Record<string, never>;

export type GetAuthMeMcpPluginsCatalogResponse200 = {
  servers: CatalogEntry[];
};

export type GetAuthMeMcpPluginsCatalogResponse401 = CommonError;

/** Request parts for `GET /auth/me/mcp-plugins/claude-sources` (schema/http/health-auth.schema.json). */
export type GetAuthMeMcpPluginsClaudeSourcesRequest = Record<string, never>;

export type GetAuthMeMcpPluginsClaudeSourcesResponse200 = {
  servers: ClaudeSource[];
};

export type GetAuthMeMcpPluginsClaudeSourcesResponse401 = CommonError;

/** Request parts for `GET /auth/me/mcp-plugins/codex-sources` (schema/http/health-auth.schema.json). */
export type GetAuthMeMcpPluginsCodexSourcesRequest = Record<string, never>;

export type GetAuthMeMcpPluginsCodexSourcesResponse200 = {
  servers: CodexSource[];
};

export type GetAuthMeMcpPluginsCodexSourcesResponse401 = CommonError;

/** Request parts for `GET /auth/me/mcp-plugins/updates` (schema/http/health-auth.schema.json). */
export type GetAuthMeMcpPluginsUpdatesRequest = Record<string, never>;

export type GetAuthMeMcpPluginsUpdatesResponse200 = {
  checkedAt: string;
  servers: McpUpdate[];
};

export type GetAuthMeMcpPluginsUpdatesResponse401 = CommonError;

/** Request parts for `POST /auth/me/mcp-plugins/add` (schema/http/health-auth.schema.json). */
export type PostAuthMeMcpPluginsAddRequest = {
  body: {
    catalogId?: string;
    /** the catalog entry's requiresArg value */
    arg?: string;
    [key: string]: unknown;
  };
};

export type PostAuthMeMcpPluginsAddResponse200 = {
  plugin: McpAdded;
  pinned?: boolean;
};

export type PostAuthMeMcpPluginsAddResponse400 = CommonError;

export type PostAuthMeMcpPluginsAddResponse401 = CommonError;

/** Request parts for `POST /auth/me/mcp-plugins/consent` (schema/http/health-auth.schema.json). */
export type PostAuthMeMcpPluginsConsentRequest = {
  body: {
    id?: string;
    consented?: boolean;
  };
};

export type PostAuthMeMcpPluginsConsentResponse200 = {
  ok: true;
  consented: boolean;
};

export type PostAuthMeMcpPluginsConsentResponse401 = CommonError;

/** Request parts for `POST /auth/me/mcp-plugins/toggle` (schema/http/health-auth.schema.json). */
export type PostAuthMeMcpPluginsToggleRequest = {
  body: {
    id?: string;
    enabled?: boolean;
  };
};

export type PostAuthMeMcpPluginsToggleResponse200 = {
  ok: true;
  enabled: boolean;
};

export type PostAuthMeMcpPluginsToggleResponse401 = CommonError;

export type PostAuthMeMcpPluginsToggleResponse409 = CommonError;

/** Request parts for `GET /auth/me/mcp-plugins/:id/resync` (schema/http/health-auth.schema.json). */
export type GetAuthMeMcpPluginsIdResyncRequest = {
  params: {
    id: string;
  };
};

export type GetAuthMeMcpPluginsIdResyncResponse200 = unknown;

export type GetAuthMeMcpPluginsIdResyncResponse400 = CommonError;

export type GetAuthMeMcpPluginsIdResyncResponse401 = CommonError;

export type GetAuthMeMcpPluginsIdResyncResponse404 = CommonError;

/** Request parts for `POST /auth/me/mcp-plugins/:id/resync` (schema/http/health-auth.schema.json). */
export type PostAuthMeMcpPluginsIdResyncRequest = {
  params: {
    id: string;
  };
};

export type PostAuthMeMcpPluginsIdResyncResponse200 = unknown;

export type PostAuthMeMcpPluginsIdResyncResponse400 = CommonError;

export type PostAuthMeMcpPluginsIdResyncResponse401 = CommonError;

export type PostAuthMeMcpPluginsIdResyncResponse404 = CommonError;

/** Request parts for `POST /auth/me/mcp-plugins/:id/update` (schema/http/health-auth.schema.json). */
export type PostAuthMeMcpPluginsIdUpdateRequest = {
  params: {
    id: string;
  };
};

export type PostAuthMeMcpPluginsIdUpdateResponse200 = {
  ok: true;
  from?: string;
  to?: string;
};

export type PostAuthMeMcpPluginsIdUpdateResponse401 = CommonError;

export type PostAuthMeMcpPluginsIdUpdateResponse404 = CommonError;

/** Request parts for `DELETE /auth/me/mcp-plugins/:id` (schema/http/health-auth.schema.json). */
export type DeleteAuthMeMcpPluginsIdRequest = {
  params: {
    id: string;
  };
};

export type DeleteAuthMeMcpPluginsIdResponse200 = HealthAuthOk;

export type DeleteAuthMeMcpPluginsIdResponse401 = CommonError;

export type DeleteAuthMeMcpPluginsIdResponse404 = CommonError;

/** Request parts for `GET /auth/me/connectors` (schema/http/health-auth.schema.json). */
export type GetAuthMeConnectorsRequest = Record<string, never>;

export type GetAuthMeConnectorsResponse200 = {
  connectors: ConnectorEntry[];
};

export type GetAuthMeConnectorsResponse401 = CommonError;

/** Request parts for `GET /auth/me/connectors/catalog` (schema/http/health-auth.schema.json). */
export type GetAuthMeConnectorsCatalogRequest = Record<string, never>;

export type GetAuthMeConnectorsCatalogResponse200 = {
  catalog: ConnectorEntry[];
};

export type GetAuthMeConnectorsCatalogResponse401 = CommonError;

/** Request parts for `POST /auth/me/connectors/add` (schema/http/health-auth.schema.json). */
export type PostAuthMeConnectorsAddRequest = {
  body: {
    id?: string;
  };
};

export type PostAuthMeConnectorsAddResponse200 = {
  ok: true;
  id: string;
};

export type PostAuthMeConnectorsAddResponse400 = CommonError;

export type PostAuthMeConnectorsAddResponse401 = CommonError;

/** Request parts for `DELETE /auth/me/connectors/:id` (schema/http/health-auth.schema.json). */
export type DeleteAuthMeConnectorsIdRequest = {
  params: {
    id: string;
  };
};

export type DeleteAuthMeConnectorsIdResponse200 = {
  ok: true;
  id: string;
};

export type DeleteAuthMeConnectorsIdResponse401 = CommonError;

/** Request parts for `POST /kb/index/notes` (schema/http/index.schema.json). */
export type PostKbIndexNotesRequest = {
  body: {
    projectId?: string;
    /** At most 50 per batch (BATCH_TOO_LARGE, 400); a body over 1 MB is 413 PAYLOAD_TOO_LARGE; a note body over 512 KiB is a 400. */
    notes: Note[];
  };
};

export type PostKbIndexNotesResponse200 = {
  /** Rows written (new or changed). */
  upserted: number;
  /** Rows whose content already matched; nothing was written. */
  unchanged: number;
  skippedHidden: number;
  /** Rows whose body was capped at 200 KiB. */
  truncated: number;
  /** Rows removed because the note is now hidden (it was indexed while visible). */
  removed: number;
};

export type PostKbIndexNotesResponse400 = CommonError;

/** Request parts for `POST /kb/index/reconcile` (schema/http/index.schema.json). */
export type PostKbIndexReconcileRequest = {
  body: {
    projectId?: string;
    /** At most 20 000 entries. */
    manifest: ManifestEntry[];
    /** true deletes the extra rows. Default false: report only. */
    prune?: boolean;
    /** Keys the Mac could not index (unparseable, unavailable, unsendable). They are never pruned and are not reported as extra. At most 20 000. */
    keep?: string[];
    /** Required with prune: true and an empty manifest. Without it that request is refused (409 EMPTY_MANIFEST_REFUSED), so an emptied or unmounted folder cannot delete the index. */
    allowEmpty?: boolean;
  };
};

export type PostKbIndexReconcileResponse200 = {
  /** In the manifest, not indexed. */
  missing: string[];
  /** Indexed with a different content hash. */
  stale: string[];
  /** Indexed, not in the manifest. */
  extra: string[];
  /** Rows deleted (only with prune true). */
  pruned: number;
};

export type PostKbIndexReconcileResponse400 = CommonError;

export type PostKbIndexReconcileResponse409 = CommonError;

/** Request parts for `DELETE /kb/index/notes/:key` (schema/http/index.schema.json). */
export type DeleteKbIndexNotesKeyRequest = {
  query: {
    projectId?: string;
  };
  params: {
    /** The note key, percent-encoded. */
    key: string;
  };
};

export type DeleteKbIndexNotesKeyResponse200 = {
  deleted: boolean;
};

export type DeleteKbIndexNotesKeyResponse400 = CommonError;

/** Request parts for `GET /kb/index/search` (schema/http/index.schema.json). */
export type GetKbIndexSearchRequest = {
  query: {
    /** 1 to 200 characters. Words of 2+ characters are matched against title and the redacted body; a query with none returns no results. */
    q: string;
    /** Integer 1 to 50; the default is 20. */
    limit?: string;
    /** At most 200 characters. Omit to search every project of the user. */
    projectId?: string;
  };
};

export type GetKbIndexSearchResponse200 = {
  /** Best match first. Only the caller's own notes. */
  results: {
    noteKey: string;
    title: string;
    /** Plain text, at most about 200 characters around the first matched word: control, bidi and zero-width characters removed, secrets redacted. Never markup. */
    snippet: string;
    /** Note start, ISO. */
    date: string;
    kind: string;
    projectId: string;
  }[];
};

export type GetKbIndexSearchResponse400 = CommonError;

/** Request parts for `GET /kb/index/status` (schema/http/index.schema.json). */
export type GetKbIndexStatusRequest = {
  query: {
    /** Omit for every project of the user. */
    projectId?: string;
  };
};

export type GetKbIndexStatusResponse200 = {
  notes: number;
  /** Search rows written by those notes. */
  ftsRows: number;
  /** true when notes equals ftsRows. */
  consistent: boolean;
  lastIndexedAt: string | null;
};

/** Request parts for `POST /kb/index/scan` (schema/http/index.schema.json). */
export type PostKbIndexScanRequest = {
  body: {
    projectId?: string;
    /** 8 to 64 letters, digits or dashes; one value per scan, chosen by the client. */
    scanId: string;
    /** 0-based chunk number, below total. */
    index: number;
    /** Chunks in the scan (1 to 100). Every chunk of one scan repeats it. */
    total: number;
    /** true on the final chunk: the scan is compared with the index. Default false. */
    complete?: boolean;
    /** true (final chunk only) deletes the rows no chunk named. Default false. */
    prune?: boolean;
    /** At most 500 per chunk. */
    entries: ManifestEntry[];
    /** Final chunk only: the entries the whole scan carries. The server compares it with the sum of the received chunks (409 SCAN_TOTAL_MISMATCH). */
    totalEntries?: number;
    /** Final chunk only: keys never pruned (unindexable on the Mac). */
    keep?: string[];
    /** Final chunk only: an all-empty scan with prune is refused (409 EMPTY_SCAN_REFUSED) unless this is true. */
    allowEmpty?: boolean;
  };
};

export type PostKbIndexScanResponse200 = {
  /** Keys in this chunk that the index lacks. */
  missing: string[];
  /** Keys in this chunk indexed with another hash. */
  stale: string[];
  /** Final chunk only: indexed keys no chunk named. */
  extra: string[];
  /** Final chunk with prune: rows deleted. */
  pruned: number;
  /** Chunks of this scan received so far. */
  received: number;
  total: number;
  complete: boolean;
};

export type PostKbIndexScanResponse400 = CommonError;

export type PostKbIndexScanResponse409 = CommonError;

/** Request parts for `GET /kb/search` (schema/http/kb-sources.schema.json). */
export type GetKbSearchRequest = {
  query: {
    q?: string;
    /** One of meeting, action, decision, blocker, code, ticket, qa, doc, plan, task or outcome; any other value searches every kind. */
    kind?: string;
    /** Capped at 100; zero, negative or non-numeric values give the default 20. */
    limit?: string;
    /** Ignored unless it is a safe id (1-128 letters, digits, underscores or hyphens). */
    projectId?: string;
  };
};

export type GetKbSearchResponse200 = {
  results: SearchHit[];
};

export type GetKbSearchResponse401 = CommonError;

/** Request parts for `GET /kb/issues` (schema/http/kb-sources.schema.json). */
export type GetKbIssuesRequest = {
  query: {
    repo?: string;
    /** Defaults to open; all disables the filter. */
    state?: string;
    /** Defaults to github. */
    provider?: string;
    /** Capped at 100; zero, negative or non-numeric values give the default 20. */
    limit?: string;
  };
};

export type GetKbIssuesResponse200 = {
  issues: Issue[];
};

export type GetKbIssuesResponse401 = CommonError;

/** Request parts for `GET /kb/meeting/:id` (schema/http/kb-sources.schema.json). */
export type GetKbMeetingIdRequest = {
  query: {
    /** Opt-in extras: `transcript` adds the stored transcript text as `transcript`. Any other value is ignored (the handler checks equality only). */
    include?: "transcript";
  };
  params: {
    id: string;
  };
};

export type GetKbMeetingIdResponse200 = Meeting;

export type GetKbMeetingIdResponse400 = CommonError;

export type GetKbMeetingIdResponse401 = CommonError;

export type GetKbMeetingIdResponse404 = CommonError;

/** Request parts for `GET /kb/entity/:id` (schema/http/kb-sources.schema.json). */
export type GetKbEntityIdRequest = {
  params: {
    id: string;
  };
};

export type GetKbEntityIdResponse200 = Entity;

export type GetKbEntityIdResponse400 = CommonError;

export type GetKbEntityIdResponse401 = CommonError;

export type GetKbEntityIdResponse404 = CommonError;

/** Request parts for `GET /kb/project/:id/export` (schema/http/kb-sources.schema.json). */
export type GetKbProjectIdExportRequest = {
  params: {
    id: string;
  };
};

export type GetKbProjectIdExportResponse200 = ProjectExport;

export type GetKbProjectIdExportResponse400 = CommonError;

export type GetKbProjectIdExportResponse401 = CommonError;

/** Request parts for `POST /kb/project/install-skills` (schema/http/kb-sources.schema.json). */
export type PostKbProjectInstallSkillsRequest = {
  body: {
    /** absolute project folder (must hold system/project.json) */
    path?: string;
    language?: string;
    stacks?: string;
  };
};

export type PostKbProjectInstallSkillsResponse200 = unknown;

export type PostKbProjectInstallSkillsResponse400 = CommonError;

export type PostKbProjectInstallSkillsResponse401 = CommonError;

export type PostKbProjectInstallSkillsResponse404 = CommonError;

/** Request parts for `GET /kb/stats` (schema/http/kb-sources.schema.json). */
export type GetKbStatsRequest = Record<string, never>;

export type GetKbStatsResponse200 = Stats;

export type GetKbStatsResponse401 = CommonError;

/** Request parts for `GET /kb/system/status` (schema/http/kb-sources.schema.json). */
export type GetKbSystemStatusRequest = Record<string, never>;

export type GetKbSystemStatusResponse200 = SystemStatus;

export type GetKbSystemStatusResponse401 = CommonError;

/** Request parts for `GET /kb/export-all` (schema/http/kb-sources.schema.json). */
export type GetKbExportAllRequest = {
  query: {
    /** meeting id to resume after */
    cursor?: string;
    /** Capped at 500; an absent value gives 100, and 0 or a non-numeric value is not replaced by the default. */
    limit?: string;
  };
};

/** application/x-ndjson: one JSON record per line (meeting with its entities), then a final {done, next_cursor} line; next_cursor is null on the last page */
export type GetKbExportAllResponse200 = string;

export type GetKbExportAllResponse401 = CommonError;

/** Request parts for `POST /kb/delete` (schema/http/kb-sources.schema.json). */
export type PostKbDeleteRequest = {
  body: {
    /** meeting id */
    id?: string;
  };
};

export type PostKbDeleteResponse200 = KbSourcesOk;

export type PostKbDeleteResponse400 = CommonError;

export type PostKbDeleteResponse401 = CommonError;

/** Request parts for `DELETE /kb/delete` (schema/http/kb-sources.schema.json). */
export type DeleteKbDeleteRequest = {
  body: {
    /** meeting id */
    id?: string;
  };
};

export type DeleteKbDeleteResponse200 = KbSourcesOk;

export type DeleteKbDeleteResponse400 = CommonError;

export type DeleteKbDeleteResponse401 = CommonError;

/** Request parts for `POST /kb/ingest` (schema/http/kb-sources.schema.json). */
export type PostKbIngestRequest = {
  body: {
    id?: string;
    title?: string;
    date?: string;
    language?: string;
    participants?: string[];
    /** seconds */
    duration?: number;
    transcript?: string;
    entities?: {
      id?: string;
      kind?: string;
      text?: string;
      quote?: string;
      /** kind-specific metadata, stored as given */
      meta?: Record<string, unknown>;
    }[];
    /** stored as meta.projectId; scopes search and project export */
    projectId?: string;
  };
};

export type PostKbIngestResponse200 = IngestResult;

export type PostKbIngestResponse400 = CommonError;

export type PostKbIngestResponse401 = CommonError;

/** Request parts for `POST /kb/connect-git` (schema/http/kb-sources.schema.json). */
export type PostKbConnectGitRequest = {
  body: {
    /** Absolute path to the repo root (must be on user allow-list) */
    path?: string;
    /** Replace existing code chunks for this repo; default true. */
    replace?: boolean;
  };
};

export type PostKbConnectGitResponse200 = GitIndex;

export type PostKbConnectGitResponse400 = CommonError;

export type PostKbConnectGitResponse401 = CommonError;

export type PostKbConnectGitResponse403 = CommonError;

/** Request parts for `POST /kb/ingest-scip` (schema/http/kb-sources.schema.json). */
export type PostKbIngestScipRequest = {
  body: {
    /** must be on the user's repo allow-list */
    repoPath?: string;
    /** Path to the SCIP index file */
    scipPath?: string;
    /** Replace the repo's existing graph rows; default true. */
    replace?: boolean;
  };
};

export type PostKbIngestScipResponse200 = unknown;

export type PostKbIngestScipResponse400 = CommonError;

export type PostKbIngestScipResponse401 = CommonError;

export type PostKbIngestScipResponse403 = CommonError;

/** Request parts for `POST /kb/connect-github-issues` (schema/http/kb-sources.schema.json). */
export type PostKbConnectGithubIssuesRequest = {
  body: {
    /** owner/name */
    repo?: string;
    /** GitHub PAT (optional — vault github.token used otherwise) */
    token?: string;
    state?: string;
  };
};

export type PostKbConnectGithubIssuesResponse200 = unknown;

export type PostKbConnectGithubIssuesResponse400 = CommonError;

export type PostKbConnectGithubIssuesResponse401 = CommonError;

/** Request parts for `POST /kb/connect-tickets-json` (schema/http/kb-sources.schema.json). */
export type PostKbConnectTicketsJsonRequest = {
  body: {
    /** Source label stored on each ticket entity; default manual. */
    provider?: string;
    /** Array of ticket objects (max 8 MB body) */
    tickets?: {
      id?: string;
      title?: string;
      body?: string;
      url?: string;
      /** provider-specific ticket fields, merged into the stored meta */
      meta?: Record<string, unknown>;
    }[];
  };
};

export type PostKbConnectTicketsJsonResponse200 = TicketIndex;

export type PostKbConnectTicketsJsonResponse400 = CommonError;

export type PostKbConnectTicketsJsonResponse401 = CommonError;

/** Request parts for `POST /kb/connect-qa` (schema/http/kb-sources.schema.json). */
export type PostKbConnectQaRequest = {
  body: {
    /** JUnit XML string */
    xml?: string;
    /** Optional label for the test run source */
    source?: string;
  };
};

export type PostKbConnectQaResponse200 = QaIndex;

export type PostKbConnectQaResponse400 = CommonError;

export type PostKbConnectQaResponse401 = CommonError;

/** Request parts for `POST /kb/email/test` (schema/http/kb-sources.schema.json). */
export type PostKbEmailTestRequest = {
  body: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    /** typed app password, probed without saving it */
    password?: string;
    mailbox?: string;
    /** password | google */
    authMethod?: string;
  };
};

export type PostKbEmailTestResponse200 = unknown;

export type PostKbEmailTestResponse400 = CommonError;

export type PostKbEmailTestResponse401 = CommonError;

export type PostKbEmailTestResponse502 = CommonError;

/** Request parts for `POST /kb/email/fetch` (schema/http/kb-sources.schema.json). */
export type PostKbEmailFetchRequest = {
  body: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    mailbox?: string;
    /** password | google */
    authMethod?: string;
    /** How many days back to look */
    lookbackDays?: number;
    /** default true */
    unreadOnly?: boolean;
    /** Filter by sender address substring */
    fromFilter?: string;
    markRead?: boolean;
  };
};

export type PostKbEmailFetchResponse200 = unknown;

export type PostKbEmailFetchResponse400 = CommonError;

export type PostKbEmailFetchResponse401 = CommonError;

export type PostKbEmailFetchResponse502 = CommonError;

/** Request parts for `POST /kb/email/seen` (schema/http/kb-sources.schema.json). */
export type PostKbEmailSeenRequest = {
  body: {
    /** IMAP message IDs to mark as seen */
    messageIds?: string[];
    /** advances the forward-only high-water mark when it parses as a date */
    lastFetchedAt?: string;
  };
};

export type PostKbEmailSeenResponse200 = KbSourcesOk;

export type PostKbEmailSeenResponse401 = CommonError;

/** Request parts for `POST /kb/email/classify` (schema/http/kb-sources.schema.json). */
export type PostKbEmailClassifyRequest = {
  body: {
    subject?: string;
    body?: string;
  };
};

export type PostKbEmailClassifyResponse200 = unknown;

export type PostKbEmailClassifyResponse400 = CommonError;

export type PostKbEmailClassifyResponse401 = CommonError;

/** Request parts for `POST /kb/slack/test` (schema/http/kb-sources.schema.json). */
export type PostKbSlackTestRequest = {
  body: {
    /** typed Slack token, probed without saving it; the probe needs the network */
    token?: string;
  };
};

export type PostKbSlackTestResponse200 = unknown;

export type PostKbSlackTestResponse400 = CommonError;

export type PostKbSlackTestResponse401 = CommonError;

export type PostKbSlackTestResponse502 = unknown;

/** Request parts for `POST /kb/slack/fetch` (schema/http/kb-sources.schema.json). */
export type PostKbSlackFetchRequest = {
  body: {
    channelId?: string;
    lookbackDays?: number;
  };
};

export type PostKbSlackFetchResponse200 = unknown;

export type PostKbSlackFetchResponse400 = CommonError;

export type PostKbSlackFetchResponse401 = CommonError;

export type PostKbSlackFetchResponse502 = unknown;

/** Request parts for `POST /kb/slack/seen` (schema/http/kb-sources.schema.json). */
export type PostKbSlackSeenRequest = {
  body: {
    channelId?: string;
    messageTs?: string[];
    /** Slack timestamp; advances the channel high-water mark when it is a positive number */
    lastTs?: string;
  };
};

export type PostKbSlackSeenResponse200 = KbSourcesOk;

export type PostKbSlackSeenResponse401 = CommonError;

/** Request parts for `GET /kb/slack/conversations` (schema/http/kb-sources.schema.json). */
export type GetKbSlackConversationsRequest = Record<string, never>;

export type GetKbSlackConversationsResponse200 = unknown;

export type GetKbSlackConversationsResponse400 = CommonError;

export type GetKbSlackConversationsResponse401 = CommonError;

/** Request parts for `POST /kb/box/test` (schema/http/kb-sources.schema.json). */
export type PostKbBoxTestRequest = {
  body: {
    clientId?: string;
    /** user | enterprise (default enterprise) */
    subjectType?: string;
    subjectId?: string;
    folderId?: string;
  };
};

export type PostKbBoxTestResponse200 = unknown;

export type PostKbBoxTestResponse400 = CommonError;

export type PostKbBoxTestResponse401 = CommonError;

export type PostKbBoxTestResponse502 = unknown;

/** Request parts for `POST /kb/connect-box` (schema/http/kb-sources.schema.json). */
export type PostKbConnectBoxRequest = {
  body: {
    clientId?: string;
    /** user | enterprise (default enterprise) */
    subjectType?: string;
    subjectId?: string;
    folderId?: string;
  };
};

export type PostKbConnectBoxResponse200 = unknown;

export type PostKbConnectBoxResponse400 = CommonError;

export type PostKbConnectBoxResponse401 = CommonError;

export type PostKbConnectBoxResponse502 = unknown;

/** Request parts for `POST /kb/mcp-connector/test` (schema/http/kb-sources.schema.json). */
export type PostKbMcpConnectorTestRequest = {
  body: {
    /** connector id from mcp-connector-defs (for example miro) */
    id?: string;
  };
};

export type PostKbMcpConnectorTestResponse200 = unknown;

export type PostKbMcpConnectorTestResponse400 = CommonError;

export type PostKbMcpConnectorTestResponse401 = CommonError;

export type PostKbMcpConnectorTestResponse502 = unknown;

/** Request parts for `POST /kb/mcp-connector/fetch` (schema/http/kb-sources.schema.json). */
export type PostKbMcpConnectorFetchRequest = {
  body: {
    id?: string;
    /** 1 to 200 */
    limit?: number;
  };
};

export type PostKbMcpConnectorFetchResponse200 = unknown;

export type PostKbMcpConnectorFetchResponse400 = CommonError;

export type PostKbMcpConnectorFetchResponse401 = CommonError;

export type PostKbMcpConnectorFetchResponse502 = unknown;

/** Request parts for `POST /kb/mcp-connector/seen` (schema/http/kb-sources.schema.json). */
export type PostKbMcpConnectorSeenRequest = {
  body: {
    id?: string;
    itemIds?: string[];
  };
};

export type PostKbMcpConnectorSeenResponse200 = {
  ok: true;
  /** Rows actually inserted; re-marking is a no-op */
  marked: number;
};

export type PostKbMcpConnectorSeenResponse401 = CommonError;

/** Request parts for `POST /kb/mcp-connector/classify` (schema/http/kb-sources.schema.json). */
export type PostKbMcpConnectorClassifyRequest = {
  body: {
    body?: {
      connectorId?: string;
      title?: string;
      date?: string;
      text?: string;
    };
  };
};

export type PostKbMcpConnectorClassifyResponse200 = unknown;

export type PostKbMcpConnectorClassifyResponse400 = CommonError;

export type PostKbMcpConnectorClassifyResponse401 = CommonError;

export type PostKbMcpConnectorClassifyResponse502 = unknown;

/** Request parts for `GET /kb/activity` (schema/http/kb-sources.schema.json). */
export type GetKbActivityRequest = {
  query: {
    /** Returns items with an id greater than this value; an absent or non-numeric value means 0. */
    since?: string;
    /** Clamped to 1-200; the default is 100 when absent or zero. */
    limit?: string;
  };
};

export type GetKbActivityResponse200 = {
  items: ActivityItem[];
  unread: number;
  lastId: number;
};

export type GetKbActivityResponse401 = CommonError;

/** Request parts for `POST /kb/activity` (schema/http/kb-sources.schema.json). */
export type PostKbActivityRequest = {
  body: {
    /** must be one of ACTIVITY_KINDS (kb/activity.mjs) */
    kind?: string;
    title?: string;
    /** kind-specific detail */
    detail?: Record<string, unknown>;
    link?: string;
  };
};

export type PostKbActivityResponse200 = {
  ok: true;
  id: number;
};

export type PostKbActivityResponse400 = CommonError;

export type PostKbActivityResponse401 = CommonError;

/** Request parts for `POST /kb/activity/seen` (schema/http/kb-sources.schema.json). */
export type PostKbActivitySeenRequest = {
  body: {
    /** mark every activity item up to this id as seen */
    uptoId?: number;
  };
};

export type PostKbActivitySeenResponse200 = {
  ok: true;
  unread: number;
};

export type PostKbActivitySeenResponse401 = CommonError;

/** Request parts for `GET /kb/agent/working-state` (schema/http/lifecycle.schema.json). */
export type GetKbAgentWorkingStateRequest = Record<string, never>;

export type GetKbAgentWorkingStateResponse200 = {
  sessions: WorkingChat[];
  purges: {
    /** Tombstones still retrying (with backoff). */
    pending: number;
    /** Tombstones that gave up after the attempt cap; resolve them, they do not retry. */
    failed: {
      chatSessionId: string;
      attempts: number;
    }[];
  };
};

/** Request parts for `POST /agent/v2/sessions/purge` (schema/http/lifecycle.schema.json). */
export type PostAgentV2SessionsPurgeRequest = {
  body: {
    /** Up to 500 non-empty chat ids. Every chat needs an archive receipt (a server commit, or POST /kb/archive-receipts); otherwise 409 NO_RECEIPT and nothing is purged. */
    chatSessionIds: string[];
    /** Must be true: the caller has checked the Mac file. Any other value is a 400 VALIDATION_FAILED. */
    verified: boolean;
    /** The Mac file is gone: no receipt is needed, ONLY working state is removed, and a chat that still has server chat rows is refused (listed in refused). */
    orphan?: boolean;
  };
};

export type PostAgentV2SessionsPurgeResponse200 = {
  /** Chats whose working state was removed. Unknown ids count as zero; the call is idempotent. */
  purged: number;
  /** Chats with a turn running right now: not purged, retry later. */
  busy: string[];
  /** Chats used after their receipt was written: not purged, the caller must verify the file again. */
  staleReceipt: string[];
  /** orphan only: chats that still have server rows and were not touched. */
  refused?: string[];
};

export type PostAgentV2SessionsPurgeResponse400 = CommonError;

export type PostAgentV2SessionsPurgeResponse409 = CommonError;

/** Request parts for `POST /kb/session-purges` (schema/http/lifecycle.schema.json). */
export type PostKbSessionPurgesRequest = {
  body: {
    chatSessionId: string;
    /** user_delete (default) or meeting_end. Any other value is a 400 VALIDATION_FAILED. */
    reason?: string;
    /** ISO time of the user's delete (kept across retries; the earliest time wins, for the reuse guard). Ignored when in the future or older than a year. */
    requestedAt?: string;
  };
};

export type PostKbSessionPurgesResponse202 = {
  /** The tombstone is durable before the purge is attempted. */
  queued: true;
  /** done: working state, transcripts and server chat rows are gone. pending: retried later with backoff. failed: gave up after the attempt cap (see working-state). */
  purged: "done" | "pending" | "failed";
  /** A turn is running on the chat: the tombstone stays pending. */
  busy?: boolean;
  /** The chat was used after the delete was requested: kept, tombstone dropped. */
  skippedReused?: boolean;
};

export type PostKbSessionPurgesResponse400 = CommonError;

/** Request parts for `POST /kb/chat/sessions/:id/archive/begin` (schema/http/lifecycle.schema.json). */
export type PostKbChatSessionsIdArchiveBeginRequest = {
  query: {
    /** A continuation page: the seq of the last message on the previous page. Needs fence. */
    after?: number;
    /** The fence of the initial begin. Required with after; a mismatch is 409 ARCHIVE_STALE. */
    fence?: number;
    /** Messages per page: default 200, at most 500. A page is also cut at about 8 MB. */
    limit?: number;
  };
  params: {
    id: string;
  };
};

export type PostKbChatSessionsIdArchiveBeginResponse200 = {
  /** Bumped by every begin. The commit must present it. */
  fence: number;
  count: number;
  /** 64 lower-case hex: the digest of ALL the chat's messages, streamed (not just this page). */
  hash: string;
  session: {
    id: string;
    title: string;
    surface: string;
    mode: string;
    projectId: string | null;
    createdAt: number;
    updatedAt: number;
  };
  /** Every message, in order. No cap (plan Q8). */
  messages: ArchiveMessage[];
  incomplete: {
    /** True when the live store dropped messages (the 2000-message prune or the 64 KB content cap). The commit refuses unless acceptIncomplete is sent. */
    incomplete: boolean;
    prunedMessages: number;
    truncatedMessages: number;
  };
  /** The seq to pass as after for the next page, or null on the last page. */
  nextAfter: number | null;
};

export type PostKbChatSessionsIdArchiveBeginResponse404 = CommonError;

export type PostKbChatSessionsIdArchiveBeginResponse409 = CommonError;

/** Request parts for `POST /kb/chat/sessions/:id/archive/commit` (schema/http/lifecycle.schema.json). */
export type PostKbChatSessionsIdArchiveCommitRequest = {
  params: {
    id: string;
  };
  body: {
    fence: number;
    /** The 64-hex hash the begin returned, recomputed over the file the Mac wrote. */
    hash: string;
    /** Archive a chat the caps made incomplete. Without it such a commit is 409 INCOMPLETE_ARCHIVE. */
    acceptIncomplete?: boolean;
  };
};

export type PostKbChatSessionsIdArchiveCommitResponse200 = {
  /** True when this call removed the rows. */
  deleted: boolean;
  /** already_archived: the chat is gone and a receipt with this hash says it was archived (idempotent). A chat that is gone without such a receipt is 404. */
  status: "deleted" | "already_archived";
};

export type PostKbChatSessionsIdArchiveCommitResponse400 = CommonError;

export type PostKbChatSessionsIdArchiveCommitResponse404 = CommonError;

export type PostKbChatSessionsIdArchiveCommitResponse409 = CommonError;

/** Request parts for `POST /kb/live/:id/ack` (schema/http/lifecycle.schema.json). */
export type PostKbLiveIdAckRequest = {
  params: {
    id: string;
  };
  body: {
    /** The relative path of the Mac note that holds the capture. */
    noteKey: string;
    /** SHA-256 of the verified file. */
    hash: string;
    /** Transcript lines in the verified file. */
    lines: number;
  };
};

export type PostKbLiveIdAckResponse200 = {
  sessionId: string;
  state: "acked";
  ackedAt: string;
  /** True when this capture was already acked. */
  idempotent: boolean;
};

export type PostKbLiveIdAckResponse400 = CommonError;

export type PostKbLiveIdAckResponse404 = CommonError;

export type PostKbLiveIdAckResponse409 = CommonError;

/** Request parts for `GET /kb/live/:id/status` (schema/http/lifecycle.schema.json). */
export type GetKbLiveIdStatusRequest = {
  params: {
    id: string;
  };
};

export type GetKbLiveIdStatusResponse200 = {
  sessionId: string;
  /** live: still capturing (a live session wins over any ack). finalized: waiting for the ack; durable says whether a restart keeps it. acked: the Mac acked it. expired: not acked within 7 days, the capture was dropped and logged. unknown: the server has no record; the extension keeps its draft. */
  state: "live" | "finalized" | "acked" | "expired" | "unknown";
  /** True when a finalized capture is stored durably (survives a restart). */
  durable: boolean;
  /** When an unacked durable capture expires (7 days after finalize). */
  expiresAt: string | null;
  /** Lines the server holds (finalized) or held when acked. */
  lines?: number;
  /** The ack hash: SHA-256 of the redacted transcript. */
  hash?: string;
  /** SHA-256 of the sanitized (speaker, text) lines before redaction: what the extension recomputes. Null for a capture finalized before migration 0051. */
  captionHash?: string | null;
  /** Language stored with the capture. */
  language?: string;
  /** Capture start, Unix ms. */
  startedAt?: number | null;
};

/** Request parts for `GET /kb/live/unacked` (schema/http/lifecycle.schema.json). */
export type GetKbLiveUnackedRequest = Record<string, never>;

export type GetKbLiveUnackedResponse200 = {
  sessions: ({
    sessionId: string;
    meetingTitle: string;
    startedAt: number | string;
    /** Null for a database-only capture (after a restart); read its transcript from the meeting. */
    captionCount: number | null;
    source: "memory" | "database";
    /** Only for database-source rows. */
    durationSec?: number;
    /** Caption lines the server holds. The ack must echo it. */
    lines: number;
    /** SHA-256 (64 hex) of the redacted transcript the server holds. The ack must echo it. */
    hash: string;
    durable: boolean;
    /** Database-source rows only. */
    expiresAt?: string;
    /** Language stored with the capture. */
    language?: string;
  })[];
};

/** Request parts for `POST /kb/archive-receipts` (schema/http/lifecycle.schema.json). */
export type PostKbArchiveReceiptsRequest = {
  body: {
    chatSessionId: string;
    /** 64 lower-case hex: the archive hash the Mac computed over the file it wrote. */
    hash: string;
    /** Messages in that file. */
    count: number;
  };
};

export type PostKbArchiveReceiptsResponse200 = {
  /** The receipt is stored; purging the chat's working state is now allowed. */
  recorded: true;
};

export type PostKbArchiveReceiptsResponse400 = CommonError;

/** Request parts for `POST /kb/loop/agent-run` (schema/http/live-loop-misc.schema.json). */
export type PostKbLoopAgentRunRequest = {
  body: {
    /** The composed Loop instruction (max 200000 chars) */
    message?: string;
    /** a string is refused with 400 (must be an array of ids) */
    skills?: string[] | string;
    /** Absolute path of the run's git root (the worktree in worktree mode) */
    repoRoot?: string;
    /** Absolute paths of project llm-doc/ directories the run may also read and edit (split layout) */
    extraRoots?: string[];
    language?: string;
    model?: string;
    /** "anthropic" or an Anthropic-compatible "custom:<id>" (one with an anthropicBaseURL). Absent = first-party Anthropic */
    provider?: string;
    timeoutMs?: number;
  };
};

/** The Loop step's result. The 200 fixtures are produced in-process (routes/loop-agent.mjs with the engine seam stubbed). The result fields are the engine's runLoopAgent return, forwarded verbatim by the route. */
export type PostKbLoopAgentRunResponse200 = {
  /** The agent's closing summary */
  reply: string;
  /** Repo-relative paths the agent's Edit/Write calls changed */
  changedPaths: string[];
  /** Absolute paths changed inside an accepted extra root */
  changedExtraPaths: string[];
  /** The subset of changedPaths a Write created (the file did not exist before the call) */
  createdPaths: string[];
  usage: LoopUsage;
  resolvedSkills: string[];
  unresolvedSkills: string[];
  /** Resolved skills longer than the cap; only their head was sent */
  truncatedSkills: string[];
  ran: boolean;
  /** The SDK result subtype (success, error_max_turns, …), or no_progress when LLM-IDE stopped the step: the same tool call repeated more than three times with no file change in between, or five tool calls in a row failed. */
  resultSubtype: string | null;
  denied: {
    toolName: string;
    reason: string;
  }[];
  /** Present only with resultSubtype no_progress — why the step was stopped */
  noProgressReason?: string;
};

export type PostKbLoopAgentRunResponse400 = CommonError;

export type PostKbLoopAgentRunResponse401 = CommonError;

export type PostKbLoopAgentRunResponse404 = FeatureDisabled;

export type PostKbLoopAgentRunResponse502 = CommonError;

export type PostKbLoopAgentRunResponse503 = CommonError;

export type PostKbLoopAgentRunResponse504 = CommonError;

/** Request parts for `POST /kb/ingest-code-graph` (schema/http/live-loop-misc.schema.json). */
export type PostKbIngestCodeGraphRequest = {
  body: {
    /** Absolute path to the repo root (must be on user allow-list) */
    repoPath?: string;
    graph?: {
      nodes?: CodeGraphNode[];
      edges?: CodeGraphEdge[];
    };
    /** Clear this producer's existing rows for the repo first (first batch only) */
    replace?: boolean;
    /** Git commit the graph was generated from (7-64 hex); find-code compares it to HEAD to warn about a stale graph */
    commitSha?: string;
    /** ISO-8601 time the graph was generated */
    generatedAt?: string;
  };
};

export type PostKbIngestCodeGraphResponse200 = {
  ok: true;
  /** canonical repo path */
  repo: string;
  /** nodes written */
  nodes: number;
  /** edges written */
  edges: number;
  droppedNodes: number;
  droppedEdges: number;
  replaced: boolean;
};

export type PostKbIngestCodeGraphResponse400 = CommonError;

export type PostKbIngestCodeGraphResponse401 = CommonError;

export type PostKbIngestCodeGraphResponse403 = CommonError;

export type PostKbIngestCodeGraphResponse404 = FeatureDisabled;

/** Request parts for `GET /kb/issue-schedule` (schema/http/live-loop-misc.schema.json). */
export type GetKbIssueScheduleRequest = {
  query: {
    provider?: string;
    repo?: string;
  };
};

export type GetKbIssueScheduleResponse200 = {
  schedules: ScheduleItem[];
  count: number;
};

export type GetKbIssueScheduleResponse400 = CommonError;

export type GetKbIssueScheduleResponse401 = CommonError;

export type GetKbIssueScheduleResponse404 = FeatureDisabled;

/** Request parts for `PUT /kb/issue-schedule` (schema/http/live-loop-misc.schema.json). */
export type PutKbIssueScheduleRequest = {
  body: {
    provider?: string;
    /** "owner/name" */
    repo?: string;
    issueNumber?: number;
    /** YYYY-MM-DD or null to clear */
    startDate?: string | null;
    /** YYYY-MM-DD or null to clear */
    dueDate?: string | null;
    estimateDays?: number | null;
    /** issue numbers */
    dependsOn?: number[];
  };
};

export type PutKbIssueScheduleResponse200 = ScheduleItem;

export type PutKbIssueScheduleResponse400 = CommonError;

export type PutKbIssueScheduleResponse401 = CommonError;

export type PutKbIssueScheduleResponse404 = FeatureDisabled;

/** Request parts for `DELETE /kb/issue-schedule` (schema/http/live-loop-misc.schema.json). */
export type DeleteKbIssueScheduleRequest = {
  body: {
    provider?: string;
    repo?: string;
    /** a non-integer is refused with 400 VALIDATION_FAILED */
    issueNumber?: number | string;
  };
};

export type DeleteKbIssueScheduleResponse200 = {
  /** false when no schedule existed */
  deleted: boolean;
};

export type DeleteKbIssueScheduleResponse400 = CommonError;

export type DeleteKbIssueScheduleResponse401 = CommonError;

export type DeleteKbIssueScheduleResponse404 = FeatureDisabled;

/** Request parts for `GET /kb/live/sessions` (schema/http/live-loop-misc.schema.json). */
export type GetKbLiveSessionsRequest = Record<string, never>;

export type GetKbLiveSessionsResponse200 = {
  sessions: LiveSession[];
};

export type GetKbLiveSessionsResponse401 = CommonError;

/** Request parts for `GET /kb/live/:id` (schema/http/live-loop-misc.schema.json). */
export type GetKbLiveIdRequest = {
  query: {
    /** decimal caption sequence; captions after it are returned */
    since?: string;
  };
  params: {
    id: string;
  };
};

export type GetKbLiveIdResponse200 = {
  captions: LiveCaption[];
  sequence: number;
  finalized: boolean;
  /** false when the sessionId is unknown (never had captions appended) */
  exists: boolean;
  meetingTitle?: string;
  /** Unix ms timestamp when session was created */
  startedAt?: number;
};

export type GetKbLiveIdResponse401 = CommonError;

/** Request parts for `POST /kb/live/:id/append` (schema/http/live-loop-misc.schema.json). */
export type PostKbLiveIdAppendRequest = {
  params: {
    id: string;
  };
  body: {
    /** Array of caption objects (text, speaker, timestamp, etc.) */
    captions?: {
      speaker?: string;
      text?: string;
      ts?: number;
      source?: string;
      meta?: {
        planTaskId?: string;
        score?: number;
        reason?: string;
      };
    }[];
    meetingTitle?: string;
    /** Unix ms start of the capture (after 2000, not in the future; 400 otherwise). Absent: the earliest caption ts. */
    startedAt?: number;
    /** Language tag of the capture (e.g. ja, en-US); stored with the capture. */
    language?: string;
    /** Capture duration in seconds (0 to 7 days). Absent: newest caption ts minus start. */
    durationSec?: number;
  };
};

export type PostKbLiveIdAppendResponse200 = {
  /** Highest sequence number in the session after this append */
  sequence: number;
  /** Number of caption items accepted (0 when session is already finalized) */
  accepted: number;
  backpressure?: boolean;
  /** Present (true) when the session was already finalized; all captions were dropped */
  finalized?: boolean;
};

export type PostKbLiveIdAppendResponse400 = CommonError;

export type PostKbLiveIdAppendResponse401 = CommonError;

export type PostKbLiveIdAppendResponse429 = RateLimited;

/** Request parts for `POST /kb/live/:id/finalize` (schema/http/live-loop-misc.schema.json). */
export type PostKbLiveIdFinalizeRequest = {
  params: {
    id: string;
  };
  body: {
    /** The COMPLETE transcript. The server sanitizes it, drops empty lines, keeps repeated lines, and holds exactly that for the ack to verify; over 2000 lines is 413 CAPTURE_TOO_LARGE and nothing changes. */
    captions?: {
      speaker?: string;
      text?: string;
      ts?: number;
      source?: string;
    }[];
    /** Replaces the session title. */
    meetingTitle?: string;
    /** Unix ms start of the capture (after 2000, not in the future; 400 otherwise). Absent: the earliest caption ts. */
    startedAt?: number;
    /** Language tag of the capture (e.g. ja, en-US); stored with the capture. */
    language?: string;
    /** Capture duration in seconds (0 to 7 days). Absent: newest caption ts minus start. */
    durationSec?: number;
  };
};

export type PostKbLiveIdFinalizeResponse200 = {
  sessionId: string;
  finalized: true;
  captionCount: number;
  /** the meetings row written by crash-recovery was removed */
  dbCleaned: boolean;
  cleanupError: string | null;
  /** SHA-256 of the held sanitized (speaker, text) lines; the extension recomputes it to verify the copy. */
  captionHash?: string;
} | {
  sessionId: string;
  finalized: true;
  /** 0: the id was never seen, so the route answers the empty summary */
  captionCount: number;
  /** SHA-256 of the held sanitized (speaker, text) lines; the extension recomputes it to verify the copy. */
  captionHash?: string;
};

export type PostKbLiveIdFinalizeResponse400 = CommonError;

export type PostKbLiveIdFinalizeResponse401 = CommonError;

/** Request parts for `GET /kb/live/:id/stream` (schema/http/live-loop-misc.schema.json). */
export type GetKbLiveIdStreamRequest = {
  params: {
    id: string;
  };
};

export type GetKbLiveIdStreamResponse200 = unknown;

export type GetKbLiveIdStreamResponse401 = CommonError;

export type GetKbLiveIdStreamResponse429 = CommonError;

/** Request parts for `GET /auth/me/audit` (schema/http/live-loop-misc.schema.json). */
export type GetAuthMeAuditRequest = {
  query: {
    /** Capped at 500; the default is 100 when absent or zero. */
    limit?: string;
    action?: string;
  };
};

export type GetAuthMeAuditResponse200 = {
  items: AuditItem[];
};

export type GetAuthMeAuditResponse401 = CommonError;

/** Request parts for `POST /auth/me/delete` (schema/http/live-loop-misc.schema.json). */
export type PostAuthMeDeleteRequest = {
  body: {
    password?: string;
  };
};

export type PostAuthMeDeleteResponse200 = {
  ok: true;
  /** rows removed per table */
  counts: Record<string, number>;
};

export type PostAuthMeDeleteResponse401 = CommonError;

/** Request parts for `POST /auth/mcp-connector/start` (schema/http/live-loop-misc.schema.json). */
export type PostAuthMcpConnectorStartRequest = {
  body: {
    /** connector id, e.g. miro */
    id?: string;
  };
};

export type PostAuthMcpConnectorStartResponse200 = unknown;

export type PostAuthMcpConnectorStartResponse400 = CommonError;

export type PostAuthMcpConnectorStartResponse401 = CommonError;

export type PostAuthMcpConnectorStartResponse502 = unknown;

/** Request parts for `GET /auth/mcp-connector/status` (schema/http/live-loop-misc.schema.json). */
export type GetAuthMcpConnectorStatusRequest = {
  query: {
    id?: string;
    /** a sign-in flow started by POST /auth/mcp-connector/start; only its initiator may read it */
    state?: string;
  };
};

export type GetAuthMcpConnectorStatusResponse200 = {
  id: string;
  /** reads the vault: true when this user holds tokens for the connector */
  connected: boolean;
  /** pending, complete, error, or unknown (no flow, or already read) */
  status: string;
  account?: string;
  message?: string;
};

export type GetAuthMcpConnectorStatusResponse400 = CommonError;

export type GetAuthMcpConnectorStatusResponse401 = CommonError;

/** Request parts for `POST /generate-notes` (schema/http/notes-generation.schema.json). */
export type PostGenerateNotesRequest = {
  body: {
    /** Raw meeting transcript text */
    transcript?: string;
    meetingTitle?: string;
    /** Optional — used to scope KB ingest ref */
    meetingId?: string;
    /** BCP-47 locale or display name (e.g. "ja", "Japanese") */
    language?: string;
  };
};

/** The JSON form (no Accept: text/event-stream). The stream form is not specified: its events are chunk and done, carrying the same text, then error on failure, and it is not covered by this schema. */
export type PostGenerateNotesResponse200 = {
  /** Markdown meeting notes. */
  notes: string;
};

export type PostGenerateNotesResponse400 = CommonError;

export type PostGenerateNotesResponse401 = CommonError;

export type PostGenerateNotesResponse429 = CommonError;

export type PostGenerateNotesResponse500 = CommonError;

/** Request parts for `POST /generate-questions` (schema/http/notes-generation.schema.json). */
export type PostGenerateQuestionsRequest = {
  body: {
    transcript?: string;
    /** Names to target; empty = any participant */
    participants?: string[];
    /** At least one type required */
    types?: string[];
    language?: string;
  };
};

export type PostGenerateQuestionsResponse200 = {
  /** Markdown: one H2 section per category used, each a numbered list. */
  questions: string;
};

export type PostGenerateQuestionsResponse400 = CommonError;

export type PostGenerateQuestionsResponse401 = CommonError;

export type PostGenerateQuestionsResponse429 = CommonError;

export type PostGenerateQuestionsResponse500 = CommonError;

/** Request parts for `POST /extract-entities` (schema/http/notes-generation.schema.json). */
export type PostExtractEntitiesRequest = {
  body: {
    transcript?: string;
    participants?: string[];
    meetingTitle?: string;
    language?: string;
  };
};

/** The model's JSON after validation (ai-routes.mjs validate): each array is capped at 30 items and an item without text is dropped. Every key is always present. */
export type PostExtractEntitiesResponse200 = {
  actions: EntityAction[];
  decisions: EntityDecision[];
  blockers: EntityBlocker[];
};

export type PostExtractEntitiesResponse400 = CommonError;

export type PostExtractEntitiesResponse401 = CommonError;

export type PostExtractEntitiesResponse429 = CommonError;

/** The fixture is INTERNAL_ERROR (a runClaude failure, sendError maps it generically). The handler also answers 500 AI_PARSE_FAILED when the model's JSON is unparseable after the retry (ai-routes.mjs, the 'Failed to parse entity JSON' branch); that body is not captured here because it needs a model reply. */
export type PostExtractEntitiesResponse500 = CommonError;

/** Request parts for `POST /generate-doc` (schema/http/notes-generation.schema.json). */
export type PostGenerateDocRequest = {
  body: {
    /** Document title / template identifier */
    templateName?: string;
    /** Ordered list of section headings (max 30); required together with templateName */
    sections?: string[];
    /** Reusable instruction text from a Doc Gen "command" .md file; alone satisfies the templateName+sections requirement */
    command?: string;
    /** Freeform one-off instructions from the prompt bar; combined with template/command, never required on its own */
    prompt?: string;
    /** Source material; non-empty is required, not just present. No item-count limit — sources are capped at 50 000 chars each and the RENDERED source block (headings included) is fitted to a 400 000-char total budget by equal-share water-filling; anything shortened is named in the response's truncated array, and anything that could not be given at least 200 chars is named in omitted */
    sources?: NotesGenerationSource[];
  };
};

/** The generated Markdown and what the source budget could not give the model: names are capped at 50 per list, the counts are exact. The Mac client reads truncated and omitted; their absence would mean an older server. */
export type PostGenerateDocResponse200 = {
  /** Full markdown document */
  content: string;
  /** Names of the sources the total-character budget forced short, capped at 50 entries (server API v52; absent on older servers, which silently kept only the first 20 sources) */
  truncated: string[];
  /** Exact number of shortened sources; never capped, so it can exceed truncated.length */
  truncatedCount: number;
  /** Names of the sources that did not fit the budget at all and were not sent, capped at 50 entries (server API v52). Dropped from the end of the request array, so the client decides what survives by the order it sends */
  omitted: string[];
  /** Exact number of omitted sources; never capped, so it can exceed omitted.length */
  omittedCount: number;
};

export type PostGenerateDocResponse400 = CommonError;

export type PostGenerateDocResponse401 = CommonError;

export type PostGenerateDocResponse429 = CommonError;

export type PostGenerateDocResponse500 = CommonError;

/** Request parts for `POST /generate-docx` (schema/http/notes-generation.schema.json). */
export type PostGenerateDocxRequest = {
  body: {
    transcript?: string;
    meetingTitle?: string;
    meetingId?: string;
    language?: string;
  };
};

/** A .docx attachment named meeting-notes-<YYYY-MM-DD>.docx (Content-Disposition attachment). The body is the Word package bytes and is not described further here. */
export type PostGenerateDocxResponse200 = Blob;

export type PostGenerateDocxResponse400 = CommonError;

export type PostGenerateDocxResponse401 = CommonError;

export type PostGenerateDocxResponse429 = CommonError;

/** Two bodies: INTERNAL_ERROR (a runClaude failure, captured) and AI_PARSE_FAILED when the model's JSON cannot be parsed, and INTERNAL_ERROR with 'Failed to build DOCX: ...' when the docx build throws (export-routes.mjs). Only the first is captured; the others need a model reply or a broken build. */
export type PostGenerateDocxResponse500 = CommonError;

/** Request parts for `POST /chat` (schema/http/notes-generation.schema.json). */
export type PostChatRequest = {
  body: {
    /** User message (max 10 000 chars after sanitization) */
    message?: string;
    transcript?: string;
    /** Prior turns (last 10 used); each item has role and content */
    history?: Turn[];
    language?: string;
  };
};

export type PostChatResponse401 = CommonError;

export type PostChatResponse410 = CommonError;

export type PostChatResponse429 = CommonError;

/** Request parts for `POST /code-assist` (schema/http/notes-generation.schema.json). */
export type PostCodeAssistRequest = {
  body: {
    /** User message (max 20 000 chars after sanitization) */
    message?: string;
    history?: Turn[];
    language?: string;
  };
};

export type PostCodeAssistResponse401 = CommonError;

export type PostCodeAssistResponse410 = CommonError;

export type PostCodeAssistResponse429 = CommonError;

/** Request parts for `POST /code-assist/decision` (schema/http/notes-generation.schema.json). */
export type PostCodeAssistDecisionRequest = {
  body: {
    /** Id from the approval_request progress event */
    requestId?: string;
    /** The legacy chat's agentContext.sessionId. */
    sdkSessionId?: string;
    /** 'always-allow' saves the rule the approval_request's `suggestion` offered — a project-scoped command-prefix rule for shell commands (`npm test`), a project-scoped tool rule for act tools — so later prompt-tier calls it covers skip the approval. No `suggestion` (a compound command) means it allows once. */
    action?: "answer" | "allow" | "deny" | "always-allow";
  };
};

export type PostCodeAssistDecisionResponse401 = CommonError;

export type PostCodeAssistDecisionResponse410 = CommonError;

/** Request parts for `POST /agent-sdk/spike` (schema/http/notes-generation.schema.json). */
export type PostAgentSdkSpikeRequest = {
  body: {
    /** Raw prompt (max 4 000 chars) */
    prompt?: string;
    /** SDK session id to resume */
    resume?: string;
  };
};

export type PostAgentSdkSpikeResponse200 = unknown;

export type PostAgentSdkSpikeResponse400 = CommonError;

export type PostAgentSdkSpikeResponse401 = CommonError;

/** Request parts for `POST /kb/complete` (schema/http/notes-generation.schema.json). */
export type PostKbCompleteRequest = {
  body: {
    /** The text sent to the model (sanitized; max 100 000 chars). */
    prompt?: string;
    /** Reply-language code; only used by framing 'code-assist'. */
    language?: string;
    model?: string;
    /** A provider id, or custom:<uuid>. A provider without a configured key answers 400 PROVIDER_UNAVAILABLE. */
    provider?: string;
    /** 'subagent' or absent. */
    tier?: string;
    /** 'code-assist' or absent. */
    framing?: string;
  };
};

export type PostKbCompleteResponse200 = {
  /** The model's reply, trimmed. */
  reply: string;
  /** Summed model tokens of the call; omitted when the provider reported none. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    modelCalls: number;
  };
};

export type PostKbCompleteResponse400 = CommonError;

export type PostKbCompleteResponse401 = CommonError;

export type PostKbCompleteResponse429 = CommonError;

export type PostKbCompleteResponse502 = CommonError;

/** Request parts for `GET /kb/os/state` (schema/http/os.schema.json). */
export type GetKbOsStateRequest = {
  query: {
    /** day (default) or week; any other value is a 400 VALIDATION_FAILED. */
    window?: string;
    /** How many activity rows to return: a positive integer, default 30, capped at 100. Any other value falls back to 30. */
    activity?: string;
  };
};

export type GetKbOsStateResponse200 = {
  /** ISO 8601 time the aggregate was built. */
  generatedAt: string;
  /** SERVER_API_VERSION of this server. */
  apiVersion: number;
  system: {
    /** The sorted enabled LLMIDE_FEATURES keys, or null when every feature is on. */
    features: string[] | null;
    kits: KitStatus[];
    /** Same as /health: ok when the DB, the Claude CLI and the skills checks all pass. */
    status: "ok" | "degraded";
    checks: {
      db: boolean;
      claude: boolean;
      claudeError?: string;
      skills: boolean;
      skillsError?: string;
    };
  };
  running: {
    /** This user's v2 chat turns running now (the in-process turn lock). Cancel: POST /agent/v2/cancel. */
    chatTurns: {
      chatSessionId: string;
      startedAt: string;
      cancel: Cancel;
    }[];
    /** This user's meeting-agent runs attached to a capture session. Cancel: POST /kb/agent/stop. */
    meetingAgentRuns: ({
      sessionId: string;
      planId: string | null;
      startedAt: string | null;
      lastTickAt: string | null;
      cancel: Cancel;
    })[];
    /** This user's live caption sessions not yet finalized. No cancel route: a session ends when its capture client stops. */
    liveSessions: ({
      sessionId: string;
      meetingTitle: string | null;
      startedAt: string | null;
      lastWrite: string | null;
      captionCount: number;
      /** Always null: a live capture session has no cancel route (it ends when its capture client stops). */
      cancel: null;
    })[];
  };
  activity: {
    /** Activity rows newer than the user's last-seen cursor. */
    unread: number;
    /** Newest first, from the activity table (kb/activity.mjs). */
    items: ({
      id: number;
      kind: string;
      title: string;
      /** The event's structured detail; its keys depend on the kind, so they are not declared. */
      detail: Record<string, unknown> | null;
      link: string | null;
      /** Local time as stored (YYYY-MM-DD HH:MM:SS). */
      createdAt: string;
    })[];
  };
  tokens: {
    window: "day" | "week";
    /** Calendar days in the window: 1 = today since local midnight (same as the daily model-limit cap), 7 = the last 7 days including today. */
    windowDays: 1 | 7;
    /** Window start, server-local time 'YYYY-MM-DD HH:MM:SS' (the usage ledger's format). */
    since: string;
    totals: {
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
    };
    byModel: {
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
      provider: string;
      model: string;
    }[];
    bySource: {
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
      /** api, cli or auto-task. */
      source: string;
    }[];
    byEndpoint: ({
      calls: number;
      runs: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      billable: number;
      /** null when the row recorded no endpoint. */
      endpoint: string | null;
    })[];
    /** Averages over the caller's newest 50 v2 turns (turn_composition, kb/turn-composition.mjs). All are chars/4 estimates of LLM-IDE text except avgFirstCallPromptTokens, which is the first API call's real prompt size (input + cache write + cache read). Prefix = system prompt + skills append + LLM-IDE tool definitions; fence = context + memory + skills fences; null when no turn reported the value. */
    turnComposition: {
      turns: number;
      avgFirstCallPromptTokens: number | null;
      avgPrefixTokens: number | null;
      avgFenceTokens: number | null;
      avgToolResultTokens: number | null;
    };
  };
  knowledge: {
    sources: {
      total: number;
      byKind: ({
        kind: string;
        count: number;
        lastIndexedAt: string | null;
      })[];
    };
    meetings: {
      count: number;
    };
    /** review_items with status pending. */
    pendingReviews: number;
    outcomes: {
      total: number;
      terminal: number;
      /** Row count per outcome state (open, merged, closed, ...). */
      byState: Record<string, number>;
    };
    /** Freshness of each code graph this user has uploaded. */
    codeGraph: ({
      repoId: string;
      commitSha: string | null;
      generatedAt: string | null;
    })[];
    /** Per repo, the project-memory ledger facts (kb/memory-ledger.mjs): active and superseded counts. */
    projectMemory: ({
      repoRoot: string;
      facts: number;
      active: number;
      superseded: number;
      lastConfirmedAt: string | null;
    })[];
  };
  /** Kits the server cannot see yet; shown from the Mac app (the v1 gap). */
  macOnly: {
    loop: "on this Mac";
    autoTasks: "on this Mac";
  };
  storage: OsStorageReport;
  agents: {
    /** This user's newest 20 agent runs (Stage 1c). */
    recentRuns: OsAgentRun[];
  };
};

export type GetKbOsStateResponse400 = CommonError;

export type GetKbOsStateResponse401 = CommonError;

/** Request parts for `GET /kb/os/stream` (schema/http/os.schema.json). */
export type GetKbOsStreamRequest = Record<string, never>;

export type GetKbOsStreamResponse200 = ReadonlyArray<OsEventsEvent>;

export type GetKbOsStreamResponse401 = CommonError;

export type GetKbOsStreamResponse429 = CommonError;

/** Request parts for `POST /kb/generate-plan` (schema/http/planning.schema.json). */
export type PostKbGeneratePlanRequest = {
  body: {
    meetingId?: string;
    goal?: string;
    language?: string;
    skipRisk?: boolean;
    skipCodeSync?: boolean;
  };
};

/** A stored plan, as getPlan returns it. */
export type PostKbGeneratePlanResponse200 = {
  id: string;
  meetingId?: string | null;
  title: string;
  goal?: string | null;
  language?: string | null;
  /** Free-form plan meta; savePlan keeps meta.snapshots (last 3 versions) on update. */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  tasks: PlanningTask[];
};

export type PostKbGeneratePlanResponse400 = CommonError;

export type PostKbGeneratePlanResponse401 = CommonError;

export type PostKbGeneratePlanResponse429 = CommonError;

export type PostKbGeneratePlanResponse500 = CommonError;

/** Request parts for `POST /kb/analyze-risks` (schema/http/planning.schema.json). */
export type PostKbAnalyzeRisksRequest = {
  body: {
    planId?: string;
    /** A client-supplied plan draft. The server reads title, goal, language, meetingId and each task's id, title, description, owner, estimateDays, dependsOn, status. */
    plan?: {
      title?: string;
      goal?: string;
      language?: string;
      meetingId?: string;
      tasks?: {
        id?: string;
        title?: string;
        description?: string;
        owner?: string;
        estimateDays?: number;
        dependsOn?: string[];
        status?: string;
      }[];
    };
    language?: string;
  };
};

/** A plan body from the risk or code-sync routes. With planId the stored plan is returned (SavedPlan shape); with a plan body the result is the sent plan with the pass applied, so id and timestamps may be absent. */
export type PostKbAnalyzeRisksResponse200 = {
  id?: string;
  meetingId?: string | null;
  title?: string;
  goal?: string | null;
  language?: string | null;
  /** Free-form plan meta; savePlan keeps meta.snapshots (last 3 versions) on update. */
  meta?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  tasks: PlanningTask[];
};

export type PostKbAnalyzeRisksResponse400 = CommonError;

export type PostKbAnalyzeRisksResponse401 = CommonError;

export type PostKbAnalyzeRisksResponse404 = CommonError;

export type PostKbAnalyzeRisksResponse429 = CommonError;

export type PostKbAnalyzeRisksResponse500 = CommonError;

/** Request parts for `POST /kb/code-sync` (schema/http/planning.schema.json). */
export type PostKbCodeSyncRequest = {
  body: {
    /** ID of a stored plan — persists result */
    planId?: string;
    /** A client-supplied plan draft. The server reads title, goal, language, meetingId and each task's id, title, description, owner, estimateDays, dependsOn, status. */
    plan?: {
      title?: string;
      goal?: string;
      language?: string;
      meetingId?: string;
      tasks?: {
        id?: string;
        title?: string;
        description?: string;
        owner?: string;
        estimateDays?: number;
        dependsOn?: string[];
        status?: string;
      }[];
    };
  };
};

/** A plan body from the risk or code-sync routes. With planId the stored plan is returned (SavedPlan shape); with a plan body the result is the sent plan with the pass applied, so id and timestamps may be absent. */
export type PostKbCodeSyncResponse200 = {
  id?: string;
  meetingId?: string | null;
  title?: string;
  goal?: string | null;
  language?: string | null;
  /** Free-form plan meta; savePlan keeps meta.snapshots (last 3 versions) on update. */
  meta?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  tasks: PlanningTask[];
};

export type PostKbCodeSyncResponse400 = CommonError;

export type PostKbCodeSyncResponse401 = CommonError;

export type PostKbCodeSyncResponse404 = CommonError;

/** Request parts for `GET /kb/plans` (schema/http/planning.schema.json). */
export type GetKbPlansRequest = {
  query: {
    /** Capped at 200; the default is 50. */
    limit?: string;
  };
};

export type GetKbPlansResponse200 = {
  plans: ({
    id?: string;
    title?: string;
    meetingId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    taskCount?: number;
  })[];
  count: number;
};

export type GetKbPlansResponse401 = CommonError;

/** Request parts for `GET /kb/plan/:id` (schema/http/planning.schema.json). */
export type GetKbPlanIdRequest = {
  params: {
    id: string;
  };
};

/** A stored plan, as getPlan returns it. */
export type GetKbPlanIdResponse200 = {
  id: string;
  meetingId?: string | null;
  title: string;
  goal?: string | null;
  language?: string | null;
  /** Free-form plan meta; savePlan keeps meta.snapshots (last 3 versions) on update. */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  tasks: PlanTask[];
};

export type GetKbPlanIdResponse401 = CommonError;

export type GetKbPlanIdResponse404 = CommonError;

/** Request parts for `POST /kb/plan/save` (schema/http/planning.schema.json). */
export type PostKbPlanSaveRequest = {
  body: {
    /** Omit to create a new plan */
    id?: string;
    title?: string;
    goal?: string;
    language?: string;
    meetingId?: string;
    /** Stored as plan meta. */
    meta?: Record<string, unknown>;
    tasks?: {
      id?: string;
      title?: string;
      description?: string;
      owner?: string;
      due?: string;
      estimateDays?: number;
      dependsOn?: string[];
      status?: string;
      risk?: string;
      riskReason?: string;
      milestone?: string;
      files?: {
        ref?: string;
        title?: string;
        bodyExcerpt?: string;
        rank?: number;
      }[];
      symbols?: {
        symbol_id?: string;
        title?: string;
        kind?: string;
        repo_id?: string;
        source_file?: string;
        line?: number;
      }[];
      /** Stored task meta. */
      meta?: Record<string, unknown>;
    }[];
  };
};

/** A stored plan, as getPlan returns it. */
export type PostKbPlanSaveResponse200 = {
  id: string;
  meetingId?: string | null;
  title: string;
  goal?: string | null;
  language?: string | null;
  /** Free-form plan meta; savePlan keeps meta.snapshots (last 3 versions) on update. */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  tasks: PlanTask[];
};

export type PostKbPlanSaveResponse400 = CommonError;

export type PostKbPlanSaveResponse401 = CommonError;

export type PostKbPlanSaveResponse500 = CommonError;

/** Request parts for `DELETE /kb/plan/delete` (schema/http/planning.schema.json). */
export type DeleteKbPlanDeleteRequest = {
  body: {
    id?: string;
  };
};

export type DeleteKbPlanDeleteResponse200 = {
  ok: true;
};

export type DeleteKbPlanDeleteResponse400 = CommonError;

export type DeleteKbPlanDeleteResponse401 = CommonError;

/** Request parts for `POST /kb/plan/delete` (schema/http/planning.schema.json). */
export type PostKbPlanDeleteRequest = {
  body: {
    id?: string;
  };
};

export type PostKbPlanDeleteResponse200 = {
  ok: true;
};

export type PostKbPlanDeleteResponse400 = CommonError;

export type PostKbPlanDeleteResponse401 = CommonError;

/** Request parts for `PATCH /kb/plan-task/update` (schema/http/planning.schema.json). */
export type PatchKbPlanTaskUpdateRequest = {
  body: {
    taskId?: string;
    /** Only the keys present change; an explicit null clears a field. */
    patch?: {
      status?: string;
      risk?: string | null;
      riskReason?: string | null;
      owner?: string | null;
      due?: string | null;
      files?: {
        ref?: string;
        title?: string;
        bodyExcerpt?: string;
        rank?: number;
      }[];
    };
  };
};

export type PatchKbPlanTaskUpdateResponse200 = PlanTask;

export type PatchKbPlanTaskUpdateResponse400 = CommonError;

export type PatchKbPlanTaskUpdateResponse401 = CommonError;

export type PatchKbPlanTaskUpdateResponse404 = CommonError;

/** Request parts for `POST /kb/plan-task/update` (schema/http/planning.schema.json). */
export type PostKbPlanTaskUpdateRequest = {
  body: {
    taskId?: string;
    /** Only the keys present change; an explicit null clears a field. */
    patch?: {
      status?: string;
      risk?: string | null;
      riskReason?: string | null;
      owner?: string | null;
      due?: string | null;
      files?: {
        ref?: string;
        title?: string;
        bodyExcerpt?: string;
        rank?: number;
      }[];
    };
  };
};

export type PostKbPlanTaskUpdateResponse200 = PlanTask;

export type PostKbPlanTaskUpdateResponse400 = CommonError;

export type PostKbPlanTaskUpdateResponse401 = CommonError;

export type PostKbPlanTaskUpdateResponse404 = CommonError;

/** Request parts for `POST /kb/dispatch` (schema/http/planning.schema.json). */
export type PostKbDispatchRequest = {
  body: {
    planId?: string;
    target?: "preview" | "github" | "backlog" | "linear";
    taskIds?: string[];
    /** Required when target != preview */
    reviewId?: string;
    /** Destination and credential keys for the target (repo/owner for github, space/projectId for backlog, teamId/projectId for linear). Credentials come from the vault unless sent here. Open: the keys are per target. */
    config?: {
      repo?: string;
      [key: string]: unknown;
    };
  };
};

/** Preview form verified. Non-preview results carry provider fields (url, number, error) that the offline capture cannot produce. */
export type PostKbDispatchResponse200 = {
  target: string;
  plan: {
    id: string;
    title: string;
  };
  results: {
    taskId: string;
    status: string;
    title?: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }[];
};

export type PostKbDispatchResponse400 = CommonError;

export type PostKbDispatchResponse401 = CommonError;

export type PostKbDispatchResponse403 = CommonError;

export type PostKbDispatchResponse429 = CommonError;

/** Request parts for `POST /kb/generate-code` (schema/http/planning.schema.json). */
export type PostKbGenerateCodeRequest = {
  body: {
    taskId?: string;
    language?: string;
    includeFileContext?: boolean;
  };
};

/** Generated files are returned, never stored. A modify of a file the model was not shown in full is dropped and listed in rejected. */
export type PostKbGenerateCodeResponse200 = {
  taskId: string;
  summary: string;
  files: CodeFile[];
  tests: CodeFile[];
  notes: string;
  rejected: string[];
};

export type PostKbGenerateCodeResponse400 = CommonError;

export type PostKbGenerateCodeResponse401 = CommonError;

export type PostKbGenerateCodeResponse429 = CommonError;

export type PostKbGenerateCodeResponse500 = CommonError;

/** Request parts for `POST /kb/summarize` (schema/http/planning.schema.json). */
export type PostKbSummarizeRequest = {
  body: {
    transcript?: string;
    title?: string;
    language?: string;
    started_at?: string;
    duration_seconds?: number;
    participants?: string[];
  };
};

export type PostKbSummarizeResponse200 = {
  gist: string;
  tldr: string[];
  full: string;
  actions: {
    owner?: string;
    text: string;
    due?: string;
  }[];
  decisions: {
    text: string;
  }[];
  blockers: {
    text: string;
  }[];
  model?: string;
  generated_at: number;
};

export type PostKbSummarizeResponse400 = CommonError;

export type PostKbSummarizeResponse401 = CommonError;

export type PostKbSummarizeResponse429 = CommonError;

export type PostKbSummarizeResponse500 = CommonError;

export type PostKbSummarizeResponse502 = CommonError;

/** Request parts for `POST /kb/conflict-questions` (schema/http/planning.schema.json). */
export type PostKbConflictQuestionsRequest = {
  body: {
    /** Current meeting transcript (max 40 000 chars) */
    transcript?: string;
    /** Attached code or notes (max 20 000 chars) */
    fileContext?: string;
    language?: string;
  };
};

export type PostKbConflictQuestionsResponse200 = {
  questions: string;
};

export type PostKbConflictQuestionsResponse401 = CommonError;

export type PostKbConflictQuestionsResponse429 = CommonError;

export type PostKbConflictQuestionsResponse500 = CommonError;

/** Request parts for `POST /kb/notify/slack` (schema/http/planning.schema.json). */
export type PostKbNotifySlackRequest = {
  body: {
    kind?: string;
    /** Optional — vault key slack.webhookUrl is preferred */
    webhookUrl?: string;
    planId?: string;
    /** Per kind: a plan, a dispatch result, a review, or {text} for custom. */
    payload?: Record<string, unknown>;
  };
};

export type PostKbNotifySlackResponse200 = unknown;

export type PostKbNotifySlackResponse400 = CommonError;

export type PostKbNotifySlackResponse401 = CommonError;

export type PostKbNotifySlackResponse404 = CommonError;

export type PostKbNotifySlackResponse429 = CommonError;

/** Request parts for `POST /kb/outcomes/refresh` (schema/http/planning.schema.json). */
export type PostKbOutcomesRefreshRequest = {
  body: {
    taskIds?: string[];
    /** Inline credentials, merged over the vault values; not echoed back. */
    creds?: Record<string, unknown>;
  };
};

export type PostKbOutcomesRefreshResponse200 = {
  pollErroredCount: number;
  pollCount: number;
  changedCount: number;
  durationMs: number;
  byState: Record<string, number>;
  polled: {
    taskId: string;
    planId?: string;
    title?: string;
    provider?: string;
    url?: string;
    state: string;
    /** Poll detail (error, or the provider's status). */
    meta?: Record<string, unknown>;
    changed: boolean;
    circuitOpen?: boolean;
  }[];
};

export type PostKbOutcomesRefreshResponse401 = CommonError;

export type PostKbOutcomesRefreshResponse429 = CommonError;

/** Request parts for `POST /kb/outcomes/retry-failed` (schema/http/planning.schema.json). */
export type PostKbOutcomesRetryFailedRequest = {
  body: {
    /** Credentials and destination for the retry targets (as /kb/dispatch config). */
    config?: Record<string, unknown>;
  };
};

export type PostKbOutcomesRetryFailedResponse200 = {
  retried: number;
  ok: number;
  failed: number;
  deferred: number;
};

export type PostKbOutcomesRetryFailedResponse401 = CommonError;

/** Request parts for `GET /kb/outcomes/task/:id` (schema/http/planning.schema.json). */
export type GetKbOutcomesTaskIdRequest = {
  params: {
    id: string;
  };
};

export type GetKbOutcomesTaskIdResponse200 = {
  outcomes: ({
    id: number;
    provider: string;
    ref?: string | null;
    state: string;
    isTerminal: boolean;
    /** Outcome detail. */
    meta?: Record<string, unknown>;
    observedAt: string;
  })[];
};

export type GetKbOutcomesTaskIdResponse400 = CommonError;

export type GetKbOutcomesTaskIdResponse401 = CommonError;

/** Request parts for `GET /kb/outcomes/stats` (schema/http/planning.schema.json). */
export type GetKbOutcomesStatsRequest = Record<string, never>;

export type GetKbOutcomesStatsResponse200 = {
  total: number;
  byState: Record<string, number>;
};

export type GetKbOutcomesStatsResponse401 = CommonError;

/** Request parts for `GET /kb/providers/catalog` (schema/http/provider-catalog.schema.json). */
export type GetKbProvidersCatalogRequest = Record<string, never>;

export type GetKbProvidersCatalogResponse200 = {
  providers: CatalogProvider[];
  settings: Settings;
  /** Present once the one-time carry-over of the user's existing provider keys into the catalog has run (API 92). created: connections made from a key already in the vault (the old key is kept); needsReview: keys not carried over (a base URL the guard refuses, or a failed connect) with the reason; toolsSuggested: a connection was created and tools on provider models are still off, so the app offers the visible "Allow tools on provider models" switch (the migration never enables tools itself). */
  migration?: {
    created: {
      /** The legacy provider: openai, google, deepseek, custom or custom:<id>. */
      provider: string;
      name: string;
    }[];
    needsReview: {
      provider: string;
      name: string;
      /** Redacted, at most 200 characters. */
      reason: string;
    }[];
    toolsSuggested: boolean;
  };
};

export type GetKbProvidersCatalogResponse401 = CommonError;

/** Request parts for `POST /kb/providers/catalog/connect` (schema/http/provider-catalog.schema.json). */
export type PostKbProvidersCatalogConnectRequest = {
  body: {
    catalogId?: string;
    /** Stored in the per-user vault; omitted on a reconnect to keep the stored key */
    apiKey?: string;
    /** Only the generic endpoint (and Ollama on another host) takes one; a hosted entry keeps its own */
    baseURL?: string;
    /** 1-24 lowercase letters or digits; names a second generic endpoint */
    slug?: string;
    name?: string;
    /** Opt in to a loopback or private-network address */
    allowPrivate?: boolean;
    /** false stores the connection switched off (default true); the Mac's enable/disable switch re-sends the connection with this */
    enabled?: boolean;
    /** Used only when apiKey is absent: copy the stored key of a legacy provider the caller already has (openai, google, deepseek, custom, or custom:<uuid>). The old key stays; it is never returned */
    copyKeyFrom?: string;
  };
};

export type PostKbProvidersCatalogConnectResponse200 = {
  ok: true;
  connection: Connection;
};

export type PostKbProvidersCatalogConnectResponse400 = CommonError;

export type PostKbProvidersCatalogConnectResponse401 = CommonError;

export type PostKbProvidersCatalogConnectResponse404 = CommonError;

export type PostKbProvidersCatalogConnectResponse409 = CommonError;

/** Request parts for `POST /kb/providers/catalog/disconnect` (schema/http/provider-catalog.schema.json). */
export type PostKbProvidersCatalogDisconnectRequest = {
  body: ConnectionId;
};

export type PostKbProvidersCatalogDisconnectResponse200 = {
  ok: true;
  /** false when the caller had no such connection */
  removed: boolean;
};

/** Request parts for `POST /kb/providers/catalog/test` (schema/http/provider-catalog.schema.json). */
export type PostKbProvidersCatalogTestRequest = {
  body: ConnectionId;
};

export type PostKbProvidersCatalogTestResponse200 = {
  ok: boolean;
  /** Human-readable result; never contains the key */
  detail: string;
  /** Chat models the provider lists; present when ok */
  modelCount?: number;
};

export type PostKbProvidersCatalogTestResponse404 = CommonError;

/** Request parts for `POST /kb/providers/catalog/models` (schema/http/provider-catalog.schema.json). */
export type PostKbProvidersCatalogModelsRequest = {
  body: {
    id?: string;
    /** Bypass the ten-minute cache */
    refresh?: boolean;
  };
};

export type PostKbProvidersCatalogModelsResponse200 = {
  models: ModelCapability[];
  /** static: the catalog's own table, because there was no key or the provider could not be reached */
  source: "live" | "cache" | "static";
  /** Why the list is static or stale */
  detail?: string;
};

export type PostKbProvidersCatalogModelsResponse403 = CommonError;

export type PostKbProvidersCatalogModelsResponse404 = CommonError;

/** Request parts for `GET /kb/providers/settings` (schema/http/provider-catalog.schema.json). */
export type GetKbProvidersSettingsRequest = Record<string, never>;

export type GetKbProvidersSettingsResponse200 = Settings;

export type GetKbProvidersSettingsResponse401 = CommonError;

/** Request parts for `PUT /kb/providers/settings` (schema/http/provider-catalog.schema.json). */
export type PutKbProvidersSettingsRequest = {
  body: SettingsPatch;
};

export type PutKbProvidersSettingsResponse200 = Settings;

/** Request parts for `POST /kb/providers/turn` (schema/http/provider-catalog.schema.json). */
export type PostKbProvidersTurnRequest = {
  body: {
    /** custom:cat-... of a connection of the caller */
    provider?: string;
    model?: string;
    message?: string;
    /** execute | plan | assist_plan | review need a model with tools; ask and document run without them */
    mode?: string;
    /** Prior turns, most recent 40 are used */
    history?: ({
      role: "user" | "assistant";
      content: string;
    })[];
    /** workspaceRoot bounds what the file tools may read; chatSessionId keys the chat's task list */
    agentContext?: {
      workspaceRoot?: string;
      chatSessionId?: string;
    };
  };
};

export type PostKbProvidersTurnResponse200 = unknown;

export type PostKbProvidersTurnResponse400 = CommonError;

export type PostKbProvidersTurnResponse401 = CommonError;

export type PostKbProvidersTurnResponse403 = CommonError;

export type PostKbProvidersTurnResponse404 = CommonError;

/** Request parts for `POST /kb/providers/verify` (schema/http/providers-usage.schema.json). */
export type PostKbProvidersVerifyRequest = {
  body: {
    /** Provider ID (e.g. anthropic, openai, custom) */
    provider?: string;
    /** key | cli */
    mode?: string;
    /** placeholder in fixtures; never a real key */
    apiKey?: string;
    /** Required for provider=custom */
    baseUrl?: string;
  };
};

/** Always 200 unless the request is invalid. ok true is answered only after a live model listing, which the capture does not reach (no external network); the true shape is the same. */
export type PostKbProvidersVerifyResponse200 = {
  ok: boolean;
  detail: string;
};

export type PostKbProvidersVerifyResponse400 = CommonError;

export type PostKbProvidersVerifyResponse401 = CommonError;

export type PostKbProvidersVerifyResponse429 = CommonError;

/** Request parts for `POST /kb/providers/models` (schema/http/providers-usage.schema.json). */
export type PostKbProvidersModelsRequest = {
  body: {
    provider?: string;
  };
};

/** The live chat models for a provider, or [] with a detail. entries and source are the Claude SDK variant (anthropic only, server API v57+ / v63+): entries carries display names and effort levels. The SDK variant is not captured (it needs the local Claude CLI login), so entries and source are optional and not covered by a fixture. */
export type PostKbProvidersModelsResponse200 = {
  models: string[];
  /** Human-readable reason when models is empty */
  detail?: string;
  /** anthropic via the Agent SDK only */
  entries?: ({
    id: string;
    displayName?: string | null;
    effortLevels?: string[];
  })[];
  /** Present when the list came from the Agent SDK */
  source?: "sdk";
};

export type PostKbProvidersModelsResponse400 = CommonError;

export type PostKbProvidersModelsResponse401 = CommonError;

export type PostKbProvidersModelsResponse429 = CommonError;

/** Request parts for `GET /kb/agent-sdk` (schema/http/providers-usage.schema.json). */
export type GetKbAgentSdkRequest = {
  query: {
    /** 1 bypasses the one-hour registry cache */
    force?: string;
  };
};

/** Claude Agent SDK version status (llm_agent/sdk/updater.mjs sdkStatus). The 200 fixture is produced in-process with an offline registry stub; the route itself reads the npm registry. */
export type GetKbAgentSdkResponse200 = {
  package: string;
  running: string | null;
  installed: string | null;
  declared: string | null;
  restartNeeded: boolean;
  latest: string | null;
  updateAvailable: boolean;
  updating: boolean;
  canUpdate: boolean;
  /** Why the registry could not be checked */
  error: string | null;
};

export type GetKbAgentSdkResponse401 = CommonError;

/** Request parts for `POST /kb/agent-sdk/update` (schema/http/providers-usage.schema.json). */
export type PostKbAgentSdkUpdateRequest = Record<string, never>;

/** Always 200: ok says whether the SDK was updated; a refusal or rollback is a normal answer. The 200 fixture is a refusal (a chat turn running), produced in-process; an install would run npm in the server checkout and reach the registry, so no install is captured. */
export type PostKbAgentSdkUpdateResponse200 = {
  ok: boolean;
  from: string | null;
  to: string | null;
  rolledBack: boolean;
  restartNeeded: boolean;
  log: string | null;
};

export type PostKbAgentSdkUpdateResponse401 = CommonError;

/** Request parts for `POST /kb/custom-providers` (schema/http/providers-usage.schema.json). */
export type PostKbCustomProvidersRequest = {
  body: {
    providers?: ({
      id?: string;
      name?: string;
      baseURL?: string;
      /** vault key path */
      apiKey?: string;
      models?: {
        id: string;
        displayName?: string;
        [key: string]: unknown;
      }[];
      isOpenAICompatible?: boolean;
      isEnabled?: boolean;
      /** Anthropic-format endpoint for the Agent engine; null when absent */
      anthropicBaseURL?: string | null;
    })[];
  };
};

export type PostKbCustomProvidersResponse200 = {
  success: boolean;
  count: number;
};

export type PostKbCustomProvidersResponse400 = CommonError;

export type PostKbCustomProvidersResponse401 = CommonError;

/** Request parts for `GET /kb/routing-tiers` (schema/http/providers-usage.schema.json). */
export type GetKbRoutingTiersRequest = Record<string, never>;

/** The stored tier routing (tiers, features) plus each tier's usability by the server's own resolver (status) and each configured role's (featureStatus). A keyless openai or google tier answers after a short CLI health probe. */
export type GetKbRoutingTiersResponse200 = {
  /** Keys strong | standard | cheap. */
  tiers: Record<string, {
      /** anthropic | openai | google | deepseek | jev | custom:<id> */
      provider: string;
      model: string;
    }>;
  /** Role -> tier. */
  features: Record<string, string>;
  /** Keys: configured tiers, plus unset ones (reason unset) when a tier is absent. */
  status: Record<string, {
      usable: boolean;
      /** unset | not_found | disabled | no_key | no_key_or_cli (OpenAI/Google, v68+) | cli_unverified (CLI health probe not run yet, v69+) | cli_failed / route_failed (the route failed at runtime in the last ~10 min, v69+) | error (only when usable is false) */
      reason?: string;
      agentCapable: boolean;
      /** why the Agent engine cannot run a usable tier, e.g. not_agent_capable */
      agentReason?: string;
      /** API v68+, only when usable. `key` = runs on an API key (user vault or operator env; custom providers always), `cli` = runs on the provider's logged-in CLI subscription (claude / codex / gemini). A key wins when both exist. */
      via?: "key" | "cli";
    }>;
  /** API v69+. One entry per CONFIGURED feature. `usable: false` with the tier's own reason when the tier is unusable, or `cli_untrusted_input` when the tier runs on a keyless codex/gemini CLI and the feature is `internal` or `pipeline` (untrusted email/connector/transcript input; pipeline output is dispatched to issue trackers), or `decision_only` (API v73+) when the tier runs on `jev` and the feature is anything but `decisions`. */
  featureStatus: Record<string, {
      usable: boolean;
      /** set when unusable: a tier reason, cli_untrusted_input, or decision_only */
      reason?: string;
    }>;
};

export type GetKbRoutingTiersResponse401 = CommonError;

/** Request parts for `POST /kb/routing-tiers` (schema/http/providers-usage.schema.json). */
export type PostKbRoutingTiersRequest = {
  body: {
    /** Keys strong | standard | cheap */
    tiers?: Record<string, {
        /** anthropic | openai | google | deepseek | jev | custom:<id> */
        provider: string;
        model: string;
      }>;
    /** Keys subagents | loop | autoTasks | quickChat | pipeline | internal | decisions (API v73+); values a tier name */
    features?: Record<string, string>;
  };
};

export type PostKbRoutingTiersResponse200 = {
  success: boolean;
  /** Entries that were not stored (API v67+) */
  dropped: ({
    /** tiers.<name> or features.<name> */
    entry: string;
    reason: "invalid_shape" | "invalid_provider" | "invalid_model" | "unknown_tier" | "unknown_feature";
  })[];
};

export type PostKbRoutingTiersResponse400 = CommonError;

export type PostKbRoutingTiersResponse401 = CommonError;

/** Request parts for `GET /kb/usage/limits` (schema/http/providers-usage.schema.json). */
export type GetKbUsageLimitsRequest = {
  query: {
    /** anthropic | openai | google | custom; restricts chains to that provider */
    provider?: string;
  };
};

export type GetKbUsageLimitsResponse200 = {
  /** Per provider, the chain of models with their caps. GET lists the built-in chain merged with the user's overrides, sorted by priority. */
  chains: Record<string, ({
      provider: string;
      model: string;
      label: string;
      priority: number;
      enabled: boolean;
      limit_value: number;
      unit: "runs" | "tokens";
      window_kind: "daily" | "monthly";
      threshold_pct: number;
      custom: boolean;
    })[]>;
};

export type GetKbUsageLimitsResponse401 = CommonError;

/** Request parts for `PUT /kb/usage/limits` (schema/http/providers-usage.schema.json). */
export type PutKbUsageLimitsRequest = {
  body: {
    /** { provider: [ { model, priority, enabled, limit_value, unit, window_kind, threshold_pct } ] } */
    chains?: Record<string, {
        model?: string;
        priority?: number;
        enabled?: boolean;
        limit_value?: number;
        unit?: string;
        window_kind?: string;
        threshold_pct?: number;
      }[]>;
  };
};

export type PutKbUsageLimitsResponse200 = {
  ok: boolean;
  /** Per provider, the chain of models with their caps. GET lists the built-in chain merged with the user's overrides, sorted by priority. */
  chains: Record<string, ({
      provider: string;
      model: string;
      label: string;
      priority: number;
      enabled: boolean;
      limit_value: number;
      unit: "runs" | "tokens";
      window_kind: "daily" | "monthly";
      threshold_pct: number;
      custom: boolean;
    })[]>;
};

export type PutKbUsageLimitsResponse400 = CommonError;

export type PutKbUsageLimitsResponse401 = CommonError;

export type PutKbUsageLimitsResponse429 = CommonError;

/** Request parts for `GET /kb/usage/summary` (schema/http/providers-usage.schema.json). */
export type GetKbUsageSummaryRequest = {
  query: {
    /** restricts providers to one */
    provider?: string;
  };
};

export type GetKbUsageSummaryResponse200 = {
  providers: Record<string, {
      /** The resolver verdict (kb/usage.mjs resolveModel). used, limit, pct and unit are present only when a model was picked (ok or degraded); a paused or unconfigured verdict has no pick. */
      active: {
        provider: string;
        /** null when paused or unconfigured */
        model: string | null;
        status: "ok" | "degraded" | "paused" | "unconfigured";
        /** ISO-8601 window reset; null when there is no chain */
        resetAt: string | null;
        reason: string;
        used?: number;
        limit?: number;
        pct?: number;
        unit?: string;
        engaged: boolean;
      };
      models: ({
        model: string;
        label: string;
        enabled: boolean;
        custom: boolean;
        priority: number;
        unit: string;
        window_kind: string;
        limit: number;
        threshold_pct: number;
        used: number;
        pct: number | null;
        state: "ok" | "warning" | "exhausted";
        quota: boolean;
        tokens: {
          input: number;
          output: number;
          cacheRead: number;
          cacheCreation: number;
          totalInput: number;
          cacheHitPct: number | null;
          unknownRows: number;
        };
        resetAt: string;
      })[];
    }>;
};

export type GetKbUsageSummaryResponse401 = CommonError;

/** Request parts for `GET /kb/usage/resolve` (schema/http/providers-usage.schema.json). */
export type GetKbUsageResolveRequest = {
  query: {
    /** anthropic | openai | google | custom; default anthropic */
    provider?: string;
    /** the caller's desired model, kept when healthy */
    prefer?: string;
  };
};

export type GetKbUsageResolveResponse200 = Resolution;

export type GetKbUsageResolveResponse400 = CommonError;

export type GetKbUsageResolveResponse401 = CommonError;

/** Request parts for `GET /kb/usage/ratelimits` (schema/http/providers-usage.schema.json). */
export type GetKbUsageRatelimitsRequest = {
  query: {
    /** default anthropic */
    provider?: string;
  };
};

export type GetKbUsageRatelimitsResponse200 = {
  /** The latest Anthropic/OpenAI-compatible rate-limit snapshot from a live response's headers (in-memory, per server run). null when only the CLI path ran, which is always the case offline. The object shape (capturedAt, provider, model, requests, tokens, inputTokens, outputTokens; each bucket limit/remaining/reset) is described but not covered: no live response is captured. */
  ratelimits?: {
    capturedAt?: string;
    provider?: string;
    model?: string | null;
    requests?: Record<string, unknown> | null;
    tokens?: Record<string, unknown> | null;
    inputTokens?: Record<string, unknown> | null;
    outputTokens?: Record<string, unknown> | null;
  } | null;
};

export type GetKbUsageRatelimitsResponse401 = CommonError;

/** Request parts for `GET /kb/usage/turn-composition` (schema/http/providers-usage.schema.json). */
export type GetKbUsageTurnCompositionRequest = {
  query: {
    /** Clamped to 1-200; the default is 50. */
    limit?: string;
  };
};

export type GetKbUsageTurnCompositionResponse200 = {
  turns: ({
    turnId: string;
    mode?: string | null;
    model?: string | null;
    resumed?: 0 | 1;
    systemPromptKind?: string | null;
    systemChars?: number | null;
    promptChars?: number | null;
    attachedFiles?: number | null;
    attachmentChars?: number | null;
    images?: number | null;
    tools?: number | null;
    mcpTools?: number | null;
    /** comma-separated server names */
    mcpServers?: string | null;
    agents?: number | null;
    skills?: number | null;
    slashCommands?: number | null;
    claudeCodeVersion?: string | null;
    apiCalls?: number | null;
    firstCallPromptTokens?: number | null;
    firstCallCacheReadTokens?: number | null;
    firstCallCacheCreationTokens?: number | null;
    /** SQLite-stored ISO timestamp */
    createdAt: string;
    systemPromptTokens?: number | null;
    skillsAppendTokens?: number | null;
    llmideToolTokens?: number | null;
    userMcpServers?: number | null;
    contextFenceTokens?: number | null;
    memoryFenceTokens?: number | null;
    skillsFenceTokens?: number | null;
    toolResultChars?: number | null;
    toolResultTokens?: number | null;
    sdkContextTotalTokens?: number | null;
    sdkSystemPromptTokens?: number | null;
    sdkSystemToolsTokens?: number | null;
    sdkMcpToolsTokens?: number | null;
    sdkMemoryTokens?: number | null;
    sdkMessagesTokens?: number | null;
    sdkDeferredToolsTokens?: number | null;
    sdkCategories?: string | null;
  })[];
};

export type GetKbUsageTurnCompositionResponse401 = CommonError;

/** Request parts for `POST /kb/usage/record` (schema/http/providers-usage.schema.json). */
export type PostKbUsageRecordRequest = {
  body: {
    provider?: string;
    model?: string;
    /** api|cli|auto-task */
    source?: string;
    endpoint?: string;
    runs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    turns?: number;
    stopReason?: string;
    requestId?: string;
  };
};

/** ok is false and id null when the ledger write failed (best effort). */
export type PostKbUsageRecordResponse200 = {
  ok: boolean;
  id: number | null;
};

export type PostKbUsageRecordResponse400 = CommonError;

export type PostKbUsageRecordResponse401 = CommonError;

export type PostKbUsageRecordResponse429 = CommonError;

/** Request parts for `POST /kb/review/submit` (schema/http/review.schema.json). */
export type PostKbReviewSubmitRequest = {
  body: {
    /** dispatch or codegen-apply. */
    kind?: string;
    planId?: string;
    taskId?: string;
    /** Stored up to 500 characters; defaults to '<kind> review'. */
    title?: string;
    payload?: Payload;
  };
};

export type PostKbReviewSubmitResponse200 = ReviewItem;

export type PostKbReviewSubmitResponse400 = CommonError;

export type PostKbReviewSubmitResponse401 = CommonError;

export type PostKbReviewSubmitResponse429 = CommonError;

/** Request parts for `GET /kb/review/list` (schema/http/review.schema.json). */
export type GetKbReviewListRequest = {
  query: {
    status?: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
    /** Capped at 200; the default is 50. */
    limit?: string;
  };
};

export type GetKbReviewListResponse200 = {
  items: ReviewSummary[];
  count: number;
};

export type GetKbReviewListResponse401 = CommonError;

/** Request parts for `GET /kb/review/get/:id` (schema/http/review.schema.json). */
export type GetKbReviewGetIdRequest = {
  params: {
    /** The review item id (rev-…). */
    id: string;
  };
};

export type GetKbReviewGetIdResponse200 = ReviewItem;

export type GetKbReviewGetIdResponse401 = CommonError;

export type GetKbReviewGetIdResponse404 = CommonError;

/** Request parts for `POST /kb/review/approve` (schema/http/review.schema.json). */
export type PostKbReviewApproveRequest = {
  body: {
    id?: string;
    /** Stored as reviewerNote. */
    note?: string;
    /** API v75+. Credentials for the dispatch target (github token / backlog or linear apiKey); highest precedence, never persisted. Without one the server uses a value held from submit, then the per-user vault. */
    config?: Record<string, unknown>;
    /** API v75+. codegen-apply only: PR credentials (ghToken); same precedence as config. */
    pr?: Record<string, unknown>;
  };
};

export type PostKbReviewApproveResponse200 = ReviewItem;

export type PostKbReviewApproveResponse400 = CommonError;

export type PostKbReviewApproveResponse401 = CommonError;

export type PostKbReviewApproveResponse404 = CommonError;

export type PostKbReviewApproveResponse409 = CommonError;

export type PostKbReviewApproveResponse422 = GuardrailRejection;

export type PostKbReviewApproveResponse429 = CommonError;

export type PostKbReviewApproveResponse500 = ExecutionFailure;

/** Request parts for `POST /kb/review/reject` (schema/http/review.schema.json). */
export type PostKbReviewRejectRequest = {
  body: {
    id?: string;
    /** Stored as reviewerNote. */
    note?: string;
  };
};

export type PostKbReviewRejectResponse200 = ReviewItem;

export type PostKbReviewRejectResponse400 = CommonError;

export type PostKbReviewRejectResponse401 = CommonError;

export type PostKbReviewRejectResponse404 = CommonError;

export type PostKbReviewRejectResponse409 = CommonError;

export type PostKbReviewRejectResponse429 = CommonError;

/** Request parts for `DELETE /kb/review/delete` (schema/http/review.schema.json). */
export type DeleteKbReviewDeleteRequest = {
  body: {
    id?: string;
  };
};

export type DeleteKbReviewDeleteResponse200 = ReviewOk;

export type DeleteKbReviewDeleteResponse400 = CommonError;

export type DeleteKbReviewDeleteResponse401 = CommonError;

/** Request parts for `POST /kb/review/delete` (schema/http/review.schema.json). */
export type PostKbReviewDeleteRequest = {
  body: {
    id?: string;
  };
};

export type PostKbReviewDeleteResponse200 = ReviewOk;

export type PostKbReviewDeleteResponse401 = CommonError;

export type PostKbReviewDeleteResponse429 = CommonError;

/** Typed map of every endpoint: request parts and each declared response, by status. */
export interface ApiEndpoints {
  "GET /kb/storage": {
    request: GetKbStorageRequest;
    responses: {
      200: GetKbStorageResponse200;
    };
  };
  "GET /kb/agent-history/settings": {
    request: GetKbAgentHistorySettingsRequest;
    responses: {
      200: GetKbAgentHistorySettingsResponse200;
    };
  };
  "PUT /kb/agent-history/settings": {
    request: PutKbAgentHistorySettingsRequest;
    responses: {
      200: PutKbAgentHistorySettingsResponse200;
      400: PutKbAgentHistorySettingsResponse400;
      503: PutKbAgentHistorySettingsResponse503;
    };
  };
  "POST /kb/agent-history/clear": {
    request: PostKbAgentHistoryClearRequest;
    responses: {
      200: PostKbAgentHistoryClearResponse200;
      400: PostKbAgentHistoryClearResponse400;
      409: PostKbAgentHistoryClearResponse409;
      503: PostKbAgentHistoryClearResponse503;
    };
  };
  "POST /kb/agent-history/compact": {
    request: PostKbAgentHistoryCompactRequest;
    responses: {
      200: PostKbAgentHistoryCompactResponse200;
      409: PostKbAgentHistoryCompactResponse409;
      503: PostKbAgentHistoryCompactResponse503;
      507: PostKbAgentHistoryCompactResponse507;
    };
  };
  "POST /agent/v2/stream": {
    request: PostAgentV2StreamRequest;
    responses: {
      200: PostAgentV2StreamResponse200;
      400: PostAgentV2StreamResponse400;
      402: PostAgentV2StreamResponse402;
      409: PostAgentV2StreamResponse409;
      503: PostAgentV2StreamResponse503;
    };
  };
  "POST /agent/v2/decision": {
    request: PostAgentV2DecisionRequest;
    responses: {
      200: PostAgentV2DecisionResponse200;
      404: PostAgentV2DecisionResponse404;
    };
  };
  "DELETE /agent/v2/session": {
    request: DeleteAgentV2SessionRequest;
    responses: {
      200: DeleteAgentV2SessionResponse200;
      400: DeleteAgentV2SessionResponse400;
    };
  };
  "POST /agent/v2/cancel": {
    request: PostAgentV2CancelRequest;
    responses: {
      200: PostAgentV2CancelResponse200;
      400: PostAgentV2CancelResponse400;
    };
  };
  "GET /agent/v2/turns": {
    request: GetAgentV2TurnsRequest;
    responses: {
      200: GetAgentV2TurnsResponse200;
    };
  };
  "GET /agent/v2/turns/stream": {
    request: GetAgentV2TurnsStreamRequest;
    responses: {
      200: GetAgentV2TurnsStreamResponse200;
      400: GetAgentV2TurnsStreamResponse400;
      404: GetAgentV2TurnsStreamResponse404;
      429: GetAgentV2TurnsStreamResponse429;
    };
  };
  "POST /kb/agent/dispatch": {
    request: PostKbAgentDispatchRequest;
    responses: {
      200: PostKbAgentDispatchResponse200;
    };
  };
  "POST /kb/agent/stop": {
    request: PostKbAgentStopRequest;
    responses: {
      200: PostKbAgentStopResponse200;
      400: PostKbAgentStopResponse400;
    };
  };
  "GET /kb/agent/runs": {
    request: GetKbAgentRunsRequest;
    responses: {
      200: GetKbAgentRunsResponse200;
    };
  };
  "POST /kb/agent/feedback": {
    request: PostKbAgentFeedbackRequest;
    responses: {
      200: PostKbAgentFeedbackResponse200;
      400: PostKbAgentFeedbackResponse400;
    };
  };
  "GET /kb/agent/feedback/stats": {
    request: GetKbAgentFeedbackStatsRequest;
    responses: {
      200: GetKbAgentFeedbackStatsResponse200;
    };
  };
  "GET /kb/agent/feedback/by-task": {
    request: GetKbAgentFeedbackByTaskRequest;
    responses: {
      200: GetKbAgentFeedbackByTaskResponse200;
    };
  };
  "GET /kb/agent/persona": {
    request: GetKbAgentPersonaRequest;
    responses: {
      200: GetKbAgentPersonaResponse200;
    };
  };
  "PUT /kb/agent/persona": {
    request: PutKbAgentPersonaRequest;
    responses: {
      200: PutKbAgentPersonaResponse200;
    };
  };
  "GET /kb/agent/personas": {
    request: GetKbAgentPersonasRequest;
    responses: {
      200: GetKbAgentPersonasResponse200;
    };
  };
  "POST /kb/agent/personas": {
    request: PostKbAgentPersonasRequest;
    responses: {
      200: PostKbAgentPersonasResponse200;
    };
  };
  "PUT /kb/agent/personas/active": {
    request: PutKbAgentPersonasActiveRequest;
    responses: {
      200: PutKbAgentPersonasActiveResponse200;
      404: PutKbAgentPersonasActiveResponse404;
    };
  };
  "PUT /kb/agent/personas/:id": {
    request: PutKbAgentPersonasIdRequest;
    responses: {
      200: PutKbAgentPersonasIdResponse200;
      404: PutKbAgentPersonasIdResponse404;
    };
  };
  "DELETE /kb/agent/personas/:id": {
    request: DeleteKbAgentPersonasIdRequest;
    responses: {
      200: DeleteKbAgentPersonasIdResponse200;
      400: DeleteKbAgentPersonasIdResponse400;
    };
  };
  "GET /kb/agent/catalog": {
    request: GetKbAgentCatalogRequest;
    responses: {
      200: GetKbAgentCatalogResponse200;
    };
  };
  "GET /kb/agent/commands": {
    request: GetKbAgentCommandsRequest;
    responses: {
      200: GetKbAgentCommandsResponse200;
    };
  };
  "GET /kb/agent/generation-library": {
    request: GetKbAgentGenerationLibraryRequest;
    responses: {
      200: GetKbAgentGenerationLibraryResponse200;
    };
  };
  "GET /kb/agent/skill-library": {
    request: GetKbAgentSkillLibraryRequest;
    responses: {
      200: GetKbAgentSkillLibraryResponse200;
    };
  };
  "GET /kb/agent/project-memory": {
    request: GetKbAgentProjectMemoryRequest;
    responses: {
      200: GetKbAgentProjectMemoryResponse200;
    };
  };
  "DELETE /kb/agent/project-memory": {
    request: DeleteKbAgentProjectMemoryRequest;
    responses: {
      200: DeleteKbAgentProjectMemoryResponse200;
      404: DeleteKbAgentProjectMemoryResponse404;
    };
  };
  "GET /kb/agent/tool-approvals": {
    request: GetKbAgentToolApprovalsRequest;
    responses: {
      200: GetKbAgentToolApprovalsResponse200;
    };
  };
  "DELETE /kb/agent/tool-approvals": {
    request: DeleteKbAgentToolApprovalsRequest;
    responses: {
      200: DeleteKbAgentToolApprovalsResponse200;
      400: DeleteKbAgentToolApprovalsResponse400;
    };
  };
  "GET /kb/agent/session-memory": {
    request: GetKbAgentSessionMemoryRequest;
    responses: {
      200: GetKbAgentSessionMemoryResponse200;
      400: GetKbAgentSessionMemoryResponse400;
    };
  };
  "DELETE /kb/agent/session-memory": {
    request: DeleteKbAgentSessionMemoryRequest;
    responses: {
      200: DeleteKbAgentSessionMemoryResponse200;
      400: DeleteKbAgentSessionMemoryResponse400;
    };
  };
  "POST /kb/agent/ask": {
    request: PostKbAgentAskRequest;
    responses: {
      200: PostKbAgentAskResponse200;
      400: PostKbAgentAskResponse400;
    };
  };
  "GET /kb/agent/ask/history": {
    request: GetKbAgentAskHistoryRequest;
    responses: {
      200: GetKbAgentAskHistoryResponse200;
    };
  };
  "DELETE /kb/agent/ask/history": {
    request: DeleteKbAgentAskHistoryRequest;
    responses: {
      200: DeleteKbAgentAskHistoryResponse200;
    };
  };
  "GET /kb/chat/sessions": {
    request: GetKbChatSessionsRequest;
    responses: {
      200: GetKbChatSessionsResponse200;
    };
  };
  "POST /kb/chat/sessions": {
    request: PostKbChatSessionsRequest;
    responses: {
      201: PostKbChatSessionsResponse201;
    };
  };
  "GET /kb/chat/sessions/:id": {
    request: GetKbChatSessionsIdRequest;
    responses: {
      200: GetKbChatSessionsIdResponse200;
      400: GetKbChatSessionsIdResponse400;
      404: GetKbChatSessionsIdResponse404;
    };
  };
  "PATCH /kb/chat/sessions/:id": {
    request: PatchKbChatSessionsIdRequest;
    responses: {
      200: PatchKbChatSessionsIdResponse200;
      400: PatchKbChatSessionsIdResponse400;
      404: PatchKbChatSessionsIdResponse404;
    };
  };
  "DELETE /kb/chat/sessions/:id": {
    request: DeleteKbChatSessionsIdRequest;
    responses: {
      200: DeleteKbChatSessionsIdResponse200;
      404: DeleteKbChatSessionsIdResponse404;
    };
  };
  "POST /kb/chat/sessions/:id/messages": {
    request: PostKbChatSessionsIdMessagesRequest;
    responses: {
      201: PostKbChatSessionsIdMessagesResponse201;
      400: PostKbChatSessionsIdMessagesResponse400;
      404: PostKbChatSessionsIdMessagesResponse404;
    };
  };
  "DELETE /kb/chat/sessions/:id/messages": {
    request: DeleteKbChatSessionsIdMessagesRequest;
    responses: {
      200: DeleteKbChatSessionsIdMessagesResponse200;
    };
  };
  "GET /agent/v2/session/route": {
    request: GetAgentV2SessionRouteRequest;
    responses: {
      200: GetAgentV2SessionRouteResponse200;
      400: GetAgentV2SessionRouteResponse400;
    };
  };
  "PUT /agent/v2/session/route": {
    request: PutAgentV2SessionRouteRequest;
    responses: {
      200: PutAgentV2SessionRouteResponse200;
      400: PutAgentV2SessionRouteResponse400;
      409: PutAgentV2SessionRouteResponse409;
      503: PutAgentV2SessionRouteResponse503;
    };
  };
  "GET /agent/v2/session/route/history": {
    request: GetAgentV2SessionRouteHistoryRequest;
    responses: {
      200: GetAgentV2SessionRouteHistoryResponse200;
      400: GetAgentV2SessionRouteHistoryResponse400;
    };
  };
  "GET /kb/docs/templates": {
    request: GetKbDocsTemplatesRequest;
    responses: {
      200: GetKbDocsTemplatesResponse200;
      400: GetKbDocsTemplatesResponse400;
      404: GetKbDocsTemplatesResponse404;
    };
  };
  "GET /kb/docs/commands": {
    request: GetKbDocsCommandsRequest;
    responses: {
      200: GetKbDocsCommandsResponse200;
      400: GetKbDocsCommandsResponse400;
      404: GetKbDocsCommandsResponse404;
    };
  };
  "PUT /kb/docs/templates/:folder": {
    request: PutKbDocsTemplatesFolderRequest;
    responses: {
      200: PutKbDocsTemplatesFolderResponse200;
      400: PutKbDocsTemplatesFolderResponse400;
      404: PutKbDocsTemplatesFolderResponse404;
      409: PutKbDocsTemplatesFolderResponse409;
    };
  };
  "DELETE /kb/docs/templates/:folder": {
    request: DeleteKbDocsTemplatesFolderRequest;
    responses: {
      200: DeleteKbDocsTemplatesFolderResponse200;
      400: DeleteKbDocsTemplatesFolderResponse400;
      404: DeleteKbDocsTemplatesFolderResponse404;
      409: DeleteKbDocsTemplatesFolderResponse409;
    };
  };
  "PUT /kb/docs/commands/:folder": {
    request: PutKbDocsCommandsFolderRequest;
    responses: {
      200: PutKbDocsCommandsFolderResponse200;
      400: PutKbDocsCommandsFolderResponse400;
      404: PutKbDocsCommandsFolderResponse404;
    };
  };
  "DELETE /kb/docs/commands/:folder": {
    request: DeleteKbDocsCommandsFolderRequest;
    responses: {
      200: DeleteKbDocsCommandsFolderResponse200;
      400: DeleteKbDocsCommandsFolderResponse400;
      404: DeleteKbDocsCommandsFolderResponse404;
    };
  };
  "POST /kb/docs/seed": {
    request: PostKbDocsSeedRequest;
    responses: {
      200: PostKbDocsSeedResponse200;
      400: PostKbDocsSeedResponse400;
      404: PostKbDocsSeedResponse404;
    };
  };
  "POST /kb/projects/register": {
    request: PostKbProjectsRegisterRequest;
    responses: {
      200: PostKbProjectsRegisterResponse200;
      400: PostKbProjectsRegisterResponse400;
      409: PostKbProjectsRegisterResponse409;
    };
  };
  "GET /auth/me/extensions/installed": {
    request: GetAuthMeExtensionsInstalledRequest;
    responses: {
      200: GetAuthMeExtensionsInstalledResponse200;
      401: GetAuthMeExtensionsInstalledResponse401;
    };
  };
  "POST /auth/me/extensions/install": {
    request: PostAuthMeExtensionsInstallRequest;
    responses: {
      200: PostAuthMeExtensionsInstallResponse200;
      400: PostAuthMeExtensionsInstallResponse400;
      401: PostAuthMeExtensionsInstallResponse401;
      403: PostAuthMeExtensionsInstallResponse403;
      404: PostAuthMeExtensionsInstallResponse404;
      409: PostAuthMeExtensionsInstallResponse409;
      422: PostAuthMeExtensionsInstallResponse422;
    };
  };
  "POST /auth/me/extensions/toggle": {
    request: PostAuthMeExtensionsToggleRequest;
    responses: {
      200: PostAuthMeExtensionsToggleResponse200;
      400: PostAuthMeExtensionsToggleResponse400;
      401: PostAuthMeExtensionsToggleResponse401;
      404: PostAuthMeExtensionsToggleResponse404;
      409: PostAuthMeExtensionsToggleResponse409;
    };
  };
  "POST /auth/me/extensions/uninstall": {
    request: PostAuthMeExtensionsUninstallRequest;
    responses: {
      200: PostAuthMeExtensionsUninstallResponse200;
      401: PostAuthMeExtensionsUninstallResponse401;
      404: PostAuthMeExtensionsUninstallResponse404;
    };
  };
  "GET /auth/me/extensions/catalog": {
    request: GetAuthMeExtensionsCatalogRequest;
    responses: {
      200: GetAuthMeExtensionsCatalogResponse200;
      400: GetAuthMeExtensionsCatalogResponse400;
      401: GetAuthMeExtensionsCatalogResponse401;
    };
  };
  "POST /auth/me/extensions/catalog/refresh": {
    request: PostAuthMeExtensionsCatalogRefreshRequest;
    responses: {
      200: PostAuthMeExtensionsCatalogRefreshResponse200;
      400: PostAuthMeExtensionsCatalogRefreshResponse400;
      401: PostAuthMeExtensionsCatalogRefreshResponse401;
      404: PostAuthMeExtensionsCatalogRefreshResponse404;
    };
  };
  "GET /auth/me/extensions/active": {
    request: GetAuthMeExtensionsActiveRequest;
    responses: {
      200: GetAuthMeExtensionsActiveResponse200;
      401: GetAuthMeExtensionsActiveResponse401;
    };
  };
  "GET /auth/me/extensions/updates": {
    request: GetAuthMeExtensionsUpdatesRequest;
    responses: {
      200: GetAuthMeExtensionsUpdatesResponse200;
      401: GetAuthMeExtensionsUpdatesResponse401;
    };
  };
  "POST /auth/me/extensions/updates/check": {
    request: PostAuthMeExtensionsUpdatesCheckRequest;
    responses: {
      200: PostAuthMeExtensionsUpdatesCheckResponse200;
      401: PostAuthMeExtensionsUpdatesCheckResponse401;
      404: PostAuthMeExtensionsUpdatesCheckResponse404;
    };
  };
  "POST /auth/me/extensions/update/preview": {
    request: PostAuthMeExtensionsUpdatePreviewRequest;
    responses: {
      200: PostAuthMeExtensionsUpdatePreviewResponse200;
      400: PostAuthMeExtensionsUpdatePreviewResponse400;
      401: PostAuthMeExtensionsUpdatePreviewResponse401;
      404: PostAuthMeExtensionsUpdatePreviewResponse404;
      409: PostAuthMeExtensionsUpdatePreviewResponse409;
      422: PostAuthMeExtensionsUpdatePreviewResponse422;
    };
  };
  "POST /auth/me/extensions/update": {
    request: PostAuthMeExtensionsUpdateRequest;
    responses: {
      200: PostAuthMeExtensionsUpdateResponse200;
      400: PostAuthMeExtensionsUpdateResponse400;
      401: PostAuthMeExtensionsUpdateResponse401;
      404: PostAuthMeExtensionsUpdateResponse404;
      409: PostAuthMeExtensionsUpdateResponse409;
      422: PostAuthMeExtensionsUpdateResponse422;
    };
  };
  "POST /auth/me/extensions/rollback": {
    request: PostAuthMeExtensionsRollbackRequest;
    responses: {
      200: PostAuthMeExtensionsRollbackResponse200;
      401: PostAuthMeExtensionsRollbackResponse401;
      404: PostAuthMeExtensionsRollbackResponse404;
      409: PostAuthMeExtensionsRollbackResponse409;
    };
  };
  "POST /auth/me/extensions/repair": {
    request: PostAuthMeExtensionsRepairRequest;
    responses: {
      200: PostAuthMeExtensionsRepairResponse200;
      401: PostAuthMeExtensionsRepairResponse401;
      404: PostAuthMeExtensionsRepairResponse404;
      409: PostAuthMeExtensionsRepairResponse409;
    };
  };
  "GET /auth/me/workspace-trust": {
    request: GetAuthMeWorkspaceTrustRequest;
    responses: {
      200: GetAuthMeWorkspaceTrustResponse200;
      401: GetAuthMeWorkspaceTrustResponse401;
    };
  };
  "PUT /auth/me/workspace-trust": {
    request: PutAuthMeWorkspaceTrustRequest;
    responses: {
      200: PutAuthMeWorkspaceTrustResponse200;
      400: PutAuthMeWorkspaceTrustResponse400;
      401: PutAuthMeWorkspaceTrustResponse401;
      404: PutAuthMeWorkspaceTrustResponse404;
    };
  };
  "GET /auth/me/extensions/allowlist": {
    request: GetAuthMeExtensionsAllowlistRequest;
    responses: {
      200: GetAuthMeExtensionsAllowlistResponse200;
      401: GetAuthMeExtensionsAllowlistResponse401;
    };
  };
  "PUT /auth/me/extensions/allowlist": {
    request: PutAuthMeExtensionsAllowlistRequest;
    responses: {
      200: PutAuthMeExtensionsAllowlistResponse200;
      400: PutAuthMeExtensionsAllowlistResponse400;
      401: PutAuthMeExtensionsAllowlistResponse401;
      403: PutAuthMeExtensionsAllowlistResponse403;
    };
  };
  "GET /": {
    request: GetRequest;
    responses: {
      200: GetResponse200;
    };
  };
  "GET /health": {
    request: GetHealthRequest;
    responses: {
      200: GetHealthResponse200;
    };
  };
  "GET /launch-app": {
    request: GetLaunchAppRequest;
    responses: {
      302: GetLaunchAppResponse302;
    };
  };
  "GET /auth/well-known": {
    request: GetAuthWellKnownRequest;
    responses: {
      200: GetAuthWellKnownResponse200;
    };
  };
  "POST /auth/register": {
    request: PostAuthRegisterRequest;
    responses: {
      201: PostAuthRegisterResponse201;
      400: PostAuthRegisterResponse400;
      403: PostAuthRegisterResponse403;
      409: PostAuthRegisterResponse409;
      429: PostAuthRegisterResponse429;
    };
  };
  "POST /auth/login": {
    request: PostAuthLoginRequest;
    responses: {
      200: PostAuthLoginResponse200;
      401: PostAuthLoginResponse401;
      429: PostAuthLoginResponse429;
    };
  };
  "POST /auth/refresh": {
    request: PostAuthRefreshRequest;
    responses: {
      200: PostAuthRefreshResponse200;
      401: PostAuthRefreshResponse401;
      429: PostAuthRefreshResponse429;
    };
  };
  "POST /auth/logout": {
    request: PostAuthLogoutRequest;
    responses: {
      200: PostAuthLogoutResponse200;
      401: PostAuthLogoutResponse401;
    };
  };
  "POST /auth/reset-request": {
    request: PostAuthResetRequestRequest;
    responses: {
      200: PostAuthResetRequestResponse200;
      429: PostAuthResetRequestResponse429;
    };
  };
  "POST /auth/reset-confirm": {
    request: PostAuthResetConfirmRequest;
    responses: {
      200: PostAuthResetConfirmResponse200;
      400: PostAuthResetConfirmResponse400;
      401: PostAuthResetConfirmResponse401;
      429: PostAuthResetConfirmResponse429;
    };
  };
  "POST /auth/google/start": {
    request: PostAuthGoogleStartRequest;
    responses: {
      200: PostAuthGoogleStartResponse200;
      401: PostAuthGoogleStartResponse401;
      503: PostAuthGoogleStartResponse503;
    };
  };
  "GET /auth/google/status": {
    request: GetAuthGoogleStatusRequest;
    responses: {
      200: GetAuthGoogleStatusResponse200;
      401: GetAuthGoogleStatusResponse401;
    };
  };
  "GET /auth/google/callback": {
    request: GetAuthGoogleCallbackRequest;
    responses: {
      200: GetAuthGoogleCallbackResponse200;
      429: GetAuthGoogleCallbackResponse429;
    };
  };
  "POST /auth/slack/start": {
    request: PostAuthSlackStartRequest;
    responses: {
      200: PostAuthSlackStartResponse200;
      401: PostAuthSlackStartResponse401;
      503: PostAuthSlackStartResponse503;
    };
  };
  "GET /auth/slack/status": {
    request: GetAuthSlackStatusRequest;
    responses: {
      200: GetAuthSlackStatusResponse200;
      401: GetAuthSlackStatusResponse401;
    };
  };
  "GET /auth/slack/callback": {
    request: GetAuthSlackCallbackRequest;
    responses: {
      200: GetAuthSlackCallbackResponse200;
    };
  };
  "GET /auth/mcp-connector/callback": {
    request: GetAuthMcpConnectorCallbackRequest;
    responses: {
      200: GetAuthMcpConnectorCallbackResponse200;
    };
  };
  "GET /auth/me": {
    request: GetAuthMeRequest;
    responses: {
      200: GetAuthMeResponse200;
      401: GetAuthMeResponse401;
    };
  };
  "POST /auth/me/password": {
    request: PostAuthMePasswordRequest;
    responses: {
      200: PostAuthMePasswordResponse200;
      400: PostAuthMePasswordResponse400;
      401: PostAuthMePasswordResponse401;
    };
  };
  "GET /auth/me/prefs": {
    request: GetAuthMePrefsRequest;
    responses: {
      200: GetAuthMePrefsResponse200;
      401: GetAuthMePrefsResponse401;
    };
  };
  "PUT /auth/me/prefs": {
    request: PutAuthMePrefsRequest;
    responses: {
      200: PutAuthMePrefsResponse200;
      401: PutAuthMePrefsResponse401;
    };
  };
  "GET /auth/me/secrets": {
    request: GetAuthMeSecretsRequest;
    responses: {
      200: GetAuthMeSecretsResponse200;
      401: GetAuthMeSecretsResponse401;
    };
  };
  "POST /auth/me/secrets": {
    request: PostAuthMeSecretsRequest;
    responses: {
      200: PostAuthMeSecretsResponse200;
      400: PostAuthMeSecretsResponse400;
      401: PostAuthMeSecretsResponse401;
    };
  };
  "POST /auth/me/repos": {
    request: PostAuthMeReposRequest;
    responses: {
      200: PostAuthMeReposResponse200;
      400: PostAuthMeReposResponse400;
      401: PostAuthMeReposResponse401;
    };
  };
  "GET /auth/me/plugins": {
    request: GetAuthMePluginsRequest;
    responses: {
      200: GetAuthMePluginsResponse200;
      401: GetAuthMePluginsResponse401;
    };
  };
  "POST /auth/me/plugins/toggle": {
    request: PostAuthMePluginsToggleRequest;
    responses: {
      200: PostAuthMePluginsToggleResponse200;
      400: PostAuthMePluginsToggleResponse400;
      401: PostAuthMePluginsToggleResponse401;
    };
  };
  "POST /auth/me/plugins/hook-trust": {
    request: PostAuthMePluginsHookTrustRequest;
    responses: {
      200: PostAuthMePluginsHookTrustResponse200;
      400: PostAuthMePluginsHookTrustResponse400;
      401: PostAuthMePluginsHookTrustResponse401;
    };
  };
  "POST /auth/me/plugins/reload": {
    request: PostAuthMePluginsReloadRequest;
    responses: {
      200: PostAuthMePluginsReloadResponse200;
      401: PostAuthMePluginsReloadResponse401;
    };
  };
  "POST /auth/me/plugins/install": {
    request: PostAuthMePluginsInstallRequest;
    responses: {
      200: PostAuthMePluginsInstallResponse200;
      400: PostAuthMePluginsInstallResponse400;
      401: PostAuthMePluginsInstallResponse401;
    };
  };
  "DELETE /auth/me/plugins/uninstall/:name": {
    request: DeleteAuthMePluginsUninstallNameRequest;
    responses: {
      200: DeleteAuthMePluginsUninstallNameResponse200;
      401: DeleteAuthMePluginsUninstallNameResponse401;
    };
  };
  "GET /auth/me/claude-plugins/installed": {
    request: GetAuthMeClaudePluginsInstalledRequest;
    responses: {
      200: GetAuthMeClaudePluginsInstalledResponse200;
      401: GetAuthMeClaudePluginsInstalledResponse401;
    };
  };
  "GET /auth/me/claude-plugins/marketplace": {
    request: GetAuthMeClaudePluginsMarketplaceRequest;
    responses: {
      200: GetAuthMeClaudePluginsMarketplaceResponse200;
      401: GetAuthMeClaudePluginsMarketplaceResponse401;
    };
  };
  "POST /auth/me/claude-plugins/import": {
    request: PostAuthMeClaudePluginsImportRequest;
    responses: {
      200: PostAuthMeClaudePluginsImportResponse200;
      400: PostAuthMeClaudePluginsImportResponse400;
      401: PostAuthMeClaudePluginsImportResponse401;
      404: PostAuthMeClaudePluginsImportResponse404;
    };
  };
  "POST /auth/me/claude-plugins/refresh": {
    request: PostAuthMeClaudePluginsRefreshRequest;
    responses: {
      200: PostAuthMeClaudePluginsRefreshResponse200;
      401: PostAuthMeClaudePluginsRefreshResponse401;
    };
  };
  "GET /auth/me/claude-plugins/updates": {
    request: GetAuthMeClaudePluginsUpdatesRequest;
    responses: {
      200: GetAuthMeClaudePluginsUpdatesResponse200;
      401: GetAuthMeClaudePluginsUpdatesResponse401;
    };
  };
  "POST /auth/me/claude-plugins/update": {
    request: PostAuthMeClaudePluginsUpdateRequest;
    responses: {
      200: PostAuthMeClaudePluginsUpdateResponse200;
      401: PostAuthMeClaudePluginsUpdateResponse401;
      404: PostAuthMeClaudePluginsUpdateResponse404;
    };
  };
  "GET /auth/me/codex-plugins/installed": {
    request: GetAuthMeCodexPluginsInstalledRequest;
    responses: {
      200: GetAuthMeCodexPluginsInstalledResponse200;
      401: GetAuthMeCodexPluginsInstalledResponse401;
    };
  };
  "GET /auth/me/codex-plugins/marketplace": {
    request: GetAuthMeCodexPluginsMarketplaceRequest;
    responses: {
      200: GetAuthMeCodexPluginsMarketplaceResponse200;
      401: GetAuthMeCodexPluginsMarketplaceResponse401;
    };
  };
  "POST /auth/me/codex-plugins/import": {
    request: PostAuthMeCodexPluginsImportRequest;
    responses: {
      200: PostAuthMeCodexPluginsImportResponse200;
      400: PostAuthMeCodexPluginsImportResponse400;
      401: PostAuthMeCodexPluginsImportResponse401;
      404: PostAuthMeCodexPluginsImportResponse404;
    };
  };
  "POST /auth/me/codex-plugins/refresh": {
    request: PostAuthMeCodexPluginsRefreshRequest;
    responses: {
      200: PostAuthMeCodexPluginsRefreshResponse200;
      401: PostAuthMeCodexPluginsRefreshResponse401;
    };
  };
  "GET /auth/me/codex-plugins/updates": {
    request: GetAuthMeCodexPluginsUpdatesRequest;
    responses: {
      200: GetAuthMeCodexPluginsUpdatesResponse200;
      401: GetAuthMeCodexPluginsUpdatesResponse401;
    };
  };
  "GET /auth/me/llm-sources": {
    request: GetAuthMeLlmSourcesRequest;
    responses: {
      200: GetAuthMeLlmSourcesResponse200;
      401: GetAuthMeLlmSourcesResponse401;
    };
  };
  "GET /auth/me/llm-sources/updates": {
    request: GetAuthMeLlmSourcesUpdatesRequest;
    responses: {
      200: GetAuthMeLlmSourcesUpdatesResponse200;
      401: GetAuthMeLlmSourcesUpdatesResponse401;
    };
  };
  "POST /auth/me/llm-sources/toggle": {
    request: PostAuthMeLlmSourcesToggleRequest;
    responses: {
      200: PostAuthMeLlmSourcesToggleResponse200;
      400: PostAuthMeLlmSourcesToggleResponse400;
      401: PostAuthMeLlmSourcesToggleResponse401;
    };
  };
  "POST /auth/me/llm-sources/items": {
    request: PostAuthMeLlmSourcesItemsRequest;
    responses: {
      200: PostAuthMeLlmSourcesItemsResponse200;
      401: PostAuthMeLlmSourcesItemsResponse401;
    };
  };
  "POST /auth/me/llm-sources/add": {
    request: PostAuthMeLlmSourcesAddRequest;
    responses: {
      200: PostAuthMeLlmSourcesAddResponse200;
      400: PostAuthMeLlmSourcesAddResponse400;
      401: PostAuthMeLlmSourcesAddResponse401;
    };
  };
  "POST /auth/me/llm-sources/update": {
    request: PostAuthMeLlmSourcesUpdateRequest;
    responses: {
      200: PostAuthMeLlmSourcesUpdateResponse200;
      401: PostAuthMeLlmSourcesUpdateResponse401;
      404: PostAuthMeLlmSourcesUpdateResponse404;
    };
  };
  "DELETE /auth/me/llm-sources/:id": {
    request: DeleteAuthMeLlmSourcesIdRequest;
    responses: {
      200: DeleteAuthMeLlmSourcesIdResponse200;
      400: DeleteAuthMeLlmSourcesIdResponse400;
      401: DeleteAuthMeLlmSourcesIdResponse401;
    };
  };
  "GET /auth/me/llm-sources/:id/discovery": {
    request: GetAuthMeLlmSourcesIdDiscoveryRequest;
    responses: {
      200: GetAuthMeLlmSourcesIdDiscoveryResponse200;
      401: GetAuthMeLlmSourcesIdDiscoveryResponse401;
      404: GetAuthMeLlmSourcesIdDiscoveryResponse404;
    };
  };
  "GET /auth/me/mcp-plugins": {
    request: GetAuthMeMcpPluginsRequest;
    responses: {
      200: GetAuthMeMcpPluginsResponse200;
      401: GetAuthMeMcpPluginsResponse401;
    };
  };
  "GET /auth/me/mcp-plugins/catalog": {
    request: GetAuthMeMcpPluginsCatalogRequest;
    responses: {
      200: GetAuthMeMcpPluginsCatalogResponse200;
      401: GetAuthMeMcpPluginsCatalogResponse401;
    };
  };
  "GET /auth/me/mcp-plugins/claude-sources": {
    request: GetAuthMeMcpPluginsClaudeSourcesRequest;
    responses: {
      200: GetAuthMeMcpPluginsClaudeSourcesResponse200;
      401: GetAuthMeMcpPluginsClaudeSourcesResponse401;
    };
  };
  "GET /auth/me/mcp-plugins/codex-sources": {
    request: GetAuthMeMcpPluginsCodexSourcesRequest;
    responses: {
      200: GetAuthMeMcpPluginsCodexSourcesResponse200;
      401: GetAuthMeMcpPluginsCodexSourcesResponse401;
    };
  };
  "GET /auth/me/mcp-plugins/updates": {
    request: GetAuthMeMcpPluginsUpdatesRequest;
    responses: {
      200: GetAuthMeMcpPluginsUpdatesResponse200;
      401: GetAuthMeMcpPluginsUpdatesResponse401;
    };
  };
  "POST /auth/me/mcp-plugins/add": {
    request: PostAuthMeMcpPluginsAddRequest;
    responses: {
      200: PostAuthMeMcpPluginsAddResponse200;
      400: PostAuthMeMcpPluginsAddResponse400;
      401: PostAuthMeMcpPluginsAddResponse401;
    };
  };
  "POST /auth/me/mcp-plugins/consent": {
    request: PostAuthMeMcpPluginsConsentRequest;
    responses: {
      200: PostAuthMeMcpPluginsConsentResponse200;
      401: PostAuthMeMcpPluginsConsentResponse401;
    };
  };
  "POST /auth/me/mcp-plugins/toggle": {
    request: PostAuthMeMcpPluginsToggleRequest;
    responses: {
      200: PostAuthMeMcpPluginsToggleResponse200;
      401: PostAuthMeMcpPluginsToggleResponse401;
      409: PostAuthMeMcpPluginsToggleResponse409;
    };
  };
  "GET /auth/me/mcp-plugins/:id/resync": {
    request: GetAuthMeMcpPluginsIdResyncRequest;
    responses: {
      200: GetAuthMeMcpPluginsIdResyncResponse200;
      400: GetAuthMeMcpPluginsIdResyncResponse400;
      401: GetAuthMeMcpPluginsIdResyncResponse401;
      404: GetAuthMeMcpPluginsIdResyncResponse404;
    };
  };
  "POST /auth/me/mcp-plugins/:id/resync": {
    request: PostAuthMeMcpPluginsIdResyncRequest;
    responses: {
      200: PostAuthMeMcpPluginsIdResyncResponse200;
      400: PostAuthMeMcpPluginsIdResyncResponse400;
      401: PostAuthMeMcpPluginsIdResyncResponse401;
      404: PostAuthMeMcpPluginsIdResyncResponse404;
    };
  };
  "POST /auth/me/mcp-plugins/:id/update": {
    request: PostAuthMeMcpPluginsIdUpdateRequest;
    responses: {
      200: PostAuthMeMcpPluginsIdUpdateResponse200;
      401: PostAuthMeMcpPluginsIdUpdateResponse401;
      404: PostAuthMeMcpPluginsIdUpdateResponse404;
    };
  };
  "DELETE /auth/me/mcp-plugins/:id": {
    request: DeleteAuthMeMcpPluginsIdRequest;
    responses: {
      200: DeleteAuthMeMcpPluginsIdResponse200;
      401: DeleteAuthMeMcpPluginsIdResponse401;
      404: DeleteAuthMeMcpPluginsIdResponse404;
    };
  };
  "GET /auth/me/connectors": {
    request: GetAuthMeConnectorsRequest;
    responses: {
      200: GetAuthMeConnectorsResponse200;
      401: GetAuthMeConnectorsResponse401;
    };
  };
  "GET /auth/me/connectors/catalog": {
    request: GetAuthMeConnectorsCatalogRequest;
    responses: {
      200: GetAuthMeConnectorsCatalogResponse200;
      401: GetAuthMeConnectorsCatalogResponse401;
    };
  };
  "POST /auth/me/connectors/add": {
    request: PostAuthMeConnectorsAddRequest;
    responses: {
      200: PostAuthMeConnectorsAddResponse200;
      400: PostAuthMeConnectorsAddResponse400;
      401: PostAuthMeConnectorsAddResponse401;
    };
  };
  "DELETE /auth/me/connectors/:id": {
    request: DeleteAuthMeConnectorsIdRequest;
    responses: {
      200: DeleteAuthMeConnectorsIdResponse200;
      401: DeleteAuthMeConnectorsIdResponse401;
    };
  };
  "POST /kb/index/notes": {
    request: PostKbIndexNotesRequest;
    responses: {
      200: PostKbIndexNotesResponse200;
      400: PostKbIndexNotesResponse400;
    };
  };
  "POST /kb/index/reconcile": {
    request: PostKbIndexReconcileRequest;
    responses: {
      200: PostKbIndexReconcileResponse200;
      400: PostKbIndexReconcileResponse400;
      409: PostKbIndexReconcileResponse409;
    };
  };
  "DELETE /kb/index/notes/:key": {
    request: DeleteKbIndexNotesKeyRequest;
    responses: {
      200: DeleteKbIndexNotesKeyResponse200;
      400: DeleteKbIndexNotesKeyResponse400;
    };
  };
  "GET /kb/index/search": {
    request: GetKbIndexSearchRequest;
    responses: {
      200: GetKbIndexSearchResponse200;
      400: GetKbIndexSearchResponse400;
    };
  };
  "GET /kb/index/status": {
    request: GetKbIndexStatusRequest;
    responses: {
      200: GetKbIndexStatusResponse200;
    };
  };
  "POST /kb/index/scan": {
    request: PostKbIndexScanRequest;
    responses: {
      200: PostKbIndexScanResponse200;
      400: PostKbIndexScanResponse400;
      409: PostKbIndexScanResponse409;
    };
  };
  "GET /kb/search": {
    request: GetKbSearchRequest;
    responses: {
      200: GetKbSearchResponse200;
      401: GetKbSearchResponse401;
    };
  };
  "GET /kb/issues": {
    request: GetKbIssuesRequest;
    responses: {
      200: GetKbIssuesResponse200;
      401: GetKbIssuesResponse401;
    };
  };
  "GET /kb/meeting/:id": {
    request: GetKbMeetingIdRequest;
    responses: {
      200: GetKbMeetingIdResponse200;
      400: GetKbMeetingIdResponse400;
      401: GetKbMeetingIdResponse401;
      404: GetKbMeetingIdResponse404;
    };
  };
  "GET /kb/entity/:id": {
    request: GetKbEntityIdRequest;
    responses: {
      200: GetKbEntityIdResponse200;
      400: GetKbEntityIdResponse400;
      401: GetKbEntityIdResponse401;
      404: GetKbEntityIdResponse404;
    };
  };
  "GET /kb/project/:id/export": {
    request: GetKbProjectIdExportRequest;
    responses: {
      200: GetKbProjectIdExportResponse200;
      400: GetKbProjectIdExportResponse400;
      401: GetKbProjectIdExportResponse401;
    };
  };
  "POST /kb/project/install-skills": {
    request: PostKbProjectInstallSkillsRequest;
    responses: {
      200: PostKbProjectInstallSkillsResponse200;
      400: PostKbProjectInstallSkillsResponse400;
      401: PostKbProjectInstallSkillsResponse401;
      404: PostKbProjectInstallSkillsResponse404;
    };
  };
  "GET /kb/stats": {
    request: GetKbStatsRequest;
    responses: {
      200: GetKbStatsResponse200;
      401: GetKbStatsResponse401;
    };
  };
  "GET /kb/system/status": {
    request: GetKbSystemStatusRequest;
    responses: {
      200: GetKbSystemStatusResponse200;
      401: GetKbSystemStatusResponse401;
    };
  };
  "GET /kb/export-all": {
    request: GetKbExportAllRequest;
    responses: {
      200: GetKbExportAllResponse200;
      401: GetKbExportAllResponse401;
    };
  };
  "POST /kb/delete": {
    request: PostKbDeleteRequest;
    responses: {
      200: PostKbDeleteResponse200;
      400: PostKbDeleteResponse400;
      401: PostKbDeleteResponse401;
    };
  };
  "DELETE /kb/delete": {
    request: DeleteKbDeleteRequest;
    responses: {
      200: DeleteKbDeleteResponse200;
      400: DeleteKbDeleteResponse400;
      401: DeleteKbDeleteResponse401;
    };
  };
  "POST /kb/ingest": {
    request: PostKbIngestRequest;
    responses: {
      200: PostKbIngestResponse200;
      400: PostKbIngestResponse400;
      401: PostKbIngestResponse401;
    };
  };
  "POST /kb/connect-git": {
    request: PostKbConnectGitRequest;
    responses: {
      200: PostKbConnectGitResponse200;
      400: PostKbConnectGitResponse400;
      401: PostKbConnectGitResponse401;
      403: PostKbConnectGitResponse403;
    };
  };
  "POST /kb/ingest-scip": {
    request: PostKbIngestScipRequest;
    responses: {
      200: PostKbIngestScipResponse200;
      400: PostKbIngestScipResponse400;
      401: PostKbIngestScipResponse401;
      403: PostKbIngestScipResponse403;
    };
  };
  "POST /kb/connect-github-issues": {
    request: PostKbConnectGithubIssuesRequest;
    responses: {
      200: PostKbConnectGithubIssuesResponse200;
      400: PostKbConnectGithubIssuesResponse400;
      401: PostKbConnectGithubIssuesResponse401;
    };
  };
  "POST /kb/connect-tickets-json": {
    request: PostKbConnectTicketsJsonRequest;
    responses: {
      200: PostKbConnectTicketsJsonResponse200;
      400: PostKbConnectTicketsJsonResponse400;
      401: PostKbConnectTicketsJsonResponse401;
    };
  };
  "POST /kb/connect-qa": {
    request: PostKbConnectQaRequest;
    responses: {
      200: PostKbConnectQaResponse200;
      400: PostKbConnectQaResponse400;
      401: PostKbConnectQaResponse401;
    };
  };
  "POST /kb/email/test": {
    request: PostKbEmailTestRequest;
    responses: {
      200: PostKbEmailTestResponse200;
      400: PostKbEmailTestResponse400;
      401: PostKbEmailTestResponse401;
      502: PostKbEmailTestResponse502;
    };
  };
  "POST /kb/email/fetch": {
    request: PostKbEmailFetchRequest;
    responses: {
      200: PostKbEmailFetchResponse200;
      400: PostKbEmailFetchResponse400;
      401: PostKbEmailFetchResponse401;
      502: PostKbEmailFetchResponse502;
    };
  };
  "POST /kb/email/seen": {
    request: PostKbEmailSeenRequest;
    responses: {
      200: PostKbEmailSeenResponse200;
      401: PostKbEmailSeenResponse401;
    };
  };
  "POST /kb/email/classify": {
    request: PostKbEmailClassifyRequest;
    responses: {
      200: PostKbEmailClassifyResponse200;
      400: PostKbEmailClassifyResponse400;
      401: PostKbEmailClassifyResponse401;
    };
  };
  "POST /kb/slack/test": {
    request: PostKbSlackTestRequest;
    responses: {
      200: PostKbSlackTestResponse200;
      400: PostKbSlackTestResponse400;
      401: PostKbSlackTestResponse401;
      502: PostKbSlackTestResponse502;
    };
  };
  "POST /kb/slack/fetch": {
    request: PostKbSlackFetchRequest;
    responses: {
      200: PostKbSlackFetchResponse200;
      400: PostKbSlackFetchResponse400;
      401: PostKbSlackFetchResponse401;
      502: PostKbSlackFetchResponse502;
    };
  };
  "POST /kb/slack/seen": {
    request: PostKbSlackSeenRequest;
    responses: {
      200: PostKbSlackSeenResponse200;
      401: PostKbSlackSeenResponse401;
    };
  };
  "GET /kb/slack/conversations": {
    request: GetKbSlackConversationsRequest;
    responses: {
      200: GetKbSlackConversationsResponse200;
      400: GetKbSlackConversationsResponse400;
      401: GetKbSlackConversationsResponse401;
    };
  };
  "POST /kb/box/test": {
    request: PostKbBoxTestRequest;
    responses: {
      200: PostKbBoxTestResponse200;
      400: PostKbBoxTestResponse400;
      401: PostKbBoxTestResponse401;
      502: PostKbBoxTestResponse502;
    };
  };
  "POST /kb/connect-box": {
    request: PostKbConnectBoxRequest;
    responses: {
      200: PostKbConnectBoxResponse200;
      400: PostKbConnectBoxResponse400;
      401: PostKbConnectBoxResponse401;
      502: PostKbConnectBoxResponse502;
    };
  };
  "POST /kb/mcp-connector/test": {
    request: PostKbMcpConnectorTestRequest;
    responses: {
      200: PostKbMcpConnectorTestResponse200;
      400: PostKbMcpConnectorTestResponse400;
      401: PostKbMcpConnectorTestResponse401;
      502: PostKbMcpConnectorTestResponse502;
    };
  };
  "POST /kb/mcp-connector/fetch": {
    request: PostKbMcpConnectorFetchRequest;
    responses: {
      200: PostKbMcpConnectorFetchResponse200;
      400: PostKbMcpConnectorFetchResponse400;
      401: PostKbMcpConnectorFetchResponse401;
      502: PostKbMcpConnectorFetchResponse502;
    };
  };
  "POST /kb/mcp-connector/seen": {
    request: PostKbMcpConnectorSeenRequest;
    responses: {
      200: PostKbMcpConnectorSeenResponse200;
      401: PostKbMcpConnectorSeenResponse401;
    };
  };
  "POST /kb/mcp-connector/classify": {
    request: PostKbMcpConnectorClassifyRequest;
    responses: {
      200: PostKbMcpConnectorClassifyResponse200;
      400: PostKbMcpConnectorClassifyResponse400;
      401: PostKbMcpConnectorClassifyResponse401;
      502: PostKbMcpConnectorClassifyResponse502;
    };
  };
  "GET /kb/activity": {
    request: GetKbActivityRequest;
    responses: {
      200: GetKbActivityResponse200;
      401: GetKbActivityResponse401;
    };
  };
  "POST /kb/activity": {
    request: PostKbActivityRequest;
    responses: {
      200: PostKbActivityResponse200;
      400: PostKbActivityResponse400;
      401: PostKbActivityResponse401;
    };
  };
  "POST /kb/activity/seen": {
    request: PostKbActivitySeenRequest;
    responses: {
      200: PostKbActivitySeenResponse200;
      401: PostKbActivitySeenResponse401;
    };
  };
  "GET /kb/agent/working-state": {
    request: GetKbAgentWorkingStateRequest;
    responses: {
      200: GetKbAgentWorkingStateResponse200;
    };
  };
  "POST /agent/v2/sessions/purge": {
    request: PostAgentV2SessionsPurgeRequest;
    responses: {
      200: PostAgentV2SessionsPurgeResponse200;
      400: PostAgentV2SessionsPurgeResponse400;
      409: PostAgentV2SessionsPurgeResponse409;
    };
  };
  "POST /kb/session-purges": {
    request: PostKbSessionPurgesRequest;
    responses: {
      202: PostKbSessionPurgesResponse202;
      400: PostKbSessionPurgesResponse400;
    };
  };
  "POST /kb/chat/sessions/:id/archive/begin": {
    request: PostKbChatSessionsIdArchiveBeginRequest;
    responses: {
      200: PostKbChatSessionsIdArchiveBeginResponse200;
      404: PostKbChatSessionsIdArchiveBeginResponse404;
      409: PostKbChatSessionsIdArchiveBeginResponse409;
    };
  };
  "POST /kb/chat/sessions/:id/archive/commit": {
    request: PostKbChatSessionsIdArchiveCommitRequest;
    responses: {
      200: PostKbChatSessionsIdArchiveCommitResponse200;
      400: PostKbChatSessionsIdArchiveCommitResponse400;
      404: PostKbChatSessionsIdArchiveCommitResponse404;
      409: PostKbChatSessionsIdArchiveCommitResponse409;
    };
  };
  "POST /kb/live/:id/ack": {
    request: PostKbLiveIdAckRequest;
    responses: {
      200: PostKbLiveIdAckResponse200;
      400: PostKbLiveIdAckResponse400;
      404: PostKbLiveIdAckResponse404;
      409: PostKbLiveIdAckResponse409;
    };
  };
  "GET /kb/live/:id/status": {
    request: GetKbLiveIdStatusRequest;
    responses: {
      200: GetKbLiveIdStatusResponse200;
    };
  };
  "GET /kb/live/unacked": {
    request: GetKbLiveUnackedRequest;
    responses: {
      200: GetKbLiveUnackedResponse200;
    };
  };
  "POST /kb/archive-receipts": {
    request: PostKbArchiveReceiptsRequest;
    responses: {
      200: PostKbArchiveReceiptsResponse200;
      400: PostKbArchiveReceiptsResponse400;
    };
  };
  "POST /kb/loop/agent-run": {
    request: PostKbLoopAgentRunRequest;
    responses: {
      200: PostKbLoopAgentRunResponse200;
      400: PostKbLoopAgentRunResponse400;
      401: PostKbLoopAgentRunResponse401;
      404: PostKbLoopAgentRunResponse404;
      502: PostKbLoopAgentRunResponse502;
      503: PostKbLoopAgentRunResponse503;
      504: PostKbLoopAgentRunResponse504;
    };
  };
  "POST /kb/ingest-code-graph": {
    request: PostKbIngestCodeGraphRequest;
    responses: {
      200: PostKbIngestCodeGraphResponse200;
      400: PostKbIngestCodeGraphResponse400;
      401: PostKbIngestCodeGraphResponse401;
      403: PostKbIngestCodeGraphResponse403;
      404: PostKbIngestCodeGraphResponse404;
    };
  };
  "GET /kb/issue-schedule": {
    request: GetKbIssueScheduleRequest;
    responses: {
      200: GetKbIssueScheduleResponse200;
      400: GetKbIssueScheduleResponse400;
      401: GetKbIssueScheduleResponse401;
      404: GetKbIssueScheduleResponse404;
    };
  };
  "PUT /kb/issue-schedule": {
    request: PutKbIssueScheduleRequest;
    responses: {
      200: PutKbIssueScheduleResponse200;
      400: PutKbIssueScheduleResponse400;
      401: PutKbIssueScheduleResponse401;
      404: PutKbIssueScheduleResponse404;
    };
  };
  "DELETE /kb/issue-schedule": {
    request: DeleteKbIssueScheduleRequest;
    responses: {
      200: DeleteKbIssueScheduleResponse200;
      400: DeleteKbIssueScheduleResponse400;
      401: DeleteKbIssueScheduleResponse401;
      404: DeleteKbIssueScheduleResponse404;
    };
  };
  "GET /kb/live/sessions": {
    request: GetKbLiveSessionsRequest;
    responses: {
      200: GetKbLiveSessionsResponse200;
      401: GetKbLiveSessionsResponse401;
    };
  };
  "GET /kb/live/:id": {
    request: GetKbLiveIdRequest;
    responses: {
      200: GetKbLiveIdResponse200;
      401: GetKbLiveIdResponse401;
    };
  };
  "POST /kb/live/:id/append": {
    request: PostKbLiveIdAppendRequest;
    responses: {
      200: PostKbLiveIdAppendResponse200;
      400: PostKbLiveIdAppendResponse400;
      401: PostKbLiveIdAppendResponse401;
      429: PostKbLiveIdAppendResponse429;
    };
  };
  "POST /kb/live/:id/finalize": {
    request: PostKbLiveIdFinalizeRequest;
    responses: {
      200: PostKbLiveIdFinalizeResponse200;
      400: PostKbLiveIdFinalizeResponse400;
      401: PostKbLiveIdFinalizeResponse401;
    };
  };
  "GET /kb/live/:id/stream": {
    request: GetKbLiveIdStreamRequest;
    responses: {
      200: GetKbLiveIdStreamResponse200;
      401: GetKbLiveIdStreamResponse401;
      429: GetKbLiveIdStreamResponse429;
    };
  };
  "GET /auth/me/audit": {
    request: GetAuthMeAuditRequest;
    responses: {
      200: GetAuthMeAuditResponse200;
      401: GetAuthMeAuditResponse401;
    };
  };
  "POST /auth/me/delete": {
    request: PostAuthMeDeleteRequest;
    responses: {
      200: PostAuthMeDeleteResponse200;
      401: PostAuthMeDeleteResponse401;
    };
  };
  "POST /auth/mcp-connector/start": {
    request: PostAuthMcpConnectorStartRequest;
    responses: {
      200: PostAuthMcpConnectorStartResponse200;
      400: PostAuthMcpConnectorStartResponse400;
      401: PostAuthMcpConnectorStartResponse401;
      502: PostAuthMcpConnectorStartResponse502;
    };
  };
  "GET /auth/mcp-connector/status": {
    request: GetAuthMcpConnectorStatusRequest;
    responses: {
      200: GetAuthMcpConnectorStatusResponse200;
      400: GetAuthMcpConnectorStatusResponse400;
      401: GetAuthMcpConnectorStatusResponse401;
    };
  };
  "POST /generate-notes": {
    request: PostGenerateNotesRequest;
    responses: {
      200: PostGenerateNotesResponse200;
      400: PostGenerateNotesResponse400;
      401: PostGenerateNotesResponse401;
      429: PostGenerateNotesResponse429;
      500: PostGenerateNotesResponse500;
    };
  };
  "POST /generate-questions": {
    request: PostGenerateQuestionsRequest;
    responses: {
      200: PostGenerateQuestionsResponse200;
      400: PostGenerateQuestionsResponse400;
      401: PostGenerateQuestionsResponse401;
      429: PostGenerateQuestionsResponse429;
      500: PostGenerateQuestionsResponse500;
    };
  };
  "POST /extract-entities": {
    request: PostExtractEntitiesRequest;
    responses: {
      200: PostExtractEntitiesResponse200;
      400: PostExtractEntitiesResponse400;
      401: PostExtractEntitiesResponse401;
      429: PostExtractEntitiesResponse429;
      500: PostExtractEntitiesResponse500;
    };
  };
  "POST /generate-doc": {
    request: PostGenerateDocRequest;
    responses: {
      200: PostGenerateDocResponse200;
      400: PostGenerateDocResponse400;
      401: PostGenerateDocResponse401;
      429: PostGenerateDocResponse429;
      500: PostGenerateDocResponse500;
    };
  };
  "POST /generate-docx": {
    request: PostGenerateDocxRequest;
    responses: {
      200: PostGenerateDocxResponse200;
      400: PostGenerateDocxResponse400;
      401: PostGenerateDocxResponse401;
      429: PostGenerateDocxResponse429;
      500: PostGenerateDocxResponse500;
    };
  };
  "POST /chat": {
    request: PostChatRequest;
    responses: {
      401: PostChatResponse401;
      410: PostChatResponse410;
      429: PostChatResponse429;
    };
  };
  "POST /code-assist": {
    request: PostCodeAssistRequest;
    responses: {
      401: PostCodeAssistResponse401;
      410: PostCodeAssistResponse410;
      429: PostCodeAssistResponse429;
    };
  };
  "POST /code-assist/decision": {
    request: PostCodeAssistDecisionRequest;
    responses: {
      401: PostCodeAssistDecisionResponse401;
      410: PostCodeAssistDecisionResponse410;
    };
  };
  "POST /agent-sdk/spike": {
    request: PostAgentSdkSpikeRequest;
    responses: {
      200: PostAgentSdkSpikeResponse200;
      400: PostAgentSdkSpikeResponse400;
      401: PostAgentSdkSpikeResponse401;
    };
  };
  "POST /kb/complete": {
    request: PostKbCompleteRequest;
    responses: {
      200: PostKbCompleteResponse200;
      400: PostKbCompleteResponse400;
      401: PostKbCompleteResponse401;
      429: PostKbCompleteResponse429;
      502: PostKbCompleteResponse502;
    };
  };
  "GET /kb/os/state": {
    request: GetKbOsStateRequest;
    responses: {
      200: GetKbOsStateResponse200;
      400: GetKbOsStateResponse400;
      401: GetKbOsStateResponse401;
    };
  };
  "GET /kb/os/stream": {
    request: GetKbOsStreamRequest;
    responses: {
      200: GetKbOsStreamResponse200;
      401: GetKbOsStreamResponse401;
      429: GetKbOsStreamResponse429;
    };
  };
  "POST /kb/generate-plan": {
    request: PostKbGeneratePlanRequest;
    responses: {
      200: PostKbGeneratePlanResponse200;
      400: PostKbGeneratePlanResponse400;
      401: PostKbGeneratePlanResponse401;
      429: PostKbGeneratePlanResponse429;
      500: PostKbGeneratePlanResponse500;
    };
  };
  "POST /kb/analyze-risks": {
    request: PostKbAnalyzeRisksRequest;
    responses: {
      200: PostKbAnalyzeRisksResponse200;
      400: PostKbAnalyzeRisksResponse400;
      401: PostKbAnalyzeRisksResponse401;
      404: PostKbAnalyzeRisksResponse404;
      429: PostKbAnalyzeRisksResponse429;
      500: PostKbAnalyzeRisksResponse500;
    };
  };
  "POST /kb/code-sync": {
    request: PostKbCodeSyncRequest;
    responses: {
      200: PostKbCodeSyncResponse200;
      400: PostKbCodeSyncResponse400;
      401: PostKbCodeSyncResponse401;
      404: PostKbCodeSyncResponse404;
    };
  };
  "GET /kb/plans": {
    request: GetKbPlansRequest;
    responses: {
      200: GetKbPlansResponse200;
      401: GetKbPlansResponse401;
    };
  };
  "GET /kb/plan/:id": {
    request: GetKbPlanIdRequest;
    responses: {
      200: GetKbPlanIdResponse200;
      401: GetKbPlanIdResponse401;
      404: GetKbPlanIdResponse404;
    };
  };
  "POST /kb/plan/save": {
    request: PostKbPlanSaveRequest;
    responses: {
      200: PostKbPlanSaveResponse200;
      400: PostKbPlanSaveResponse400;
      401: PostKbPlanSaveResponse401;
      500: PostKbPlanSaveResponse500;
    };
  };
  "DELETE /kb/plan/delete": {
    request: DeleteKbPlanDeleteRequest;
    responses: {
      200: DeleteKbPlanDeleteResponse200;
      400: DeleteKbPlanDeleteResponse400;
      401: DeleteKbPlanDeleteResponse401;
    };
  };
  "POST /kb/plan/delete": {
    request: PostKbPlanDeleteRequest;
    responses: {
      200: PostKbPlanDeleteResponse200;
      400: PostKbPlanDeleteResponse400;
      401: PostKbPlanDeleteResponse401;
    };
  };
  "PATCH /kb/plan-task/update": {
    request: PatchKbPlanTaskUpdateRequest;
    responses: {
      200: PatchKbPlanTaskUpdateResponse200;
      400: PatchKbPlanTaskUpdateResponse400;
      401: PatchKbPlanTaskUpdateResponse401;
      404: PatchKbPlanTaskUpdateResponse404;
    };
  };
  "POST /kb/plan-task/update": {
    request: PostKbPlanTaskUpdateRequest;
    responses: {
      200: PostKbPlanTaskUpdateResponse200;
      400: PostKbPlanTaskUpdateResponse400;
      401: PostKbPlanTaskUpdateResponse401;
      404: PostKbPlanTaskUpdateResponse404;
    };
  };
  "POST /kb/dispatch": {
    request: PostKbDispatchRequest;
    responses: {
      200: PostKbDispatchResponse200;
      400: PostKbDispatchResponse400;
      401: PostKbDispatchResponse401;
      403: PostKbDispatchResponse403;
      429: PostKbDispatchResponse429;
    };
  };
  "POST /kb/generate-code": {
    request: PostKbGenerateCodeRequest;
    responses: {
      200: PostKbGenerateCodeResponse200;
      400: PostKbGenerateCodeResponse400;
      401: PostKbGenerateCodeResponse401;
      429: PostKbGenerateCodeResponse429;
      500: PostKbGenerateCodeResponse500;
    };
  };
  "POST /kb/summarize": {
    request: PostKbSummarizeRequest;
    responses: {
      200: PostKbSummarizeResponse200;
      400: PostKbSummarizeResponse400;
      401: PostKbSummarizeResponse401;
      429: PostKbSummarizeResponse429;
      500: PostKbSummarizeResponse500;
      502: PostKbSummarizeResponse502;
    };
  };
  "POST /kb/conflict-questions": {
    request: PostKbConflictQuestionsRequest;
    responses: {
      200: PostKbConflictQuestionsResponse200;
      401: PostKbConflictQuestionsResponse401;
      429: PostKbConflictQuestionsResponse429;
      500: PostKbConflictQuestionsResponse500;
    };
  };
  "POST /kb/notify/slack": {
    request: PostKbNotifySlackRequest;
    responses: {
      200: PostKbNotifySlackResponse200;
      400: PostKbNotifySlackResponse400;
      401: PostKbNotifySlackResponse401;
      404: PostKbNotifySlackResponse404;
      429: PostKbNotifySlackResponse429;
    };
  };
  "POST /kb/outcomes/refresh": {
    request: PostKbOutcomesRefreshRequest;
    responses: {
      200: PostKbOutcomesRefreshResponse200;
      401: PostKbOutcomesRefreshResponse401;
      429: PostKbOutcomesRefreshResponse429;
    };
  };
  "POST /kb/outcomes/retry-failed": {
    request: PostKbOutcomesRetryFailedRequest;
    responses: {
      200: PostKbOutcomesRetryFailedResponse200;
      401: PostKbOutcomesRetryFailedResponse401;
    };
  };
  "GET /kb/outcomes/task/:id": {
    request: GetKbOutcomesTaskIdRequest;
    responses: {
      200: GetKbOutcomesTaskIdResponse200;
      400: GetKbOutcomesTaskIdResponse400;
      401: GetKbOutcomesTaskIdResponse401;
    };
  };
  "GET /kb/outcomes/stats": {
    request: GetKbOutcomesStatsRequest;
    responses: {
      200: GetKbOutcomesStatsResponse200;
      401: GetKbOutcomesStatsResponse401;
    };
  };
  "GET /kb/providers/catalog": {
    request: GetKbProvidersCatalogRequest;
    responses: {
      200: GetKbProvidersCatalogResponse200;
      401: GetKbProvidersCatalogResponse401;
    };
  };
  "POST /kb/providers/catalog/connect": {
    request: PostKbProvidersCatalogConnectRequest;
    responses: {
      200: PostKbProvidersCatalogConnectResponse200;
      400: PostKbProvidersCatalogConnectResponse400;
      401: PostKbProvidersCatalogConnectResponse401;
      404: PostKbProvidersCatalogConnectResponse404;
      409: PostKbProvidersCatalogConnectResponse409;
    };
  };
  "POST /kb/providers/catalog/disconnect": {
    request: PostKbProvidersCatalogDisconnectRequest;
    responses: {
      200: PostKbProvidersCatalogDisconnectResponse200;
    };
  };
  "POST /kb/providers/catalog/test": {
    request: PostKbProvidersCatalogTestRequest;
    responses: {
      200: PostKbProvidersCatalogTestResponse200;
      404: PostKbProvidersCatalogTestResponse404;
    };
  };
  "POST /kb/providers/catalog/models": {
    request: PostKbProvidersCatalogModelsRequest;
    responses: {
      200: PostKbProvidersCatalogModelsResponse200;
      403: PostKbProvidersCatalogModelsResponse403;
      404: PostKbProvidersCatalogModelsResponse404;
    };
  };
  "GET /kb/providers/settings": {
    request: GetKbProvidersSettingsRequest;
    responses: {
      200: GetKbProvidersSettingsResponse200;
      401: GetKbProvidersSettingsResponse401;
    };
  };
  "PUT /kb/providers/settings": {
    request: PutKbProvidersSettingsRequest;
    responses: {
      200: PutKbProvidersSettingsResponse200;
    };
  };
  "POST /kb/providers/turn": {
    request: PostKbProvidersTurnRequest;
    responses: {
      200: PostKbProvidersTurnResponse200;
      400: PostKbProvidersTurnResponse400;
      401: PostKbProvidersTurnResponse401;
      403: PostKbProvidersTurnResponse403;
      404: PostKbProvidersTurnResponse404;
    };
  };
  "POST /kb/providers/verify": {
    request: PostKbProvidersVerifyRequest;
    responses: {
      200: PostKbProvidersVerifyResponse200;
      400: PostKbProvidersVerifyResponse400;
      401: PostKbProvidersVerifyResponse401;
      429: PostKbProvidersVerifyResponse429;
    };
  };
  "POST /kb/providers/models": {
    request: PostKbProvidersModelsRequest;
    responses: {
      200: PostKbProvidersModelsResponse200;
      400: PostKbProvidersModelsResponse400;
      401: PostKbProvidersModelsResponse401;
      429: PostKbProvidersModelsResponse429;
    };
  };
  "GET /kb/agent-sdk": {
    request: GetKbAgentSdkRequest;
    responses: {
      200: GetKbAgentSdkResponse200;
      401: GetKbAgentSdkResponse401;
    };
  };
  "POST /kb/agent-sdk/update": {
    request: PostKbAgentSdkUpdateRequest;
    responses: {
      200: PostKbAgentSdkUpdateResponse200;
      401: PostKbAgentSdkUpdateResponse401;
    };
  };
  "POST /kb/custom-providers": {
    request: PostKbCustomProvidersRequest;
    responses: {
      200: PostKbCustomProvidersResponse200;
      400: PostKbCustomProvidersResponse400;
      401: PostKbCustomProvidersResponse401;
    };
  };
  "GET /kb/routing-tiers": {
    request: GetKbRoutingTiersRequest;
    responses: {
      200: GetKbRoutingTiersResponse200;
      401: GetKbRoutingTiersResponse401;
    };
  };
  "POST /kb/routing-tiers": {
    request: PostKbRoutingTiersRequest;
    responses: {
      200: PostKbRoutingTiersResponse200;
      400: PostKbRoutingTiersResponse400;
      401: PostKbRoutingTiersResponse401;
    };
  };
  "GET /kb/usage/limits": {
    request: GetKbUsageLimitsRequest;
    responses: {
      200: GetKbUsageLimitsResponse200;
      401: GetKbUsageLimitsResponse401;
    };
  };
  "PUT /kb/usage/limits": {
    request: PutKbUsageLimitsRequest;
    responses: {
      200: PutKbUsageLimitsResponse200;
      400: PutKbUsageLimitsResponse400;
      401: PutKbUsageLimitsResponse401;
      429: PutKbUsageLimitsResponse429;
    };
  };
  "GET /kb/usage/summary": {
    request: GetKbUsageSummaryRequest;
    responses: {
      200: GetKbUsageSummaryResponse200;
      401: GetKbUsageSummaryResponse401;
    };
  };
  "GET /kb/usage/resolve": {
    request: GetKbUsageResolveRequest;
    responses: {
      200: GetKbUsageResolveResponse200;
      400: GetKbUsageResolveResponse400;
      401: GetKbUsageResolveResponse401;
    };
  };
  "GET /kb/usage/ratelimits": {
    request: GetKbUsageRatelimitsRequest;
    responses: {
      200: GetKbUsageRatelimitsResponse200;
      401: GetKbUsageRatelimitsResponse401;
    };
  };
  "GET /kb/usage/turn-composition": {
    request: GetKbUsageTurnCompositionRequest;
    responses: {
      200: GetKbUsageTurnCompositionResponse200;
      401: GetKbUsageTurnCompositionResponse401;
    };
  };
  "POST /kb/usage/record": {
    request: PostKbUsageRecordRequest;
    responses: {
      200: PostKbUsageRecordResponse200;
      400: PostKbUsageRecordResponse400;
      401: PostKbUsageRecordResponse401;
      429: PostKbUsageRecordResponse429;
    };
  };
  "POST /kb/review/submit": {
    request: PostKbReviewSubmitRequest;
    responses: {
      200: PostKbReviewSubmitResponse200;
      400: PostKbReviewSubmitResponse400;
      401: PostKbReviewSubmitResponse401;
      429: PostKbReviewSubmitResponse429;
    };
  };
  "GET /kb/review/list": {
    request: GetKbReviewListRequest;
    responses: {
      200: GetKbReviewListResponse200;
      401: GetKbReviewListResponse401;
    };
  };
  "GET /kb/review/get/:id": {
    request: GetKbReviewGetIdRequest;
    responses: {
      200: GetKbReviewGetIdResponse200;
      401: GetKbReviewGetIdResponse401;
      404: GetKbReviewGetIdResponse404;
    };
  };
  "POST /kb/review/approve": {
    request: PostKbReviewApproveRequest;
    responses: {
      200: PostKbReviewApproveResponse200;
      400: PostKbReviewApproveResponse400;
      401: PostKbReviewApproveResponse401;
      404: PostKbReviewApproveResponse404;
      409: PostKbReviewApproveResponse409;
      422: PostKbReviewApproveResponse422;
      429: PostKbReviewApproveResponse429;
      500: PostKbReviewApproveResponse500;
    };
  };
  "POST /kb/review/reject": {
    request: PostKbReviewRejectRequest;
    responses: {
      200: PostKbReviewRejectResponse200;
      400: PostKbReviewRejectResponse400;
      401: PostKbReviewRejectResponse401;
      404: PostKbReviewRejectResponse404;
      409: PostKbReviewRejectResponse409;
      429: PostKbReviewRejectResponse429;
    };
  };
  "DELETE /kb/review/delete": {
    request: DeleteKbReviewDeleteRequest;
    responses: {
      200: DeleteKbReviewDeleteResponse200;
      400: DeleteKbReviewDeleteResponse400;
      401: DeleteKbReviewDeleteResponse401;
    };
  };
  "POST /kb/review/delete": {
    request: PostKbReviewDeleteRequest;
    responses: {
      200: PostKbReviewDeleteResponse200;
      401: PostKbReviewDeleteResponse401;
      429: PostKbReviewDeleteResponse429;
    };
  };
}

export type ApiEndpointKey = keyof ApiEndpoints;

export type ApiResponse<K extends ApiEndpointKey, S extends keyof ApiEndpoints[K]['responses']> =
  ApiEndpoints[K]['responses'][S];
