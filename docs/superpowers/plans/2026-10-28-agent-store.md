# Agent store: a separate `agent.db` for agent history, with rollups, retention and a Storage hub

Status: plan, not started. Branch: `main`. Date: 2026-10-28.
Research basis: read-only pass over `extension/` and `mac/` at `e2b41022`. Every
`path:line` below was read in that pass. Items marked **(confirm T0)** were not
read in full and must be checked in task T0.1 before code depends on them.

## 0. Decisions (fixed by the user, 2026-10-28)

1. **History moves, live state stays.** Agent-related history moves to a
   separate SQLite file `agent.db` next to the main DB. Live state stays in the
   main DB and cleaning never touches it: `agent_sessions`, `session_memory`,
   `tool_permission_rules`, `tool_approvals`, `personas` / `agent_ask_messages`,
   `agent_feedback`, `project_memory_ledger`, `model_limits`, `quota_state`.
2. **Cleaning = automatic compression + manual clear.** Raw rows are kept N days
   (default 30, configurable). Then they are rolled up into daily summaries
   (kept 400 days) and the raw rows are deleted. A Clear button shows a dry-run
   preview first. A Compact (VACUUM) button reclaims space. Everything is per user.
3. **Storage hub (10th part of the OS view).** It shows size, last cleaned and
   retention for every data group (agent history, search index, code graph,
   sources, meetings). Actions exist only for agent history. Agents, Models and
   Activity hubs read from the new store.
4. **Goals:** robust, professional, accurate, lightweight. Metadata only. No
   prompts or responses are ever stored.

Non-goals: moving live state; per-user files; cross-user analytics; storing
content of any kind.

---

## 1. Inventory

### 1.1 Tables in scope and their writers

| Table (main DB) | Created by | Writers (file:line) | Timestamp format |
|---|---|---|---|
| `usage_ledger` | `0019_usage_limits.sql`; `+cache_read/creation` `0032`; `+turns, stop_reason` `0039`; index `0047` | `kb/usage.mjs:390` (`recordUsage`, the single funnel) | `ts` = `datetime('now','localtime')` (`0019`) |
| `turn_tool_events` | `0035_turn_tool_events.sql` | `kb/tool-events.mjs:20` (`recordToolEvents`) | `created_at` UTC `…Z` |
| `turn_composition` | `0040` + `0044` split | `kb/turn-composition.mjs:98` (`recordTurnComposition`) | `created_at` UTC `…Z` |
| `activity` + `activity_seen` | `0018_activity.sql` | `kb/activity.mjs:68-74` (`recordActivity`, insert then prune to `KEEP_PER_USER=500`, `activity.mjs:28`) | `created_at` = `datetime('now')` (UTC) |

**Timezone trap.** `usage_ledger.ts` is local time. `turn_tool_events` and
`turn_composition` are UTC. Today's "day" windows are local midnight
(`kb/usage.mjs:87-92` `windowStart`, `:103-107` `toSqliteLocal`). The rollup
must use one day key, and that key is defined in §2.2.

### 1.2 Callers of `recordUsage` (the ledger writers)

| Caller | file:line | Sync or async | Notes |
|---|---|---|---|
| Provider call metering, `runClaudeDirect` | `providers/runtime.mjs:19` (in try) | sync, in-process | Also `flagQuota` at `:22` |
| Provider call metering, `callProvider` | `providers/providers.mjs:450` | sync | Per attempt; `recordRateLimits` in the same block |
| Native OpenAI-compatible loop | `llm_agent/runtime/route.mjs:572` | sync | `complete` wrapper, per call |
| Jev decisions | `providers/jev.mjs:251` | sync | provider `jev` |
| Agent v2 turn end | `routes/agent-v2.mjs:605` loop over `ledgerRowsForTurn` (`:210`) | sync, once per turn per model | `requestId: turnId` |
| Loop run end | `routes/loop-agent.mjs` `meterRun` (~`:62`), rows built ~`:70-80` | sync, once per run | `turns`, `stopReason` |
| HTTP | `routes/router.mjs:1061` `POST /kb/usage/record` | sync | Mac Auto Tasks CLI path |

`recordUsage` also emits `emitOsEvent(userId,'usage')` (`usage.mjs:405`) and
runs `maybePruneLedger` every 500 inserts (`usage.mjs:418-426`). That prune is a
**global** `DELETE … WHERE ts < 90 days` (`:425`). It must be retired in the new
store (see §2.6 and risk R4).

### 1.3 Readers of the ledger, and the hot path

This is the most important part of the inventory. Budget and limit enforcement
reads the ledger on the model-call path.

**H1. Auto-fallback resolve, on every direct provider call.**
- Entry: `providers/runtime.mjs:255` (`runClaudeDirect`, signature default
  `autoFallback = true`), guard at `:277`, call at `:285`
  `resolveUsageModel(getDb(), userId, prov, new Date(), { preferModel: model })`.
- Cost per call (synchronous, better-sqlite3, on the event loop):
  1. `getLimits` = 1 query on `model_limits` (`usage.mjs:229-233`).
  2. For each **enabled** model in the provider chain (`resolveModel`,
     `usage.mjs:556-589`): `usedForModel` (1 SUM query on `usage_ledger`,
     `usage.mjs:146-170`, filter `user_id, provider, model IN (aliases), ts >= ?`,
     plus `endpoint NOT LIKE '%:internal'`) and `isQuotaFlagged` (1 query on
     `quota_state`, `usage.mjs:218-224`).
  3. With N enabled models the call costs about `1 + 2N` queries. The default chains
     hold only a handful of entries in total (`DEFAULT_CHAINS`, `usage.mjs:40-58`),
     so N is small (about 3 for anthropic; confirm in T0.1).
- Latency budget for the new store (proposal): **p95 under 2 ms** for the whole
  H1 resolve on a user with 1M raw ledger rows in the window. Establish the
  baseline in T0.1 before any change.

**H2. Reactive fallback on a 429.** `providers/providers.mjs:471` (`flagQuota`)
and `:475` (`resolveUsageModel`). Rare, but it runs inside an error path, so it
must never throw.

**H3. Per-turn USD cap for the agent engine.** `llm_agent/sdk/engine.mjs:1107`
`resolveMaxBudgetUsd` → `usdCapForModel` (`usage.mjs:492-508`), one query on
`model_limits` per turn. It reads `model_limits`, which stays in the main DB.
It is not a ledger reader, but it is on the turn path and stays put.

**H4. Dashboard and summary (not hot, but per panel refresh).**
- `usageSummary` (`usage.mjs:591-614`): for every model, `usedForModel` +
  `isQuotaFlagged` + `tokenBreakdown` (`usage.mjs:185-215`, one SUM query with
  four columns and the `unknownRows` count), plus `resolveModel` per provider.
  Served by `GET /kb/usage/summary` (`routes/router.mjs:1027`).
- `GET /kb/usage/resolve` → `routes/router.mjs:1034` → `resolveModel`.
- `GET /kb/os/state` → `routes/os.mjs:227` → `usageForWindow`
  (`kb/os-state.mjs:86-115`, GROUP BY provider, model, source, endpoint over
  `ts >= windowSince`, `windowSince` at `:19-22`). Only `day` and `week` are
  accepted (`routes/os.mjs` window check, plus `TOKEN_WINDOWS` at
  `os-state.mjs:14-17`).

**H5. Turn and tool readers.**
- `kb/tool-events-summary.mjs:11` `summarizeToolEventsOn`: queries at `:20`,
  `:25`, `:33`, and a join to `usage_ledger` at `:49-51`
  (`request_id` ↔ `turn_id`). Used by the operator report.
- `kb/os-state.mjs` `rollupTurnComposition` input comes from
  `turnCompositionRecent` (`kb/turn-composition.mjs:115`,
  `ORDER BY created_at DESC LIMIT`), read at `routes/os.mjs` ~`:225`.
- `scripts/usage-report.mjs:82-85` (reads `usage_ledger` and checks
  `pragma_table_info` for `turns`); `scripts/retrieval-report.mjs:38, 72-92`
  (joins `turn_composition` ↔ `usage_ledger`).
- `routes/agent-v2.mjs:499` comment and `routes/loop-agent.mjs:59` reference the
  request-id join, which is the measurement contract (see test
  `tests/agent-v2-routes.test.mjs:1348-1408`).

**H6. Activity readers.** `kb/activity.mjs:92-96` (list with cursor),
`:108-110` (unread count), `:121-124` (seen cursor). Called from
`routes/os.mjs` (`listActivity`, `unreadCount`) on every `/kb/os/state`. The Mac
side reads `/kb/activity` via `mac/Sources/LlmIdeMac/Core/Platform/ActivityStore.swift`.

**Other activity writers (cross-cutting).**
`kb/meetings.mjs:106`, `kb/outcomes.mjs:214`, `providers/providers.mjs:480`
(`model_fallback`). Moving `activity` means these non-agent writers depend on the
agent store (see open question Q3).

### 1.4 Mac-side readers and writers

- `mac/Sources/LlmIdeMac/Core/Networking/API/LlmIdeAPIClient+Usage.swift` (usage
  endpoints), `Features/AutoTask/Views/ModelLimitsPanel.swift` (Models).
- `Features/System/Services/SystemBridge.swift:244` is the bridge request
  allowlist (`case ("GET", "/kb/os/state")`). Any new path is added here.
- `Features/System/Services/SystemEventStream.swift` (SSE consumer) and
  `Features/System/Views/SystemWebView.swift` (hosts the bundled page
  `Resources/os-view/index.html`, built from `ui/os-view`).
- `mac/Sources/APIContractLab/Routes.swift` and `mac/Tests/LlmIdeMacTests/SystemViewTests.swift`
  pin the os contract on the Swift side.
- **AutoTask run history is Mac-side JSON**, not server data:
  `Features/AutoTask/Models/AutoTaskRunHistory.swift:36-94` (`record`,
  `recentEntries`, `HistoryFile` load/save). It is not in the main DB and is not
  in `agent.db` today. See Q2.

### 1.5 Run registries (in memory, not in any DB)

- Chat turns: `routes/agent-v2.mjs:175` `listInFlightChatTurns` (`inFlightTurns` map).
- Meeting-agent runs: `agents/meeting-agent.mjs:331` `listRuns` (`runs` map).
- Live sessions: `listActiveSessions` (already read by `routes/os.mjs`).
- Loop runs: the Loop route is in-process; no registry was read in full **(confirm T0)**.
- Planner, dispatcher, and the `/kb/dispatch` path were **not** traced for run
  recording **(confirm T0)**.

### 1.6 Deletion, tests and invariants that constrain the design

- `kb/db.mjs:946-1044` `deleteUserCascade`: explicit per-table deletes for
  `usage_ledger` (`:1005`), `model_limits` (`:1006`), `quota_state` (`:1007`),
  `activity` (`:1000`), `activity_seen` (`:1001`), and the loop over
  `turn_tool_events` / `turn_composition` (`:1019-1023`). A new file means this
  function must also purge `agent.db` (see §2.8).
- `tests/user-delete-cascade.test.mjs` enumerates the user_id tables (see its
  header, lines 1-10). A table missing from the main cascade fails CI, so the
  agent store needs an equivalent enumerator.
- Test isolation: `core/config.mjs:197-199` `TEST_DB_PATH` under
  `NODE_TEST_CONTEXT`, `:242` `dbPath`. `kb/db.mjs:13` `DB_PATH`. Agent DB must
  derive its test path from the same switch.
- Tests that build their own tables or in-memory DBs (these break if the writer
  or reader signature changes): `tests/usage.test.mjs:320-327`,
  `tests/token-bench.test.mjs:150`, `tests/turn-token-totals.test.mjs:17`,
  `tests/model-ids.test.mjs:43-131`, `tests/os-state.test.mjs:64,157`,
  `tests/loop-agent.test.mjs:571-1185`, `tests/agent-v2-routes.test.mjs:174-1408`,
  `tests/agent-v2-live.test.mjs:208`, `tests/custom-provider-dispatch.test.mjs:133`,
  `tests/jev-decisions.test.mjs:104,472`, `tests/tier-routing.test.mjs:533`,
  `tests/usage-routes.test.mjs:175`, `tests/os-stream.test.mjs`,
  `tests/os-state-running.test.mjs`, `tests/activity.test.mjs:41-167`,
  `tests/tool-events.test.mjs:34`, `tests/turn-composition*.test.mjs`,
  `tests/user-delete-cascade.test.mjs:276-302`.

### 1.7 Migrations and the runner

- Main DB is at `0048_doc_project_roots.sql` (list of `kb/migrations/`).
- Runner: `kb/migrations.mjs` (`applyMigrations`, `FILE_RE` at top, `schema_migrations`
  table, FNV-1a checksum, JS data steps `JS_MIGRATIONS` for 45 and 46, transaction
  per file). It refuses to start in production on an edited applied migration.
- `0046_retired_model_ids.sql`: `usage_ledger` is **not** rewritten. Retired model
  ids are resolved at read time through `modelAliases` (`kb/model-ids.mjs`). The
  copy and the new reads must keep that alias behaviour.

### 1.8 Contracts, schemas and version

- `extension/server.mjs:281` `SERVER_API_VERSION = 82`. The comment at
  `server.mjs:277` still says `v79` (stale; fix in the same PR).
- `ALL_ENDPOINTS` contains `/kb/usage/*` (`server.mjs:336-343`) and `/kb/os/state`
  (`:401`). Write classification: `kbWrite` for `/kb/usage/limits` (`:432`),
  `/kb/usage/record` (`:474`), `/kb/activity*` (`:499`).
- `schema/http/os.schema.json` (`/kb/os/state` contract; "Token windows: day = last
  24 h, week = last 7 days"), `schema/http/providers-usage.schema.json` (usage
  routes), `schema/http/swift-decode-allowlist.json`, fixtures under
  `schema/http/fixtures/`. `make contract-gates` runs them.
- Rust viz for the OS view lives in the graph-kit submodule:
  `mac/LocalPackages/graph-kit/rust/os-graph/src/{viz,api,builder,orbit,lib}.rs`.
  The submodule is currently **dirty** in the working tree (`git status`: `M
  mac/LocalPackages/graph-kit`). This plan must not commit it.
- Web OS page source: `ui/os-view/` (Vite; `tests/os-view.test.mjs`). The bundled
  output is `mac/Sources/LlmIdeMac/Resources/os-view/`.

---

## 2. Design

### 2.1 Runs, calls, tool events

| Unit | Meaning | Table | Key | Written at |
|---|---|---|---|---|
| **call** | One metered model invocation or ledger row (today's `recordUsage` row). A chat turn can yield one row per model (`ledgerRowsForTurn`). | `usage_calls` | `request_id` = turn id | every `recordUsage` |
| **run** | One user-visible unit of agent work: chat turn (v2 or legacy), loop run, meeting-agent run, auto-task run, dispatch. Groups calls and tool events. | `agent_runs` | `run_id` = turn id | at run end (and an open row at start, see §2.5) |
| **tool event** | One tool call inside a run (today's `turn_tool_events`). Capped at 200 per turn (`tool-events.mjs:6`). | `agent_tool_events` | `run_id`, `seq` | at run end, batched |
| **composition** | One per-turn context split (today's `turn_composition`, chars and tokens only). | `turn_composition` | `run_id` | at run end, batched |

The join contract stays: `usage_calls.request_id = agent_runs.run_id =
agent_tool_events.run_id`. The test at `tests/agent-v2-routes.test.mjs:1348-1408`
must still pass.

### 2.2 Day key

Every row in `agent.db` carries `day TEXT NOT NULL` = **local calendar date
`YYYY-MM-DD` computed at write time** with the same `toSqliteLocal` rule the
budget windows use (`usage.mjs:103-107`). This makes rollup buckets identical to
`windowStart('daily'|'monthly')` (local midnight). Copied history gets
`day = date(created_at, 'localtime')` at copy time (DST edge cases accepted and
documented, see R5).

### 2.3 DDL (`agent.db`, migration `0001_agent_store.sql`)

```sql
-- One row per metered model call. Same columns the readers need today.
CREATE TABLE usage_calls (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                TEXT NOT NULL,
  day                    TEXT NOT NULL,            -- YYYY-MM-DD local
  ts                     TEXT NOT NULL,            -- YYYY-MM-DD HH:MM:SS local (window compares)
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'api',
  endpoint               TEXT,                     -- clamped 128
  is_internal            INTEGER NOT NULL DEFAULT 0, -- endpoint LIKE '%:internal' at write time
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_read_tokens      INTEGER,
  cache_creation_tokens  INTEGER,
  runs                   INTEGER NOT NULL DEFAULT 1,
  request_id             TEXT,
  turns                  INTEGER,
  stop_reason            TEXT
);
CREATE INDEX idx_uc_user_prov_model_day ON usage_calls(user_id, provider, model, day);
CREATE INDEX idx_uc_user_ts            ON usage_calls(user_id, ts);
CREATE INDEX idx_uc_request            ON usage_calls(request_id);

-- One row per user-visible agent run. Open row at start, closed at end.
CREATE TABLE agent_runs (
  run_id        TEXT PRIMARY KEY,                  -- turn id / run id
  user_id       TEXT NOT NULL,
  day           TEXT NOT NULL,
  source        TEXT NOT NULL,                     -- chat | loop | meeting | autotask | dispatch | review
  engine        TEXT,                              -- v2 | legacy | loop | meeting
  mode          TEXT,
  provider      TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'running',   -- running | ok | error | cancelled | aborted
  started_at    TEXT NOT NULL,                     -- UTC ISO
  ended_at      TEXT,
  duration_ms   INTEGER,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,        -- denormalised at close
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  stop_reason   TEXT,
  error_code    TEXT                               -- code only, never a message
);
CREATE INDEX idx_runs_user_started ON agent_runs(user_id, started_at);
CREATE INDEX idx_runs_user_day     ON agent_runs(user_id, day);

CREATE TABLE agent_tool_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  day          TEXT NOT NULL,
  engine       TEXT NOT NULL,
  mode         TEXT,
  seq          INTEGER NOT NULL,
  tool         TEXT NOT NULL,
  result_chars INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,
  is_error     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL                       -- UTC ISO
);
CREATE INDEX idx_ate_user_day ON agent_tool_events(user_id, day);
CREATE INDEX idx_ate_run      ON agent_tool_events(run_id);

-- Same columns as turn_composition today (migrations 0040 + 0044), keyed by run_id.
CREATE TABLE turn_composition ( /* identical column list to main-DB turn_composition */ );
CREATE INDEX idx_tc_user_day ON turn_composition(user_id, day);

-- Activity feed, moved (Q3). Same columns as 0018.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,
  link       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_user_time ON activity(user_id, created_at DESC, id DESC);
CREATE TABLE activity_seen (user_id TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL DEFAULT 0);

-- Daily rollup. One row per (user, local day, provider, model, source, endpoint, internal flag).
CREATE TABLE agent_daily (
  user_id               TEXT NOT NULL,
  day                   TEXT NOT NULL,             -- YYYY-MM-DD local
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  source                TEXT NOT NULL,
  endpoint              TEXT NOT NULL DEFAULT '',  -- '' = null, same as os-state COALESCE
  is_internal           INTEGER NOT NULL DEFAULT 0,
  calls                 INTEGER NOT NULL DEFAULT 0,
  runs                  INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  unknown_rows          INTEGER NOT NULL DEFAULT 0, -- rows with all four token columns NULL
  turns_sum             INTEGER NOT NULL DEFAULT 0,
  turns_rows            INTEGER NOT NULL DEFAULT 0,
  tool_calls            INTEGER NOT NULL DEFAULT 0, -- reserved for per-day tool roll-up
  PRIMARY KEY (user_id, day, provider, model, source, endpoint, is_internal)
) WITHOUT ROWID;
CREATE INDEX idx_daily_user_prov_model_day ON agent_daily(user_id, provider, model, day);

-- Global store state and per-user settings (see §2.7).
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE agent_user_settings (
  user_id          TEXT PRIMARY KEY,
  retention_days   INTEGER NOT NULL DEFAULT 30,     -- clamp 7..365
  last_rolled_day  TEXT,                            -- watermark: last day folded into agent_daily
  last_cleared_at  TEXT,
  last_cleared_scope TEXT,
  updated_at       TEXT NOT NULL
);
```

Notes:
- `usage_calls` deliberately keeps the existing column names so the readers'
  SQL changes only in the table name and the day filter.
- `agent_daily` has no `ts`, only `day`. Budget windows are local-day
  granular, so day-level sums are exact (see §2.6).
- `activity`, `activity_seen` are included only if Q3 is answered "move".
- `turn_composition` is copied as-is (same DDL as migrations 0040 and 0044,
  generated from the migration files, not retyped).

Size per 1k runs/day (estimates; measure in T0.1):

| Data | Rows per 1k runs | Bytes per row incl. index (est.) | Per day | Per 30 days raw |
|---|---|---|---|---|
| `usage_calls` (about 2 per run) | 2,000 | ~200 B | ~0.4 MB | ~12 MB |
| `agent_tool_events` (about 4 per run) | 4,000 | ~150 B | ~0.6 MB | ~18 MB |
| `turn_composition` (1 per run) | 1,000 | ~400 B | ~0.4 MB | ~12 MB |
| `agent_runs` (1 per run) | 1,000 | ~160 B | ~0.2 MB | ~5 MB |
| `agent_daily` (per day, about 20 keys per user) | 20 per user-day | ~120 B | negligible | ~400 days ≈ 1 MB per user |

The raw total is about 1.4 MB per 1k runs/day. At 30 days the raw store is about
47 MB; at 400 days of rollups it stays under a few MB per user. These are design
estimates. T0.1 replaces them with measured numbers.

### 2.4 Process design

**Path.** `LLMIDE_AGENT_DB_PATH` (new in `core/config.mjs`). Default:
`path.join(path.dirname(config.dbPath), 'agent.db')`, which is `kb/agent.db`
beside `kb/data.db`. Under `NODE_TEST_CONTEXT` with no explicit env, the path is
`${TEST_DB_PATH}.agent.db`, and the test teardown at `core/config.mjs:197-199`
removes it too.

**Module.** `kb/agent-db.mjs` (new). Exports:
`getAgentDb()`, `openAgentDb({ logger })`, `closeAgentDb()`, and a test seam
`setAgentDbForTests(handle)`. Same shape as `getDb`/`closeDb` in `kb/db.mjs:71-94`.

**Pragmas.** Same set as the main DB (`kb/db.mjs:54-61`): WAL, `synchronous=NORMAL`,
`busy_timeout=5000`, `temp_store=MEMORY`. Add `foreign_keys=ON` only if the
tables have FKs (they will not; per-user rows carry `user_id` with no FK, the same
pattern as `turn_tool_events`). Set `auto_vacuum=INCREMENTAL` at file creation,
before the first table, so space can be reclaimed in slices (§2.9).

**Migrations.** Own directory `kb/agent-migrations/`, numbered from `0001`. The
runner is the existing `applyMigrations` generalised to take `{ dir, table }`
(today it is hard-wired to `kb/migrations/` and `schema_migrations`,
see the `MIGRATIONS_DIR` constant and `applyMigrations` in `kb/migrations.mjs`). The main DB keeps its current behaviour. Same
checksum rule and production refusal.

**Writes.** Two classes, on purpose.
- `usage_calls`: **synchronous** insert in the same call as today. Reason in
  §2.6 (the caps read these rows, so they cannot lag).
- `agent_tool_events`, `turn_composition`, `agent_runs` close, `activity`: a
  **write queue**. Batched every 250 ms or 200 rows, whichever comes first, in one
  transaction. Bounded at 5,000 queued rows; over that, drop the oldest and bump
  `store_meta.dropped_rows` (visible in the Storage hub). Never throws into a turn
  (try/catch at enqueue and flush, as `recordToolEvents` does, `tool-events.mjs:12-38`).
- Flush on shutdown: call `flushAgentQueue()` from the same SIGTERM path that calls
  `closeDb` (`kb/db.mjs:83`). Also flush before any clear or compact.

**Open at boot.** Open in the server boot path after the main DB, not lazily
(budget reads need it on the first model call). Keep it off the Agent SDK path:
it imports nothing from `llm_agent/sdk/` (lazy-engine rule, `extension/CLAUDE.md`).
Health: add an `agentStore` check to `/health` (`server.mjs` checks) that is
`ok`, `degraded` (queue drops or quarantine happened), or `down`.

**Corruption.** On a `SQLITE_CORRUPT`/`SQLITE_NOTADB` error during open or write:
close the handle, rename `agent.db` to `agent.db.corrupt-<ISO>-<6 hex>`, and
recreate. The name must be **unique**. Never overwrite an existing quarantine.
This is the K1a lesson recorded in `docs/kits/docs-kit.md:318-321`
(`DamagedFileQuarantine.setAside` picks a free name). Also run
`PRAGMA quick_check` once after listen, not on the boot critical path. Record
`store_meta.quarantined_at` so the Storage hub can say history was reset.

**Size watchdog.** Stat the file every 10 min and once per rollup. Proposed
thresholds: soft 256 MB, which forces a rollup now and shows a warning. Hard
1 GB, which stops tool-event and composition writes (usage calls are never
dropped) and emits a `storage` event. Thresholds are settings in `store_meta`,
tunable without a release.

**Rollup and retention job.** Runs at boot (after `quick_check`), daily at 03:10
local, and when the soft threshold trips. Idempotent. For each user:
1. `horizon = localDate(now - retention_days)`, with the rule that the day just
   before the horizon is the last day rolled.
2. In **one transaction** (single file, so it is atomic):
   - `INSERT INTO agent_daily … SELECT user, day, provider, model, source,
     COALESCE(endpoint,''), is_internal, COUNT(*), SUM(runs), SUM(input_tokens), …,
     SUM(CASE WHEN all four token cols NULL THEN 1 ELSE 0 END), SUM(turns),
     COUNT(turns) FROM usage_calls WHERE user_id=? AND day < ? AND day > ? GROUP BY …`
     with `? = last_rolled_day`, which makes the fold exactly once. Rolled days are
     never re-folded.
   - `DELETE FROM usage_calls WHERE user_id=? AND day < ? AND day > ?` (same
     bounds), same for `agent_tool_events`, `turn_composition`, and closed
     `agent_runs`. `agent_runs` are folded into a daily count of runs and
     tokens, so the Agents hub has history beyond 30 days (see `agent_daily`
     columns: `runs`, `tool_calls`).
   - `UPDATE agent_user_settings SET last_rolled_day = ?`.
3. `agent_daily` rows older than 400 days are deleted (same transaction, separate
   statement).

Property test (§4, R1): for any random raw set and any cut, the sums returned by
the budget query shapes (H1 `usedForModel` both `unit` variants, H4
`tokenBreakdown`, `usageForWindow`) are identical before and after the rollup.

**Retention settings.** Per user, `agent_user_settings.retention_days`, default
30, clamped 7 to 365. Changing it takes effect at the next rollup, never deletes
synchronously. Lowering retention rolls up on the next run.

### 2.5 Hook points for run recording

| Source | Hook | Recorded |
|---|---|---|
| Chat v2 turn | `routes/agent-v2.mjs:548` (`runTurn`) start: open `agent_runs`; `:605-609` after usage rows: close with tokens; `:646` tool events; `:651` composition | chat |
| Legacy code-assist turn | `llm_agent/runtime/route.mjs` near `:572` (usage) and `:705` (`recordToolEvents`, engine `legacy`) | chat |
| Loop run | `routes/loop-agent.mjs` `meterRun` (~`:62`): close run, `recordToolEvents` at `:66` | loop |
| Meeting-agent run | `agents/meeting-agent.mjs` run finish (the `runs` map, `:331`) **(confirm T0 for the exact finish call)** | meeting |
| Auto-task run | Mac `AutoTaskRunHistory.record` (`AutoTaskRunHistory.swift:58`). Server-side hook needed if Q2 is "server". | autotask |
| Dispatch / review | `/kb/dispatch` and review approval paths **(confirm T0)** | dispatch |

Open-row rule: a run is inserted with `status='running'` at start and closed
at end. A crash leaves rows as `running`. On boot, rows still `running` older
than 24 h are closed as `aborted` (same as the Loop's `.aborted` journal record
from the Loop interrupted-run fix).

### 2.6 Budget and limit reads after the move

The caps are a correctness feature. A lagging ledger lets parallel calls
overshoot a cap. That is why `usage_calls` is written synchronously and why the
budget reads need the rollup.

Read shape for `usedForModel(window, unit)` after the move:

```sql
-- local-day granular, exact against the raw ts comparison used today
SELECT SUM(x) FROM (
  SELECT <col> AS x FROM agent_daily
   WHERE user_id=? AND provider=? AND model IN (…) AND day >= ? AND day < ?   -- rolled days
     AND is_internal = 0
  UNION ALL
  SELECT <col_raw> AS x FROM usage_calls
   WHERE user_id=? AND provider=? AND model IN (…) AND day >= ?                -- raw days
     AND is_internal = 0
);
```

- `day >= ?` for the window start (the same `windowStart` local midnight).
- The boundary `last_rolled_day` splits the two sides, so no day is counted twice.
- The `<col>` choice mirrors `usedForModel` today: tokens = input + output +
  cache_creation (cache reads excluded, `usage.mjs:150-154`); runs = `runs`.
  In `agent_daily` store `tokens_billable` as one column if the read cost matters,
  or keep the parts and sum in SQL.
- `tokenBreakdown` (`usage.mjs:185-215`) reads the four token sums and
  `unknownRows` the same way.

**Cost target.** Measured in T0.1 against the current code, then a regression
gate in T2.2: the new H1 resolve must not exceed **1.2 times the baseline p95**
and must stay under the 2 ms absolute budget at 1M rows.

**Pathway for the main-DB table.** `model_limits` and `quota_state` stay in the
main DB, so `resolveModel` now reads two files on each call. Both are local
better-sqlite3 handles in the same process, so there is no network cost. There is
no cross-file transaction, which is fine: the read is advisory and the write
path is one insert.

### 2.7 Storage model for groups and sizes

- File-level: `fs.stat` of `agent.db` (+ `-wal`, `-shm`), `page_count`, `freelist_count`.
- Per user: row counts per table (`COUNT(*)` with `user_id = ?`, indexed) and
  an estimate of bytes = rows × sampled average row size. `dbstat` virtual table
  gives exact per-table bytes if compiled in **(confirm T0; better-sqlite3 may
  not enable it)**. If not, use the estimate and label it "approx".
- Other groups (search index, code graph, sources, meetings) are reported with
  counts and last-changed time, actions null, from the main DB, using the
  existing counters in `kb/os-state.mjs` `knowledgeCounts`.

### 2.8 User delete

`deleteUserCascade` (`kb/db.mjs:946`) runs in the main DB. Add a second step:
delete the user's rows from `agent.db` after the main transaction commits. This
is not atomic across files, so: write `store_meta.pending_purge` with the user id
inside the main transaction, purge `agent.db`, then clear the marker. At boot,
replay any pending purge (idempotent). The user-delete-cascade test gets an
`agent.db` enumerator, and CI fails if a new agent table misses the purge.

### 2.9 Clear and compact

**Clear (per user).**
- `POST /kb/agent-history/clear` with `{ scope: 'raw' | 'all', beforeDays?, dryRun: true }`
  returns `{ wouldDelete: { usage_calls, agent_tool_events, turn_composition, agent_runs, activity?, agent_daily? }, previewId, expiresAt }`.
  `previewId` is an HMAC of user, scope, cutoff, and counts, valid for 5 minutes.
- `POST` with `dryRun: false` and the `previewId` deletes. A mismatch of counts
  (rows changed since preview) refuses with `409 preview_stale`. This is the
  confirm step the page and the bridge require.
- `scope: 'raw'` deletes raw rows only and keeps `agent_daily` (the summaries).
  `scope: 'all'` also deletes `agent_daily` for the user and resets the watermark.
  Live state is never in this set.

**Compact.**
- Not a plain VACUUM. better-sqlite3 is synchronous, so a VACUUM blocks the whole
  Node event loop (chat, SSE and health included), not only writers. Measure
  before choosing (T0.1). Proposal:
  1. `PRAGMA incremental_vacuum(N)` in slices of about 200 pages, with
     `setImmediate` between slices, until `freelist_count` is 0 or a time budget
     of 2 s is spent.
  2. Full `VACUUM` only when freelist ratio > 25 percent and file > 50 MB, and only
     when no run is in flight (`listInFlightChatTurns` and `listRuns` are empty).
- Pre-check disk: refuse if free space is less than 2 times the file size (VACUUM
  needs room).
- Refuse with `409 busy` if runs are in flight. Otherwise run and return
  `{ mode, pagesFreed, bytesBefore, bytesAfter, ms }`.

Compact is per-file, so it never blocks the main DB, which is a benefit of the
split.

---

## 3. API surface, contracts and UI

### 3.1 Routes

| Method | Path | Gating | Class | Notes |
|---|---|---|---|---|
| GET | `/kb/storage` | always on | kbRead | `{ generatedAt, groups:[{key,label,rows,bytes,bytesApprox,lastCleanedAt,retentionDays,actions:[…]}], agentHistory:{rawFromDay, rawRows, rolledDays, oldestDay, quarantinedAt, droppedRows, watermark} }` |
| GET | `/kb/agent-history/settings` | always on | kbRead | `{ retentionDays, rollupKeepDays: 400 }` |
| PUT | `/kb/agent-history/settings` | always on | kbWrite | `{ retentionDays }`, clamp 7 to 365 |
| POST | `/kb/agent-history/clear` | always on | kbWrite | §2.9 two-step |
| POST | `/kb/agent-history/compact` | always on | kbWrite | §2.9; `409 busy` |

Always on. The ledger serves budgets, and `agent_chat` is always on. No
`LLMIDE_FEATURES` group (decision recorded here; open question Q5 covers
whether to group the Storage routes).

Register the five paths in `ALL_ENDPOINTS` (`server.mjs:336-343`), classify them
in the write table (`server.mjs:432-499`), and route them through
`routes/router.mjs` next to the usage routes (`:1005-1070`). Put the handler in a
new `routes/agent-history.mjs`. Dispatch from the router with the same pattern as
`routes/os.mjs`.

### 3.2 `/kb/os/state` additions (additive)

- `storage`: the summary of `GET /kb/storage` (same data, so the page needs one fetch).
- `agents.recentRuns`: last 20 runs for this user from `agent_runs` (id, source,
  status, startedAt, durationMs, tokens, toolCalls, model). No prompt, no error
  text, only `error_code`.
- `tokens`: `window` accepts `day`, `week`, and `month` (new). `week` and `month` read
  through the §2.6 rollup shape. `routes/os.mjs` currently rejects anything but
  `day` and `week`; extend it and the schema together.
- `turnComposition`: unchanged shape; source moves to `turn_composition` in
  `agent.db`.

### 3.3 Versions and schemas

- Bump `SERVER_API_VERSION` 82 to 83 (`server.mjs:281`). Fix the stale `v79`
  comment (`server.mjs:277`) in the same change.
- Update `schema/http/os.schema.json` (new `storage`, `agents.recentRuns`,
  `month` window, the "Token windows" description) and add
  `schema/http/agent-history.schema.json` for the five routes, with fixtures in
  `schema/http/fixtures/`. Run `make contract-gates`.
- `schema/http/swift-decode-allowlist.json`: list new optional fields so Swift
  decoders ignore unknown keys.
- Regenerate `extension/src/lib/api-types.ts` for the new fields (it already
  holds the turn-composition docs at `:4135`).

### 3.4 SSE

New event kind `storage` on `/kb/os/stream` (`core/os-events.mjs`). Emitted after
clear, compact, rollup, and quarantine. The payload stays `{ type, at }` only
(existing rule). Add it to the schema the same way `activity` and `usage` are.

### 3.5 Bridge allowlist (Mac)

`SystemBridge.swift:244` gets exact (method, path) entries for `GET /kb/storage`,
`GET` and `PUT /kb/agent-history/settings`, `POST /kb/agent-history/clear`, and
`POST /kb/agent-history/compact`. Path parameters are not used, so the existing
parameter check (`SystemBridge.swift:295-296`) does not change. The page must
never call clear without the preview step. The bridge only forwards; the
two-step is enforced server-side by `previewId`.

### 3.6 OS view (web and Rust)

- **Storage hub (10th hub).** Rust: `graph-kit/rust/os-graph/src/viz.rs` and
  `api.rs` (graph-kit repo; commit there, then bump both pins per
  `CLAUDE.md`). Web: `ui/os-view`.
  - Overview tile: total bytes, per-group size bars (agent history, search index,
    code graph, sources, meetings), last-cleaned per group.
  - Agent history detail: raw window (days), rolled days, oldest day, dropped
    rows, quarantine notice, retention control (7 to 365).
  - Actions (agent history only): **Clear** (opens the preview: counts per table,
    then a confirm button that sends `previewId`) and **Compact** (shows the
    result or `busy`).
  - Other groups: read-only rows with no action buttons.
- **Agents hub.** From `agents.recentRuns`: status, duration, tokens per run,
  filter by source. No prompt text.
- **Models hub.** From `tokens` (day, week, month). Same panels as today plus
  month.
- **Activity hub.** Same feed, now from `agent.db`. No visible change.

### 3.7 Mac Settings card

"Agent history" card in Settings (Core `SettingsSectionRegistry` slot, per the
module-boundary rules in `CLAUDE.md`): retention stepper, last cleaned, storage
size, Clear and Compact buttons that open the same preview sheet. Feature-gated
only by the Settings always-compiled layer; no feature key.

---

## 4. Phases and tasks

Gates for every task: `make test` (extension), `make regression` before any push
(the push itself is out of scope for this plan), `make contract-gates` when a
schema or route changes, `make test-mac` when Swift changes, lint and
markdownlint on changed docs. The feature matrix (`make build-mac-min`,
`build-mac-lite`) runs in the phase that touches Mac code. Run test suites with
`NODE_TEST_CONTEXT` so the live DB is never written (memory: test DB isolation).

### Phase 0: baseline and guards (no behaviour change)

**T0.1 Measure the baseline (S, about 0.5 day).**
- Bench H1 (`runClaudeDirect` resolve) and H4 (`usageSummary`) against a seeded
  temp DB with 10k, 100k and 1M rows. Record p50 and p95 for the current code.
- Measure: `dbstat` availability in better-sqlite3; VACUUM time per 100 MB;
  incremental_vacuum slice time; `usage_calls` insert cost; row bytes.
- Confirm the items marked **(confirm T0)**: meeting-agent finish call, dispatch
  and review run paths, Loop run registry, `auto_vacuum` behaviour.
- Output: a numbers table committed inside the PR description or the plan's
  appendix. Not a new report file.

**T0.2 Guard tests (S).**
- Add a test that fails when a `usage_ledger`, `turn_tool_events`,
  `turn_composition`, or `activity` writer or reader is added outside the
  inventory list (grep-based, like the feature-boundary gate).
- Add the `agent.db` user-purge enumerator to the user-delete-cascade test as a
  failing placeholder (red until T3.5).

### Phase 1: the store (new code, not yet wired)

**T1.1 Path, config, open and close (S).** `core/config.mjs` (`LLMIDE_AGENT_DB_PATH`,
test derivation at `:197-199`, `:242`), `kb/agent-db.mjs` (new). Tests: path
resolution, test isolation, close idempotence.

**T1.2 Migration runner generalised (S).** `kb/migrations.mjs` takes `{ dir, table }`
(default unchanged). Tests: the existing migration tests still pass; a second
runner with its own table works.

**T1.3 DDL `0001_agent_store.sql` (M).** `kb/agent-migrations/0001_agent_store.sql`
per §2.3. `auto_vacuum=INCREMENTAL` set at creation. Tests: schema matches a
golden column list; idempotent re-run.

**T1.4 Write queue (M).** Batched writer for the non-budget tables per §2.4. Tests:
ordering, batch boundary, 5,000-row cap with drop counter, flush on close, never
throws (inject a failing handle), no lost rows on flush-then-close.

**T1.5 Corruption quarantine and quick_check (M).** Per §2.4. Tests: corrupt file
(write garbage bytes) gets quarantined under a unique name; a second corruption
does not overwrite the first quarantine (K1a rule); the store recreates and
keeps working.

**T1.6 Size watchdog (S).** Stat-based thresholds in `store_meta`. Tests: soft
threshold triggers a rollup request; hard threshold stops tool-event writes but
not usage calls.

### Phase 2: move the writers and readers

**T2.1 Synchronous `usage_calls` writer (M).** Change `recordUsage` (`kb/usage.mjs:375-411`)
to write `usage_calls` in `agent.db`, keeping its signature and the funnel. Keep
`emitOsEvent` (`:405`). Remove the global 90-day prune (`:418-426`) from the
write path; retention moves to the rollup job (T3.1). Tests: the 20+ listed test
files, with fixtures repointed to the agent store; `tests/usage.test.mjs:320`
checks table names and must change to the new names.

**T2.2 Budget readers on the rollup shape (L).** `usedForModel` (`usage.mjs:146-170`),
`tokenBreakdown` (`:185-215`), `usageSummary` (`:591-614`), `usdCapForModel` stays
on `model_limits`. Add the §2.6 read shape. Gate: the H1 cost target in §2.6.
Tests: `tests/model-ids.test.mjs`, `tests/agent-v2-engine.test.mjs:1688-1696`,
`tests/tier-routing.test.mjs:533`, `tests/usage-routes.test.mjs:175`.

**T2.3 Shadow parity for the budget reads (M).** A flag
`LLMIDE_AGENT_BUDGET_READS=legacy|shadow|agent` (default `legacy` at first). In
`shadow`, both answers are computed and compared; a mismatch increments a counter
and logs. Ship with `legacy` as the default. Gate for flipping: zero mismatches
across the live data for N days (Q6), plus the property test (R1).

**T2.4 Run recording (M).** Open and close `agent_runs` at the hook points in §2.5,
through the write queue (the close uses the queue; the open row is written
synchronously so `listRuns` and the Agents hub see it). Tests: a v2 turn, a loop
run, a legacy turn each produce one run row with correct tokens and status;
crash-recovery rule (open to aborted on boot).

**T2.5 Copy history from the main DB (M).** On first boot after the release:
copy `usage_ledger`, `turn_tool_events`, `turn_composition`, and `activity` in
batches of 5,000 by `id` cursor, each batch in its own transaction, cursor in
`store_meta`. Copied `day` per §2.2. Then count and sum checks. Idempotent and
resumable. Tests: copy of a real old-format fixture (a main-DB snapshot made by
the migration chain up to 0048); resume after a kill mid-copy; counts and token
sums equal before and after.

**T2.6 Switch the writers and readers, freeze the old tables (M).** After the copy
and a catch-up pass (copy rows with `id` above the cursor), point all readers and
writers at `agent.db`. The main-DB tables stay in place and get no writes. Tests:
a regression test that nothing writes to the frozen tables; the `deleteUserCascade`
still clears them (old rows).

### Phase 3: retention, clear, compact

**T3.1 Rollup job and property test (L).** `kb/agent-rollup.mjs`: §2.4 algorithm,
watermark, 400-day key cleanup. Tests: the property test (R1) with random rows,
NULL tokens, internal endpoints, both timezones of copied rows, multi-user, and
cuts at every boundary (day before, day of, day after). Also: running it twice
changes nothing; a crash inside the transaction changes nothing.

**T3.2 Retention settings (S).** `agent_user_settings` read and write, clamp,
effect at next rollup. Tests: lowering retention rolls up on the next run;
raising it never restores deleted raw rows.

**T3.3 Clear with dry-run and preview id (M).** §2.9. Tests: preview counts match
the delete; `previewId` expires; a changed count returns `409 preview_stale`;
`scope: 'all'` resets the watermark; live tables untouched (explicit assertion on
`agent_sessions`, `model_limits`, `quota_state`, and friends).

**T3.4 Compact (M).** §2.9 incremental slices, full VACUUM gate, disk check,
`409 busy`. Tests: slices yield to the event loop (a timer fires between slices);
busy refusal with an in-flight run; disk-check refusal (inject free-space
function).

**T3.5 User purge across files (M).** §2.8 pending marker, boot replay, and the
T0.2 enumerator turned green. Tests: delete user, crash between the two steps,
boot replays and finishes; no rows left for the user in either file.

### Phase 4: API, contracts, UI

**T4.1 Routes and schemas (M).** `routes/agent-history.mjs`, `ALL_ENDPOINTS`,
write classes, `SERVER_API_VERSION` 83, schema and fixtures, `api-types.ts`.
Gate: `make contract-gates`, `make test`.

**T4.2 `/kb/os/state` additions (M).** `storage`, `agents.recentRuns`, `month`
window. Tests: `tests/os-state.test.mjs`, `tests/os-state-running.test.mjs`,
`tests/os-stream.test.mjs`.

**T4.3 SSE `storage` event (S).** `core/os-events.mjs` and the schema.

**T4.4 Rust Storage hub and hub data (L).** graph-kit repo: `rust/os-graph`
viz and api. Commit in graph-kit, then bump both pins (`Package.swift` revision
and the submodule gitlink) per `CLAUDE.md`. Do not commit the currently dirty
submodule state in llm-ide.

**T4.5 Web drawer panels (M).** `ui/os-view`: Storage overview, Clear preview and
confirm, Compact, retention control, Agents and Models from the new fields.
Tests: `ui/os-view/tests/os-view.test.mjs`. Rebuild the bundle into
`mac/Sources/LlmIdeMac/Resources/os-view/`.

**T4.6 Mac: bridge, decoders, Settings card (M).** `SystemBridge.swift:244`
allowlist entries, Swift decoders (`SystemViewTests.swift`, `APIContractLab/Routes.swift`),
the Settings card via `SettingsSectionRegistry`. Gates: `make test-mac` (with
`LLMIDE_KEYCHAIN_BACKEND=memory`), `make build-mac-min`, `make build-mac-lite`.

**T4.7 Cleanup and docs (S).** Update `scripts/usage-report.mjs`,
`scripts/retrieval-report.mjs` to the agent DB path; `docs/spec/*` for the store;
the stale `v79` comment; `docs/explanation/invariants.md` entry for the agent
store. Retire the frozen main-DB tables in a later release (see §5).

Task count: Phase 0 = 2, Phase 1 = 6, Phase 2 = 6, Phase 3 = 5, Phase 4 = 7.
**Total 26 tasks.**

Parallelism: T1.2 and T1.1 in parallel. T1.4, T1.5 and T1.6 after T1.3. T2.2 and
T2.4 in parallel after T2.1. T3.2 and T3.3 in parallel after T3.1. T4.3 and T4.4
in parallel. T4.5 and T4.6 after T4.1 and T4.2.

Review points: after T0.1 (numbers decide the read shape), after T2.3 (parity
before the flip), after T2.6 (the switch), after T3.1 (rollup correctness is
the riskiest code), after T4.1 (the contract is the Mac's and the page's shared
language).

Sizes: S = under 1 day, M = 1 to 2 days, L = 3 to 4 days. About 35 to 40
engineering days in total, with parallel lanes shortening the calendar time.

---

## 5. Rollout and rollback

**Recommendation: one-way switch after a copy, with frozen legacy tables, not
dual write.**

- Dual write doubles the hot-path cost and makes the ledger two sources of truth.
  A cap would then depend on which copy won. Rejected.
- Copy at first boot (T2.5), catch-up pass at switch (T2.6), then all writes and
  reads move. The main-DB tables stay in place, frozen, for **one full release**.
- Rollback path for the release: an operator env flag
  `LLMIDE_AGENT_DB_READ=legacy` makes the readers use the frozen main-DB tables
  again. Rows written to `agent.db` during the new release are not visible to the
  old readers. This is documented in the release note. A tested reverse-copy
  script (`scripts/agent-db-rollback.mjs`, idempotent, same batching as T2.5)
  copies missing rows back for an operator who needs them.
- Old server with new Mac: the Storage hub gets a 404 on `/kb/storage`. The Mac
  shows "not supported by this server" and nothing else changes.
- New server with old Mac: all changes are additive, so old decoders are fine.
  `tokens` gains a `month` option. Old Macs never request it.
- The budget read flag (T2.3) ships `legacy` by default. It flips to `agent`
  only after the parity gate passes, so the budget read is the last thing to move.
- Retiring the frozen tables happens in the release after that, once the
  rollback window has passed. Drop statements go in a numbered migration on the
  main DB.

---

## 6. Risks

- **R1. Rollup correctness.** A rollup that double-counts or drops a day silently
  moves a cap. Mitigation: the exact-once watermark, one-transaction fold, the
  property test in T3.1, and the parity gate in T2.3.
- **R2. Hot-path latency of limit reads.** H1 runs on every direct call and is
  synchronous. Mitigation: the `agent_daily` shape, the 2 ms target measured in
  T0.1, and the regression gate in T2.2.
- **R3. Double recording.** A turn that writes both a run and a call twice, or
  a loop meter that runs twice, inflates usage. Mitigation: the single
  `recordUsage` funnel, `request_id` = `run_id`, idempotent close on
  `agent_runs`, and a test that counts rows per turn.
- **R4. Retention conflict.** The current global 90-day prune (`usage.mjs:418-426`)
  would delete raw rows before they are rolled up. Mitigation: remove it in T2.1
  and rely only on the rollup job.
- **R5. Timezone and DST.** `usage_ledger` is local, the turn tables are UTC. A
  copied UTC row gets a local day at copy time, so the day after a DST change
  can shift by one hour. Mitigation: document it; the budget window is
  day-granular, so the error is bounded to the boundary hour. Accept.
- **R6. VACUUM blocks the event loop.** better-sqlite3 is synchronous. Mitigation:
  incremental slices, a busy refusal, and a T0.1 measurement before any full
  VACUUM.
- **R7. Test DB isolation.** Tests that write the live DB caused junk rows before
  (memory: test DB isolation, fixed by `NODE_TEST_CONTEXT`). The agent DB must
  derive its test path from the same switch, and T1.1 tests it.
- **R8. Multi-process.** `CLAUDE.md` forbids a second Node process writing the
  same DB. `agent.db` is written only by the server process. The operator scripts
  (`usage-report`, `retrieval-report`) must open it read-only.
- **R9. Cross-file consistency.** Purge and copy span two files and are not
  atomic. Mitigation: pending markers, idempotent replay (§2.8, T3.5).
- **R10. Quarantine resets the budget counters.** A corrupt `agent.db` means the
  window's usage is undercounted until the day rolls. The main-DB `quota_state`
  flags survive. Mitigation: visible "history reset" notice; open question Q4.
- **R11. Non-agent writers depend on the agent store** if `activity` moves (Q3).
  Mitigation: the store getter is injectable; meetings and outcomes keep their
  call sites unchanged.
- **R12. Mac-side auto-task history stays out of the server store** (Q2), so the
  Agents hub is incomplete for auto tasks unless Q2 is resolved.

---

## 7. Open questions (with recommendations)

- **Q1. Move `turn_composition` and `turn_tool_events` as raw history, or keep only
  aggregates?** Recommend: move raw for 30 days, then roll up. The
  `rollupTurnComposition` averages need raw turns, so keep the last 50 turns raw
  regardless of retention (the Models hub reads them).
- **Q2. Auto-task (Mac) run history: keep Mac JSON, or post to the server?**
  Recommend: post a run record to `POST /kb/agent-history/run` from the Mac
  (`AutoTaskRunHistory.record`, `AutoTaskRunHistory.swift:58`), so the server
  store is complete. The Mac JSON stays as a local cache for offline display.
  This is a new write route and needs a schema, so it adds to T4.1.
- **Q3. Is `activity` "agent history"?** It is written by meetings and outcomes
  too. Recommend: move it (the user listed it), and keep a small injectable store
  getter so non-agent writers do not know the file exists.
- **Q4. Quarantine policy for the budget counters.** Recommend: quarantine and
  recreate (never block a turn), and surface "usage history reset on <date>" in
  the Storage hub. A rebuild from the main DB is not possible once copied, so
  accept the reset.
- **Q5. Should the Storage routes sit behind a feature key?** Recommend: no. The
  ledger serves budgets and `agent_chat` is always on.
- **Q6. Parity window length for the budget flip.** Recommend: 7 days of zero
  mismatches on live data, plus the property test, before flipping
  `LLMIDE_AGENT_BUDGET_READS` to `agent`.
- **Q7. Retention bounds.** Recommend: default 30, minimum 7, maximum 365 days of
  raw rows; rollups kept 400 days (user decision). A minimum of 7 keeps the
  `week` window exact from raw.
- **Q8. Full VACUUM policy.** Recommend: incremental only by default; full VACUUM
  only from the manual Compact button, and only when no run is in flight and the
  freelist ratio is above 25 percent.
- **Q9. `dbstat` availability.** If better-sqlite3 has no `dbstat`, the storage
  sizes are estimates. Recommend: label them "approx" in the UI and do not block
  the hub on exact bytes.
- **Q10. Which runs get a `daily` summary?** Recommend: chat, loop, meeting, and
  autotask. Dispatch and review are counted only if T0.1 shows they have a clean
  finish hook; otherwise they stay out of v1.

---

## 8. Notes for the implementer

- No prompt, response, error message, file path, or tool argument is ever stored.
  Only codes, counts, sizes, and ids. `activity.detail` keeps its existing redaction
  (`kb/activity.mjs` `redact`, `DETAIL_CAP` 4000 at `:26`).
- Every write is best-effort and never throws into a turn, except `usage_calls`,
  whose failure is also swallowed (the existing `recordUsage` try/catch, `:406-411`)
  but is counted, so a silent failure shows in `/health`.
- Keep the migration files append-only. The main DB migrations 0039 through 0047
  are the reference for how the columns were added.
- The graph-kit submodule is dirty in the working tree. Do not stage it in any
  llm-ide commit for this work.
