# Activity Feed + Notification Bell — Design

**Status:** approved design (2026-06-24)
**Goal:** Give LLM IDE a single, durable, per-user record of auto-generated events, surfaced in the Mac app as an in-app activity feed with a notification bell + unread badge.

---

## 1. Overview

Today there is no notification or activity system. Auto-generated events are scattered: most happen in-process in the Mac app (graph/memory regen, regression runs, issue/comment creation), a few originate on the backend (dispatcher issue creation, outcome transitions, meeting ingest, email/slack fetch), and none are recorded in one place or shown to the user.

This feature adds:
1. A **backend per-user `activity` table** (durable, cross-device) as the single source of truth, written through one `recordActivity` helper — mirroring the existing `audit_log` / per-user table pattern.
2. **Backend-originated events** recorded directly at their source.
3. **Mac-originated events** reported to the backend via a small `POST /kb/activity` endpoint.
4. A **Mac activity store** that short-polls the feed and a **bell + popover** UI showing an unread badge and a clickable, day-grouped activity list.

### Goals
- One durable, per-user, queryable record of the v1 event set (§5).
- A glanceable unread count + a feed the user can review and click through to the relevant section.
- Adding a new event kind later is a one-liner (one enum value + one `recordActivity` call).

### Non-goals (v1 — see §12)
- macOS system/banner notifications (Notification Center).
- Server→client push / SSE (v1 is short-poll; the table/API are designed so SSE can be added without rework).
- Per-item read flags (v1 uses a single per-user "last-seen" cursor).
- Capturing events beyond the v1 set (autonomous-code-run summary, KB doc ingest, plan generated, etc.).

---

## 2. Architecture

```
 Backend events ─┐
 (dispatcher,    │   recordActivity(db, {...})        ┌─ GET /kb/activity?since=&limit=  ─┐
  outcomes,      ├──────────────────────────────▶ activity ◀── POST /kb/activity (report) │
  meeting,       │                                  table     POST /kb/activity/seen        │
  email, slack)  ┘                                    ▲                                     │
                                                      │                                     ▼
 Mac events ──── ActivityStore.report() ── POST /kb/activity ───────────────────  ActivityStore (poll)
 (graph, regression,                                                                  │
  issue, comment)                                                                     ▼
                                                                         Bell + unread badge + popover
```

- **Backend** owns the durable store and records its own events directly.
- **Mac** reports its in-process events via HTTP and reads the feed by short-poll.
- A new **`activity` table** is used (NOT `audit_log`, which is a security/compliance trail with different semantics, outcome enum, ip/request_id, and retention).

---

## 3. Backend

### 3.1 Migration `extension/kb/migrations/0018_activity.sql`
(Head is currently `0017_slack_state.sql`.)

```sql
CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,                 -- redacted JSON string (nullable)
  link       TEXT,                 -- optional deep-link target (nullable)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user_time ON activity(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS activity_seen (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);
```

### 3.2 Module `extension/kb/activity.mjs` (single source of truth)
- `recordActivity(db, { userId, kind, title, detail, link })`
  - Validates `kind` against the allowed enum (§5); throws/loga and no-ops on invalid kind so a typo can't silently create junk.
  - `detail` (object) is JSON-stringified after running through the shared `redactSecrets` (the same pattern `recordAudit` uses) — never store raw secrets.
  - Caps: `title` ≤ 200 chars, `detail` JSON ≤ 4 000 chars, `link` ≤ 512 chars (truncate).
  - Inserts, then **prunes to the newest 500 rows for that `user_id`** (`DELETE … WHERE user_id=? AND id NOT IN (SELECT id … ORDER BY id DESC LIMIT 500)`).
  - Returns the inserted row id.
- `listActivity(db, userId, { sinceId = 0, limit = 100 })` → newest-first rows with `id > sinceId` (or the newest `limit` when `sinceId=0`), each row `{ id, kind, title, detail (parsed), link, created_at }`.
- `unreadCount(db, userId)` → count of `activity.id > activity_seen.last_seen_id`.
- `markSeen(db, userId, uptoId)` → upsert `activity_seen.last_seen_id = max(existing, uptoId)`.

All functions are best-effort wrappers: a failure here must never throw into the operation that triggered the event (callers wrap in try/catch and log).

### 3.3 HTTP routes (in `kb/router.mjs`, gated by `authenticate`)
- `GET /kb/activity?since=<id>&limit=<n>` → `{ items: [...], unread: <n>, lastId: <maxId> }`
- `POST /kb/activity/seen` body `{ uptoId: <id> }` → `{ ok: true, unread: 0 }`
- `POST /kb/activity` body `{ kind, title, detail?, link? }` → `{ ok: true, id }` — the Mac app reports an in-process event. Validates `kind` ∈ enum and the length caps; rejects unknown kinds with 400.

The three paths must also be registered in `server.mjs`'s `ENDPOINTS` array and `rateLimitProfile()` (the `check_api_coverage.py` and `check_rate_limit_mapping.py` guards read these).

Rate-limit profiles (`server.mjs rateLimitProfile()` + the §6 table in `docs/spec/api-server.md`):
- `POST /kb/activity` and `POST /kb/activity/seen` → `kbWrite`.
- `GET /kb/activity` → default profile (read).

### 3.4 Server-side event recording (direct `recordActivity` calls)
| kind | call site | guard / detail |
|---|---|---|
| `dispatch_issue_created` | `agents/dispatcher.mjs` after a successful GitHub/Backlog/Linear issue create (the points that today set `meta.dispatched`) | detail: `{ provider, url, number }` |
| `outcome_changed` | `agents/outcome-watcher.mjs` / `kb/outcomes.mjs recordOutcome` — only when it reports a real change (already deduped) | detail: `{ resource, fromState, toState }` |
| `meeting_added` | `kb/meetings.mjs ingestMeeting` (covers the live-session finalize path too) | detail: `{ title, participantCount, date }` |
| `email_fetched` | `/kb/email/fetch` route, **only when newly-ingested count > 0** | detail: `{ count }` |
| `slack_fetched` | `/kb/slack/fetch` route, **only when count > 0** | detail: `{ channelId, count }` |

### 3.5 Cascade + housekeeping
- `kb/db.mjs deleteUserCascade` must delete from `activity` and `activity_seen` (add to the cascade; extend `tests/user-delete-cascade.test.mjs`).
- The 500/user prune in `recordActivity` keeps the table bounded; no separate cron needed.

---

## 4. Mac app

### 4.1 `Services/ActivityStore.swift`
`@MainActor @Observable final class ActivityStore` (matches the newer `ShellState`/`BackendManager` idiom), constructed in `LlmIdeMacApp.init` and injected via `.environment(...)`.

State: `items: [ActivityItem]`, `unreadCount: Int`, `lastId: Int`.
Behavior:
- **Poll:** every ~25 s (and on window focus / app foreground) calls `GET /kb/activity?since=lastId`, prepends new items, updates `lastId` + `unreadCount`. Failures retry next tick silently (the `AgentRunsStore` polling idiom).
- **report(kind:title:detail:link:):** fire-and-forget `POST /kb/activity`; failure is logged, never thrown (it must not break the originating action).
- **markSeen():** on popover open, `POST /kb/activity/seen { uptoId: lastId }`, set `unreadCount = 0`.

`ActivityItem`: `{ id, kind, title, detail: [String:Any]?, link: String?, createdAt: Date }`.

### 4.2 Mac event reporting (the 4 Mac-originated kinds)
App-level services get a `weak var activity: ActivityStore?` set in `LlmIdeMacApp.init` (the existing `RegressionRunner.weak var config` pattern); view-level call sites use `@Environment(ActivityStore.self)`.

| kind | call site | detail |
|---|---|---|
| `knowledge_updated` | `CodeGraph/GraphAutoUpdater.publishToSession(repoRoot:)` after publishing | `{ repo, codeNodes, docNodes, mergedNodes }` |
| `regression_done` | `Services/RegressionRunner.run` completion (the `defer` summary block) | `{ regressed, unchanged, failed }` |
| `issue_created` | each success of `RepoBackend.createIssue` (manual sheet, confirm-apply, `AutoCodeUpdateService`) | `{ title, repo, url }` |
| `comment_added` | success of `createIssueComment` | `{ iid, url }` |

### 4.3 UI: bell + popover
- A bell chip in `Views/Shell/StatusBar.swift` beside `AgentStatusBadge` (new `Views/Shell/ActivityBell.swift`): SF Symbol `bell`/`bell.badge`, unread count badge.
- Tapping opens a popover (`ActivityPanel`) with the list grouped by day (Today / Yesterday / earlier), each row: icon per `kind`, `title`, relative time. On open → `markSeen()`.
- Row click → post `.openSection(<section>)` (the existing deep-link mechanism) to jump to the relevant view (issues, regression, code graph); `link` carries the section + params.
- New `Notification.Name` (if needed) added to `Services/NotificationNames.swift` (the file that centralizes them).

---

## 5. Event kinds (the v1 enum — shared contract)

| kind | side | title example |
|---|---|---|
| `knowledge_updated` | Mac | "Project knowledge updated — 312 code · 48 doc nodes" |
| `regression_done` | Mac | "Regression complete — 2 regressed, 18 unchanged" |
| `issue_created` | Mac | "Issue created — Fix caption drift" |
| `comment_added` | Mac | "Comment added to issue #42" |
| `dispatch_issue_created` | Backend | "Dispatched issue to GitHub — #128" |
| `outcome_changed` | Backend | "Issue #42 merged" |
| `meeting_added` | Backend | "Meeting added — Weekly sync (4 participants)" |
| `email_fetched` | Backend | "Fetched 7 new emails" |
| `slack_fetched` | Backend | "Fetched 12 new Slack messages (#eng)" |

The enum is defined once on each side (a Swift enum + a JS allow-list set) and validated at the `POST /kb/activity` boundary.

---

## 6. Data flow
- **Backend event:** source → `recordActivity(db, {...})` → `activity` table.
- **Mac event:** source → `ActivityStore.report(...)` → `POST /kb/activity` → `recordActivity` → table.
- **Feed:** `ActivityStore` poll → `GET /kb/activity?since=lastId` → update items + badge; popover open → `POST /kb/activity/seen` → badge clears.

---

## 7. Error handling
- `recordActivity` and every `report()` call are best-effort: wrapped in try/catch, log on failure, never propagate into the triggering operation (same posture as the Graphify memory injection).
- Invalid `kind` at the route → 400; internally → logged no-op.
- Poll failures → silent retry next interval.
- `detail` is redacted (`redactSecrets`) before storage; the API never returns secrets.

---

## 8. Testing
**Backend (node --test):**
- `recordActivity`: inserts; prunes to newest 500/user; redacts `detail`; rejects unknown `kind`; enforces length caps.
- `listActivity`: `since`/`limit` semantics, newest-first, per-user isolation.
- `unreadCount` / `markSeen`: cursor math, monotonic (markSeen never lowers).
- Routes: `GET`/`POST` shapes, kind-enum validation (400 on bad kind), auth required.
- `deleteUserCascade` wipes `activity` + `activity_seen` (extend the existing cascade test).

**Mac:** `ActivityStore` report-payload construction + unread math + markSeen behavior. (Note: `swift test` is currently blocked by the local Xcode/CommandLineTools toolchain skew — Mac tests are authored + `swift build`-verified only until that's resolved.)

---

## 9. Docs / drift-guard updates (must accompany the change)
- `docs/reference/api/openapi.yaml`: add the 3 new endpoints (or the `GET` + 2 `POST`s) so `check_api_coverage.py` passes.
- `docs/spec/api-server.md` §6 rate-limit table: add `/kb/activity`, `/kb/activity/seen` under `kbWrite` so `check_rate_limit_mapping.py` passes.
- Migration-head value bumps (so `check_spec_values.py` passes): `docs/spec/cross-cutting.md`, `docs/spec/knowledge-base.md`, `docs/explanation/architecture.md` → `0018`.
- New spec section: document the activity table + module in `docs/spec/knowledge-base.md` (table) and the feature flow in `docs/spec/agent-runtime.md` or `docs/spec/macos-app.md` (the bell/store).
- `make docs-check` must be green.

---

## 10. Component boundaries (for the plan)
- `kb/activity.mjs` — pure DB store logic (record/list/unread/seen).
- `kb/migrations/0018_activity.sql` — schema.
- routes in `kb/router.mjs` — thin HTTP layer.
- 5 backend `recordActivity` call sites (dispatcher, outcomes, meeting, email, slack).
- `Services/ActivityStore.swift` — Mac observable + poll/report.
- `Views/Shell/ActivityBell.swift` + `ActivityPanel` — UI.
- 4 Mac `report()` call sites (graph, regression, issue, comment).

---

## 11. Build / CI notes
- Extension-only parts (table, module, routes, server-side recording, tests) push through the node gate (`make test`) cleanly.
- Mac parts (`ActivityStore`, bell, the 4 report call sites) touch `mac/` → the pre-push gate runs `make regression` (`swift build` + `swift test`); `swift test` is currently blocked by the Xcode/CLT toolchain skew, so mac-touching pushes need `--no-verify` until that's fixed (verify with `swift build`).

---

## 12. Out of scope / future
- macOS banner notifications (`UNUserNotificationCenter`) for opt-in "alert me" events.
- SSE push (per-user `notif-<userId>` channel via the live-caption SSE pattern) to replace the poll.
- Additional event kinds: autonomous-code-run summary, KB doc ingested, plan generated, dispatch retry/gave-up, Slack/email connection errors.
- Per-item read/dismiss and filtering by kind.
