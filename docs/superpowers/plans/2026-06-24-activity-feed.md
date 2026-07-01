# Activity Feed + Notification Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LLM IDE a single, durable, per-user record of auto-generated events (graph/memory regen, regression, issues, comments, dispatch, outcomes, meetings, email, slack), surfaced in the Mac app as an activity feed with a notification bell + unread badge.

**Architecture:** A new backend per-user `activity` table is the single source of truth, written through one `recordActivity` helper (mirroring the `audit_log`/`recordAudit` pattern). Backend events call `recordActivity` directly; Mac in-process events report via `POST /kb/activity`. A Mac `ActivityStore` short-polls `GET /kb/activity`, and a bell + popover render the feed with an unread badge.

**Tech Stack:** Node.js + better-sqlite3 (extension backend, `node --test`); Swift / SwiftUI `@Observable` (`mac/`, `swift build`).

**Source of truth:** `docs/superpowers/specs/2026-06-24-activity-feed-design.md`. Read it alongside this plan.

## Global Constraints

- **Migration head** is currently `0017_slack_state.sql`; this feature adds `0018_activity.sql` and bumps the documented head to `0018` everywhere.
- **9 event kinds (the v1 enum, exact strings):** `knowledge_updated`, `regression_done`, `issue_created`, `comment_added`, `dispatch_issue_created`, `outcome_changed`, `meeting_added`, `email_fetched`, `slack_fetched`. Defined once per side (JS `Set` + Swift `enum`), validated at the `POST /kb/activity` boundary.
- **Secrets:** `detail` objects are JSON-stringified only after `redactSecrets` (from `core/redact-secrets.mjs`) — never store raw secrets. The API never returns secrets.
- **Best-effort:** `recordActivity` and every Mac `report()` are wrapped in try/catch by callers; a failure must never throw into the operation that triggered the event.
- **Length caps:** `title` ≤ 200 chars, `detail` JSON ≤ 4000 chars, `link` ≤ 512 chars (truncate, don't reject).
- **Bounding:** `recordActivity` prunes to the newest 500 rows per `user_id` after each insert. No cron.
- **Rate-limit profiles:** `POST /kb/activity` and `POST /kb/activity/seen` → `kbWrite`; `GET /kb/activity` → default (read, no profile).
- **Commit message footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **Build/CI sequencing:** Tasks 1–6 are extension-only and push cleanly through the node gate (`make test`, run from `extension/`). Tasks 7–9 touch `mac/`, which trips the pre-push `make regression` gate whose `swift test` is currently blocked by an Xcode/CommandLineTools toolchain skew — push mac-touching commits with `--no-verify` after verifying with `swift build`. **Do all backend tasks first**, then mac tasks.
- **Drift guards:** `make docs-check` (run from repo root) must stay green. Each task that changes a guard-tracked surface (endpoints, rate-limit map, migration head) updates the matching doc *in the same commit*.

---

## File Structure

**Create:**
- `extension/kb/migrations/0018_activity.sql` — schema (auto-discovered by `kb/migrations.mjs`).
- `extension/kb/activity.mjs` — pure DB store: enum + `recordActivity`/`listActivity`/`unreadCount`/`markSeen`.
- `extension/tests/activity.test.mjs` — store unit tests.
- `extension/tests/activity-routes.test.mjs` — HTTP route tests.
- `mac/Sources/LlmIdeMac/Services/ActivityStore.swift` — `@Observable` store + poll/report/markSeen + `ActivityItem` + `ActivityKind`.
- `mac/Sources/LlmIdeMac/Views/Shell/ActivityBell.swift` — bell chip + `ActivityPanel` popover.

**Modify:**
- `extension/kb/router.mjs` — 3 routes.
- `extension/server.mjs` — `ENDPOINTS` + `rateLimitProfile()`.
- `extension/kb/db.mjs` — `deleteUserCascade`.
- `extension/tests/user-delete-cascade.test.mjs` — extend cascade assertions.
- `extension/agents/dispatcher.mjs`, `agents/outcome-watcher.mjs` (or `kb/outcomes.mjs`), `kb/meetings.mjs`, `kb/router.mjs` (email/slack fetch) — 5 server-side `recordActivity` call sites.
- `mac/Sources/LlmIdeMac/CodeGraph/GraphAutoUpdater.swift`, `Services/RegressionRunner.swift`, the `RepoBackend.createIssue`/`createIssueComment` callers — 4 Mac `report()` call sites.
- `mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift`, `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` — bell wiring + store injection.
- Docs: `docs/reference/api/openapi.yaml`, `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, `docs/spec/knowledge-base.md`, `docs/explanation/architecture.md`, `docs/spec/macos-app.md`.

---

## Task 1: Migration `0018_activity.sql` + migration-head doc bumps

**Files:**
- Create: `extension/kb/migrations/0018_activity.sql`
- Create (test): `extension/tests/activity.test.mjs` (schema-presence test only in this task; store tests added in Tasks 2–3)
- Modify: `docs/spec/cross-cutting.md`, `docs/spec/knowledge-base.md`, `docs/explanation/architecture.md` (migration-head `0017`→`0018`)
- Modify: `docs/spec/knowledge-base.md` (add an `activity` table description)

**Interfaces:**
- Produces: tables `activity(id, user_id, kind, title, detail, link, created_at)` and `activity_seen(user_id, last_seen_id)`, both `ON DELETE CASCADE` from `users(id)`; index `idx_activity_user_time`. Migrations are auto-discovered — `kb/migrations.mjs` globs `migrations/NNN_*.sql` and applies in version order, so the file just needs to exist.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/activity.test.mjs`:

```js
// Activity store + schema tests.  A temp DB is created per run so the
// 0018 migration is applied fresh and pruning math is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_activity-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

function freshDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

test('0018 migration creates activity + activity_seen tables', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('activity','activity_seen')")
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(tables, ['activity', 'activity_seen']);
  const cols = db.prepare('PRAGMA table_info(activity)').all().map((c) => c.name);
  for (const c of ['id', 'user_id', 'kind', 'title', 'detail', 'link', 'created_at']) {
    assert.ok(cols.includes(c), `activity.${c} missing`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/activity.test.mjs`
Expected: FAIL — tables `activity`/`activity_seen` do not exist (migration not yet present).

- [ ] **Step 3: Create the migration**

Create `extension/kb/migrations/0018_activity.sql`:

```sql
-- Activity feed: a durable, per-user record of auto-generated events
-- (graph/memory regen, regression, issues, comments, dispatch, outcomes,
-- meetings, email, slack).  Separate from audit_log (which is a
-- security/compliance trail with different semantics + retention).
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

-- Single per-user "last seen" cursor (v1 has no per-item read flags).
CREATE TABLE IF NOT EXISTS activity_seen (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/activity.test.mjs`
Expected: PASS.

- [ ] **Step 5: Bump migration-head in the spec docs**

In each of `docs/spec/cross-cutting.md`, `docs/spec/knowledge-base.md`, `docs/explanation/architecture.md`, find the documented migration head (`0017_slack_state.sql` / `0017`) and update it to `0018_activity.sql` / `0018`. In `docs/spec/knowledge-base.md`, add a short description of the new tables alongside the migration-head line:

```markdown
- **`activity`** / **`activity_seen`** (migration `0018_activity.sql`): per-user
  durable feed of auto-generated events (see `kb/activity.mjs`). `activity` holds
  `{ kind, title, detail (redacted JSON), link, created_at }`, pruned to the
  newest 500 rows per user; `activity_seen` is a single per-user last-seen cursor
  for the unread badge. Both cascade-delete with the user.
```

- [ ] **Step 6: Verify the migration-head drift guard**

Run: `make docs-check` (from repo root)
Expected: PASS (in particular `check_spec_values` no longer flags the migration head).

- [ ] **Step 7: Commit**

```bash
git add extension/kb/migrations/0018_activity.sql extension/tests/activity.test.mjs \
        docs/spec/cross-cutting.md docs/spec/knowledge-base.md docs/explanation/architecture.md
git commit -m "$(cat <<'EOF'
feat(kb): add activity + activity_seen tables (migration 0018)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `recordActivity` + the event-kind enum

**Files:**
- Create: `extension/kb/activity.mjs`
- Modify (test): `extension/tests/activity.test.mjs`

**Interfaces:**
- Consumes: `getDb` from `kb/db.mjs`; `redactSecrets` from `core/redact-secrets.mjs`.
- Produces:
  - `export const ACTIVITY_KINDS` — a `Set` of the 9 kind strings (the shared allow-list).
  - `export function recordActivity(db, { userId, kind, title, detail, link })` → inserted row `id` (Number), or `null` on invalid input / failure. Validates `kind ∈ ACTIVITY_KINDS`; redacts + JSON-stringifies `detail`; truncates `title`/`detail`/`link` to the caps; prunes to newest 500 per user.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/activity.test.mjs`:

```js
test('recordActivity inserts a valid event and returns its id', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-rec@example.com', 'pw-12345678');
  const rowId = recordActivity(db, {
    userId,
    kind: 'regression_done',
    title: 'Regression complete — 2 regressed, 18 unchanged',
    detail: { regressed: 2, unchanged: 18, failed: 0 },
  });
  assert.equal(typeof rowId, 'number');
  const row = db.prepare('SELECT * FROM activity WHERE id = ?').get(rowId);
  assert.equal(row.kind, 'regression_done');
  assert.deepEqual(JSON.parse(row.detail), { regressed: 2, unchanged: 18, failed: 0 });
});

test('recordActivity rejects an unknown kind (no insert, returns null)', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-bad@example.com', 'pw-12345678');
  const rowId = recordActivity(db, { userId, kind: 'totally_made_up', title: 'x' });
  assert.equal(rowId, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activity').get().c, 0);
});

test('recordActivity redacts secrets in detail', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-sec@example.com', 'pw-12345678');
  const rowId = recordActivity(db, {
    userId,
    kind: 'email_fetched',
    title: 'Fetched 1 new email',
    detail: { count: 1, apiKey: 'sk-supersecretvalue1234567890' },
  });
  const row = db.prepare('SELECT detail FROM activity WHERE id = ?').get(rowId);
  assert.ok(!row.detail.includes('sk-supersecretvalue1234567890'), 'secret leaked into detail');
});

test('recordActivity enforces length caps', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-cap@example.com', 'pw-12345678');
  const rowId = recordActivity(db, {
    userId,
    kind: 'issue_created',
    title: 'T'.repeat(500),
    link: 'L'.repeat(1000),
  });
  const row = db.prepare('SELECT title, link FROM activity WHERE id = ?').get(rowId);
  assert.ok(row.title.length <= 200);
  assert.ok(row.link.length <= 512);
});

test('recordActivity prunes to the newest 500 rows per user', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-prune@example.com', 'pw-12345678');
  for (let i = 0; i < 505; i++) {
    recordActivity(db, { userId, kind: 'meeting_added', title: `m${i}` });
  }
  const count = db.prepare('SELECT COUNT(*) c FROM activity WHERE user_id = ?').get(userId).c;
  assert.equal(count, 500);
  // The oldest titles must have been pruned; the newest must survive.
  const titles = db.prepare('SELECT title FROM activity WHERE user_id = ? ORDER BY id').all(userId).map((r) => r.title);
  assert.equal(titles[0], 'm5');
  assert.equal(titles.at(-1), 'm504');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/activity.test.mjs`
Expected: FAIL — `Cannot find module '../kb/activity.mjs'`.

- [ ] **Step 3: Implement `kb/activity.mjs` (enum + recordActivity)**

Create `extension/kb/activity.mjs`:

```js
// Activity feed store — the single source of truth for auto-generated events.
// Mirrors the audit_log / recordAudit pattern (server/audit.mjs) but writes to
// the separate `activity` table (different semantics + retention).
//
// All functions are best-effort: callers wrap in try/catch and a failure here
// must never throw into the operation that triggered the event.
import { redactSecrets } from '../core/redact-secrets.mjs';

// The v1 event-kind allow-list (shared contract; Swift mirrors this).
export const ACTIVITY_KINDS = new Set([
  'knowledge_updated',
  'regression_done',
  'issue_created',
  'comment_added',
  'dispatch_issue_created',
  'outcome_changed',
  'meeting_added',
  'email_fetched',
  'slack_fetched',
]);

const TITLE_CAP = 200;
const DETAIL_CAP = 4000;
const LINK_CAP = 512;
const KEEP_PER_USER = 500;

function clamp(str, cap) {
  if (typeof str !== 'string') return null;
  return str.length > cap ? str.slice(0, cap) : str;
}

// Redact + stringify a detail object, capped to DETAIL_CAP chars.
function encodeDetail(detail) {
  if (detail == null) return null;
  let json;
  try { json = JSON.stringify(detail); } catch { return null; }
  // redactSecrets operates on the serialized string (same posture as
  // recordAudit, which truncates first then redacts the text).
  const redacted = redactSecrets(json.length > DETAIL_CAP ? json.slice(0, DETAIL_CAP) : json);
  return redacted.length > DETAIL_CAP ? redacted.slice(0, DETAIL_CAP) : redacted;
}

// Insert one event and prune the user's feed to the newest KEEP_PER_USER rows.
// Returns the inserted row id, or null on invalid input / failure.
export function recordActivity(db, { userId, kind, title, detail, link } = {}) {
  if (!userId || !ACTIVITY_KINDS.has(kind) || typeof title !== 'string' || !title) {
    return null;
  }
  try {
    const info = db.prepare(
      `INSERT INTO activity (user_id, kind, title, detail, link) VALUES (?, ?, ?, ?, ?)`
    ).run(userId, kind, clamp(title, TITLE_CAP), encodeDetail(detail), clamp(link, LINK_CAP));
    const id = Number(info.lastInsertRowid);
    db.prepare(
      `DELETE FROM activity
        WHERE user_id = ?
          AND id NOT IN (SELECT id FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
    ).run(userId, userId, KEEP_PER_USER);
    return id;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/activity.test.mjs`
Expected: PASS (all `recordActivity` tests).

- [ ] **Step 5: Commit**

```bash
git add extension/kb/activity.mjs extension/tests/activity.test.mjs
git commit -m "$(cat <<'EOF'
feat(kb): add recordActivity + event-kind enum

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `listActivity` / `unreadCount` / `markSeen`

**Files:**
- Modify: `extension/kb/activity.mjs`
- Modify (test): `extension/tests/activity.test.mjs`

**Interfaces:**
- Consumes: the `activity` / `activity_seen` tables; `ACTIVITY_KINDS`/`recordActivity` from Task 2.
- Produces:
  - `export function listActivity(db, userId, { sinceId = 0, limit = 100 })` → array of `{ id, kind, title, detail (parsed object|null), link, created_at }`, newest-first. When `sinceId > 0`, only rows with `id > sinceId`; otherwise the newest `limit`.
  - `export function unreadCount(db, userId)` → Number of `activity.id > activity_seen.last_seen_id`.
  - `export function markSeen(db, userId, uptoId)` → upserts `last_seen_id = max(existing, uptoId)`; returns the new cursor value.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/activity.test.mjs`:

```js
test('listActivity returns newest-first and honours sinceId', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity, listActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-list@example.com', 'pw-12345678');
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(recordActivity(db, { userId, kind: 'meeting_added', title: `m${i}` }));
  const all = listActivity(db, userId, {});
  assert.equal(all.length, 3);
  assert.equal(all[0].title, 'm2', 'newest first');
  const sinceFirst = listActivity(db, userId, { sinceId: ids[0] });
  assert.deepEqual(sinceFirst.map((r) => r.title), ['m2', 'm1']);
});

test('listActivity isolates users and parses detail', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity, listActivity } = await import('../kb/activity.mjs');
  const db = getDb();
  const a = registerUser('u-a@example.com', 'pw-12345678').id;
  const b = registerUser('u-b@example.com', 'pw-12345678').id;
  recordActivity(db, { userId: a, kind: 'email_fetched', title: 'a', detail: { count: 3 } });
  recordActivity(db, { userId: b, kind: 'email_fetched', title: 'b', detail: { count: 9 } });
  const forA = listActivity(db, a, {});
  assert.equal(forA.length, 1);
  assert.deepEqual(forA[0].detail, { count: 3 });
});

test('unreadCount and markSeen track the cursor monotonically', async () => {
  freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity, unreadCount, markSeen } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-seen@example.com', 'pw-12345678');
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(recordActivity(db, { userId, kind: 'meeting_added', title: `m${i}` }));
  assert.equal(unreadCount(db, userId), 3);
  markSeen(db, userId, ids[1]);
  assert.equal(unreadCount(db, userId), 1);
  // markSeen never lowers the cursor.
  markSeen(db, userId, ids[0]);
  assert.equal(unreadCount(db, userId), 1);
  markSeen(db, userId, ids[2]);
  assert.equal(unreadCount(db, userId), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/activity.test.mjs`
Expected: FAIL — `listActivity`/`unreadCount`/`markSeen` are not exported.

- [ ] **Step 3: Implement the read/cursor functions**

Append to `extension/kb/activity.mjs`:

```js
// Newest-first feed.  sinceId>0 → only rows after that id (incremental poll);
// otherwise the newest `limit` rows.
export function listActivity(db, userId, { sinceId = 0, limit = 100 } = {}) {
  const rows = sinceId > 0
    ? db.prepare(
        `SELECT id, kind, title, detail, link, created_at
           FROM activity WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT ?`
      ).all(userId, sinceId, limit)
    : db.prepare(
        `SELECT id, kind, title, detail, link, created_at
           FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?`
      ).all(userId, limit);
  return rows.map((r) => {
    let detail = null;
    if (r.detail) { try { detail = JSON.parse(r.detail); } catch { detail = null; } }
    return { id: r.id, kind: r.kind, title: r.title, detail, link: r.link, created_at: r.created_at };
  });
}

// Number of events newer than the user's last-seen cursor.
export function unreadCount(db, userId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM activity
      WHERE user_id = ?
        AND id > COALESCE((SELECT last_seen_id FROM activity_seen WHERE user_id = ?), 0)`
  ).get(userId, userId);
  return row ? row.c : 0;
}

// Advance the last-seen cursor; never lowers it.
export function markSeen(db, userId, uptoId) {
  const upto = Number(uptoId) || 0;
  db.prepare(
    `INSERT INTO activity_seen (user_id, last_seen_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)`
  ).run(userId, upto);
  const row = db.prepare(`SELECT last_seen_id FROM activity_seen WHERE user_id = ?`).get(userId);
  return row ? row.last_seen_id : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/activity.test.mjs`
Expected: PASS (all activity store tests).

- [ ] **Step 5: Commit**

```bash
git add extension/kb/activity.mjs extension/tests/activity.test.mjs
git commit -m "$(cat <<'EOF'
feat(kb): add listActivity, unreadCount, markSeen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `deleteUserCascade` wipes activity tables

**Files:**
- Modify: `extension/kb/db.mjs` (the `deleteUserCascade` function)
- Modify (test): `extension/tests/user-delete-cascade.test.mjs`

**Interfaces:**
- Consumes: `recordActivity`/`markSeen` from `kb/activity.mjs`.
- Produces: after `deleteUserCascade(userId)`, zero rows remain in `activity` and `activity_seen` for that user.

> Note: the FK is `ON DELETE CASCADE`, but `deleteUserCascade` does explicit per-table deletes (foreign keys may not be enforced on every connection). Add `activity`/`activity_seen` to the explicit list so the contract holds regardless.

- [ ] **Step 1: Write the failing test**

Add a test to `extension/tests/user-delete-cascade.test.mjs` (follow the file's existing style — register a user, write rows, delete, assert empty):

```js
test('deleteUserCascade removes activity + activity_seen rows', async () => {
  const { getDb, deleteUserCascade } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity, markSeen } = await import('../kb/activity.mjs');
  const db = getDb();
  const { id: userId } = registerUser('u-cascade-activity@example.com', 'pw-12345678');
  const id = recordActivity(db, { userId, kind: 'meeting_added', title: 'm' });
  markSeen(db, userId, id);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM activity WHERE user_id = ?').get(userId).c > 0);

  deleteUserCascade(userId);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM activity WHERE user_id = ?').get(userId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activity_seen WHERE user_id = ?').get(userId).c, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/user-delete-cascade.test.mjs`
Expected: FAIL — rows remain (or the test asserts >0 then nonzero after delete), proving cascade doesn't cover the new tables.

- [ ] **Step 3: Extend `deleteUserCascade`**

In `extension/kb/db.mjs`, locate `deleteUserCascade` and add `activity` and `activity_seen` to its set of per-table deletes, matching the existing idiom in that function (e.g. alongside the other `DELETE FROM <table> WHERE user_id = ?` statements):

```js
  db.prepare('DELETE FROM activity WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM activity_seen WHERE user_id = ?').run(userId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/user-delete-cascade.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/kb/db.mjs extension/tests/user-delete-cascade.test.mjs
git commit -m "$(cat <<'EOF'
feat(kb): wipe activity tables in deleteUserCascade

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: HTTP routes + endpoint registration + drift docs

**Files:**
- Modify: `extension/kb/router.mjs` (3 routes)
- Modify: `extension/server.mjs` (`ENDPOINTS` array + `rateLimitProfile()`)
- Create (test): `extension/tests/activity-routes.test.mjs`
- Modify: `docs/reference/api/openapi.yaml` (add 3 endpoints)
- Modify: `docs/spec/api-server.md` (§6 rate-limit table: 2 POSTs under `kbWrite`)

**Interfaces:**
- Consumes: `listActivity`/`unreadCount`/`markSeen`/`recordActivity`/`ACTIVITY_KINDS` from `kb/activity.mjs`; `sendJSON`/`readBody`/`parseJSON` from `core/utils.mjs`; `getDb` from `kb/db.mjs`; `req.user.id` (set by the tenancy gate at the top of `handleKB`).
- Produces:
  - `GET /kb/activity?since=<id>&limit=<n>` → `200 { items: [...], unread: <n>, lastId: <maxId> }`
  - `POST /kb/activity/seen` `{ uptoId }` → `200 { ok: true, unread: 0 }`
  - `POST /kb/activity` `{ kind, title, detail?, link? }` → `200 { ok: true, id }`; `400 VALIDATION_FAILED` on unknown kind / missing title.

- [ ] **Step 1: Write the failing route tests**

Create `extension/tests/activity-routes.test.mjs`. Follow the existing route-test idiom (set env, point `LLMIDE_DB_PATH` at a temp file, register a user, call `handleKB` with a fake `req`/`res`). Capture the helper here so the file is self-contained:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_activity-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch {} }

// Minimal req/res doubles compatible with handleKB.
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h); },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}
function makeReq({ method, url, userId, body }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  let i = 0;
  return {
    method, url, user: { id: userId }, headers: {},
    on(ev, cb) {
      if (ev === 'data') { for (const c of chunks) cb(c); }
      if (ev === 'end') cb();
      return this;
    },
  };
}

test('POST /kb/activity records a valid event; GET returns it; seen clears unread', async () => {
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { handleKB } = await import('../kb/router.mjs');
  getDb();
  const { id: userId } = registerUser('u-route@example.com', 'pw-12345678');

  let res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/activity', userId,
    body: { kind: 'issue_created', title: 'Issue created — X', detail: { url: 'https://x/1' } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const id = res.body.id;

  res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/activity', userId }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.unread, 1);
  assert.equal(res.body.lastId, id);

  res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/activity/seen', userId, body: { uptoId: id } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.unread, 0);
});

test('POST /kb/activity rejects an unknown kind with 400', async () => {
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { handleKB } = await import('../kb/router.mjs');
  getDb();
  const { id: userId } = registerUser('u-route-bad@example.com', 'pw-12345678');
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/activity', userId,
    body: { kind: 'nope', title: 'x' } }), res);
  assert.equal(res.statusCode, 400);
});
```

> If the existing route tests use a different `req`/`res` harness (check `tests/` for an established helper before writing), prefer that helper over these doubles to stay consistent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/activity-routes.test.mjs`
Expected: FAIL — routes return 404/fall through (handler not yet added).

- [ ] **Step 3: Add the routes to `kb/router.mjs`**

Add the import near the other kb imports at the top of `extension/kb/router.mjs`:

```js
import { recordActivity, listActivity, unreadCount, markSeen, ACTIVITY_KINDS } from './activity.mjs';
```

Inside `handleKB` (after the `userId` tenancy gate, alongside the other `if (req.method === ... && url === ...)` blocks), add:

```js
    if (req.method === 'GET' && (url === '/kb/activity' || url.startsWith('/kb/activity?'))) {
      const u = new URL(url, 'http://127.0.0.1');
      const sinceId = Number(u.searchParams.get('since')) || 0;
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 100, 1), 200);
      const db = getDb();
      const items = listActivity(db, userId, { sinceId, limit });
      const lastId = items.length ? items[0].id : sinceId;
      sendJSON(res, 200, { items, unread: unreadCount(db, userId), lastId });
      return true;
    }

    if (req.method === 'POST' && url === '/kb/activity/seen') {
      const body = parseJSON(await readBody(req, 16 * 1024)) || {};
      const db = getDb();
      markSeen(db, userId, Number(body.uptoId) || 0);
      sendJSON(res, 200, { ok: true, unread: unreadCount(db, userId) });
      return true;
    }

    if (req.method === 'POST' && url === '/kb/activity') {
      const body = parseJSON(await readBody(req, 16 * 1024)) || {};
      if (!ACTIVITY_KINDS.has(body.kind) || typeof body.title !== 'string' || !body.title) {
        sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid activity kind or title' } });
        return true;
      }
      const db = getDb();
      const id = recordActivity(db, {
        userId, kind: body.kind, title: body.title, detail: body.detail, link: body.link,
      });
      if (id == null) {
        sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Could not record activity' } });
        return true;
      }
      sendJSON(res, 200, { ok: true, id });
      return true;
    }
```

> `getDb` is already imported/used in `router.mjs`; if not, import it from `./db.mjs` like the neighbouring routes do.

- [ ] **Step 4: Register the endpoints + rate-limit profiles in `server.mjs`**

In `extension/server.mjs`, add the three paths to the `ENDPOINTS` array (near the other `/kb/...` entries):

```js
  '/kb/activity',
  '/kb/activity/seen',
```

(`/kb/activity` covers both `GET` and `POST`; `/kb/activity/seen` is the POST. List each path once.)

In `rateLimitProfile()`, add the two POSTs to the `kbWrite` group (after the existing `/kb/slack/seen` line):

```js
  if (url === '/kb/activity' || url === '/kb/activity/seen') return 'kbWrite';
```

(`GET /kb/activity` is handled by the `method === 'GET'` short-circuit returning `null` — the default read profile — so no GET entry is needed.)

- [ ] **Step 5: Run route tests + full suite**

Run: `cd extension && node --test tests/activity-routes.test.mjs && node --test`
Expected: PASS (new route tests + no regressions).

- [ ] **Step 6: Update the drift-guard docs**

In `docs/reference/api/openapi.yaml`, add path entries for `/kb/activity` (`get` + `post`) and `/kb/activity/seen` (`post`), following the shape of the neighbouring `/kb/*` paths (each with the `get`/`post` operation, a one-line summary, and the standard auth + JSON response). Minimum to satisfy `check_api_coverage`:

```yaml
  /kb/activity:
    get:
      summary: List the authenticated user's activity feed
      responses:
        '200':
          description: Activity items + unread count
    post:
      summary: Record an in-process activity event (Mac app)
      responses:
        '200':
          description: Event recorded
        '400':
          description: Invalid kind or title
  /kb/activity/seen:
    post:
      summary: Advance the activity last-seen cursor
      responses:
        '200':
          description: Cursor advanced
```

In `docs/spec/api-server.md` §6 rate-limit table, add two rows under the `kbWrite` profile:

```markdown
| `POST /kb/activity`      | `kbWrite` | Mac reports an in-process event |
| `POST /kb/activity/seen` | `kbWrite` | advance the unread cursor       |
```

- [ ] **Step 7: Verify drift guards**

Run: `make docs-check` (from repo root)
Expected: PASS (`check_api_coverage` + `check_rate_limit_mapping` green).

- [ ] **Step 8: Commit**

```bash
git add extension/kb/router.mjs extension/server.mjs extension/tests/activity-routes.test.mjs \
        docs/reference/api/openapi.yaml docs/spec/api-server.md
git commit -m "$(cat <<'EOF'
feat(api): add /kb/activity GET, POST, and /seen routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Server-side `recordActivity` call sites (5)

**Files:**
- Modify: `extension/agents/dispatcher.mjs` (`dispatch_issue_created`)
- Modify: `extension/agents/outcome-watcher.mjs` or `extension/kb/outcomes.mjs` (`outcome_changed`)
- Modify: `extension/kb/meetings.mjs` (`meeting_added`)
- Modify: `extension/kb/router.mjs` (`/kb/email/fetch` → `email_fetched`; `/kb/slack/fetch` → `slack_fetched`)
- Modify (test): `extension/tests/activity-routes.test.mjs` (one integration assertion is enough; the unit behavior is already covered)

**Interfaces:**
- Consumes: `recordActivity` from `kb/activity.mjs`; the `userId` and `getDb()` already available at each site.
- Each call is best-effort: wrap in `try { recordActivity(...); } catch {}` so a feed failure never breaks dispatch/ingest/fetch.

- [ ] **Step 1: Write a failing integration test (email fetch path)**

The email/slack fetch routes are the most testable server-side sites. Add to `extension/tests/activity-routes.test.mjs` a test asserting that after a fetch reporting `count > 0`, an `email_fetched` row exists. Because `/kb/email/fetch` performs real IMAP, assert at the unit boundary instead: verify the recording happens when invoked with a fake result. The simplest durable check — assert the call site exists and records — is to test the helper the route uses. Add:

```js
test('recordActivity is called for email_fetched with count>0 shape', async () => {
  // Guard test: the email_fetched kind is in the allow-list and round-trips.
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { recordActivity, listActivity } = await import('../kb/activity.mjs');
  getDb();
  const { id: userId } = registerUser('u-email-evt@example.com', 'pw-12345678');
  const db = getDb();
  recordActivity(db, { userId, kind: 'email_fetched', title: 'Fetched 7 new emails', detail: { count: 7 } });
  const items = listActivity(db, userId, {});
  assert.equal(items[0].kind, 'email_fetched');
});
```

> The 5 call sites are wiring, not new logic — the store behavior is unit-tested in Tasks 2–3. This guard test confirms the kinds are valid; the call sites are verified by reading + the full suite passing.

- [ ] **Step 2: Run it to verify it passes against the store (sanity)**

Run: `cd extension && node --test tests/activity-routes.test.mjs`
Expected: PASS (store already supports the kind).

- [ ] **Step 3: Add the dispatcher call site**

In `extension/agents/dispatcher.mjs`, at each point that today marks `meta.dispatched` after a successful issue create (GitHub/Backlog/Linear), add (using the `userId` + provider/url/number in scope):

```js
    try {
      recordActivity(getDb(), {
        userId,
        kind: 'dispatch_issue_created',
        title: `Dispatched issue to ${provider} — #${number}`,
        detail: { provider, url, number },
        link: url,
      });
    } catch {}
```

Add `import { recordActivity } from '../kb/activity.mjs';` and ensure `getDb` is imported (`import { getDb } from '../kb/db.mjs';`).

- [ ] **Step 4: Add the outcome-changed call site**

In whichever module reports a real outcome transition (`agents/outcome-watcher.mjs` or `kb/outcomes.mjs recordOutcome`), at the branch that fires **only on a real, deduped change**, add:

```js
    try {
      recordActivity(getDb(), {
        userId,
        kind: 'outcome_changed',
        title: `${resource} ${toState}`,
        detail: { resource, fromState, toState },
      });
    } catch {}
```

- [ ] **Step 5: Add the meeting-added call site**

In `extension/kb/meetings.mjs ingestMeeting` (the path that also covers live-session finalize), after a successful ingest:

```js
    try {
      recordActivity(getDb(), {
        userId,
        kind: 'meeting_added',
        title: `Meeting added — ${title}${participantCount ? ` (${participantCount} participants)` : ''}`,
        detail: { title, participantCount, date },
      });
    } catch {}
```

- [ ] **Step 6: Add the email + slack fetch call sites**

In `extension/kb/router.mjs`, in the `/kb/email/fetch` branch, **only when the newly-ingested count > 0** (use the result's count field — inspect the route's result shape), add:

```js
      if (fetchCount > 0) {
        try {
          recordActivity(getDb(), {
            userId,
            kind: 'email_fetched',
            title: `Fetched ${fetchCount} new email${fetchCount === 1 ? '' : 's'}`,
            detail: { count: fetchCount },
          });
        } catch {}
      }
```

In the `/kb/slack/fetch` branch, **only when count > 0**:

```js
      if (slackCount > 0) {
        try {
          recordActivity(getDb(), {
            userId,
            kind: 'slack_fetched',
            title: `Fetched ${slackCount} new Slack message${slackCount === 1 ? '' : 's'}${channelId ? ` (#${channelId})` : ''}`,
            detail: { channelId, count: slackCount },
          });
        } catch {}
      }
```

(`recordActivity`/`ACTIVITY_KINDS` are already imported in `router.mjs` from Task 5. Bind `fetchCount`/`slackCount`/`channelId` to the actual fields the fetch results expose — read those handlers to confirm the names.)

- [ ] **Step 7: Run the full suite**

Run: `cd extension && node --test`
Expected: PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add extension/agents/dispatcher.mjs extension/kb/meetings.mjs extension/kb/router.mjs \
        extension/agents/outcome-watcher.mjs extension/kb/outcomes.mjs extension/tests/activity-routes.test.mjs
git commit -m "$(cat <<'EOF'
feat(kb): record server-side activity events (dispatch, outcome, meeting, email, slack)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> After Tasks 1–6, push the backend cleanly: `cd extension && make test`, then `git push` (the node gate passes; **no** `--no-verify` needed since nothing under `mac/` changed yet).

---

## Task 7: Mac `ActivityStore` + `ActivityKind` + `ActivityItem`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ActivityStore.swift`

**Interfaces:**
- Consumes: the backend HTTP client used by the other stores (match `AgentRunsStore`/`ShellState` — find how they reach the backend base URL + auth header; reuse that, do not invent a new client).
- Produces:
  - `enum ActivityKind: String, CaseIterable` — the 9 kinds (exact raw values matching the JS allow-list).
  - `struct ActivityItem: Identifiable` — `{ id: Int, kind: ActivityKind?, title: String, detail: [String: Any]?, link: String?, createdAt: Date }`.
  - `@MainActor @Observable final class ActivityStore` with `items: [ActivityItem]`, `unreadCount: Int`, `lastId: Int`, and methods `start()`, `refresh() async`, `report(kind:title:detail:link:)`, `markSeen()`.

> `swift test` is blocked by the local toolchain skew — **verify with `swift build` only**. Author the test intent as comments / a `#if DEBUG` helper if the repo has that idiom, but do not gate the task on `swift test`.

- [ ] **Step 1: Author `ActivityStore.swift`**

Create `mac/Sources/LlmIdeMac/Services/ActivityStore.swift`. Match the existing store idiom — read `Services/AgentRunsStore.swift` (or the nearest polling `@Observable`) first and mirror its backend-call + decode + Timer pattern. Skeleton (adapt the networking to the existing client):

```swift
import Foundation

enum ActivityKind: String, CaseIterable {
    case knowledgeUpdated = "knowledge_updated"
    case regressionDone = "regression_done"
    case issueCreated = "issue_created"
    case commentAdded = "comment_added"
    case dispatchIssueCreated = "dispatch_issue_created"
    case outcomeChanged = "outcome_changed"
    case meetingAdded = "meeting_added"
    case emailFetched = "email_fetched"
    case slackFetched = "slack_fetched"
}

struct ActivityItem: Identifiable {
    let id: Int
    let kind: ActivityKind?
    let title: String
    let detail: [String: Any]?
    let link: String?
    let createdAt: Date
}

@MainActor
@Observable
final class ActivityStore {
    private(set) var items: [ActivityItem] = []
    private(set) var unreadCount: Int = 0
    private(set) var lastId: Int = 0

    private let backend: BackendManager   // or whatever the other stores hold
    private var pollTask: Task<Void, Never>?
    private let pollInterval: Duration = .seconds(25)

    init(backend: BackendManager) { self.backend = backend }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(25))
            }
        }
    }

    // GET /kb/activity?since=lastId — prepend new items, update lastId + unread.
    func refresh() async {
        do {
            let resp = try await backend.getJSON("/kb/activity?since=\(lastId)")
            // decode resp.items into [ActivityItem], prepend new (id > lastId),
            // set lastId = resp.lastId, unreadCount = resp.unread
            // (match the manual-JSON decode style the other stores use)
        } catch {
            // silent retry next tick (AgentRunsStore idiom)
        }
    }

    // POST /kb/activity — fire-and-forget; never throws into the caller.
    func report(kind: ActivityKind, title: String, detail: [String: Any]? = nil, link: String? = nil) {
        Task { [weak self] in
            guard let self else { return }
            do {
                var body: [String: Any] = ["kind": kind.rawValue, "title": title]
                if let detail { body["detail"] = detail }
                if let link { body["link"] = link }
                _ = try await self.backend.postJSON("/kb/activity", body: body)
            } catch {
                // logged, never thrown
            }
        }
    }

    // POST /kb/activity/seen { uptoId: lastId } — clears the badge on popover open.
    func markSeen() {
        let upto = lastId
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await self.backend.postJSON("/kb/activity/seen", body: ["uptoId": upto]) } catch {}
            await MainActor.run { self.unreadCount = 0 }
        }
    }
}
```

> Replace `backend.getJSON`/`postJSON` with the actual methods the sibling stores use. Keep the public surface (`items`, `unreadCount`, `lastId`, `start`, `refresh`, `report`, `markSeen`) exactly as listed — Tasks 8–9 depend on these names.

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build`
Expected: build succeeds (no errors). Fix any signature mismatches against the real backend client.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ActivityStore.swift
git commit -m "$(cat <<'EOF'
feat(mac): add ActivityStore (poll/report/markSeen) + ActivityKind

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Mac event reporting (4 call sites) + store injection

**Files:**
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` (construct `ActivityStore`, inject via `.environment`, set `weak` ref on app-level services)
- Modify: `mac/Sources/LlmIdeMac/CodeGraph/GraphAutoUpdater.swift` (`knowledge_updated`)
- Modify: `mac/Sources/LlmIdeMac/Services/RegressionRunner.swift` (`regression_done`)
- Modify: the `RepoBackend.createIssue` / `createIssueComment` callers (`issue_created`, `comment_added`)

**Interfaces:**
- Consumes: `ActivityStore.report(kind:title:detail:link:)` from Task 7.
- App-level services hold `weak var activity: ActivityStore?` (the existing `RegressionRunner.weak var config` pattern); view-level sites use `@Environment(ActivityStore.self)`.

- [ ] **Step 1: Construct + inject the store in the app entry**

In `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift init`, construct `ActivityStore(backend:)`, call `.start()`, inject it with `.environment(activityStore)` on the root scene, and assign it to the `weak var activity` on `GraphAutoUpdater` and `RegressionRunner` (wherever those app-level services are created), mirroring how other shared services are wired.

- [ ] **Step 2: Add the `knowledge_updated` report**

In `CodeGraph/GraphAutoUpdater.swift publishToSession(repoRoot:)`, after publishing succeeds:

```swift
        activity?.report(
            kind: .knowledgeUpdated,
            title: "Project knowledge updated — \(codeNodes) code · \(docNodes) doc nodes",
            detail: ["repo": repo, "codeNodes": codeNodes, "docNodes": docNodes, "mergedNodes": mergedNodes]
        )
```

(Bind `codeNodes`/`docNodes`/`mergedNodes`/`repo` to the values the publish step already computes.)

- [ ] **Step 3: Add the `regression_done` report**

In `Services/RegressionRunner.run` completion (the `defer` summary block), after the summary counts are known:

```swift
        activity?.report(
            kind: .regressionDone,
            title: "Regression complete — \(regressed) regressed, \(unchanged) unchanged",
            detail: ["regressed": regressed, "unchanged": unchanged, "failed": failed]
        )
```

- [ ] **Step 4: Add the `issue_created` + `comment_added` reports**

At each success of `RepoBackend.createIssue` (manual sheet, confirm-apply, `AutoCodeUpdateService`), in the view/service that owns the `@Environment(ActivityStore.self)` (or the injected ref):

```swift
        activity.report(
            kind: .issueCreated,
            title: "Issue created — \(issueTitle)",
            detail: ["title": issueTitle, "repo": repo, "url": url],
            link: url
        )
```

At success of `createIssueComment`:

```swift
        activity.report(
            kind: .commentAdded,
            title: "Comment added to issue #\(iid)",
            detail: ["iid": iid, "url": url],
            link: url
        )
```

(For view-level sites add `@Environment(ActivityStore.self) private var activity`; for service-level sites use the injected `weak var activity`.)

- [ ] **Step 5: Build to verify it compiles**

Run: `cd mac && swift build`
Expected: build succeeds. Resolve any optional-chaining / environment-injection mismatches.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/LlmIdeMacApp.swift \
        mac/Sources/LlmIdeMac/CodeGraph/GraphAutoUpdater.swift \
        mac/Sources/LlmIdeMac/Services/RegressionRunner.swift
# plus the createIssue/createIssueComment caller files you edited
git commit -m "$(cat <<'EOF'
feat(mac): report knowledge/regression/issue/comment events to activity feed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Bell + popover UI + StatusBar wiring + macOS doc

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shell/ActivityBell.swift` (bell chip + `ActivityPanel`)
- Modify: `mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift` (place the bell beside `AgentStatusBadge`)
- Modify: `mac/Sources/LlmIdeMac/Services/NotificationNames.swift` (only if a new `Notification.Name` is needed for deep-link)
- Modify: `docs/spec/macos-app.md` (document the bell/store flow)

**Interfaces:**
- Consumes: `@Environment(ActivityStore.self)`; the existing `.openSection(...)` deep-link `Notification.Name` (reuse if present).
- Produces: `ActivityBell` view + `ActivityPanel` popover; rendered in the status bar.

- [ ] **Step 1: Author `ActivityBell.swift`**

Create `mac/Sources/LlmIdeMac/Views/Shell/ActivityBell.swift`:

```swift
import SwiftUI

struct ActivityBell: View {
    @Environment(ActivityStore.self) private var activity
    @State private var showPanel = false

    var body: some View {
        Button {
            showPanel.toggle()
        } label: {
            Image(systemName: activity.unreadCount > 0 ? "bell.badge" : "bell")
                .overlay(alignment: .topTrailing) {
                    if activity.unreadCount > 0 {
                        Text("\(min(activity.unreadCount, 99))")
                            .font(.caption2).padding(3)
                            .background(Circle().fill(.red)).foregroundStyle(.white)
                            .offset(x: 6, y: -6)
                    }
                }
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showPanel) { ActivityPanel() }
        .onChange(of: showPanel) { _, open in if open { activity.markSeen() } }
    }
}

struct ActivityPanel: View {
    @Environment(ActivityStore.self) private var activity

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(groupedByDay(), id: \.0) { (day, rows) in
                    Text(day).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.top, 8)
                    ForEach(rows) { item in ActivityRow(item: item) }
                }
                if activity.items.isEmpty {
                    Text("No activity yet").foregroundStyle(.secondary).padding()
                }
            }
        }
        .frame(width: 360, height: 420)
    }

    // Group items into Today / Yesterday / earlier (relative day buckets).
    private func groupedByDay() -> [(String, [ActivityItem])] {
        let cal = Calendar.current
        var buckets: [(String, [ActivityItem])] = []
        func label(_ d: Date) -> String {
            if cal.isDateInToday(d) { return "Today" }
            if cal.isDateInYesterday(d) { return "Yesterday" }
            return d.formatted(date: .abbreviated, time: .omitted)
        }
        for item in activity.items {
            let l = label(item.createdAt)
            if let idx = buckets.firstIndex(where: { $0.0 == l }) { buckets[idx].1.append(item) }
            else { buckets.append((l, [item])) }
        }
        return buckets
    }
}

struct ActivityRow: View {
    let item: ActivityItem

    var body: some View {
        Button {
            if let link = item.link {
                NotificationCenter.default.post(name: .openSection, object: link)
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon(for: item.kind))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).lineLimit(2)
                    Text(item.createdAt, format: .relative(presentation: .named))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }

    private func icon(for kind: ActivityKind?) -> String {
        switch kind {
        case .knowledgeUpdated: return "brain"
        case .regressionDone: return "checkmark.seal"
        case .issueCreated, .dispatchIssueCreated: return "exclamationmark.bubble"
        case .commentAdded: return "text.bubble"
        case .outcomeChanged: return "arrow.triangle.branch"
        case .meetingAdded: return "person.3"
        case .emailFetched: return "envelope"
        case .slackFetched: return "number"
        case .none: return "circle"
        }
    }
}
```

> If `.openSection` is not an existing `Notification.Name`, reuse the actual deep-link name the codebase uses (read `Services/NotificationNames.swift` + existing call sites) instead of inventing one. Only add a new name if none fits.

- [ ] **Step 2: Place the bell in the status bar**

In `mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift`, add `ActivityBell()` beside `AgentStatusBadge` (match the surrounding `HStack` spacing/alignment).

- [ ] **Step 3: Build to verify it compiles**

Run: `cd mac && swift build`
Expected: build succeeds.

- [ ] **Step 4: Document the feature in `docs/spec/macos-app.md`**

Add a short section describing: `ActivityStore` (short-poll `GET /kb/activity` every ~25 s + on focus, `report()` POST for the 4 Mac kinds, `markSeen()` on popover open) and the `ActivityBell`/`ActivityPanel` in the status bar (unread badge, day-grouped list, row click → `.openSection` deep-link). Mention it pairs with the backend `activity` table/module documented in `docs/spec/knowledge-base.md`.

- [ ] **Step 5: Verify docs guard**

Run: `make docs-check` (from repo root)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shell/ActivityBell.swift \
        mac/Sources/LlmIdeMac/Views/Shell/StatusBar.swift \
        mac/Sources/LlmIdeMac/Services/NotificationNames.swift \
        docs/spec/macos-app.md
git commit -m "$(cat <<'EOF'
feat(mac): add activity bell + popover in status bar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> **Pushing the mac tasks (7–9):** the pre-push `make regression` gate's `swift test` is blocked by the toolchain skew. Verify with `cd mac && swift build`, then push with `git push --no-verify`.

---

## Self-Review

**Spec coverage** (each §-of-spec → task):
- §3.1 migration → Task 1. §3.2 module (record/list/unread/seen + caps + prune + redact + enum) → Tasks 2–3. §3.3 routes + ENDPOINTS + rateLimitProfile → Task 5. §3.4 five server-side sites → Task 6. §3.5 cascade → Task 4. §4.1 ActivityStore → Task 7. §4.2 four Mac sites + injection → Task 8. §4.3 bell + popover + StatusBar → Task 9. §5 enum (JS Set + Swift enum) → Tasks 2 + 7. §7 error handling (best-effort) → encoded in every call-site wrapper + store catch. §8 testing → Tasks 1–6 TDD; mac authored + `swift build` (noted blocked `swift test`). §9 docs/drift-guards → Task 1 (migration head + kb table prose), Task 5 (openapi + rate-limit table), Task 9 (macos-app). §10 boundaries → file structure. §11 build/CI → Global Constraints + push notes after Tasks 6 and 9.

**Placeholder scan:** Mac integration call sites (Tasks 8–9) reference real method/value names (`publishToSession`, `RegressionRunner.run`, `createIssue`, `createIssueComment`, `AgentStatusBadge`, `.openSection`) but instruct the implementer to bind to the actual in-scope variables and confirm the deep-link name — this is integration glue against existing code the implementer must read, not an unfilled blank. Backend tasks (1–6) carry complete, runnable code + exact commands.

**Type consistency:** `recordActivity({ userId, kind, title, detail, link })` and the `{ id, kind, title, detail, link, created_at }` row shape are used identically in store, routes, and tests. `ActivityStore` public surface (`items`/`unreadCount`/`lastId`/`start`/`refresh`/`report`/`markSeen`) is fixed in Task 7 and consumed verbatim in Tasks 8–9. The 9 kind strings match between `ACTIVITY_KINDS` (JS) and `ActivityKind` (Swift raw values).

**Known soft spots flagged for the implementer:** the exact email/slack fetch result count field names (Task 6) and the exact backend HTTP-client methods on the Mac side (Task 7) must be confirmed by reading the neighbouring code — the plan says so at each site rather than guessing a wrong name.
