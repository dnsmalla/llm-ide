# Desktop Job Scheduler and Approval Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Tauri desktop app, show the command-bus jobs that wait for the desktop's approval (Approve / Deny with the bus nonce), and run per-kind schedules (first: Google Calendar, Google Drive and iCal `sources.update`, every N hours) that enqueue as `desktop-ui` and are approved either by a click on each run or by a scoped, expiring, revocable, audited standing approval.

**Architecture:** The core stays timer-free (G7 ruling: a server timer would bypass the T1 approval). The core gains a `bus_schedules` table, three routes (`GET`/`POST /bus/schedules`, `DELETE /bus/schedules/:id`) and an optional `scheduleId` on `POST /bus/commands/:id/approve`, which the core accepts only when the schedule's standing approval is live and covers exactly that command (same kind, same args hash, `desktop-ui` origin, `sched:<id>:` idem, T1, not too soon). The nonce is still required, `approved_by` is still written, and the executor's T1/T2 check from `4e9ad5e1` is unchanged; it gains one more check (the schedule still exists and its standing approval is still live) for a run approved that way. The desktop shell gets a scheduler tick (60 s) and an inbox in the status bar that polls `GET /bus/approvals` and raises the existing fixed `approval_needed` notification.

**Tech Stack:** Node 20 core (`node:test`, better-sqlite3), React 19 shell in `ui/screens/shell/` (desktop node tests through esbuild, `tsc --noEmit`), the existing Tauri `notify` command (no Rust change).

**Spec:** `docs/spec/command-bus.md` (the implemented bus contract) and `docs/superpowers/plans/2026-10-31-command-bus-spec.md`; G7 rulings in `docs/superpowers/MASTER-PLAN.md` ("Google G7 automation hook"); commits `9c9e8460`, `287cd52a`, `4e9ad5e1`.

## Global Constraints

- The bus refuses T1 and T2 without a recorded approval at execution (`extension/routes/bus/executor.mjs`, `if (info.tier !== 'T0' && !approved) fail('tier_denied')`). Do not change or bypass that line.
- No server-side timer runs bus commands. Only the desktop enqueues scheduled runs.
- Every approval still needs `mayApprove(client)` (desktop class, with host proof) and the per-command nonce. A standing approval adds a constraint, never a way around those two.
- A standing approval is never granted for a T2 kind or a T0 kind, and it never approves a command that a phone, extension or web client started.
- Every kb helper takes `userId` first and filters on it. Another user's schedule reads as 404 `NOT_FOUND`.
- Migrations are append-only. Next number: `0063` (if `main` already has a `0063`, take the next free number and update the account-delete list comment to match).
- `SERVER_API_VERSION` goes up by one (110 to 111 today; if `main` has moved, use current + 1) and the new paths go into `ALL_ENDPOINTS`.
- Audit rows never hold a nonce, a token, a request body or a source name. They hold ids, kind, class, counts and codes only.
- The notification is the host's fixed template `approval_needed`. Its detail is a kind title from our own table, never server text.
- Do not touch `ui/screens/settings/sections/AccountSection.tsx`, `marketing/` or `web/` (another agent owns them).
- Commits go on `main` (the user does not want branches). Use Conventional Commits, one concern per commit, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Security model of the standing approval

| Property | Rule | Where enforced |
|---|---|---|
| Who grants | Only the desktop class (`mayApprove`): host proof, so a phone, the extension, the web app or an adopted core cannot | `POST /bus/schedules` |
| Explicit scope | It covers one kind and one exact args object (sha-256 `argsHashOf(kind, args)`). For `sources.update` the args must name `sourceIds`: "every source" is refused for a standing approval, because it would silently grow with each new connection | `parseScheduleBody`, `standingRefusal` |
| Kinds | Allow-list `SCHEDULABLE_KINDS = ['sources.update']`. Only an available T1 kind can be added to it. T2 never, so a T2 run always needs a click in the inbox with its exact ids confirmed | `parseScheduleBody`, `standingRefusal` (`tier`) |
| Origin | It approves only a command that the desktop itself enqueued (`origin_client = desktop-ui`) with the idem `sched:<scheduleId>:<slot>`. A command that a phone queued is never approved by a schedule | `standingRefusal` (`origin`, `not_scheduled`) |
| Rate | At most one approved run per half interval (`last_run_at`), so even a compromised webview holding the proof cannot use it to run the job in a loop | `standingRefusal` (`too_soon`) |
| Expiry | `standing_until` = creation + `standingDays` (default 30, at most 90). Once it has expired, every run waits for a click again. There is no silent renewal: renewing means creating a new schedule | store + `standingRefusal` |
| Revocation | Deleting the schedule ends it at once. A run already approved and still queued is refused at execution (`switch_off`) | `DELETE /bus/schedules/:id`, executor re-check |
| Nonce and approver | Unchanged: the scheduler still reads the nonce from `GET /bus/approvals` and still calls approve, and `approved_by` is still written | `executor.approve` |
| Audit | `bus.schedule_create` (kind, interval, standing, until, source count), `bus.schedule_delete`, and `bus.approve` with `via: 'standing'` + `scheduleId` (also on a refusal, outcome `denied`, reason code) | `bus-routes.mjs` |
| Honest limit | The desktop webview already holds the host proof, which can approve any single T1 command. A standing approval does not add power. It adds a recorded human decision with a bounded scope, rate and lifetime, and it lets the desktop run unattended without asking the user for blanket trust | stated in the spec |

**What the phone sees.** A native phone (`ios-native`, rank 3) can read every command of the user's. A scheduled run shows in `GET /bus/commands` as a `sources.update` command with `originClient: "desktop-ui"`. The phone can read `GET /bus/schedules` (interval, standing, until, last run) but cannot create, delete or approve: those are desktop-class only. `phone-pwa` and `extension` get 403 `TIER_DENIED` on schedules and still see only commands started by their own class. A `sources.update` that the phone queued waits in the desktop inbox, where the origin shows as "your iPhone". It is never approved by a standing approval.

## File map

| File | Responsibility |
|---|---|
| `extension/kb/migrations/0063_bus_schedules.sql` (create) | `bus_schedules` table, `bus_commands.schedule_id` |
| `extension/kb/bus-schedules.mjs` (create) | per-user schedule CRUD, `standing` computed from `standing_until` |
| `extension/kb/bus-store.mjs` (modify) | `approveCommand` records `schedule_id` and the schedule's `last_run_at` in the same transaction; `shapeRow` exposes `scheduleId` |
| `extension/kb/db.mjs` (modify) | `bus_schedules` in the account-delete list |
| `extension/routes/bus/schedules.mjs` (create) | pure policy: `SCHEDULABLE_KINDS`, `parseScheduleBody`, `standingRefusal` |
| `extension/routes/bus/executor.mjs` (modify) | `approve(..., { scheduleId })`, execution re-check for standing runs |
| `extension/routes/bus/bus-routes.mjs` (modify) | schedule routes, `scheduleId` on approve, audit |
| `extension/server.mjs` (modify) | `ALL_ENDPOINTS`, `SERVER_API_VERSION`, version comment |
| `extension/tests/bus-schedules.test.mjs` (create) | store, policy, executor and HTTP tests |
| `schema/http/bus.schema.json`, `schema/http/fixtures/bus/*` (modify/create) | the HTTP contract of the new routes |
| `extension/tests/http-contract-live.test.mjs` (modify) | the live-replay skip rule for the new rows |
| `ui/screens/shell/approvals/bus-api.ts` (create) | decoders and calls for approvals and schedules, `buildScheduleInput` |
| `ui/screens/shell/approvals/summary.ts` (create) | safe display summary of a pending command; source names |
| `ui/screens/shell/approvals/scheduler.ts` (create) | `runSchedulesOnce` (pure) and `startBusScheduler` |
| `ui/screens/shell/approvals/inbox-store.ts` (create) | polled pending list, notification on new ids |
| `ui/screens/shell/approvals/BusInbox.tsx` (create) | status-bar button and popover: pending list, schedules, new-schedule form |
| `ui/screens/shell/StatusBar.tsx`, `Shell.tsx`, `shell.css` (modify) | mount the inbox and the scheduler |
| `ui/screens/shell/tests/bus-inbox.test.mjs` (create) | desktop node tests for all of the above |
| `docs/spec/command-bus.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | contract section 9, G7 line |

---

### Task 1: Schedule store and migration

**Files:**
- Create: `extension/kb/migrations/0063_bus_schedules.sql`
- Create: `extension/kb/bus-schedules.mjs`
- Modify: `extension/kb/db.mjs` (account-delete list, after the `// migration 0062` comment, about line 1054)
- Test: `extension/tests/bus-schedules.test.mjs` (create, with the harness later tasks reuse)

**Interfaces:**
- Produces: `createSchedule(userId, { kind, args, intervalMs, standingDays, now? }) -> Schedule`, `getSchedule(userId, id, now?) -> Schedule|null`, `listSchedules(userId, now?) -> Schedule[]`, `deleteSchedule(userId, id) -> boolean`, `SCHEDULE_LIMITS`. `Schedule = { id, kind, args, argsHash, intervalMs, standingUntil: string|null, standing: boolean, createdAt, lastRunAt: string|null }`. A store error has `code: 'QUOTA_EXCEEDED'`.

- [ ] **Step 1: Write the failing test (harness + store tests)**

Create `extension/tests/bus-schedules.test.mjs`:

```js
// Desktop scheduler records and standing approvals for the command bus (plan
// docs/superpowers/plans/2026-11-05-desktop-job-scheduler-approvals.md, spec docs/spec/command-bus.md section 9).
// No network, no engine: sources.update runs on a fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_BUS;
process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER = '1'; // tests declare the class by header (loopback, not production)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_bus-schedules-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const sched = await import('../kb/bus-schedules.mjs');
const bstore = await import('../kb/bus-store.mjs');
const { createBus, approvalNonce } = await import('../routes/bus/executor.mjs');
const { handleBusRoute } = await import('../routes/bus/bus-routes.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `bs-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(15); } };
const ACCT = 'aaaaaaaaaaaa';
const ARGS = { sourceIds: [`gcal:${ACCT}`] };

const ran = [];
const fakeSources = async ({ userId, args }) => { ran.push({ userId, args }); return { synced: 1, refused: 0, skipped: 0, results: [], text: 'Synced 1 of 1 sources.' }; };
const bus = createBus({ graceMs: 50, sweepMs: 60_000, deps: { runSourcesUpdate: fakeSources } });
bus.start();

const server = http.createServer(async (req, res) => { req.user = { id: req.headers['x-test-user'] }; await handleBusRoute(req, res, { bus }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
function call(method, p, body, { user, client = 'desktop-ui' } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { 'x-test-user': user, ...(client ? { 'x-llmide-client': client } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, body: json }); }); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const nonceOf = (u, id) => approvalNonce(u, id, db.prepare('SELECT args_hash FROM bus_commands WHERE user_id = ? AND id = ?').get(u, id).args_hash);

after(async () => {
  await bus.stop();
  await new Promise((r) => server.close(r));
  kb.closeDb();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });
});

test('store: create, list and delete are per user; standing is computed from standing_until', () => {
  const u = mkUser(); const other = mkUser();
  const now = Date.now();
  const a = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30, now });
  const b = sched.createSchedule(u, { kind: 'sources.update', args: {}, intervalMs: 3_600_000, standingDays: null, now });
  assert.equal(a.standing, true);
  assert.equal(Date.parse(a.standingUntil), now + 30 * 86_400_000);
  assert.equal(b.standing, false); assert.equal(b.standingUntil, null);
  assert.deepEqual(a.args, ARGS);
  assert.equal(a.argsHash, bstore.argsHashOf('sources.update', ARGS));
  assert.deepEqual(sched.listSchedules(u).map((s) => s.id), [a.id, b.id]);
  assert.deepEqual(sched.listSchedules(other), []);
  assert.equal(sched.getSchedule(other, a.id), null, 'another user reads nothing');
  assert.equal(sched.deleteSchedule(other, a.id), false, 'another user deletes nothing');
  assert.equal(sched.getSchedule(u, a.id, now + 31 * 86_400_000).standing, false, 'expired');
  assert.equal(sched.deleteSchedule(u, a.id), true);
  assert.equal(sched.getSchedule(u, a.id), null);
});

test('store: at most SCHEDULE_LIMITS.maxPerUser schedules; interval bounds are a CHECK', () => {
  const u = mkUser();
  for (let i = 0; i < sched.SCHEDULE_LIMITS.maxPerUser; i++) sched.createSchedule(u, { kind: 'sources.update', args: {}, intervalMs: 3_600_000, standingDays: null });
  assert.throws(() => sched.createSchedule(u, { kind: 'sources.update', args: {}, intervalMs: 3_600_000, standingDays: null }), { code: 'QUOTA_EXCEEDED' });
  const v = mkUser();
  assert.throws(() => sched.createSchedule(v, { kind: 'sources.update', args: {}, intervalMs: 60_000, standingDays: null }), /CHECK/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/bus-schedules.test.mjs`
Expected: FAIL with `Cannot find module '../kb/bus-schedules.mjs'`.

- [ ] **Step 3: Write the migration**

Create `extension/kb/migrations/0063_bus_schedules.sql`:

```sql
-- Desktop schedules for command-bus kinds (spec docs/spec/command-bus.md section 9). Additive, N-1 safe.
-- No server timer reads this table: the desktop enqueues each run itself (idem sched:<id>:<slot>) and approves it,
-- on the standing approval only while standing_until is in the future. bus_commands.schedule_id is set only for a run
-- that was approved on a standing approval; the executor re-checks that schedule before the run starts.
CREATE TABLE IF NOT EXISTS bus_schedules (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  args_json      TEXT NOT NULL DEFAULT '{}',
  args_hash      TEXT NOT NULL,
  interval_ms    INTEGER NOT NULL CHECK (interval_ms >= 3600000 AND interval_ms <= 604800000),
  standing_until TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_run_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bus_schedules_user ON bus_schedules(user_id, created_at);
ALTER TABLE bus_commands ADD COLUMN schedule_id TEXT;
```

- [ ] **Step 4: Write the store**

Create `extension/kb/bus-schedules.mjs`:

```js
// Desktop schedules for bus kinds (migration 0063, spec docs/spec/command-bus.md section 9). Data access only, per user:
// every helper takes userId first and filters on it. The policy (which kinds, which args, when a standing approval may
// approve a command) lives in routes/bus/schedules.mjs.
import crypto from 'node:crypto';
import { getDb } from './db.mjs';
import { argsHashOf } from './bus-store.mjs';

export const SCHEDULE_LIMITS = Object.freeze({ maxPerUser: 10, minIntervalMs: 3_600_000, maxIntervalMs: 604_800_000, maxStandingDays: 90 });

const jparse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const shape = (r, now) => (r ? {
  id: r.id, kind: r.kind, args: jparse(r.args_json, {}), argsHash: r.args_hash, intervalMs: r.interval_ms,
  standingUntil: r.standing_until ?? null,
  standing: typeof r.standing_until === 'string' && Date.parse(r.standing_until) > now,
  createdAt: r.created_at, lastRunAt: r.last_run_at ?? null,
} : null);

export function getSchedule(userId, id, now = Date.now()) {
  return shape(getDb().prepare('SELECT * FROM bus_schedules WHERE user_id = ? AND id = ?').get(userId, id), now);
}

export function listSchedules(userId, now = Date.now()) {
  return getDb().prepare('SELECT * FROM bus_schedules WHERE user_id = ? ORDER BY created_at, rowid').all(userId).map((r) => shape(r, now));
}

/** `standingDays` null or 0 = no standing approval (every run waits for a click). */
export function createSchedule(userId, { kind, args, intervalMs, standingDays, now = Date.now() }) {
  const db = getDb();
  return db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM bus_schedules WHERE user_id = ?').get(userId).n;
    if (count >= SCHEDULE_LIMITS.maxPerUser) throw Object.assign(new Error(`at most ${SCHEDULE_LIMITS.maxPerUser} schedules per user`), { code: 'QUOTA_EXCEEDED' });
    const id = crypto.randomUUID();
    const a = args ?? {};
    const until = standingDays ? new Date(now + standingDays * 86_400_000).toISOString() : null;
    db.prepare('INSERT INTO bus_schedules (id, user_id, kind, args_json, args_hash, interval_ms, standing_until) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, kind, JSON.stringify(a), argsHashOf(kind, a), intervalMs, until);
    return getSchedule(userId, id, now);
  })();
}

export function deleteSchedule(userId, id) {
  return getDb().prepare('DELETE FROM bus_schedules WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}
```

- [ ] **Step 5: Add the table to the account-delete list**

In `extension/kb/db.mjs`, directly below the line `// migration 0062 — host_api_identity is install-level (one row, no user_id), so it is NOT in this per-user list`, add:

```js
      // migration 0063 — desktop schedules for bus kinds (standing approvals)
      'bus_schedules',
```

- [ ] **Step 6: Run the tests**

Run: `cd extension && node --test --experimental-strip-types tests/bus-schedules.test.mjs tests/user-delete-cascade.test.mjs tests/command-bus.test.mjs`
Expected: PASS (the cascade test sees `bus_schedules` with `ON DELETE CASCADE` and in the list; the bus tests are unaffected by the new nullable column).

- [ ] **Step 7: Commit**

```bash
git add extension/kb/migrations/0063_bus_schedules.sql extension/kb/bus-schedules.mjs extension/kb/db.mjs extension/tests/bus-schedules.test.mjs
git commit -m "feat(kb): store desktop schedules for bus kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schedule policy and standing approval in the executor

**Files:**
- Create: `extension/routes/bus/schedules.mjs`
- Modify: `extension/kb/bus-store.mjs` (`shapeRow` about line 135, `approveCommand` about line 215)
- Modify: `extension/routes/bus/executor.mjs` (imports, `execute` after the `approved` check, `approve`)
- Test: `extension/tests/bus-schedules.test.mjs` (append)

**Interfaces:**
- Consumes: `getSchedule` (Task 1).
- Produces: `SCHEDULABLE_KINDS: string[]`, `STANDING_DEFAULT_DAYS = 30`, `parseScheduleBody(body) -> { ok: true, value: { kind, args, intervalMs, standingDays: number|null } } | { ok: false, message: string, details?: object }`, `standingRefusal({ schedule, cmd, argsHash, now }) -> null | 'no_schedule'|'standing_expired'|'origin'|'tier'|'scope'|'not_scheduled'|'too_soon'`. `bus.approve(userId, id, { client, nonce, confirm, scheduleId })` throws `BusError(403, 'STANDING_APPROVAL_INVALID', ..., { reason })`. Command objects from `getCommand` gain `scheduleId: string|null`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/bus-schedules.test.mjs` (add `const policy = await import('../routes/bus/schedules.mjs');` below the other top-level imports):

```js
test('policy: only listed T1 kinds; standing needs explicit sourceIds; bounds', () => {
  const ok = policy.parseScheduleBody({ kind: 'sources.update', args: ARGS, intervalHours: 6, standing: true });
  assert.deepEqual(ok, { ok: true, value: { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 } });
  assert.equal(policy.parseScheduleBody({ kind: 'sources.update', args: {}, intervalHours: 6 }).ok, true, 'ask-each-run may cover every source');
  for (const [body, why] of [
    [{ kind: 'issues.implement', args: { projectId: 'p1', issueIds: ['1'] }, intervalHours: 6 }, 'T2 never'],
    [{ kind: 'review', args: { focus: 'code', projectId: 'p1' }, intervalHours: 6 }, 'T0 not listed'],
    [{ kind: 'loop.run', args: { projectId: 'p1', loopId: 'l1' }, intervalHours: 6 }, 'unavailable T1 not listed'],
    [{ kind: 'sources.update', args: {}, intervalHours: 6, standing: true }, 'standing without sourceIds'],
    [{ kind: 'sources.update', args: { sourceIds: [] }, intervalHours: 6, standing: true }, 'standing with empty sourceIds'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 0 }, 'interval < 1'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 169 }, 'interval > 168'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 1.5 }, 'non-integer interval'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 6, standing: true, standingDays: 91 }, 'days > 90'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 6, standingDays: 5 }, 'days without standing'],
    [{ kind: 'sources.update', args: { sourceIds: ['has space'] }, intervalHours: 6 }, 'args schema'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 6, extra: 1 }, 'unknown field'],
    [null, 'not an object'],
  ]) assert.equal(policy.parseScheduleBody(body).ok, false, why);
});

test('policy: standingRefusal checks expiry, origin, tier, scope, idem and rate', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const hash = bstore.argsHashOf('sources.update', ARGS);
  const schedule = { id: 'sched-0001', kind: 'sources.update', argsHash: hash, intervalMs: 6 * 3_600_000, standing: true, standingUntil: '2026-12-01T00:00:00.000Z', lastRunAt: null };
  const cmd = { kind: 'sources.update', tier: 'T1', originClient: 'desktop-ui', idem: 'sched:sched-0001:7' };
  const r = (s, c, h = hash) => policy.standingRefusal({ schedule: s, cmd: c, argsHash: h, now });
  assert.equal(r(schedule, cmd), null);
  assert.equal(r(null, cmd), 'no_schedule');
  assert.equal(r({ ...schedule, standing: false, standingUntil: null }, cmd), 'standing_expired');
  assert.equal(r({ ...schedule, standingUntil: '2026-11-05T11:59:59.000Z' }, cmd), 'standing_expired');
  assert.equal(r(schedule, { ...cmd, originClient: 'ios-native' }), 'origin');
  assert.equal(r(schedule, { ...cmd, tier: 'T2' }), 'tier');
  assert.equal(r(schedule, cmd, 'f'.repeat(64)), 'scope');
  assert.equal(r(schedule, { ...cmd, idem: 'phone-1' }), 'not_scheduled');
  assert.equal(r(schedule, { ...cmd, idem: 'sched:sched-0002:7' }), 'not_scheduled');
  assert.equal(r({ ...schedule, lastRunAt: '2026-11-05T10:00:00.000Z' }, cmd), 'too_soon');
  assert.equal(r({ ...schedule, lastRunAt: '2026-11-05T08:00:00.000Z' }, cmd), null);
});

/** Enqueue as the desktop for `s` (slot `slot`) and return the command id. */
const enqueueFor = (u, s, slot = 1, client = 'desktop-ui', args = s.args) =>
  bus.receive(u, { v: 1, kind: s.kind, idem: `sched:${s.id}:${slot}`, args }, { client }).command.id;

test('executor: a standing approval approves the desktop run with the nonce; the run is recorded on the schedule', async () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const id = enqueueFor(u, s);
  assert.equal(bstore.getCommand(u, id).state, 'awaiting_approval', 'T1 still waits at receipt');
  bus.approve(u, id, { client: 'desktop-ui', nonce: nonceOf(u, id), scheduleId: s.id });
  await until(() => bstore.getCommand(u, id).state === 'succeeded');
  const cmd = bstore.getCommand(u, id);
  assert.equal(cmd.approvedBy, 'desktop-ui', 'approved_by is still recorded');
  assert.equal(cmd.scheduleId, s.id);
  assert.ok(sched.getSchedule(u, s.id).lastRunAt);
  assert.deepEqual(ran.at(-1), { userId: u, args: ARGS });
});

test('executor: the nonce is still required, and a standing approval never covers a phone command, other args, an expired or a too-soon run', () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const reason = (fn) => { try { fn(); } catch (e) { return e.code === 'STANDING_APPROVAL_INVALID' ? e.details.reason : e.code; } return 'approved'; };
  const a = enqueueFor(u, s, 1);
  assert.equal(reason(() => bus.approve(u, a, { client: 'desktop-ui', nonce: '0'.repeat(64), scheduleId: s.id })), 'APPROVAL_NONCE_INVALID');
  assert.equal(reason(() => bus.approve(u, a, { client: 'ios-native', nonce: nonceOf(u, a), scheduleId: s.id })), 'TIER_DENIED');
  const phone = enqueueFor(u, s, 2, 'ios-native');
  assert.equal(reason(() => bus.approve(u, phone, { client: 'desktop-ui', nonce: nonceOf(u, phone), scheduleId: s.id })), 'origin');
  const wider = enqueueFor(u, s, 3, 'desktop-ui', { sourceIds: [`gcal:${ACCT}`, 'ical:bbbbbbbbbbbb'] });
  assert.equal(reason(() => bus.approve(u, wider, { client: 'desktop-ui', nonce: nonceOf(u, wider), scheduleId: s.id })), 'scope');
  assert.equal(reason(() => bus.approve(u, a, { client: 'desktop-ui', nonce: nonceOf(u, a), scheduleId: 'no-such-schedule' })), 'no_schedule');
  assert.equal(reason(() => bus.approve(u, a, { client: 'desktop-ui', nonce: nonceOf(u, a), scheduleId: s.id })), 'approved');
  const b = enqueueFor(u, s, 4);
  assert.equal(reason(() => bus.approve(u, b, { client: 'desktop-ui', nonce: nonceOf(u, b), scheduleId: s.id })), 'too_soon');
  db.prepare('UPDATE bus_schedules SET standing_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id);
  db.prepare('UPDATE bus_schedules SET last_run_at = NULL WHERE id = ?').run(s.id);
  assert.equal(reason(() => bus.approve(u, b, { client: 'desktop-ui', nonce: nonceOf(u, b), scheduleId: s.id })), 'standing_expired');
  assert.equal(bstore.getCommand(u, b).state, 'awaiting_approval', 'a refused standing approval leaves the command for a click');
  assert.equal(reason(() => bus.approve(u, b, { client: 'desktop-ui', nonce: nonceOf(u, b) })), 'approved', 'a click still approves it');
});

test('executor: revoking (deleting) the schedule after approval stops the queued run at execution', async () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const id = enqueueFor(u, s);
  const before = ran.length;
  bus.approve(u, id, { client: 'desktop-ui', nonce: nonceOf(u, id), scheduleId: s.id });
  sched.deleteSchedule(u, s.id); // revoke before the runner's next tick, as the user would
  await until(() => ['succeeded', 'failed', 'interrupted'].includes(bstore.getCommand(u, id).state));
  const cmd = bstore.getCommand(u, id);
  assert.equal(cmd.state, 'failed'); assert.equal(cmd.error, 'switch_off');
  assert.equal(ran.length, before, 'the sync never ran');
});

test('executor: the T1 execution check from 4e9ad5e1 still holds for a standing run', async () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const id = enqueueFor(u, s);
  const before = ran.length;
  bus.approve(u, id, { client: 'desktop-ui', nonce: nonceOf(u, id), scheduleId: s.id });
  db.prepare('UPDATE bus_commands SET approved_by = NULL WHERE user_id = ? AND id = ?').run(u, id);
  await until(() => ['succeeded', 'failed', 'interrupted'].includes(bstore.getCommand(u, id).state));
  assert.equal(bstore.getCommand(u, id).error, 'tier_denied');
  assert.equal(ran.length, before);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test --experimental-strip-types tests/bus-schedules.test.mjs`
Expected: FAIL with `Cannot find module '../routes/bus/schedules.mjs'`.

- [ ] **Step 3: Write the policy module**

Create `extension/routes/bus/schedules.mjs`:

```js
// Pure policy for desktop schedules and their standing approvals (spec docs/spec/command-bus.md section 9). No I/O.
// A kind is schedulable only when it is listed here, available and T1: T2 always needs a click with its exact ids
// confirmed, and T0 has its own enable flag. Add kinds one at a time, each with an explicit-scope rule below.
import { kindInfo } from './registry.mjs';
import { validate } from './schema-validate.mjs';
import { SCHEDULE_LIMITS } from '../../kb/bus-schedules.mjs';

export const SCHEDULABLE_KINDS = Object.freeze(['sources.update']);
export const STANDING_DEFAULT_DAYS = 30;
// The arg that names a standing approval's scope. "Every source" would grow with each new connection, so a standing
// approval must list the ids it covers.
const EXPLICIT_SCOPE = Object.freeze({ 'sources.update': 'sourceIds' });
const FIELDS = new Set(['kind', 'args', 'intervalHours', 'standing', 'standingDays']);

export function parseScheduleBody(body) {
  const bad = (message, details) => ({ ok: false, message, ...(details ? { details } : {}) });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object');
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) return bad(`unknown field ${k.slice(0, 40)}`);
  const { kind, args = {}, intervalHours, standing = false, standingDays } = body;
  const info = typeof kind === 'string' && SCHEDULABLE_KINDS.includes(kind) ? kindInfo(kind) : null;
  if (!info || !info.available || info.tier !== 'T1') return bad('this kind cannot be scheduled');
  if (!args || typeof args !== 'object' || Array.isArray(args)) return bad('args must be an object');
  const problems = validate(info.args, args, {}, '.args');
  if (problems.length) return bad('args are not valid', { errors: problems.slice(0, 10) });
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) return bad('intervalHours must be an integer from 1 to 168');
  if (typeof standing !== 'boolean') return bad('standing must be a boolean');
  if (!standing) {
    if (standingDays !== undefined) return bad('standingDays needs standing: true');
    return { ok: true, value: { kind, args, intervalMs: intervalHours * 3_600_000, standingDays: null } };
  }
  const days = standingDays ?? STANDING_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > SCHEDULE_LIMITS.maxStandingDays) return bad(`standingDays must be an integer from 1 to ${SCHEDULE_LIMITS.maxStandingDays}`);
  const scope = EXPLICIT_SCOPE[kind];
  if (!Array.isArray(args[scope]) || args[scope].length === 0) return bad(`a standing approval needs the exact ${scope} it covers`);
  return { ok: true, value: { kind, args, intervalMs: intervalHours * 3_600_000, standingDays: days } };
}

/** Why `schedule`'s standing approval may NOT approve `cmd` now (a fixed reason code), or null when it may. */
export function standingRefusal({ schedule, cmd, argsHash, now = Date.now() }) {
  if (!schedule) return 'no_schedule';
  if (!schedule.standing || !schedule.standingUntil || Date.parse(schedule.standingUntil) <= now) return 'standing_expired';
  if (cmd.originClient !== 'desktop-ui') return 'origin';
  if (cmd.tier !== 'T1' || kindInfo(cmd.kind)?.tier !== 'T1') return 'tier';
  if (cmd.kind !== schedule.kind || argsHash !== schedule.argsHash) return 'scope';
  if (typeof cmd.idem !== 'string' || !cmd.idem.startsWith(`sched:${schedule.id}:`)) return 'not_scheduled';
  if (schedule.lastRunAt && now - Date.parse(schedule.lastRunAt) < schedule.intervalMs / 2) return 'too_soon';
  return null;
}
```

- [ ] **Step 4: Record the schedule on approval (store)**

In `extension/kb/bus-store.mjs`:

In `shapeRow`, change the line `approvalReason: r.approval_reason, approvedBy: r.approved_by, ttlAt: r.ttl_at, createdAt: r.created_at,` to:

```js
    approvalReason: r.approval_reason, approvedBy: r.approved_by, scheduleId: r.schedule_id ?? null, ttlAt: r.ttl_at, createdAt: r.created_at,
```

Change the `approveCommand` signature and its UPDATE:

```js
export function approveCommand(userId, id, { approvedBy, lane, jobPayload, scheduleId = null, now = Date.now() }) {
```

```js
    db.prepare("UPDATE bus_commands SET state='enqueued', approved_by=?, schedule_id=?, decided_at=? WHERE user_id=? AND id=?").run(approvedBy, scheduleId, nowIso(), userId, id);
    // Same transaction: the rate check of the next standing approval reads last_run_at.
    if (scheduleId) db.prepare('UPDATE bus_schedules SET last_run_at = ? WHERE user_id = ? AND id = ?').run(nowIso(), userId, scheduleId);
```

- [ ] **Step 5: Use it in the executor**

In `extension/routes/bus/executor.mjs`:

Add imports below `import { runSourcesUpdate } from './sources-update.mjs';`:

```js
import { getSchedule } from '../../kb/bus-schedules.mjs';
import { standingRefusal } from './schedules.mjs';
```

In `execute`, directly after `if (info.tier !== 'T0' && !approved) fail('tier_denied');` add:

```js
      // A run approved on a standing approval: the schedule must still exist and its approval must still be live, so
      // deleting the schedule (revoking) stops a run that is still queued.
      if (cmd.scheduleId) {
        const s = getSchedule(userId, cmd.scheduleId);
        if (!s || !s.standing || s.kind !== kind) fail('switch_off');
      }
```

Replace `approve`'s signature and add the standing check after the nonce check (before the `desktop_confirm` check):

```js
  function approve(userId, id, { client, nonce, confirm, scheduleId }) {
```

```js
    if (!ok) throw new BusError(403, 'APPROVAL_NONCE_INVALID', 'the approval nonce is missing or wrong; read it from the desktop approvals list');
    let viaSchedule = null;
    if (scheduleId !== undefined) {
      const schedule = typeof scheduleId === 'string' ? getSchedule(userId, scheduleId) : null;
      const reason = standingRefusal({ schedule, cmd, argsHash: hash, now: Date.now() });
      if (reason) throw new BusError(403, 'STANDING_APPROVAL_INVALID', 'no live standing approval covers this command; approve it with a click', { reason });
      viaSchedule = schedule.id;
    }
```

and pass it on: `command = approveCommand(userId, id, { approvedBy: client, lane: laneFor(info, cmd.kind, args), jobPayload: { args }, scheduleId: viaSchedule });`

- [ ] **Step 6: Run the tests**

Run: `cd extension && node --test --experimental-strip-types tests/bus-schedules.test.mjs tests/sources-update-bus.test.mjs tests/command-bus.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/routes/bus/schedules.mjs extension/routes/bus/executor.mjs extension/kb/bus-store.mjs extension/tests/bus-schedules.test.mjs
git commit -m "feat(bus): approve a scheduled desktop run on a scoped standing approval

The nonce, approved_by and the T1 execution check are unchanged; a standing run
is re-checked against its schedule before it starts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Schedule routes, approve body and audit

**Files:**
- Modify: `extension/routes/bus/bus-routes.mjs` (header comment, imports, a block before `// ---- approvals (desktop only) ----`, the `/approve` branch)
- Modify: `extension/server.mjs` (`ALL_ENDPOINTS` after `'/bus/kinds/:kind',` about line 500; `SERVER_API_VERSION` about line 323 and its comment)
- Test: `extension/tests/bus-schedules.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1 store, Task 2 `parseScheduleBody`, `bus.approve({ scheduleId })`.
- Produces (HTTP, used by Tasks 4 and 5):
  - `GET /bus/schedules` -> 200 `{ items: BusSchedule[] }`; `desktop-ui` and `ios-native` only, else 403 `TIER_DENIED`.
  - `POST /bus/schedules { kind, args, intervalHours, standing?, standingDays? }` -> 201 `{ schedule }`; 400 `INVALID_ARGS`; 403 `TIER_DENIED` (not desktop); 429 `QUOTA_EXCEEDED`.
  - `DELETE /bus/schedules/:id` -> 200 `{ deleted: true }`; 403; 404 `NOT_FOUND`.
  - `POST /bus/commands/:id/approve { nonce, confirm?, scheduleId? }` -> as before, plus 403 `STANDING_APPROVAL_INVALID { reason }`.
  - `BusSchedule = { id, kind, args, intervalHours, standing, standingUntil: string|null, createdAt, lastRunAt: string|null }`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/bus-schedules.test.mjs`:

```js
const audit = (u, action) => db.prepare('SELECT * FROM audit_log WHERE user_id = ? AND action = ? ORDER BY id').all(u, action);

test('routes: only the desktop creates and deletes; the native phone reads; lower classes get 403', async () => {
  const u = mkUser(); const other = mkUser();
  const body = { kind: 'sources.update', args: ARGS, intervalHours: 6, standing: true };
  for (const client of ['ios-native', 'extension', 'phone-pwa']) {
    const r = await call('POST', '/bus/schedules', body, { user: u, client });
    assert.equal(r.status, 403, client); assert.equal(r.body.error.code, 'TIER_DENIED');
  }
  const c = await call('POST', '/bus/schedules', body, { user: u });
  assert.equal(c.status, 201);
  const s = c.body.schedule;
  assert.deepEqual(Object.keys(s).sort(), ['args', 'createdAt', 'id', 'intervalHours', 'kind', 'lastRunAt', 'standing', 'standingUntil']);
  assert.equal(s.intervalHours, 6); assert.equal(s.standing, true);
  assert.equal((await call('GET', '/bus/schedules', undefined, { user: u, client: 'ios-native' })).body.items.length, 1);
  for (const client of ['extension', 'phone-pwa']) assert.equal((await call('GET', '/bus/schedules', undefined, { user: u, client })).status, 403);
  assert.deepEqual((await call('GET', '/bus/schedules', undefined, { user: other })).body.items, [], 'per user');
  assert.equal((await call('DELETE', `/bus/schedules/${s.id}`, undefined, { user: other })).status, 404, 'another user');
  assert.equal((await call('DELETE', `/bus/schedules/${s.id}`, undefined, { user: u, client: 'ios-native' })).status, 403);
  const d = await call('DELETE', `/bus/schedules/${s.id}`, undefined, { user: u });
  assert.equal(d.status, 200); assert.deepEqual(d.body, { deleted: true });
  assert.equal((await call('DELETE', `/bus/schedules/${s.id}`, undefined, { user: u })).status, 404);
  const created = audit(u, 'bus.schedule_create');
  assert.equal(created.length, 1);
  assert.deepEqual(JSON.parse(created[0].detail), { kind: 'sources.update', client: 'desktop-ui', intervalHours: 6, standing: true, standingUntil: s.standingUntil, sources: 1 });
  assert.equal(audit(u, 'bus.schedule_delete').length, 1);
});

test('routes: invalid schedules are 400 INVALID_ARGS; the quota is 429', async () => {
  const u = mkUser();
  const r = await call('POST', '/bus/schedules', { kind: 'sources.update', args: {}, intervalHours: 6, standing: true }, { user: u });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'INVALID_ARGS');
  assert.equal((await call('POST', '/bus/schedules', { kind: 'issues.implement', args: { projectId: 'p', issueIds: ['1'] }, intervalHours: 6 }, { user: u })).status, 400);
  for (let i = 0; i < sched.SCHEDULE_LIMITS.maxPerUser; i++) assert.equal((await call('POST', '/bus/schedules', { kind: 'sources.update', args: {}, intervalHours: 6 }, { user: u })).status, 201);
  const q = await call('POST', '/bus/schedules', { kind: 'sources.update', args: {}, intervalHours: 6 }, { user: u });
  assert.equal(q.status, 429); assert.equal(q.body.error.code, 'QUOTA_EXCEEDED');
});

test('routes: approve with scheduleId runs on the standing approval and is audited with via: standing; a refusal is audited denied', async () => {
  const u = mkUser();
  const s = (await call('POST', '/bus/schedules', { kind: 'sources.update', args: ARGS, intervalHours: 6, standing: true }, { user: u })).body.schedule;
  const enq = await call('POST', '/bus/commands', { v: 1, kind: 'sources.update', idem: `sched:${s.id}:1`, args: s.args }, { user: u });
  assert.equal(enq.status, 202); assert.equal(enq.body.command.state, 'awaiting_approval');
  const pending = (await call('GET', '/bus/approvals', undefined, { user: u })).body.items;
  const item = pending.find((p) => p.id === enq.body.command.id);
  const ok = await call('POST', `/bus/commands/${item.id}/approve`, { nonce: item.nonce, scheduleId: s.id }, { user: u });
  assert.equal(ok.status, 200);
  const rows = audit(u, 'bus.approve');
  assert.deepEqual(JSON.parse(rows.at(-1).detail), { kind: 'sources.update', tier: 'T1', client: 'desktop-ui', via: 'standing', scheduleId: s.id });
  const enq2 = await call('POST', '/bus/commands', { v: 1, kind: 'sources.update', idem: `sched:${s.id}:2`, args: s.args }, { user: u });
  const item2 = (await call('GET', '/bus/approvals', undefined, { user: u })).body.items.find((p) => p.id === enq2.body.command.id);
  const refused = await call('POST', `/bus/commands/${item2.id}/approve`, { nonce: item2.nonce, scheduleId: s.id }, { user: u });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body.error, { code: 'STANDING_APPROVAL_INVALID', message: 'no live standing approval covers this command; approve it with a click', details: { reason: 'too_soon' } });
  const last = audit(u, 'bus.approve').at(-1);
  assert.equal(last.outcome, 'denied');
  assert.equal(JSON.parse(last.detail).reason, 'STANDING_APPROVAL_INVALID');
  assert.ok(!JSON.stringify(audit(u, 'bus.approve')).includes(item.nonce), 'no nonce in the audit');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test --experimental-strip-types tests/bus-schedules.test.mjs`
Expected: FAIL (`/bus/schedules` answers 404 `no such bus route`).

- [ ] **Step 3: Implement the routes**

In `extension/routes/bus/bus-routes.mjs`:

Add to the route list in the header comment:

```js
//   GET    /bus/schedules                  desktop + native phone: the user's schedules (no secret in them)
//   POST   /bus/schedules                  desktop-class only: create (optionally with a standing approval)
//   DELETE /bus/schedules/:id              desktop-class only: delete, which also revokes its standing approval
```

Add imports:

```js
import { createSchedule, listSchedules, deleteSchedule } from '../../kb/bus-schedules.mjs';
import { parseScheduleBody } from './schedules.mjs';
```

Add below `const outcomeOf = ...`:

```js
const shapeSchedule = (s) => ({
  id: s.id, kind: s.kind, args: s.args, intervalHours: s.intervalMs / 3_600_000, standing: s.standing,
  standingUntil: s.standingUntil, createdAt: s.createdAt, lastRunAt: s.lastRunAt,
});
```

Insert directly before `// ---- approvals (desktop only) ----`:

```js
    // ---- schedules (docs/spec/command-bus.md section 9): records only; the desktop enqueues each run ----
    if (path === '/bus/schedules' && req.method === 'GET') {
      if (!readsAll(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop and the native phone can read schedules', { client }); return; }
      send(res, 200, { items: listSchedules(userId).map(shapeSchedule) });
      return;
    }
    if (path === '/bus/schedules' && req.method === 'POST') {
      if (!mayApprove(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop can create a schedule', { client }); return; }
      let body;
      try { body = await readJson(req, 8192); } catch { fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); return; }
      const parsed = parseScheduleBody(body);
      if (!parsed.ok) { fail(res, 400, 'INVALID_ARGS', parsed.message, parsed.details); return; }
      let s;
      try { s = createSchedule(userId, parsed.value); }
      catch (e) { if (e.code === 'QUOTA_EXCEEDED') { fail(res, 429, 'QUOTA_EXCEEDED', e.message); return; } throw e; }
      auditBus(req, userId, 'bus.schedule_create', s.id, 'success', {
        kind: s.kind, client, intervalHours: s.intervalMs / 3_600_000, standing: s.standing, standingUntil: s.standingUntil,
        sources: Array.isArray(s.args.sourceIds) ? s.args.sourceIds.length : 'all',
      });
      send(res, 201, { schedule: shapeSchedule(s) });
      return;
    }
    if (path === '/bus/schedules') { fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET or POST only'); return; }
    if (path.startsWith('/bus/schedules/') && req.method === 'DELETE') {
      if (!mayApprove(client)) { fail(res, 403, 'TIER_DENIED', 'only the desktop can delete a schedule', { client }); return; }
      const id = decodeURIComponent(path.slice('/bus/schedules/'.length));
      if (!ID_RE.test(id) || !deleteSchedule(userId, id)) { fail(res, 404, 'NOT_FOUND', 'schedule not found'); return; }
      auditBus(req, userId, 'bus.schedule_delete', id, 'success', { client });
      send(res, 200, { deleted: true });
      return;
    }
```

Replace the `/approve` branch's `try` block:

```js
        const before = getCommand(userId, id);
        // Only a well-formed id goes into the audit row; anything else still reaches approve and is refused there.
        const via = body.scheduleId === undefined ? {} : { via: 'standing', ...(typeof body.scheduleId === 'string' && ID_RE.test(body.scheduleId) ? { scheduleId: body.scheduleId } : {}) };
        try {
          const cmd = bus.approve(userId, id, { client, nonce: body.nonce, confirm: body.confirm, scheduleId: body.scheduleId });
          auditBus(req, userId, 'bus.approve', id, 'success', { kind: cmd.kind, tier: cmd.tier, client, ...via });
          send(res, 200, { command: shapeCommand(userId, cmd) });
        } catch (e) {
          if (e instanceof BusError) auditBus(req, userId, 'bus.approve', id, outcomeOf(e), { kind: before?.kind, client, reason: e.code, ...via });
          throw e;
        }
```

- [ ] **Step 4: Register the paths and bump the API version**

In `extension/server.mjs`, after `'/bus/kinds/:kind',` in `ALL_ENDPOINTS`:

```js
  '/bus/schedules',
  '/bus/schedules/:id',
```

Change `const SERVER_API_VERSION = 110;` to `111` and add above it, after the `v110` comment lines:

```js
//   v111 — command bus desktop schedules, additive (spec docs/spec/command-bus.md section 9, migration 0063): GET /bus/schedules → { items: BusSchedule[] } (desktop-ui and ios-native; else 403 TIER_DENIED); POST /bus/schedules { kind: 'sources.update', args, intervalHours 1-168, standing?, standingDays? 1-90 } → 201 { schedule } (desktop-ui only; 400 INVALID_ARGS, 429 QUOTA_EXCEEDED at 10); DELETE /bus/schedules/:id → { deleted: true } | 404 (desktop-ui only; revokes its standing approval). POST /bus/commands/:id/approve takes an optional scheduleId: with the nonce it approves a desktop-enqueued run on that schedule's live standing approval (same kind and args, idem sched:<id>:, T1, at most one per half interval), else 403 STANDING_APPROVAL_INVALID { reason }. No server timer.
```

- [ ] **Step 5: Run the tests**

Run: `cd extension && node --test --experimental-strip-types tests/bus-schedules.test.mjs tests/command-bus.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/routes/bus/bus-routes.mjs extension/server.mjs extension/tests/bus-schedules.test.mjs
git commit -m "feat(bus): add schedule routes and audit standing approvals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: HTTP contract, fixtures and the spec

**Files:**
- Modify: `schema/http/bus.schema.json` (`$defs.BusSchedule`, three endpoints, `scheduleId` on approve)
- Create: 13 fixtures under `schema/http/fixtures/bus/` (listed below)
- Modify: `extension/tests/http-contract-live.test.mjs:87-93` (the bus skip rule)
- Regenerate: `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md`
- Modify: `docs/spec/command-bus.md` (new section 9; section 7 error list; section 1 files)

**Interfaces:**
- Consumes: the HTTP shapes from Task 3, message texts copied exactly.

- [ ] **Step 1: Add the schema**

In `schema/http/bus.schema.json`, add to `$defs`:

```json
"BusSchedule": {
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "kind": { "type": "string" },
    "args": { "type": "object", "additionalProperties": true, "description": "The exact args every run is enqueued with; a standing approval covers these args only." },
    "intervalHours": { "type": "integer", "minimum": 1, "maximum": 168 },
    "standing": { "type": "boolean", "description": "true while the standing approval is live (standingUntil in the future); false = every run waits for a click." },
    "standingUntil": { "type": ["string", "null"] },
    "createdAt": { "type": "string" },
    "lastRunAt": { "type": ["string", "null"], "description": "When a run was last approved on the standing approval." }
  },
  "required": ["id", "kind", "args", "intervalHours", "standing", "standingUntil", "createdAt", "lastRunAt"]
}
```

Add to `endpoints`:

```json
"GET /bus/schedules": {
  "responses": {
    "200": { "type": "object", "properties": { "items": { "type": "array", "items": { "$ref": "#/$defs/BusSchedule" } } }, "required": ["items"] },
    "401": { "$ref": "_common#/$defs/Error" },
    "403": { "$ref": "_common#/$defs/Error" }
  }
},
"POST /bus/schedules": {
  "request": {
    "body": {
      "type": "object",
      "properties": {
        "kind": { "type": "string", "enum": ["sources.update"] },
        "args": { "type": "object", "additionalProperties": true, "description": "Typed by the kind's registry args. A standing approval needs explicit sourceIds." },
        "intervalHours": { "type": "integer", "minimum": 1, "maximum": 168 },
        "standing": { "type": "boolean", "x-optional": true },
        "standingDays": { "type": "integer", "minimum": 1, "maximum": 90, "x-optional": true, "description": "Default 30; only with standing: true." }
      },
      "required": ["kind", "args", "intervalHours"]
    }
  },
  "responses": {
    "201": { "type": "object", "properties": { "schedule": { "$ref": "#/$defs/BusSchedule" } }, "required": ["schedule"] },
    "400": { "$ref": "_common#/$defs/Error" },
    "401": { "$ref": "_common#/$defs/Error" },
    "403": { "$ref": "_common#/$defs/Error" },
    "429": { "$ref": "_common#/$defs/Error" }
  }
},
"DELETE /bus/schedules/:id": {
  "request": { "params": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string", "description": "The schedule id." } } } },
  "responses": {
    "200": { "type": "object", "properties": { "deleted": { "type": "boolean", "const": true } }, "required": ["deleted"] },
    "401": { "$ref": "_common#/$defs/Error" },
    "403": { "$ref": "_common#/$defs/Error" },
    "404": { "$ref": "_common#/$defs/Error" }
  }
}
```

In `POST /bus/commands/:id/approve` → `request.body.properties`, add:

```json
"scheduleId": { "type": "string", "x-optional": true, "description": "Approve on this schedule's standing approval (desktop-enqueued run, same kind and args, live, not too soon); 403 STANDING_APPROVAL_INVALID otherwise. The nonce is still required." }
```

- [ ] **Step 2: Add the fixtures**

Create each file under `schema/http/fixtures/bus/` (shared values: schedule id `5a1b2c3d-0000-4000-8000-0000000000a1`, command id `7c1d2e3f-0000-4000-8000-0000000000a2`, `sourceIds: ["gcal:aaaaaaaaaaaa"]`):

`get-bus-schedules-200-the-user-s-schedules-for-a-desktop-or-phone.json`:
```json
{
  "endpoint": "GET /bus/schedules",
  "status": 200,
  "description": "the user's schedules, for a desktop or native phone client",
  "response": {
    "items": [
      { "id": "5a1b2c3d-0000-4000-8000-0000000000a1", "kind": "sources.update", "args": { "sourceIds": ["gcal:aaaaaaaaaaaa"] }, "intervalHours": 6, "standing": true, "standingUntil": "2026-12-05T09:00:00.000Z", "createdAt": "2026-11-05T09:00:00.000Z", "lastRunAt": "2026-11-05T12:00:00.000Z" }
    ]
  }
}
```

`get-bus-schedules-401-no-access-token.json`:
```json
{ "endpoint": "GET /bus/schedules", "status": 401, "description": "no access token", "response": { "error": { "code": "AUTH_REQUIRED", "message": "Missing access token" } } }
```

`get-bus-schedules-403-the-extension-class-cannot-read-schedules.json`:
```json
{ "endpoint": "GET /bus/schedules", "status": 403, "description": "the extension class cannot read schedules", "response": { "error": { "code": "TIER_DENIED", "message": "only the desktop and the native phone can read schedules", "details": { "client": "extension" } } } }
```

`post-bus-schedules-201-the-desktop-creates-a-schedule-with-a-standing.json`:
```json
{
  "endpoint": "POST /bus/schedules",
  "status": 201,
  "description": "the desktop creates a schedule with a standing approval for exact sources",
  "request": { "body": { "kind": "sources.update", "args": { "sourceIds": ["gcal:aaaaaaaaaaaa"] }, "intervalHours": 6, "standing": true, "standingDays": 30 } },
  "response": { "schedule": { "id": "5a1b2c3d-0000-4000-8000-0000000000a1", "kind": "sources.update", "args": { "sourceIds": ["gcal:aaaaaaaaaaaa"] }, "intervalHours": 6, "standing": true, "standingUntil": "2026-12-05T09:00:00.000Z", "createdAt": "2026-11-05T09:00:00.000Z", "lastRunAt": null } }
}
```

`post-bus-schedules-400-a-standing-approval-needs-explicit-sources.json`:
```json
{ "endpoint": "POST /bus/schedules", "status": 400, "description": "a standing approval needs explicit sources", "request": { "body": { "kind": "sources.update", "args": {}, "intervalHours": 6, "standing": true } }, "response": { "error": { "code": "INVALID_ARGS", "message": "a standing approval needs the exact sourceIds it covers" } } }
```

`post-bus-schedules-401-no-access-token.json`:
```json
{ "endpoint": "POST /bus/schedules", "status": 401, "description": "no access token", "request": { "body": { "kind": "sources.update", "args": {}, "intervalHours": 6 } }, "response": { "error": { "code": "AUTH_REQUIRED", "message": "Missing access token" } } }
```

`post-bus-schedules-403-only-the-desktop-creates-a-schedule.json`:
```json
{ "endpoint": "POST /bus/schedules", "status": 403, "description": "only the desktop creates a schedule", "request": { "body": { "kind": "sources.update", "args": {}, "intervalHours": 6 } }, "response": { "error": { "code": "TIER_DENIED", "message": "only the desktop can create a schedule", "details": { "client": "extension" } } } }
```

`post-bus-schedules-429-at-most-ten-schedules-per-user.json`:
```json
{ "endpoint": "POST /bus/schedules", "status": 429, "description": "at most ten schedules per user", "request": { "body": { "kind": "sources.update", "args": {}, "intervalHours": 6 } }, "response": { "error": { "code": "QUOTA_EXCEEDED", "message": "at most 10 schedules per user" } } }
```

`delete-bus-schedules-id-200-the-desktop-deletes-and-revokes.json`:
```json
{ "endpoint": "DELETE /bus/schedules/:id", "status": 200, "description": "the desktop deletes a schedule, which revokes its standing approval", "request": { "params": { "id": "5a1b2c3d-0000-4000-8000-0000000000a1" } }, "response": { "deleted": true } }
```

`delete-bus-schedules-id-401-no-access-token.json`:
```json
{ "endpoint": "DELETE /bus/schedules/:id", "status": 401, "description": "no access token", "request": { "params": { "id": "5a1b2c3d-0000-4000-8000-0000000000a1" } }, "response": { "error": { "code": "AUTH_REQUIRED", "message": "Missing access token" } } }
```

`delete-bus-schedules-id-403-only-the-desktop-deletes-a-schedule.json`:
```json
{ "endpoint": "DELETE /bus/schedules/:id", "status": 403, "description": "only the desktop deletes a schedule", "request": { "params": { "id": "5a1b2c3d-0000-4000-8000-0000000000a1" } }, "response": { "error": { "code": "TIER_DENIED", "message": "only the desktop can delete a schedule", "details": { "client": "extension" } } } }
```

`delete-bus-schedules-id-404-no-such-schedule-for-this-user.json`:
```json
{ "endpoint": "DELETE /bus/schedules/:id", "status": 404, "description": "no such schedule for this user", "request": { "params": { "id": "5a1b2c3d-0000-4000-8000-0000000000a1" } }, "response": { "error": { "code": "NOT_FOUND", "message": "schedule not found" } } }
```

`post-bus-commands-id-approve-403-the-standing-approval-has-expired.json`:
```json
{
  "endpoint": "POST /bus/commands/:id/approve",
  "status": 403,
  "description": "the standing approval has expired: the run waits for a click",
  "request": { "params": { "id": "7c1d2e3f-0000-4000-8000-0000000000a2" }, "body": { "nonce": "5f0c1a9e7b3d4c2a8e6f1b0d9c7a5e3f2d4b6a8c0e1f3a5b7c9d1e2f4a6b8c0d", "scheduleId": "5a1b2c3d-0000-4000-8000-0000000000a1" } },
  "response": { "error": { "code": "STANDING_APPROVAL_INVALID", "message": "no live standing approval covers this command; approve it with a click", "details": { "reason": "standing_expired" } } }
}
```

- [ ] **Step 3: Update the live-replay skip rule**

In `extension/tests/http-contract-live.test.mjs`, the command-bus rule: add `DELETE` to the method list and keep the schedules' 400 out of the replay (the replay client is the `extension` class, which gets 403 before the body is read). Replace its `when` with:

```js
    when: (fx) => /^(GET|POST|PUT|DELETE) \/bus\//.test(fx.endpoint) && !(
      fx.status === 401
      || (fx.status === 400 && fx.endpoint !== 'PUT /bus/kinds/:kind' && !fx.endpoint.includes('/bus/schedules'))
      || (fx.status === 403 && fx.response?.error?.code === 'TIER_DENIED' && !/\/(approve|deny)$/.test(fx.endpoint) && fx.endpoint !== 'GET /bus/approvals')
      || (fx.status === 200 && /^GET \/bus\/(kinds|commands)$/.test(fx.endpoint))
      || (fx.status === 404 && /^(GET|POST) \/bus\/commands\/:id(\/(events|cancel))?$/.test(fx.endpoint))
    ),
```

and extend the comment above it with one line: `// Schedules: only 401 and the extension's 403 replay; the rest need the desktop class (tests/bus-schedules.test.mjs).`

- [ ] **Step 4: Regenerate and run the gates**

Run:
```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs
make contract-gates
cd extension && node --test --experimental-strip-types tests/http-contract-live.test.mjs
```
Expected: generators write files; `contract-gates` exits 0 (conformance-http shows the 13 new fixtures valid and every declared path covered); the live test PASSes with the coverage ratio still >= 60 %. If coverage reports an uncovered `details` path on an Error response, add `details` to that fixture exactly as the handler sends it.

- [ ] **Step 5: Write the spec section**

In `docs/spec/command-bus.md`:
- Section 1 table, add a row: `| `extension/kb/bus-schedules.mjs`, migration `0063_bus_schedules.sql`, `extension/routes/bus/schedules.mjs` | desktop schedules and the standing-approval policy (section 9) |`.
- Section 7, add `STANDING_APPROVAL_INVALID` to the list of HTTP codes.
- Append:

```markdown
## 9. Schedules and standing approvals (API 111)

The core never runs a timer for the bus (G7 ruling: a server timer would bypass the T1 approval). The desktop does the scheduling: every 60 s its shell reads `GET /bus/schedules` and, for each schedule, enqueues the current slot as `desktop-ui` with idem `sched:<scheduleId>:<floor(now / interval)>` and `ttlMs = min(interval, 24 h)`, so a slot runs at most once, however many windows or restarts there are, and an unanswered run expires before the next slot.

- `POST /bus/schedules` (desktop class only): `{ kind, args, intervalHours 1-168, standing?, standingDays? 1-90, default 30 }`. Schedulable kinds: `sources.update` only (`SCHEDULABLE_KINDS`, available T1 kinds only; never T2, never T0). At most 10 per user. Audited `bus.schedule_create`.
- `GET /bus/schedules` (desktop and `ios-native`): `{ items: [{ id, kind, args, intervalHours, standing, standingUntil, createdAt, lastRunAt }] }`.
- `DELETE /bus/schedules/:id` (desktop class only): removes the schedule and so revokes its standing approval. Audited `bus.schedule_delete`.
- **Without a standing approval** a scheduled run waits in the desktop inbox like a phone command, and the desktop raises the fixed `approval_needed` notification.
- **With a standing approval** the desktop still reads the nonce from `GET /bus/approvals` and calls `POST /bus/commands/:id/approve { nonce, scheduleId }`. The core accepts it only when the schedule exists, `standing_until` is in the future, the command was enqueued by `desktop-ui` with that schedule's idem prefix, the kind is T1 and the command's args hash equals the schedule's, and the previous standing run was at least half an interval ago; otherwise 403 `STANDING_APPROVAL_INVALID { reason }` (`no_schedule`, `standing_expired`, `origin`, `tier`, `scope`, `not_scheduled`, `too_soon`) and the command stays for a click. `approved_by` is written as for any approval, `bus_commands.schedule_id` and the schedule's `last_run_at` in the same transaction; the audit row is `bus.approve` with `via: 'standing'` and `scheduleId`.
- A standing approval for `sources.update` must list `sourceIds`; "every source" (no ids) is allowed only for ask-each-run schedules, because it would grow with each new connection.
- **Execution-time re-check:** the T1/T2 `approved_by` check is unchanged; a run approved on a standing approval is refused `switch_off` when its schedule was deleted or its approval expired before the run started.
- **Limit, stated plainly:** the desktop webview already holds the host proof and can approve any single T1 command. A standing approval adds no power: it records a human decision with a bounded scope, rate and lifetime, so unattended runs are explainable and revocable.
- **What the phone sees:** scheduled runs in `GET /bus/commands` (`originClient: desktop-ui`) and the schedules read-only; it cannot create, delete or approve. A command that the phone queued is never covered by a standing approval.
```

- [ ] **Step 6: Commit**

```bash
git add schema/http/bus.schema.json schema/http/fixtures/bus extension/tests/http-contract-live.test.mjs extension/src/lib/api-types.ts docs/reference/api/openapi.yaml schema/http/INVENTORY.md docs/spec/command-bus.md
git commit -m "docs(bus): contract and spec for desktop schedules and standing approvals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Desktop bus client and the safe approval summary

**Files:**
- Create: `ui/screens/shell/approvals/bus-api.ts`
- Create: `ui/screens/shell/approvals/summary.ts`
- Test: `ui/screens/shell/tests/bus-inbox.test.mjs` (create)

**Interfaces:**
- Consumes: HTTP shapes of Task 3; `RawResponse` from `../core`; `safeText` from `../safe-text`.
- Produces:
  - `type Raw = (path: string, init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }) => Promise<RawResponse>`
  - `interface PendingApproval { id; kind; tier: "T0"|"T1"|"T2"; reason: "tier"|"switch_off"; originClient; args: Record<string, unknown>; createdAt; expiresAt; nonce }`
  - `interface BusSchedule { id; kind; args; intervalHours: number; standing: boolean; standingUntil: string|null; createdAt: string; lastRunAt: string|null }`
  - `interface ScheduleInput { kind: "sources.update"; args: { sourceIds?: string[] }; intervalHours: number; standing?: boolean; standingDays?: number }`
  - `class BusCallError extends Error { status: number; code: string }`
  - `decodeApprovals(b) -> PendingApproval[]`, `decodeSchedules(b) -> BusSchedule[]`, `buildScheduleInput(form) -> { ok: true, input } | { ok: false, message }`, `rec(v)`, `type BusApi`, `interface EnqueueFrame { kind; args; idem; ttlMs }`, `busApi(raw)` with `kindsClient() -> Promise<string|null>`, `approvals()`, `approve(a, extra?)`, `deny(id)`, `schedules()`, `createSchedule(input)`, `deleteSchedule(id)`, `enqueue(frame)`, `sourceLists() -> Promise<[google, ical]>`
  - `type SourceNames = Record<string, string>`, `decodeSourceNames(google, ical) -> SourceNames`, `kindTitle(kind) -> string`, `sourceLabel(id, names) -> string`, `summarizeApproval(a, names) -> { title, lines: string[], origin, needsConfirm }`, `confirmFor(a) -> { projectId, issueIds, ship }`

- [ ] **Step 1: Write the failing test**

Create `ui/screens/shell/tests/bus-inbox.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const api = await load("approvals/bus-api.ts");
const sum = await load("approvals/summary.ts");
const NONCE = "a".repeat(64);
const item = (o = {}) => ({ id: "7c1d2e3f-0000-4000-8000-0000000000a2", kind: "sources.update", tier: "T1", reason: "tier", originClient: "ios-native", args: { sourceIds: ["gcal:aaaaaaaaaaaa", "ical:bbbbbbbbbbbb"] }, createdAt: "2026-11-05T09:00:00.000Z", expiresAt: "2026-11-06T09:00:00.000Z", nonce: NONCE, ...o });

test("decodeApprovals keeps well-formed rows only and never trusts the shape", () => {
  const out = api.decodeApprovals({ items: [item(), item({ nonce: "short" }), item({ id: "../x" }), item({ tier: "D" }), null, "x"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].nonce, NONCE);
  assert.deepEqual(api.decodeApprovals("nope"), []);
  assert.equal(api.decodeApprovals({ items: Array.from({ length: 500 }, () => item()) }).length, 50);
});

test("decodeSchedules: bounds and types", () => {
  const s = { id: "5a1b2c3d-0000-4000-8000-0000000000a1", kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, intervalHours: 6, standing: true, standingUntil: "2026-12-05T09:00:00.000Z", createdAt: "2026-11-05T09:00:00.000Z", lastRunAt: null };
  assert.deepEqual(api.decodeSchedules({ items: [s, { ...s, intervalHours: 0 }, { ...s, id: 3 }] }), [s]);
});

test("buildScheduleInput: standing needs at least one source; days bounded", () => {
  assert.deepEqual(api.buildScheduleInput({ hours: 6, sourceIds: [], standing: false, days: 30 }), { ok: true, input: { kind: "sources.update", args: {}, intervalHours: 6 } });
  assert.equal(api.buildScheduleInput({ hours: 6, sourceIds: [], standing: true, days: 30 }).ok, false);
  assert.deepEqual(api.buildScheduleInput({ hours: 12, sourceIds: ["gcal:aaaaaaaaaaaa"], standing: true, days: 30 }), { ok: true, input: { kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, intervalHours: 12, standing: true, standingDays: 30 } });
  assert.equal(api.buildScheduleInput({ hours: 6, sourceIds: ["gcal:aaaaaaaaaaaa"], standing: true, days: 91 }).ok, false);
  assert.equal(api.buildScheduleInput({ hours: 0, sourceIds: [], standing: false, days: 30 }).ok, false);
});

test("busApi: approve sends the nonce (and scheduleId when given); a non-2xx answer throws its error code", async () => {
  const calls = [];
  const raw = async (path, init) => { calls.push({ path, init }); return path.endsWith("/deny") ? { status: 409, body: { error: { code: "NOT_PENDING" } } } : { status: 200, body: { command: {} } }; };
  const b = api.busApi(raw);
  await b.approve(item(), { scheduleId: "5a1b2c3d-0000-4000-8000-0000000000a1" });
  assert.deepEqual(calls[0], { path: "/bus/commands/7c1d2e3f-0000-4000-8000-0000000000a2/approve", init: { method: "POST", body: { nonce: NONCE, scheduleId: "5a1b2c3d-0000-4000-8000-0000000000a1" } } });
  await assert.rejects(b.deny("7c1d2e3f-0000-4000-8000-0000000000a2"), (e) => e.code === "NOT_PENDING" && e.status === 409);
});

test("summarizeApproval: named sources, unknown ids flagged, origin in words, hostile text neutralised", () => {
  const names = sum.decodeSourceNames(
    { accounts: [{ accountId: "aaaaaaaaaaaa", email: "me@example.com", products: ["gcal", "gmail"] }] },
    { sources: [{ sourceId: "cccccccccccc", name: "Team‮" }] },
  );
  assert.deepEqual(names, { "gcal:aaaaaaaaaaaa": "me@example.com", "ical:cccccccccccc": "Team" });
  const s = sum.summarizeApproval(item(), names);
  assert.equal(s.title, "Sync connected sources");
  assert.equal(s.origin, "your iPhone");
  assert.deepEqual(s.lines, ["Google Calendar: me@example.com", "iCal feed bbbbbbbbbbbb (not connected now; it will be refused)"]);
  assert.equal(s.needsConfirm, false);
  assert.deepEqual(sum.summarizeApproval(item({ args: {} }), names).lines, ["Every connected Google Calendar, Google Drive and iCal source"]);
  const evil = sum.summarizeApproval(item({ kind: "x‮<img>", originClient: "relay\u0000", args: { a: "b\nc" } }), {});
  assert.ok(evil.title.startsWith("Unknown kind"));
  assert.ok(!/[‮\u0000\n]/.test(JSON.stringify(evil)));
  const t2 = item({ kind: "issues.implement", tier: "T2", args: { projectId: "p1", issueIds: ["2", "1"], ship: true } });
  assert.equal(sum.summarizeApproval(t2, {}).needsConfirm, true);
  assert.deepEqual(sum.confirmFor(t2), { projectId: "p1", issueIds: ["2", "1"], ship: true });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: FAIL (esbuild cannot resolve `approvals/bus-api.ts`).

- [ ] **Step 3: Write `bus-api.ts`**

Create `ui/screens/shell/approvals/bus-api.ts`:

```ts
// The desktop's client for the command-bus approval and schedule routes (docs/spec/command-bus.md sections 3 and 9).
// Every server answer is decoded defensively; a nonce is kept in memory only and never rendered or logged.
import type { RawResponse } from "../core";

export type Raw = (path: string, init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }) => Promise<RawResponse>;

export interface PendingApproval {
  id: string; kind: string; tier: "T0" | "T1" | "T2"; reason: "tier" | "switch_off"; originClient: string;
  args: Record<string, unknown>; createdAt: string; expiresAt: string; nonce: string;
}
export interface BusSchedule {
  id: string; kind: string; args: Record<string, unknown>; intervalHours: number; standing: boolean;
  standingUntil: string | null; createdAt: string; lastRunAt: string | null;
}
export interface ScheduleInput { kind: "sources.update"; args: { sourceIds?: string[] }; intervalHours: number; standing?: boolean; standingDays?: number }
export interface EnqueueFrame { kind: string; args: Record<string, unknown>; idem: string; ttlMs: number }

export class BusCallError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "BusCallError"; }
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE = /^[0-9a-f]{64}$/;
export const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 40) : null);

export function decodeApprovals(b: unknown): PendingApproval[] {
  if (!rec(b) || !Array.isArray(b.items)) return [];
  const out: PendingApproval[] = [];
  for (const it of b.items.slice(0, 50)) {
    if (!rec(it) || typeof it.id !== "string" || !ID.test(it.id) || typeof it.nonce !== "string" || !NONCE.test(it.nonce)) continue;
    if (it.tier !== "T0" && it.tier !== "T1" && it.tier !== "T2") continue;
    out.push({
      id: it.id, kind: str(it.kind, 64), tier: it.tier, reason: it.reason === "switch_off" ? "switch_off" : "tier",
      originClient: str(it.originClient, 32), args: rec(it.args) ? it.args : {}, createdAt: str(it.createdAt, 40),
      expiresAt: str(it.expiresAt, 40), nonce: it.nonce,
    });
  }
  return out;
}

export function decodeSchedules(b: unknown): BusSchedule[] {
  if (!rec(b) || !Array.isArray(b.items)) return [];
  const out: BusSchedule[] = [];
  for (const s of b.items.slice(0, 20)) {
    if (!rec(s) || typeof s.id !== "string" || !ID.test(s.id) || !Number.isInteger(s.intervalHours)) continue;
    const h = s.intervalHours as number;
    if (h < 1 || h > 168) continue;
    out.push({
      id: s.id, kind: str(s.kind, 64), args: rec(s.args) ? s.args : {}, intervalHours: h, standing: s.standing === true,
      standingUntil: strOrNull(s.standingUntil), createdAt: str(s.createdAt, 40), lastRunAt: strOrNull(s.lastRunAt),
    });
  }
  return out;
}

/** The new-schedule form's values -> the POST body, with the same rules the core applies. */
export function buildScheduleInput(f: { hours: number; sourceIds: string[]; standing: boolean; days: number }):
  { ok: true; input: ScheduleInput } | { ok: false; message: string } {
  if (!Number.isInteger(f.hours) || f.hours < 1 || f.hours > 168) return { ok: false, message: "Choose an interval from 1 to 168 hours." };
  const args = f.sourceIds.length ? { sourceIds: [...f.sourceIds] } : {};
  if (!f.standing) return { ok: true, input: { kind: "sources.update", args, intervalHours: f.hours } };
  if (!f.sourceIds.length) return { ok: false, message: "Pick the sources the standing approval covers." };
  if (!Number.isInteger(f.days) || f.days < 1 || f.days > 90) return { ok: false, message: "A standing approval lasts 1 to 90 days." };
  return { ok: true, input: { kind: "sources.update", args, intervalHours: f.hours, standing: true, standingDays: f.days } };
}

async function ok(p: Promise<RawResponse>): Promise<unknown> {
  const r = await p;
  if (r.status >= 200 && r.status < 300) return r.body;
  const e = rec(r.body) && rec(r.body.error) ? r.body.error : null;
  throw new BusCallError(r.status, e && typeof e.code === "string" ? e.code.slice(0, 40) : `HTTP_${r.status}`);
}
const enc = encodeURIComponent;

export function busApi(raw: Raw) {
  return {
    /** The class the core sees this UI as; only `desktop-ui` may approve or schedule. */
    kindsClient: async (): Promise<string | null> => { const b = await ok(raw("/bus/kinds")); return rec(b) && typeof b.client === "string" ? b.client : null; },
    approvals: async (): Promise<PendingApproval[]> => decodeApprovals(await ok(raw("/bus/approvals"))),
    approve: (a: PendingApproval, extra: { confirm?: Record<string, unknown>; scheduleId?: string } = {}) =>
      ok(raw(`/bus/commands/${enc(a.id)}/approve`, { method: "POST", body: { nonce: a.nonce, ...extra } })),
    deny: (id: string) => ok(raw(`/bus/commands/${enc(id)}/deny`, { method: "POST", body: {} })),
    schedules: async (): Promise<BusSchedule[]> => decodeSchedules(await ok(raw("/bus/schedules"))),
    createSchedule: (input: ScheduleInput) => ok(raw("/bus/schedules", { method: "POST", body: input })),
    deleteSchedule: (id: string) => ok(raw(`/bus/schedules/${enc(id)}`, { method: "DELETE" })),
    enqueue: (f: EnqueueFrame) => ok(raw("/bus/commands", { method: "POST", body: { v: 1, ...f } })),
    /** The raw Google and iCal lists, for `decodeSourceNames`; a failure gives empty lists (names are a nicety). */
    sourceLists: async (): Promise<[unknown, unknown]> => Promise.all([
      ok(raw("/kb/google/accounts")).catch(() => ({})), ok(raw("/kb/calendar-ical/sources")).catch(() => ({})),
    ]),
  };
}
export type BusApi = ReturnType<typeof busApi>;
```

- [ ] **Step 4: Write `summary.ts`**

Create `ui/screens/shell/approvals/summary.ts`:

```ts
// What a pending command will do, in words, from its stored args only (never a client-written summary). Every
// server-supplied string goes through safeText; unknown kinds and ids are shown as unknown, never guessed.
import { safeText } from "../safe-text";
import { rec, type PendingApproval } from "./bus-api";

export type SourceNames = Record<string, string>;

const KIND_TITLES: Readonly<Record<string, string>> = {
  "sources.update": "Sync connected sources",
  review: "Read-only review",
  "issues.from_notes": "Create issues from notes",
  "issues.implement": "Implement issues",
  "loop.run": "Run a Loop",
  "custom.run": "Run a custom task",
};
const ORIGINS: Readonly<Record<string, string>> = {
  "ios-native": "your iPhone",
  "desktop-ui": "this desktop",
  extension: "the browser extension",
  "phone-pwa": "the web app",
};
const SRC: Readonly<Record<string, string>> = { gcal: "Google Calendar", gdrive: "Google Drive", ical: "iCal feed" };
const SRC_ID = /^(gcal|gdrive|ical):([a-f0-9]{12})$/;

/** Our own title for a kind (also the notification detail): never server text. */
export const kindTitle = (kind: string): string => KIND_TITLES[kind] ?? "A job";

export function decodeSourceNames(google: unknown, ical: unknown): SourceNames {
  const out: SourceNames = {};
  const accounts = rec(google) && Array.isArray(google.accounts) ? google.accounts.slice(0, 50) : [];
  for (const a of accounts) {
    if (!rec(a) || typeof a.accountId !== "string" || !/^[a-f0-9]{12}$/.test(a.accountId)) continue;
    for (const p of Array.isArray(a.products) ? a.products : []) if (p === "gcal" || p === "gdrive") out[`${p}:${a.accountId}`] = safeText(a.email, 80);
  }
  const sources = rec(ical) && Array.isArray(ical.sources) ? ical.sources.slice(0, 50) : [];
  for (const s of sources) if (rec(s) && typeof s.sourceId === "string" && /^[a-f0-9]{12}$/.test(s.sourceId)) out[`ical:${s.sourceId}`] = safeText(s.name, 80);
  return out;
}

export function sourceLabel(id: string, names: SourceNames): string {
  const m = SRC_ID.exec(id);
  if (!m) return `${safeText(id, 60)} (not a syncable source; it will be skipped)`;
  const name = names[id];
  return name ? `${SRC[m[1]]}: ${name}` : `${SRC[m[1]]} ${m[2]} (not connected now; it will be refused)`;
}

export function summarizeApproval(a: PendingApproval, names: SourceNames): { title: string; lines: string[]; origin: string; needsConfirm: boolean } {
  const title = KIND_TITLES[a.kind] ?? `Unknown kind ${safeText(a.kind, 40)}`;
  const lines: string[] = [];
  if (a.kind === "sources.update") {
    const ids = Array.isArray(a.args.sourceIds) ? a.args.sourceIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    if (!ids.length) lines.push("Every connected Google Calendar, Google Drive and iCal source");
    for (const id of ids) lines.push(sourceLabel(id, names));
  } else {
    for (const [k, v] of Object.entries(a.args).slice(0, 10)) lines.push(`${safeText(k, 40)}: ${safeText(typeof v === "string" ? v : JSON.stringify(v), 120)}`);
  }
  return { title, lines, origin: ORIGINS[a.originClient] ?? safeText(a.originClient, 32), needsConfirm: a.tier === "T2" };
}

/** A T2 approval must repeat the exact ids it acts on: built from the stored args the user just read. */
export function confirmFor(a: PendingApproval): { projectId: unknown; issueIds: unknown; ship: boolean } {
  return { projectId: a.args.projectId ?? null, issueIds: Array.isArray(a.args.issueIds) ? a.args.issueIds : [], ship: a.args.ship === true };
}
```

- [ ] **Step 5: Run the test**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/screens/shell/approvals/bus-api.ts ui/screens/shell/approvals/summary.ts ui/screens/shell/tests/bus-inbox.test.mjs
git commit -m "feat(desktop): bus approvals client and safe job summaries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Desktop scheduler

**Files:**
- Create: `ui/screens/shell/approvals/scheduler.ts`
- Modify: `ui/screens/shell/Shell.tsx` (an effect next to the custom Auto Task scheduler effect, about line 136)
- Test: `ui/screens/shell/tests/bus-inbox.test.mjs` (append)

**Interfaces:**
- Consumes: `BusApi`, `BusSchedule`, `PendingApproval`, `BusCallError`, `rec` (Task 5).
- Produces: `slotOf(s, nowMs)`, `idemFor(s, nowMs)`, `runSchedulesOnce(deps) -> Promise<{ enqueued: string[]; approved: string[]; errors: string[] }>`, `startBusScheduler(api?, tickMs?) -> () => void`, `SCHEDULE_TICK_MS = 60_000`.

- [ ] **Step 1: Write the failing test**

Append to `ui/screens/shell/tests/bus-inbox.test.mjs`:

```js
const sch = await load("approvals/scheduler.ts");
const H = 3_600_000;
const schedule = (o = {}) => ({ id: "5a1b2c3d-0000-4000-8000-0000000000a1", kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, intervalHours: 6, standing: true, standingUntil: "2026-12-05T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", lastRunAt: null, ...o });

function fakeBus({ state = "awaiting_approval", deduped = false, origin = "desktop-ui", args } = {}) {
  const log = [];
  return {
    log,
    deps: (list, nowMs) => ({
      now: () => nowMs,
      schedules: async () => list,
      enqueue: async (f) => { log.push(["enqueue", f]); return { command: { id: `cmd-${f.idem.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60), state }, deduped }; },
      approvals: async () => { log.push(["approvals"]); return list.map((s) => ({ id: `cmd-${sch.idemFor(s, nowMs).replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60), kind: s.kind, originClient: origin, args: args ?? s.args, nonce: "a".repeat(64), tier: "T1" })); },
      approve: async (a, extra) => { log.push(["approve", a.id, extra]); },
    }),
  };
}

test("scheduler: one idem per slot; ttl is min(interval, 24 h); slots are epoch-anchored", () => {
  const s = schedule();
  const t = Date.parse("2026-11-05T13:00:00Z");
  assert.equal(sch.idemFor(s, t), `sched:${s.id}:${Math.floor(t / (6 * H))}`);
  assert.equal(sch.idemFor(s, t + H), sch.idemFor(s, t), "same slot within the interval");
  assert.notEqual(sch.idemFor(s, t + 6 * H), sch.idemFor(s, t));
  assert.ok(sch.idemFor(s, t).length <= 64, "fits the idem limit");
});

test("scheduler: a live standing approval enqueues then approves with the nonce and scheduleId", async () => {
  const f = fakeBus();
  const now = Date.parse("2026-11-05T13:00:00Z");
  const out = await sch.runSchedulesOnce(f.deps([schedule()], now));
  assert.deepEqual(out.approved, [schedule().id]);
  const enq = f.log.find((x) => x[0] === "enqueue")[1];
  assert.deepEqual(enq, { kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, idem: sch.idemFor(schedule(), now), ttlMs: 6 * H });
  assert.deepEqual(f.log.find((x) => x[0] === "approve")[2], { scheduleId: schedule().id });
});

test("scheduler: never approves without a live standing approval, a different origin or different args", async () => {
  const now = Date.parse("2026-11-05T13:00:00Z");
  for (const [f, list, why] of [
    [fakeBus(), [schedule({ standing: false, standingUntil: null })], "ask each run"],
    [fakeBus(), [schedule({ standingUntil: "2026-11-05T12:59:00.000Z" })], "expired"],
    [fakeBus({ origin: "ios-native" }), [schedule()], "a phone command"],
    [fakeBus({ args: { sourceIds: ["gcal:aaaaaaaaaaaa", "ical:bbbbbbbbbbbb"] } }), [schedule()], "wider args"],
    [fakeBus({ state: "queued" }), [schedule()], "already approved"],
  ]) {
    const out = await sch.runSchedulesOnce(f.deps(list, now));
    assert.deepEqual(out.approved, [], why);
    assert.equal(f.log.filter((x) => x[0] === "approve").length, 0, why);
  }
});

test("scheduler: one failing schedule does not stop the others; errors carry the code only", async () => {
  const now = Date.parse("2026-11-05T13:00:00Z");
  const { BusCallError } = api;
  const good = schedule({ id: "5a1b2c3d-0000-4000-8000-0000000000b2" });
  const deps = {
    ...fakeBus().deps([schedule(), good], now),
    enqueue: async (f) => { if (f.idem.includes("0000000000a1")) throw new BusCallError(429, "QUOTA_EXCEEDED"); return { command: { id: "x", state: "queued" }, deduped: false }; },
  };
  const out = await sch.runSchedulesOnce(deps);
  assert.deepEqual(out.errors, [`${schedule().id}:QUOTA_EXCEEDED`]);
  assert.deepEqual(out.enqueued, [good.id]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: FAIL (cannot resolve `approvals/scheduler.ts`).

- [ ] **Step 3: Write the scheduler**

Create `ui/screens/shell/approvals/scheduler.ts`:

```ts
// The desktop scheduler for bus schedules (docs/spec/command-bus.md section 9). The core has no timer: this tick
// enqueues each schedule's current slot as the desktop (idempotent per slot) and approves it ONLY on a live standing
// approval, with the nonce from GET /bus/approvals. Everything else waits in the inbox for a click.
// shortcut: runs only while the app runs (a hidden window too); a missed slot is not back-filled, only the current one runs.
import { core } from "../runtime";
import { BusCallError, busApi, rec, type BusApi, type BusSchedule, type EnqueueFrame, type PendingApproval } from "./bus-api";

export const SCHEDULE_TICK_MS = 60_000;
const HOUR = 3_600_000;

export const slotOf = (s: BusSchedule, nowMs: number): number => Math.floor(nowMs / (s.intervalHours * HOUR));
export const idemFor = (s: BusSchedule, nowMs: number): string => `sched:${s.id}:${slotOf(s, nowMs)}`;
const sameArgs = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface SchedulerDeps {
  now(): number;
  schedules(): Promise<BusSchedule[]>;
  enqueue(f: EnqueueFrame): Promise<unknown>;
  approvals(): Promise<PendingApproval[]>;
  approve(a: PendingApproval, extra: { scheduleId: string }): Promise<unknown>;
}

export async function runSchedulesOnce(d: SchedulerDeps): Promise<{ enqueued: string[]; approved: string[]; errors: string[] }> {
  const out = { enqueued: [] as string[], approved: [] as string[], errors: [] as string[] };
  const now = d.now();
  let pending: PendingApproval[] | null = null;
  for (const s of await d.schedules()) {
    try {
      const res = await d.enqueue({ kind: s.kind, args: s.args, idem: idemFor(s, now), ttlMs: Math.min(s.intervalHours * HOUR, 24 * HOUR) });
      const cmd = rec(res) && rec(res.command) ? res.command : null;
      if (!cmd || typeof cmd.id !== "string") continue;
      if (!(rec(res) && res.deduped === true)) out.enqueued.push(s.id);
      const live = s.standing && s.standingUntil !== null && Date.parse(s.standingUntil) > now;
      if (cmd.state !== "awaiting_approval" || !live) continue;
      pending ??= await d.approvals();
      const item = pending.find((p) => p.id === cmd.id);
      // The core checks all of this again; checking here keeps a mismatch from ever being sent.
      if (!item || item.kind !== s.kind || item.originClient !== "desktop-ui" || !sameArgs(item.args, s.args)) continue;
      await d.approve(item, { scheduleId: s.id });
      out.approved.push(s.id);
    } catch (e) {
      out.errors.push(`${s.id}:${e instanceof BusCallError ? e.code : "error"}`);
    }
  }
  return out;
}

const defaultApi = (): BusApi => busApi((path, init) => core.requestRaw(path, init ?? {}));

/** Start the tick; returns a stop function. Idle unless the core sees this UI as `desktop-ui` (a spawned, proven core). */
export function startBusScheduler(api: BusApi = defaultApi(), tickMs = SCHEDULE_TICK_MS): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if ((await api.kindsClient()) !== "desktop-ui") return;
      await runSchedulesOnce({ now: Date.now, schedules: api.schedules, enqueue: api.enqueue, approvals: api.approvals, approve: api.approve });
    } catch {
      // the next tick retries; a slot's idem makes a retry safe
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), tickMs);
  void tick();
  return () => { stopped = true; window.clearInterval(timer); };
}
```

- [ ] **Step 4: Mount it in the shell**

In `ui/screens/shell/Shell.tsx`, directly after the custom Auto Task scheduler `useEffect` (the one ending `}, [projectRoot, session.signedIn, gate, features.usable]);`), add:

```tsx
  // The command-bus scheduler (docs/spec/command-bus.md section 9): not tied to a project or a feature, idle on a core
  // that does not see this UI as the desktop class.
  useEffect(() => {
    if (!session.signedIn || gate !== "open") return undefined;
    let live = true;
    let stop: (() => void) | undefined;
    void import("./approvals/scheduler").then((m) => {
      if (live) stop = m.startBusScheduler();
    });
    return () => { live = false; stop?.(); };
  }, [session.signedIn, gate]);
```

- [ ] **Step 5: Run the tests and the type check**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs ../ui/screens/shell/tests/state.test.mjs && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/screens/shell/approvals/scheduler.ts ui/screens/shell/Shell.tsx ui/screens/shell/tests/bus-inbox.test.mjs
git commit -m "feat(desktop): run bus schedules from the shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Inbox store and notification

**Files:**
- Create: `ui/screens/shell/approvals/inbox-store.ts`
- Test: `ui/screens/shell/tests/bus-inbox.test.mjs` (append)

**Interfaces:**
- Consumes: `PendingApproval`, `BusCallError` (Task 5), `kindTitle` (Task 5).
- Produces: `createInboxStore({ approvals, notify }) -> { refresh(): Promise<void>; getSnapshot(): { items: PendingApproval[]; error: string | null }; subscribe(l): () => void; start(ms?): void; stop(): void }`; `inboxStore` (the app singleton, wired to `core` and the host `notify` command).

- [ ] **Step 1: Write the failing test**

Append to `ui/screens/shell/tests/bus-inbox.test.mjs`:

```js
const inbox = await load("approvals/inbox-store.ts");

test("inbox: notifies once per new pending id with our own kind title; a 403 is a quiet error", async () => {
  let list = [item()];
  const notes = [];
  const s = inbox.createInboxStore({ approvals: async () => list, notify: (d) => { notes.push(d); } });
  await s.refresh(); await s.refresh();
  assert.deepEqual(notes, ["Sync connected sources"], "once per id");
  list = [item(), item({ id: "7c1d2e3f-0000-4000-8000-0000000000b9", kind: "evil‮" }), item({ id: "7c1d2e3f-0000-4000-8000-0000000000c9" })];
  await s.refresh();
  assert.deepEqual(notes, ["Sync connected sources", "2 jobs"]);
  assert.equal(s.getSnapshot().items.length, 3);
  const denied = inbox.createInboxStore({ approvals: async () => { throw new api.BusCallError(403, "TIER_DENIED"); }, notify: () => assert.fail("no notification") });
  await denied.refresh();
  assert.deepEqual(denied.getSnapshot(), { items: [], error: "TIER_DENIED" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: FAIL (cannot resolve `approvals/inbox-store.ts`).

- [ ] **Step 3: Write the store**

Create `ui/screens/shell/approvals/inbox-store.ts`:

```ts
// The pending bus approvals, polled while the status-bar inbox is mounted. A NEW pending id raises the host's fixed
// `approval_needed` notification with our own kind title (never server text); the host sanitises and rate-limits it.
import { core } from "../runtime";
import { invokeHost, isHostAvailable } from "../host";
import { BusCallError, busApi, type PendingApproval } from "./bus-api";
import { kindTitle } from "./summary";

export interface InboxDeps { approvals(): Promise<PendingApproval[]>; notify(detail: string): void | Promise<void> }
export interface InboxSnapshot { items: PendingApproval[]; error: string | null }

export function createInboxStore(d: InboxDeps) {
  let snap: InboxSnapshot = { items: [], error: null };
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* a broken listener must not stop the others */ } } };
  async function refresh(): Promise<void> {
    try {
      const items = await d.approvals();
      const fresh = items.filter((a) => !seen.has(a.id));
      for (const a of fresh) seen.add(a.id);
      if (seen.size > 500) for (const id of [...seen].slice(0, seen.size - 500)) seen.delete(id);
      snap = { items, error: null };
      if (fresh.length) {
        try { await d.notify(fresh.length === 1 ? kindTitle(fresh[0].kind) : `${fresh.length} jobs`); } catch { /* notifications are best effort */ }
      }
    } catch (e) {
      snap = { items: [], error: e instanceof BusCallError ? e.code : "UNAVAILABLE" };
    }
    emit();
  }
  return {
    refresh,
    getSnapshot: (): InboxSnapshot => snap,
    subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
    start(ms = 15_000): void { if (timer === null) { void refresh(); timer = setInterval(() => void refresh(), ms); } },
    stop(): void { if (timer !== null) { clearInterval(timer); timer = null; } },
  };
}

/** The app's inbox: approvals from the core, notifications through the host (none in a plain browser). */
export const inboxStore = createInboxStore({
  approvals: () => busApi((path, init) => core.requestRaw(path, init ?? {})).approvals(),
  notify: async (detail) => { if (isHostAvailable()) await invokeHost("notify", { kind: "approval_needed", detail }); },
});
```

- [ ] **Step 4: Run the test**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/shell/approvals/inbox-store.ts ui/screens/shell/tests/bus-inbox.test.mjs
git commit -m "feat(desktop): poll pending bus approvals and notify on new ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Inbox UI in the status bar

**Files:**
- Create: `ui/screens/shell/approvals/BusInbox.tsx`
- Modify: `ui/screens/shell/StatusBar.tsx` (import; `<BusInbox />` just before `<ActivityBell />`, about line 215)
- Modify: `ui/screens/shell/shell.css` (append a few rules next to `.sh-activity`, about line 105)
- Test: `ui/screens/shell/tests/bus-inbox.test.mjs` (append)

**Interfaces:**
- Consumes: Tasks 5 to 7.
- Produces: `PendingList`, `ScheduleList`, `ScheduleForm` (pure presentational, tested), `BusInbox` (status-bar button + popover).

- [ ] **Step 1: Write the failing test**

Append to `ui/screens/shell/tests/bus-inbox.test.mjs`, and change its first helpers import line to `import { load, React, renderToStaticMarkup } from "./helpers.mjs";`:

```js
const ui = await load("approvals/BusInbox.tsx");
const h = React.createElement;
const names = { "gcal:aaaaaaaaaaaa": "me@example.com" };

test("PendingList: what it will do, who asked, Approve and Deny; T2 needs the confirm box; no nonce in the markup", () => {
  const html = renderToStaticMarkup(h(ui.PendingList, { items: [item()], names, busy: null, onApprove() {}, onDeny() {} }));
  assert.match(html, /Sync connected sources/);
  assert.match(html, /your iPhone/);
  assert.match(html, /Google Calendar: me@example\.com/);
  assert.match(html, />Approve</); assert.match(html, />Deny</);
  assert.ok(!html.includes(NONCE), "the nonce is never rendered");
  const t2 = renderToStaticMarkup(h(ui.PendingList, { items: [item({ kind: "issues.implement", tier: "T2", args: { projectId: "p1", issueIds: ["1"] } })], names: {}, busy: null, onApprove() {}, onDeny() {} }));
  assert.match(t2, /I checked the project and issue ids above/);
  assert.equal(renderToStaticMarkup(h(ui.PendingList, { items: [], names, busy: null, onApprove() {}, onDeny() {} })).includes("Nothing is waiting"), true);
});

test("ScheduleList and ScheduleForm state the scope and the approval mode in words", () => {
  const nowMs = Date.parse("2026-11-05T13:00:00Z");
  const list = renderToStaticMarkup(h(ui.ScheduleList, { items: [schedule(), schedule({ id: "5a1b2c3d-0000-4000-8000-0000000000b2", standing: false, standingUntil: null, args: {} })], names, nowMs, busy: null, onDelete() {} }));
  assert.match(list, /every 6 hours/);
  assert.match(list, /Runs without asking until/);
  assert.match(list, /Asks you on each run/);
  assert.match(list, /Every connected Google Calendar/);
  assert.match(list, /Delete \(revokes\)/);
  const form = renderToStaticMarkup(h(ui.ScheduleForm, { names, onCreate: async () => {} }));
  assert.match(form, /Run without asking for/);
  assert.match(form, /only the sources ticked above/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/bus-inbox.test.mjs`
Expected: FAIL (cannot resolve `approvals/BusInbox.tsx`).

- [ ] **Step 3: Write the component**

Create `ui/screens/shell/approvals/BusInbox.tsx`:

```tsx
// Status-bar inbox for command-bus jobs (docs/spec/command-bus.md sections 3 and 9): what waits for the desktop's
// approval, and the scheduled jobs. Shown only while the core sees this UI as the desktop class. All text is rendered as
// text; the nonce stays in memory and is sent only with Approve.
import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { core } from "../runtime";
import { useCoreSession } from "../use-shell";
import { busApi, buildScheduleInput, type BusSchedule, type PendingApproval, type ScheduleInput } from "./bus-api";
import { confirmFor, decodeSourceNames, sourceLabel, summarizeApproval, type SourceNames } from "./summary";
import { inboxStore } from "./inbox-store";

const api = busApi((path, init) => core.requestRaw(path, init ?? {}));
const HOURS = [1, 3, 6, 12, 24] as const;

export function PendingList({ items, names, busy, onApprove, onDeny }: {
  items: PendingApproval[]; names: SourceNames; busy: string | null;
  onApprove: (a: PendingApproval, confirmed: boolean) => void; onDeny: (a: PendingApproval) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  if (!items.length) return <p className="sh-activity-empty">Nothing is waiting for your approval</p>;
  return (
    <ul className="sh-inbox-list" aria-label="Waiting for your approval">
      {items.map((a) => {
        const s = summarizeApproval(a, names);
        const ok = !s.needsConfirm || checked[a.id] === true;
        return (
          <li key={a.id} className="sh-inbox-row">
            <strong>{s.title}</strong>
            <span className="sh-activity-kind">Asked by {s.origin} · {a.tier}</span>
            <ul className="sh-inbox-lines">{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            {s.needsConfirm && (
              <label className="sh-inbox-confirm">
                <input type="checkbox" checked={checked[a.id] === true} onChange={(e) => setChecked({ ...checked, [a.id]: e.target.checked })} />
                I checked the project and issue ids above
              </label>
            )}
            <div className="sh-inbox-actions">
              <button type="button" disabled={busy !== null || !ok} onClick={() => onApprove(a, ok)}>Approve</button>
              <button type="button" disabled={busy !== null} onClick={() => onDeny(a)}>Deny</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ScheduleList({ items, names, nowMs, busy, onDelete }: {
  items: BusSchedule[]; names: SourceNames; nowMs: number; busy: string | null; onDelete: (s: BusSchedule) => void;
}) {
  if (!items.length) return <p className="sh-activity-empty">No scheduled jobs</p>;
  return (
    <ul className="sh-inbox-list" aria-label="Scheduled jobs">
      {items.map((s) => {
        const ids = Array.isArray(s.args.sourceIds) ? s.args.sourceIds.filter((x): x is string => typeof x === "string") : [];
        const live = s.standing && s.standingUntil !== null && Date.parse(s.standingUntil) > nowMs;
        return (
          <li key={s.id} className="sh-inbox-row">
            <strong>Sync sources every {s.intervalHours} {s.intervalHours === 1 ? "hour" : "hours"}</strong>
            <span className="sh-activity-kind">
              {live ? `Runs without asking until ${new Date(s.standingUntil as string).toLocaleDateString()}` : "Asks you on each run"}
              {s.lastRunAt ? ` · last approved run ${new Date(s.lastRunAt).toLocaleString()}` : ""}
            </span>
            <ul className="sh-inbox-lines">
              {ids.length ? ids.map((id) => <li key={id}>{sourceLabel(id, names)}</li>) : <li>Every connected Google Calendar, Google Drive and iCal source</li>}
            </ul>
            <div className="sh-inbox-actions">
              <button type="button" disabled={busy !== null} onClick={() => onDelete(s)}>Delete (revokes)</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ScheduleForm({ names, onCreate }: { names: SourceNames; onCreate: (input: ScheduleInput) => Promise<void> }) {
  const [hours, setHours] = useState(6);
  const [picked, setPicked] = useState<string[]>([]);
  const [standing, setStanding] = useState(false);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const ids = Object.keys(names).sort();
  const submit = async () => {
    const r = buildScheduleInput({ hours, sourceIds: picked, standing, days });
    if (!r.ok) { setError(r.message); return; }
    setError(null);
    await onCreate(r.input);
  };
  return (
    <form className="sh-inbox-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="New scheduled sync">
      <label>Every{" "}
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {HOURS.map((n) => <option key={n} value={n}>{n} {n === 1 ? "hour" : "hours"}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Sources (none ticked = every connected source)</legend>
        {ids.map((id) => (
          <label key={id}>
            <input type="checkbox" checked={picked.includes(id)} onChange={(e) => setPicked(e.target.checked ? [...picked, id] : picked.filter((x) => x !== id))} />
            {sourceLabel(id, names)}
          </label>
        ))}
      </fieldset>
      <label className="sh-inbox-confirm">
        <input type="checkbox" checked={standing} onChange={(e) => setStanding(e.target.checked)} />
        Run without asking for{" "}
        <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days" /> days: only the sources ticked above, at most once per interval. Deleting the schedule revokes it.
      </label>
      {error && <p className="sh-warning" role="alert">{error}</p>}
      <button type="submit">Create schedule</button>
    </form>
  );
}

export const BusInbox = memo(function BusInbox() {
  const { signedIn } = useCoreSession();
  const snap = useSyncExternalStore(inboxStore.subscribe, inboxStore.getSnapshot);
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<SourceNames>({});
  const [schedules, setSchedules] = useState<BusSchedule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!signedIn) return undefined;
    inboxStore.start();
    return () => inboxStore.stop();
  }, [signedIn]);

  const reload = useCallback(async () => {
    await inboxStore.refresh();
    const [g, i] = await api.sourceLists();
    setNames(decodeSourceNames(g, i));
    setSchedules(await api.schedules().catch(() => []));
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, reload]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Hidden unless the core treats this UI as the desktop class (a 403 TIER_DENIED otherwise).
  if (!signedIn || snap.error === "TIER_DENIED") return null;
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "failed"); } finally { setBusy(null); void reload(); }
  };
  const count = snap.items.length;
  return (
    <div className="sh-menu-root" ref={root}>
      <button type="button" className="sh-statusbar-item sh-bell" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
        aria-label={count ? `Approvals, ${count} waiting` : "Approvals and scheduled jobs"} title="Approvals and scheduled jobs" onClick={() => setOpen((v) => !v)}>
        Jobs{count ? <span className="sh-bell-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span> : null}
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label="Approvals and scheduled jobs" tabIndex={-1} className="sh-menu sh-menu-up sh-menu-end sh-activity sh-inbox"
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
          <div className="sh-activity-scroll">
            {error && <p className="sh-activity-note sh-warning" role="status">That did not work ({error}). The list was reloaded.</p>}
            <h3 className="sh-activity-day">Waiting for you</h3>
            <PendingList items={snap.items} names={names} busy={busy}
              onApprove={(a, confirmed) => void act(a.id, () => api.approve(a, a.tier === "T2" && confirmed ? { confirm: confirmFor(a) } : {}))}
              onDeny={(a) => void act(a.id, () => api.deny(a.id))} />
            <h3 className="sh-activity-day">Scheduled jobs</h3>
            <ScheduleList items={schedules} names={names} nowMs={Date.now()} busy={busy} onDelete={(s) => void act(s.id, () => api.deleteSchedule(s.id))} />
            <ScheduleForm names={names} onCreate={(input) => act("new", () => api.createSchedule(input))} />
          </div>
        </div>
      )}
    </div>
  );
});
```

- [ ] **Step 4: Mount it and style it**

In `ui/screens/shell/StatusBar.tsx`: add `import { BusInbox } from "./approvals/BusInbox";` next to the `ActivityBell` import, and put `<BusInbox />` on the line before `<ActivityBell />`.

Append to `ui/screens/shell/shell.css` after the `.sh-activity-*` rules:

```css
.sh-inbox { width: 400px; }
.sh-inbox-list { list-style: none; margin: 0; padding: 0 12px; }
.sh-inbox-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-bottom: 1px solid var(--tok-color-border); }
.sh-inbox-lines { margin: 2px 0 0; padding-left: 16px; font-size: 12px; }
.sh-inbox-actions { display: flex; gap: 8px; margin-top: 4px; }
.sh-inbox-confirm { font-size: 12px; }
.sh-inbox-form { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 12px; font-size: 12px; }
```

- [ ] **Step 5: Run the desktop gates**

Run: `cd desktop && npm test && npx tsc --noEmit && npm run -s check:security`
Expected: all PASS (the existing status-bar tests still render; `check:security` finds no new capability, since `notify` is already allowed).

- [ ] **Step 6: Commit**

```bash
git add ui/screens/shell/approvals/BusInbox.tsx ui/screens/shell/StatusBar.tsx ui/screens/shell/shell.css ui/screens/shell/tests/bus-inbox.test.mjs
git commit -m "feat(desktop): approval inbox and scheduled jobs in the status bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full regression and the master plan line

**Files:**
- Modify: `docs/superpowers/MASTER-PLAN.md:238` (the "Google G7 automation hook" line)

- [ ] **Step 1: Update the G7 line**

Replace `open: a desktop scheduler and approval UI so scheduled syncs run (me)` at the end of that line with:

`desktop scheduler and approval inbox built (plan plans/2026-11-05-desktop-job-scheduler-approvals.md, API 111, migration 0063): schedules are records in the core and the desktop enqueues each slot; a run is approved by a click, or by a per-schedule standing approval (desktop only, exact sources, T1 only, 30-day default expiry, revoked by deleting, audited); open: the phone's path to the Tauri core's bus (Host API v1 has no bus command yet) and a real-account run (you)`

- [ ] **Step 2: Run every affected gate**

Run:
```bash
cd extension && npm test
cd .. && make contract-gates
cd desktop && npm test && npx tsc --noEmit
```
Expected: all PASS. If `npm test` in `extension/` shows a failure outside the bus files, check `git stash; npm test` on the base commit before touching it (see memory "Main pre-existing failing tests": `main` is expected green).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/MASTER-PLAN.md
git commit -m "docs: mark the G7 desktop scheduler and approval inbox built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Decisions for the user (secure defaults are what this plan builds)

1. **How scheduled runs are approved.** Default: a new schedule asks on each run (a notification and a click in the inbox). A standing approval is an explicit opt-in per schedule.
2. **Lifetime of a standing approval.** Default 30 days, at most 90, no automatic renewal.
3. **Scope of a standing approval.** Default: exact `sourceIds` only. "Every connected source" is offered only for ask-each-run schedules.
4. **Who may revoke.** Default: the desktop only; the phone sees schedules read-only. The alternative is to let `ios-native` delete a schedule, which only ever revokes and never grants.
5. **Interval bounds.** Default: 1 to 168 hours. The form offers 1, 3, 6, 12 and 24.
6. **Notification on a new pending job.** Default on, with the fixed template and our own kind title only.
7. **Slot anchor and first run.** Default: slots are anchored to the UTC epoch (every 6 hours = 00, 06, 12, 18 UTC) and the current slot runs as soon as the schedule is created.
8. **Missed slots while the app is closed.** Default: they are not back-filled; only the current slot runs at the next tick.

## Manual check list (for the user)

1. Start the desktop app (`cd desktop && npm run tauri dev`) on a core it spawned. The status bar shows **Jobs**. On an adopted core (one you started yourself) **Jobs** is hidden.
2. Connect one Google Calendar or iCal feed in the Library. Open **Jobs**, then **Create schedule**: every 1 hour, tick that source, leave "Run without asking" off. Within a minute a notification "Approval needed: Sync connected sources" appears, and the row shows "Asked by this desktop" with the source by name.
3. Click **Approve**. The Library calendar updates. Click **Deny** on the next run instead: nothing syncs.
4. Delete that schedule. Create one with "Run without asking for 30 days" and the same source. Within a minute it syncs without a notification, and the row shows "Runs without asking until <date>" and a last-run time.
5. Untick every source and tick "Run without asking": the form refuses ("Pick the sources the standing approval covers").
6. From the iPhone (through the Mac host, where the phone path exists), queue a Source update. It waits in **Jobs** as "Asked by your iPhone" even while the standing schedule exists, and it runs only after your click.
7. Delete the standing schedule: no further runs. In the core's `audit_log` (`sqlite3 <data.db> "select action, outcome, detail from audit_log where action like 'bus.%' order by id desc limit 10"`) you see `bus.schedule_create`, `bus.approve` with `"via":"standing"`, and `bus.schedule_delete`, with no nonce or token in them.
8. Close the window to the tray, wait past one interval and reopen: the scheduled run happened while the window was hidden (if it did not, report it: the webview timers may be throttled while hidden).

## Self-review notes

- Coverage: inbox (Tasks 5, 7, 8), Approve/Deny with the nonce (Task 5 `approve`, Task 8), safe summary of kind, sources and origin (Task 5), scheduler per kind with a configurable interval (Tasks 1 to 3, 6), approval model with scope, expiry, revocation and audit (Tasks 2 and 3), T2 never standing and always a confirmed click (Task 2 `parseScheduleBody` and `standingRefusal`, Task 8 confirm box), `4e9ad5e1` untouched and re-tested (Task 2), what the phone sees (security section, spec section 9), manual check list (above). No Rust change: the `notify` command and its `approval_needed` template already exist (`desktop/src-tauri/src/tray.rs`).
- Names used across tasks: `parseScheduleBody`, `standingRefusal`, `getSchedule`, `createSchedule`, `listSchedules`, `deleteSchedule`, `busApi().sourceLists`, `runSchedulesOnce`, `idemFor`, `createInboxStore`, `inboxStore`, `PendingList`, `ScheduleList`, `ScheduleForm`, `BusInbox`.
