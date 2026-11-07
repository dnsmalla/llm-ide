# Team Hub H1.2 — Every Route Within Its Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every HTTP route, Host API command and background job runs only within the caller's team role, run mode (`max_mode`) and monthly USD cap; anything not declared is refused. Owners, admins and engineers (role `member`) can do all the work; everyone else (`viewer`) can only Ask.

**Architecture:** One class table (`CLASS_GRANTS` in `extension/kb/members.mjs`) says what each kind of action needs. One route table (`ROUTE_POLICY` in `extension/server/route-authority.mjs`) gives every method + path exactly one class, and the server refuses an authenticated request that matches no rule (deny by default). The Host API gateway, the command-bus executor, the meeting agent and the outcome poller check the same classes at the moment they act, so a demotion takes effect on the next frame or tick. `/auth/me` reports the caller's permitted classes so the desktop can hide what it would refuse.

**Tech Stack:** Node 20 core (pure `node:http`, better-sqlite3, `node:test`), React desktop UI (`ui/screens`), JSON-schema HTTP contract (`schema/http`).

**Spec:** [ADR 0021 Team Hub](../../decisions/0021-team-hub.md) (roles `owner > admin > member > viewer`, grants `max_mode` + `usd_cap_month`, "enforced in one place"); the gap it closes is [R-014 Worst #1](../../../agent-coord/reviews/R-014-system-review.md) (git-ignored; summary: roles were enforced only in chat and the Host API). The route-by-route evidence is [route-inventory-2026-11-08.md](parity-inventory/route-inventory-2026-11-08.md) (329 rows, effect class per route).

**Builds on:** commit `9c2a3e76` (on `main`): `extension/server/route-authority.mjs` with a 25-rule `ROUTE_AUTHORITY` table applied by `server.mjs` to the listed routes only. This plan keeps its exported names (`routeAuthorityFor`, `authorizeRoute`, `enforceRouteAuthority`) and replaces the short table with the full one.

## Global Constraints

- Roles are read from the `members` row on every check (`getMember`), never from the JWT claim or `users.role` (ADR 0021).
- No `members` row = refused for every class except `public` (fail closed).
- A refusal writes exactly one audit row: `action: 'team.deny'`, `outcome: 'denied'`, `detail: { reason }` — never a path, body, prompt or model name.
- Refusal wire shape: `403 { error: { code: 'ROLE_DENIED', message } }`, or `429 { error: { code: 'USD_CAP', message } }` for the cap.
- An authenticated request that matches no rule answers `404 { error: { code: 'NOT_FOUND', message: 'Not found' } }` and logs `route_policy_unlisted` at error level with `{ method, path }` (no query string).
- A disabled feature's routes keep answering `404 feature_disabled`; the policy check is skipped for them (as `9c2a3e76` does).
- Layering (ESLint allow-table, zero violations): pure role logic lives in `kb/members.mjs` (L1); the audited check lives in `server/route-authority.mjs` (L2); routes and agents import them, never the reverse.
- The desktop's own user is the install owner, so a solo install keeps working unchanged; every existing gate test must stay green.
- Work on `main`, Conventional Commits, one concern per commit, never `--no-verify`.

## User decision (2026-11-08)

"Admin and engineers need all, but others only ask." Mapped onto the ADR 0021 roles:

- **owner, admin, member (= engineer):** every work class — model with tools, files, connectors, pushes, installing plugins / MCP servers / extensions / the skills kit. The `member` role id stays; UI copy may call it "Engineer".
- **viewer (everyone else):** only Ask — a chat turn forced to the read-only `ask` mode (no edit or command tools), within the USD cap, plus their own data. No one-shot model routes, files, connectors or installs.
- **admin and owner only:** team and install management — members, invites, deleting users, backups, metrics.
- `max_mode` still narrows a member: `read_only` keeps tools off, `none` refuses every model action.

## Decisions (recommended defaults — the user may change them before Task 2)

| # | Decision | Default in this plan | To change |
|---|---|---|---|
| D1 | What may a `viewer` do with the model? | **Ask only** (user decision): chat turns forced to `ask` mode, `/kb/agent/ask`, answering the agent's own questions; within the USD cap. | Change the `model.ask` routes or `CLASS_GRANTS['model.ask']`. |
| D2 | What does an undeclared route answer? | **404 NOT_FOUND** + an error log. A missing rule looks like a missing route to the caller; the log and the coverage test tell the developer. | Change `enforceRouteAuthority`'s unlisted branch. |
| D3 | Who may enable code that runs on the host (plugins, MCP servers, hook trust, workspace trust, extension installs, the skills kit, SDK update)? | **Engineers too** (user decision): `install` = member + execute. Only team management (`/admin/*`, `/metrics`) stays admin. | Raise `CLASS_GRANTS.install.role`. |
| D4 | Host-proof routes (`/kb/sync/*`, `/kb/self-heal/*`, `/host-api/*`, `/bus` approvals, `/kb/issues/*`) | Class `host` = any member row; the **host proof** in each module stays the gate. | Raise `CLASS_GRANTS.host.role`. |
| D5 | Background work that is not per-user AI or shell (sync scheduler, auth GC, backups, agent-store jobs) | Not gated: it moves only the user's own data or is system maintenance. | Add a check in that job. |

## Classes

| class | min role | min `max_mode` | USD cap checked | used for |
|---|---|---|---|---|
| `public` | — | — | — | pre-auth paths (health, login, register, OAuth callbacks) |
| `self.read` | viewer | none | no | reading the caller's own data |
| `self.write` | viewer | none | no | writing the caller's own data (notes, chats, settings, sessions) |
| `model.ask` | viewer | read_only | yes | Ask: a chat turn forced to the read-only `ask` mode; `/kb/agent/ask`; answering the agent's questions |
| `model.read` | member | read_only | yes | any other model call with no file-editing or command tools (one-shot notes, summaries, plans, classify) |
| `model.exec` | member | execute | yes | an agent that edits files or runs commands |
| `fs.read` | member | read_only | no | reading host files outside the DB (repos, project dirs, plugin dirs) |
| `fs.write` | member | execute | no | writing host files, or adding a path an agent may edit |
| `external.read` | member | read_only | no | fetching from a third-party service with the user's credentials |
| `external.write` | member | execute | no | pushing to a third-party service (GitHub/Linear/Backlog/Slack) |
| `install` | member | execute | no | enabling code that runs on the host (engineers — user decision) |
| `admin` | admin | none | no | team and install management: members, invites, deleting users, backups, metrics |
| `host` | viewer | none | no | desktop-only routes; the host proof is the real gate (D4) |

## File Structure

- Modify `extension/server/users.mjs` — `registerUser` writes the `members` row in its own transaction (one place for the default grant).
- Modify `extension/server/auth-routes.mjs` — registration passes the invite's grant into `registerUser`; `GET /auth/me` adds `member.permissions`.
- Create `extension/tests/helpers/grant.mjs` — test-only upsert of a member's grant.
- Modify `extension/kb/members.mjs` — `CLASS_GRANTS`, `classRefusal`, `permittedClasses` (pure).
- Rewrite `extension/server/route-authority.mjs` — `authorizeAction`, `ROUTE_POLICY` (every route), deny by default.
- Modify `extension/server.mjs` — pass the request logger to `enforceRouteAuthority`; API 124 + changelog.
- Modify `extension/routes/host-api/gateway.mjs` — `COMMAND_CLASS`, a per-frame check.
- Modify `extension/routes/bus/executor.mjs`, `extension/agents/meeting-agent.mjs`, `extension/agents/outcome-watcher.mjs` — check at the moment of acting.
- Modify `schema/http/health-auth.schema.json` + the `/auth/me` fixture; regenerate api-types / openapi / INVENTORY.
- Create `ui/screens/shell/permissions.ts`; modify `ui/screens/chat/ChatScreen.tsx` — hide what the server would refuse.
- Create `extension/tests/route-policy-coverage.test.mjs`, `extension/tests/route-policy-e2e.test.mjs`, `extension/tests/register-grant.test.mjs`.
- Docs: `docs/decisions/0021-team-hub.md`, `docs/explanation/invariants.md`, `extension/CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md`.

---

### Task 1: Registration owns the member row

Today `POST /auth/register` writes the `members` row after `registerUser`, so every other caller of `registerUser` (about 195 test files, and any future code path) creates an account with no authority row. Deny by default (Task 3) would refuse all of them. Make `registerUser` write the row in the same transaction.

**Files:**
- Modify: `extension/server/users.mjs:72-100`
- Modify: `extension/server/auth-routes.mjs:121-160` (the registration transaction)
- Create: `extension/tests/helpers/grant.mjs`
- Create: `extension/tests/register-grant.test.mjs`
- Modify: the 7 test files that call `ensureMember` after `registerUser`: `agent-busy`, `agent-v2-routes`, `invites-registration`, `host-approval-bypass`, `loop-agent`, `members`, `route-authority` (all `extension/tests/*.test.mjs`)

**Interfaces:**
- Produces: `registerUser(db, { email, password, displayName, invite = null, grant = null })` — `grant` is `{ teamRole, maxMode, usdCapMonth, grantedBy? }` or null for the default. Every account it creates has a `members` row.
- Produces: `grant(db, userId, { teamRole = 'member', maxMode = 'execute', usdCapMonth = 0 })` in `extension/tests/helpers/grant.mjs` (tests only).

- [ ] **Step 1: Write the failing test** — `extension/tests/register-grant.test.mjs`

```js
// Plan H1.2 Task 1: registerUser writes the members row itself, so no code path creates an account
// without team authority (ADR 0021: no row = refused).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_register-grant-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { getMember } = await import('../kb/members.mjs');

after(() => {
  try { closeDb(); } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

const reg = (email, extra = {}) => registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 'x', ...extra });

test('the first account is the owner with execute and no cap', () => {
  const u = reg('first@example.com');
  assert.deepEqual(getMember(getDb(), u.id), { userId: u.id, teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0, grantedBy: null });
});

test('a later account without an invite gets the solo default: member, execute, no cap', () => {
  const u = reg('second@example.com');
  const m = getMember(getDb(), u.id);
  assert.equal(m.teamRole, 'member');
  assert.equal(m.maxMode, 'execute');
  assert.equal(m.usdCapMonth, 0);
});

test('an explicit grant is written as given', () => {
  const owner = getDb().prepare("SELECT user_id FROM members WHERE team_role = 'owner'").get().user_id;
  const u = reg('third@example.com', { grant: { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 20, grantedBy: owner } });
  const m = getMember(getDb(), u.id);
  assert.equal(m.teamRole, 'viewer');
  assert.equal(m.maxMode, 'read_only');
  assert.equal(m.usdCapMonth, 20);
});

test('a failed registration leaves no members row behind', () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM members').get().n;
  assert.throws(() => reg('second@example.com'), /already registered/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM members').get().n, before);
});
```

Before writing the assertion on line `assert.deepEqual(getMember(...))`, open `extension/kb/members.mjs` `getMember` and match its exact return shape (field names and whether `grantedBy` is present); keep the test's intent (owner / execute / 0).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/register-grant.test.mjs`
Expected: FAIL — `getMember` returns `null` for the first account.

- [ ] **Step 3: Implement** — `extension/server/users.mjs`

Add the import at the top with the other imports:

```js
import { ensureMember, ownerCount } from '../kb/members.mjs';
```

Add above `registerUser`:

```js
/**
 * The grant a registration without an invite gets (ADR 0021): the first real account owns the install;
 * later ones get the solo defaults, or the hub defaults (read_only, 20 USD/month) when LLMIDE_HUB=1.
 */
function defaultGrant(db) {
  if (ownerCount(db) === 0) return { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 };
  return config.hub
    ? { teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20 }
    : { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 };
}
```

Change the signature and the transaction body:

```js
export function registerUser(db, { email, password, displayName, invite = null, grant = null }) {
```

```js
    db.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, e, name, hash, role);
    // ADR 0021 / plan H1.2: every account gets its authority row in the same transaction, so no code
    // path can create an account the route policy would have to guess about.
    ensureMember(db, id, grant ?? defaultGrant(db));
    return role;
```

- [ ] **Step 4: Move the route onto it** — `extension/server/auth-routes.mjs`, inside the registration transaction. Replace from `if (inviteToken) peekInvite(...)` to the final `return { user, invite: null };` with:

```js
        // Cheap refusal first: a garbage token must not cost a bcrypt hash (R-008#1). The peek reads the
        // invite's grant; the burn below is still in this transaction, so the two commit or roll back together.
        const peeked = inviteToken ? peekInvite(db, inviteToken, { email: body.email }) : null;
        const user = registerUser(db, {
          email: body.email,
          password: body.password,
          displayName: body.displayName,
          invite: inviteToken,     // lets a closed installation accept this one registration
          // No invite: registerUser applies the default (first account = owner; solo or hub defaults).
          grant: peeked
            ? { teamRole: peeked.teamRole, maxMode: peeked.maxMode, usdCapMonth: peeked.usdCapMonth, grantedBy: peeked.createdBy }
            : null,
        });
        if (inviteToken) {
          // Burn it (single use); a concurrent registration that won the token rolls this one back.
          const grants = consumeInvite(db, inviteToken, { email: body.email, userId: user.id });
          return { user, invite: grants.id };
        }
        return { user, invite: null };
```

Remove `ensureMember` and `ownerCount` from this file's `kb/members.mjs` import if nothing else in the file uses them (`grep -n "ensureMember\|ownerCount" extension/server/auth-routes.mjs`).

- [ ] **Step 5: Add the test helper** — `extension/tests/helpers/grant.mjs`

```js
// Test-only: set a member's grant directly. registerUser already wrote the default row (plan H1.2
// Task 1), so ensureMember (insert-or-ignore) would be a no-op; this upserts.
export function grant(db, userId, { teamRole = 'member', maxMode = 'execute', usdCapMonth = 0 } = {}) {
  db.prepare(`
    INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      team_role = excluded.team_role, max_mode = excluded.max_mode, usd_cap_month = excluded.usd_cap_month
  `).run(String(userId), teamRole, maxMode, Number(usdCapMonth));
}
```

- [ ] **Step 6: Update the 7 test files.** In each, a call `ensureMember(db, <id>, { ... })` made on an account that `registerUser` just created is now a no-op. Replace it with `grant(db, <id>, { ... })` and add `import { grant } from './helpers/grant.mjs';`. Exception: in `members.test.mjs`, a test that checks `ensureMember`'s own insert-or-ignore behaviour must create its account with a raw `INSERT INTO users (id, email, display_name, password_hash, role) VALUES (...)` instead, so the row does not exist yet. List each change in the task report.

- [ ] **Step 7: Run the affected suites**

Run: `cd extension && node --test tests/register-grant.test.mjs tests/members.test.mjs tests/route-authority.test.mjs tests/loop-agent.test.mjs tests/agent-busy.test.mjs tests/agent-v2-routes.test.mjs tests/host-approval-bypass.test.mjs tests/invites-registration.test.mjs tests/auth-routes.test.mjs tests/team-routes.test.mjs tests/team-yaml-boot.test.mjs`
Expected: PASS (the spawned-server suites need local port binding; run unsandboxed).

Then: `make test` — expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add extension/server/users.mjs extension/server/auth-routes.mjs extension/tests/helpers/grant.mjs extension/tests/register-grant.test.mjs extension/tests/*.test.mjs
git commit -m "refactor(auth): registerUser writes the account's members row"
```

---

### Task 2: Action classes and one audited check

**Files:**
- Modify: `extension/kb/members.mjs` (append)
- Modify: `extension/server/route-authority.mjs` (add `authorizeAction`; the table is replaced in Task 3)
- Create: `extension/tests/action-classes.test.mjs`

**Interfaces:**
- Produces (`kb/members.mjs`): `CLASS_GRANTS` (frozen map class → `{ role, mode, cap }` or `null` for `public`); `classRefusal(member, cls, usedUsd = null) → null | 'role_denied' | 'max_mode_none' | 'max_mode_insufficient' | 'usd_cap' | 'unknown_class'` (`usedUsd` is a function returning this month's USD spend, or null to skip the cap); `permittedClasses(member) → string[]` (classes allowed ignoring the cap, in `CLASS_GRANTS` order).
- Produces (`server/route-authority.mjs`): `authorizeAction(db, userId, cls, { req = null } = {}) → { ok: true, member } | { ok: false, reason, status, code, message }` — audits a refusal; sets `req.member` when allowed.

- [ ] **Step 1: Write the failing test** — `extension/tests/action-classes.test.mjs`

```js
// Plan H1.2 Task 2: the class table is the one statement of what each kind of action needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const { CLASS_GRANTS, classRefusal, permittedClasses } = await import('../kb/members.mjs');

const m = (teamRole, maxMode, usdCapMonth = 0) => ({ teamRole, maxMode, usdCapMonth });

// [class, member, expected refusal]
const MATRIX = [
  ['public', null, null],
  ['self.read', null, 'role_denied'],
  ['self.read', m('viewer', 'none'), null],
  ['self.write', m('viewer', 'none'), null],
  ['model.ask', m('viewer', 'read_only'), null],
  ['model.ask', m('viewer', 'none'), 'max_mode_none'],
  ['model.read', m('viewer', 'execute'), 'role_denied'],
  ['model.read', m('member', 'none'), 'max_mode_none'],
  ['model.read', m('member', 'read_only'), null],
  ['model.exec', m('member', 'read_only'), 'max_mode_insufficient'],
  ['model.exec', m('member', 'execute'), null],
  ['fs.read', m('viewer', 'execute'), 'role_denied'],
  ['fs.read', m('member', 'read_only'), null],
  ['fs.write', m('member', 'read_only'), 'max_mode_insufficient'],
  ['external.read', m('member', 'read_only'), null],
  ['external.write', m('member', 'execute'), null],
  ['install', m('viewer', 'execute'), 'role_denied'],
  ['install', m('member', 'execute'), null],
  ['install', m('member', 'read_only'), 'max_mode_insufficient'],
  ['install', m('admin', 'execute'), null],
  ['admin', m('member', 'execute'), 'role_denied'],
  ['admin', m('admin', 'none'), null],
  ['host', m('viewer', 'none'), null],
  ['no.such.class', m('owner', 'execute'), 'unknown_class'],
];

test('every class answers the matrix', () => {
  for (const [cls, member, want] of MATRIX) {
    assert.equal(classRefusal(member, cls), want, `${cls} for ${JSON.stringify(member)}`);
  }
});

test('the cap applies only to capped classes, only when a cap is set, and only when spend is known', () => {
  const capped = m('member', 'execute', 20);
  assert.equal(classRefusal(capped, 'model.read', () => 20), 'usd_cap');
  assert.equal(classRefusal(capped, 'model.read', () => 19.99), null);
  assert.equal(classRefusal(capped, 'model.read'), null, 'no spend function: the caller skips the cap');
  assert.equal(classRefusal(capped, 'fs.write', () => 999), null, 'fs.write is not a spending class');
  assert.equal(classRefusal(m('member', 'execute', 0), 'model.exec', () => 1e9), null, '0 = no cap');
});

test('every class except public has a role and a mode; public is null', () => {
  for (const [cls, g] of Object.entries(CLASS_GRANTS)) {
    if (cls === 'public') { assert.equal(g, null); continue; }
    assert.ok(['viewer', 'member', 'admin', 'owner'].includes(g.role), cls);
    assert.ok(['none', 'read_only', 'execute'].includes(g.mode), cls);
    assert.equal(typeof g.cap, 'boolean', cls);
  }
});

test('permittedClasses lists what the member may do, in table order', () => {
  assert.deepEqual(permittedClasses(m('viewer', 'read_only')), ['self.read', 'self.write', 'model.ask', 'host']);
  assert.deepEqual(permittedClasses(null), []);
  assert.ok(permittedClasses(m('owner', 'execute')).includes('install'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/action-classes.test.mjs`
Expected: FAIL — `CLASS_GRANTS` is not exported.

- [ ] **Step 3: Implement** — append to `extension/kb/members.mjs`

```js
// ── Action classes (plan H1.2): what each kind of action needs ──────────────────────────────────
// One table. A route, a Host API command or a background job names its class; nothing else
// decides who may do what. `null` = public (no account needed).
export const CLASS_GRANTS = Object.freeze({
  public: null,
  'self.read': Object.freeze({ role: 'viewer', mode: 'none', cap: false }),
  'self.write': Object.freeze({ role: 'viewer', mode: 'none', cap: false }),
  // A viewer may only Ask (user decision 2026-11-08): the chat turn is forced to `ask` mode.
  'model.ask': Object.freeze({ role: 'viewer', mode: 'read_only', cap: true }),
  'model.read': Object.freeze({ role: 'member', mode: 'read_only', cap: true }),
  'model.exec': Object.freeze({ role: 'member', mode: 'execute', cap: true }),
  'fs.read': Object.freeze({ role: 'member', mode: 'read_only', cap: false }),
  'fs.write': Object.freeze({ role: 'member', mode: 'execute', cap: false }),
  'external.read': Object.freeze({ role: 'member', mode: 'read_only', cap: false }),
  'external.write': Object.freeze({ role: 'member', mode: 'execute', cap: false }),
  // Engineers install too (user decision 2026-11-08); only team management stays admin.
  install: Object.freeze({ role: 'member', mode: 'execute', cap: false }),
  admin: Object.freeze({ role: 'admin', mode: 'none', cap: false }),
  host: Object.freeze({ role: 'viewer', mode: 'none', cap: false }),
});

const MODE_RANK = Object.freeze({ none: 0, read_only: 1, execute: 2 });

/**
 * Why `member` may not perform an action of class `cls`, or null when it may. Pure. `usedUsd` is a
 * function returning the member's USD spend this month (called only for a capped class with a
 * non-zero cap); pass null to leave the cap to the caller.
 */
export function classRefusal(member, cls, usedUsd = null) {
  if (!Object.prototype.hasOwnProperty.call(CLASS_GRANTS, cls)) return 'unknown_class';
  const need = CLASS_GRANTS[cls];
  if (need === null) return null;
  if (!member || !atLeast(member.teamRole, need.role)) return 'role_denied';
  if ((MODE_RANK[member.maxMode] ?? 0) < MODE_RANK[need.mode]) {
    return member.maxMode === 'none' ? 'max_mode_none' : 'max_mode_insufficient';
  }
  if (need.cap && typeof usedUsd === 'function') {
    const cap = Number(member.usdCapMonth);
    if (cap > 0 && usedUsd() >= cap) return 'usd_cap';
  }
  return null;
}

/** The classes `member` may use (cap ignored), in table order. For `/auth/me`. */
export function permittedClasses(member) {
  return Object.keys(CLASS_GRANTS).filter((cls) => CLASS_GRANTS[cls] !== null && classRefusal(member, cls) === null);
}
```

- [ ] **Step 4: Add the audited form** — `extension/server/route-authority.mjs`. Add to the imports:

```js
import { getMember, classRefusal, CLASS_GRANTS } from '../kb/members.mjs';
```

Add below the imports:

```js
const REFUSALS = Object.freeze({
  role_denied: { status: 403, code: 'ROLE_DENIED', message: (need) => `Requires team role ${need?.role ?? 'member'}` },
  max_mode_none: { status: 403, code: 'ROLE_DENIED', message: () => 'Your team grant cannot run this' },
  max_mode_insufficient: { status: 403, code: 'ROLE_DENIED', message: (need) => `Requires the ${need?.mode} run mode` },
  usd_cap: { status: 429, code: 'USD_CAP', message: () => 'Monthly USD cap reached' },
  unknown_class: { status: 403, code: 'ROLE_DENIED', message: () => 'This action is not permitted' },
});

function refuse(db, userId, reason, cls) {
  try {
    // The reason only: never the request body, a path, a prompt or a model.
    recordAudit(db, { userId, action: 'team.deny', outcome: 'denied', detail: { reason } });
  } catch { /* an audit failure must not turn a refusal into a 500 */ }
  const r = REFUSALS[reason];
  return { ok: false, reason, status: r.status, code: r.code, message: r.message(CLASS_GRANTS[cls]) };
}

/**
 * The one audited check (plan H1.2). Reads the caller's members row now, so a grant change applies on
 * the next request or tick. Used by the route policy, the Host API gateway and the background jobs.
 */
export function authorizeAction(db, userId, cls, { req = null } = {}) {
  if (!userId) return refuse(db, null, 'role_denied', cls);
  const member = getMember(db, userId);
  const reason = classRefusal(member, cls, () => usedUsdMonth(db, userId));
  if (reason) return refuse(db, userId, reason, cls);
  if (req) req.member = member;
  return { ok: true, member };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd extension && node --test tests/action-classes.test.mjs tests/route-authority.test.mjs tests/members.test.mjs && npx eslint kb/members.mjs server/route-authority.mjs`
Expected: PASS, eslint clean.

- [ ] **Step 6: Commit**

```bash
git add extension/kb/members.mjs extension/server/route-authority.mjs extension/tests/action-classes.test.mjs
git commit -m "feat(team): action classes and one audited authority check"
```

---

### Task 3: Every route declares its class; undeclared routes are refused

**Files:**
- Rewrite: `extension/server/route-authority.mjs` (the table and the route functions; keep Task 2's `REFUSALS`, `refuse`, `authorizeAction`)
- Modify: `extension/server.mjs` (the two `enforceRouteAuthority` calls, ~lines 831 and 881)
- Modify: `extension/tests/route-authority.test.mjs` (the table test at line ~102)
- Modify: `extension/routes/extension-routes.mjs` (its inline `requireRole(db, req, 'admin')` checks become the `install` class — engineers install too)
- Modify: `extension/tests/auth-routes.test.mjs` (the three "must refuse a member" loops at ~840, ~1304, ~1405)
- Create: `extension/tests/route-policy-coverage.test.mjs`

**Interfaces:**
- Consumes: `CLASS_GRANTS`, `authorizeAction` (Task 2).
- Produces: `ROUTE_POLICY` (frozen array of `{ cls, method, path, re, literal, role, maxMode, cap }`); `routeAuthorityFor(method, url) → rule | null` (a literal path wins over a `:param` path); `authorizeRoute(db, req, { rule, userId }) → { ok, rule, member } | refusal`; `enforceRouteAuthority(db, req, res, { logger } = {}) → boolean` (true = answered).

- [ ] **Step 1: Write the coverage test** — `extension/tests/route-policy-coverage.test.mjs`

```js
// Plan H1.2 Task 3: every route the server serves has exactly one class per method, and the table
// names no route that does not exist. The rosters are parsed from source (the server is never booted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET ||= 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY ||= 'b'.repeat(48);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadRosters } = await import('../../scripts/lib/roster.mjs');
const { ROUTE_POLICY, routeAuthorityFor } = await import('../server/route-authority.mjs');
const { CLASS_GRANTS } = await import('../kb/members.mjs');

const rosters = loadRosters((rel) => fs.readFileSync(path.join(REPO, rel), 'utf8'));
const rosterPaths = [...new Set([...rosters.endpoints, ...rosters.publicAuth].map((e) => e.path.split('?')[0]))];

// Served, but advertised by neither roster: admin-only operations and a diagnostics read.
const NON_ROSTER = new Map([
  ['/metrics', 'admin-only Prometheus text, deliberately not advertised by /health'],
  ['/admin/backup', 'admin-only, not advertised'],
  ['/admin/users/:userId', 'admin-only delete, not advertised (R-010#2)'],
  ['/kb/agent/diagnose', 'meeting-agent diagnostics read, not advertised'],
]);

test('every roster path has at least one policy rule', () => {
  const missing = rosterPaths.filter((p) => !ROUTE_POLICY.some((r) => r.path === p || r.re.test(p)));
  assert.deepEqual(missing, [], 'add these to ROUTE_POLICY with the class from the route inventory');
});

test('every rule names a known class and a served path', () => {
  for (const r of ROUTE_POLICY) assert.ok(r.cls in CLASS_GRANTS, `${r.method} ${r.path}: unknown class ${r.cls}`);
  const dead = ROUTE_POLICY.filter((r) => !NON_ROSTER.has(r.path) && !rosterPaths.some((p) => p === r.path || r.re.test(p)));
  assert.deepEqual(dead.map((r) => `${r.method} ${r.path}`), []);
});

test('a method + path has exactly one rule', () => {
  const seen = new Map();
  for (const r of ROUTE_POLICY) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate rule ${key}`);
    seen.set(key, r.cls);
  }
});

test('a literal path wins over a parameter path; the query string is ignored', () => {
  assert.equal(routeAuthorityFor('POST', '/kb/loop/agent-run?x=1').cls, 'model.exec');
  assert.equal(routeAuthorityFor('GET', '/kb/no-such-route'), null);
  assert.equal(routeAuthorityFor('GET', '/kb/loop/agent-run'), null, 'only the declared method');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/route-policy-coverage.test.mjs`
Expected: FAIL — `ROUTE_POLICY` is not exported.

- [ ] **Step 3: Replace the table and route functions** — in `extension/server/route-authority.mjs`, delete `exact`, `prefix`, `any`, `docsWrite`, `ROUTE_AUTHORITY`, `routeAuthorityFor`, `routeAuthorityById`, `deny`, `authorizeRoute` and `enforceRouteAuthority`, and replace the file header comment's first paragraph with:

```js
// Team authority for every HTTP route (ADR 0021, plan H1.2). Every method + path the core serves has
// exactly one action class (kb/members.mjs CLASS_GRANTS); an authenticated request that matches no
// rule is refused (deny by default). tests/route-policy-coverage.test.mjs fails when a served route has
// no rule or a rule names no route. The evidence for each class is
// docs/superpowers/plans/parity-inventory/route-inventory-2026-11-08.md.
```

Then add:

```js
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(routePath) {
  return new RegExp(`^${routePath.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRe(seg))).join('/')}$`);
}
function rules(cls, method, paths) {
  const need = CLASS_GRANTS[cls];
  return paths.map((p) => Object.freeze({
    cls, method, path: p, re: compile(p), literal: !p.includes('/:'),
    role: need?.role ?? null, maxMode: need?.mode ?? null, cap: need?.cap ?? false,
  }));
}

/** Every route the core serves, by class. Generated from the 2026-11-08 route inventory. */
export const ROUTE_POLICY = Object.freeze([
  ...rules('public', 'GET', [
    '/',
    '/auth/google/callback',
    '/auth/mcp-connector/callback',
    '/auth/slack/callback',
    '/auth/well-known',
    '/health',
    '/kb/sync/box/callback',
    '/launch-app',
  ]),
  ...rules('public', 'POST', [
    '/auth/login',
    '/auth/refresh',
    '/auth/register',
    '/auth/reset-confirm',
    '/auth/reset-request',
  ]),
  ...rules('self.read', 'GET', [
    '/agent/v2/session/route',
    '/agent/v2/session/route/history',
    '/agent/v2/turns',
    '/agent/v2/turns/stream',
    '/auth/google/status',
    '/auth/mcp-connector/status',
    '/auth/me',
    '/auth/me/audit',
    '/auth/me/connectors',
    '/auth/me/connectors/catalog',
    '/auth/me/extensions/active',
    '/auth/me/extensions/allowlist',
    '/auth/me/extensions/catalog',
    '/auth/me/extensions/installed',
    '/auth/me/extensions/updates',
    '/auth/me/llm-sources',
    '/auth/me/mcp-plugins',
    '/auth/me/mcp-plugins/catalog',
    '/auth/me/plugins',
    '/auth/me/prefs',
    '/auth/me/repos',
    '/auth/me/secrets',
    '/auth/me/workspace-trust',
    '/auth/slack/status',
    '/bus/commands',
    '/bus/commands/:id',
    '/bus/commands/:id/events',
    '/bus/kinds',
    '/bus/schedules',
    '/kb/activity',
    '/kb/agent-history/settings',
    '/kb/agent-sdk',
    '/kb/agent/ask/history',
    '/kb/agent/catalog',
    '/kb/agent/commands',
    '/kb/agent/diagnose',
    '/kb/agent/feedback/by-task',
    '/kb/agent/feedback/stats',
    '/kb/agent/generation-library',
    '/kb/agent/persona',
    '/kb/agent/personas',
    '/kb/agent/runs',
    '/kb/agent/session-memory',
    '/kb/agent/skill-library',
    '/kb/agent/tool-approvals',
    '/kb/agent/working-state',
    '/kb/calendar-ical/sources',
    '/kb/chat/sessions',
    '/kb/chat/sessions/:id',
    '/kb/entity/:id',
    '/kb/export-all',
    '/kb/google/accounts',
    '/kb/google/status',
    '/kb/index/search',
    '/kb/index/status',
    '/kb/issue-schedule',
    '/kb/issues',
    '/kb/live/:id',
    '/kb/live/:id/capture',
    '/kb/live/:id/status',
    '/kb/live/:id/stream',
    '/kb/live/sessions',
    '/kb/live/unacked',
    '/kb/meeting/:id',
    '/kb/os/state',
    '/kb/os/stream',
    '/kb/outcomes/stats',
    '/kb/outcomes/task/:id',
    '/kb/plan/:id',
    '/kb/plans',
    '/kb/project/:id/export',
    '/kb/providers/catalog',
    '/kb/providers/custom',
    '/kb/providers/settings',
    '/kb/review/get/:id',
    '/kb/review/list',
    '/kb/routing-tiers',
    '/kb/search',
    '/kb/stats',
    '/kb/storage',
    '/kb/system/status',
    '/kb/usage/limits',
    '/kb/usage/ratelimits',
    '/kb/usage/resolve',
    '/kb/usage/summary',
    '/kb/usage/turn-composition',
  ]),
  ...rules('self.read', 'POST', [
    '/chat',
    '/code-assist',
    '/code-assist/decision',
  ]),
  ...rules('self.write', 'POST', [
    '/agent/v2/cancel',
    '/agent/v2/sessions/purge',
    '/auth/google/start',
    '/auth/logout',
    '/auth/me/connectors/add',
    '/auth/me/delete',
    '/auth/me/llm-sources/items',
    '/auth/me/llm-sources/toggle',
    '/auth/me/password',
    '/auth/me/secrets',
    '/auth/slack/start',
    '/bus/commands/:id/cancel',
    '/kb/activity',
    '/kb/activity/seen',
    '/kb/agent-history/clear',
    '/kb/agent-history/compact',
    '/kb/agent/feedback',
    '/kb/agent/personas',
    '/kb/agent/stop',
    '/kb/archive-receipts',
    '/kb/calendar-ical/options',
    '/kb/calendar-ical/sources',
    '/kb/chat/sessions',
    '/kb/chat/sessions/:id/archive/begin',
    '/kb/chat/sessions/:id/archive/commit',
    '/kb/chat/sessions/:id/messages',
    '/kb/connect-qa',
    '/kb/connect-tickets-json',
    '/kb/custom-providers',
    '/kb/delete',
    '/kb/email/seen',
    '/kb/google/disconnect',
    '/kb/google/gmail/seen',
    '/kb/google/options',
    '/kb/google/start',
    '/kb/index/notes',
    '/kb/index/reconcile',
    '/kb/ingest',
    '/kb/ingest-code-graph',
    '/kb/live/:id/ack',
    '/kb/live/:id/append',
    '/kb/live/:id/finalize',
    '/kb/mcp-connector/seen',
    '/kb/plan-task/update',
    '/kb/plan/delete',
    '/kb/plan/save',
    '/kb/providers/catalog/connect',
    '/kb/providers/catalog/disconnect',
    '/kb/review/delete',
    '/kb/review/reject',
    '/kb/review/submit',
    '/kb/routing-tiers',
    '/kb/session-purges',
    '/kb/slack/seen',
    '/kb/usage/record',
  ]),
  ...rules('self.write', 'PUT', [
    '/agent/v2/session/route',
    '/auth/me/prefs',
    '/kb/agent-history/settings',
    '/kb/agent/persona',
    '/kb/agent/personas/:id',
    '/kb/agent/personas/active',
    '/kb/issue-schedule',
    '/kb/providers/settings',
    '/kb/usage/limits',
  ]),
  ...rules('self.write', 'PATCH', [
    '/kb/chat/sessions/:id',
    '/kb/plan-task/update',
  ]),
  ...rules('self.write', 'DELETE', [
    '/agent/v2/session',
    '/auth/me/connectors/:id',
    '/kb/agent/ask/history',
    '/kb/agent/personas/:id',
    '/kb/agent/session-memory',
    '/kb/agent/tool-approvals',
    '/kb/calendar-ical/sources/:id',
    '/kb/chat/sessions/:id',
    '/kb/chat/sessions/:id/messages',
    '/kb/delete',
    '/kb/index/notes/:key',
    '/kb/issue-schedule',
    '/kb/plan/delete',
    '/kb/review/delete',
  ]),
  ...rules('model.ask', 'POST', [
    '/agent/v2/decision',
    '/agent/v2/stream',
    '/kb/agent/ask',
  ]),
  ...rules('model.read', 'POST', [
    '/bus/commands',
    '/extract-entities',
    '/generate-doc',
    '/generate-docx',
    '/generate-notes',
    '/generate-questions',
    '/kb/analyze-risks',
    '/kb/complete',
    '/kb/conflict-questions',
    '/kb/email/classify',
    '/kb/generate-code',
    '/kb/generate-plan',
    '/kb/mcp-connector/classify',
    '/kb/summarize',
  ]),
  ...rules('model.exec', 'POST', [
    '/agent-sdk/spike',
    '/kb/agent/dispatch',
    '/kb/loop/agent-run',
    '/kb/providers/turn',
  ]),
  ...rules('fs.read', 'GET', [
    '/auth/me/claude-plugins/installed',
    '/auth/me/claude-plugins/marketplace',
    '/auth/me/codex-plugins/installed',
    '/auth/me/codex-plugins/marketplace',
    '/kb/agent/project-memory',
    '/kb/docs/commands',
    '/kb/docs/templates',
  ]),
  ...rules('fs.read', 'POST', [
    '/auth/me/claude-plugins/refresh',
    '/auth/me/codex-plugins/refresh',
    '/kb/code-sync',
    '/kb/connect-git',
    '/kb/index/scan',
  ]),
  ...rules('fs.write', 'POST', [
    '/auth/me/repos',
    '/kb/docs/seed',
    '/kb/ingest-scip',
    '/kb/projects/register',
  ]),
  ...rules('fs.write', 'PUT', [
    '/kb/docs/commands/:folder',
    '/kb/docs/templates/:folder',
  ]),
  ...rules('fs.write', 'DELETE', [
    '/auth/me/repos',
    '/kb/agent/project-memory',
    '/kb/docs/commands/:folder',
    '/kb/docs/templates/:folder',
  ]),
  ...rules('external.read', 'GET', [
    '/auth/me/claude-plugins/updates',
    '/auth/me/codex-plugins/updates',
    '/auth/me/llm-sources/updates',
    '/auth/me/mcp-plugins/updates',
    '/kb/google/calendars',
    '/kb/google/drive/folders',
    '/kb/slack/conversations',
  ]),
  ...rules('external.read', 'POST', [
    '/auth/mcp-connector/start',
    '/kb/box/test',
    '/kb/calendar-ical/sync',
    '/kb/connect-box',
    '/kb/connect-github-issues',
    '/kb/email/fetch',
    '/kb/email/test',
    '/kb/google/gmail/fetch',
    '/kb/google/sync',
    '/kb/mcp-connector/fetch',
    '/kb/mcp-connector/test',
    '/kb/outcomes/refresh',
    '/kb/providers/catalog/models',
    '/kb/providers/catalog/test',
    '/kb/providers/models',
    '/kb/providers/verify',
    '/kb/repos/check-token',
    '/kb/slack/fetch',
    '/kb/slack/test',
  ]),
  ...rules('external.write', 'POST', [
    '/kb/dispatch',
    '/kb/notify/slack',
    '/kb/outcomes/retry-failed',
    '/kb/review/approve',
  ]),
  ...rules('install', 'GET', [
    '/auth/me/llm-sources/:id/discovery',
    '/auth/me/mcp-plugins/:id/resync',
    '/auth/me/mcp-plugins/claude-sources',
    '/auth/me/mcp-plugins/codex-sources',
  ]),
  ...rules('install', 'POST', [
    '/auth/me/claude-plugins/import',
    '/auth/me/claude-plugins/update',
    '/auth/me/codex-plugins/import',
    '/auth/me/extensions/catalog/refresh',
    '/auth/me/extensions/install',
    '/auth/me/extensions/repair',
    '/auth/me/extensions/rollback',
    '/auth/me/extensions/toggle',
    '/auth/me/extensions/uninstall',
    '/auth/me/extensions/update',
    '/auth/me/extensions/update/preview',
    '/auth/me/extensions/updates/check',
    '/auth/me/llm-sources/add',
    '/auth/me/llm-sources/update',
    '/auth/me/mcp-plugins/:id/resync',
    '/auth/me/mcp-plugins/:id/update',
    '/auth/me/mcp-plugins/add',
    '/auth/me/mcp-plugins/consent',
    '/auth/me/mcp-plugins/toggle',
    '/auth/me/plugins/hook-trust',
    '/auth/me/plugins/install',
    '/auth/me/plugins/install-git',
    '/auth/me/plugins/reload',
    '/auth/me/plugins/toggle',
    '/kb/agent-sdk/update',
    '/kb/project/install-skills',
  ]),
  ...rules('install', 'PUT', [
    '/auth/me/extensions/allowlist',
    '/auth/me/workspace-trust',
  ]),
  ...rules('install', 'DELETE', [
    '/auth/me/llm-sources/:id',
    '/auth/me/mcp-plugins/:id',
    '/auth/me/plugins/uninstall/:name',
  ]),
  ...rules('admin', 'GET', [
    '/admin/invites',
    '/admin/members',
    '/metrics',
  ]),
  ...rules('admin', 'POST', [
    '/admin/backup',
    '/admin/invites',
  ]),
  ...rules('admin', 'PATCH', [
    '/admin/members/:userId',
  ]),
  ...rules('admin', 'DELETE', [
    '/admin/invites/:id',
    '/admin/users/:userId',
  ]),
  ...rules('host', 'GET', [
    '/bus/approvals',
    '/host-api/devices',
    '/host-api/push/status',
    '/kb/self-heal/incidents',
    '/kb/sync/status',
  ]),
  ...rules('host', 'POST', [
    '/bus/commands/:id/approve',
    '/bus/commands/:id/deny',
    '/bus/schedules',
    '/host-api/pin',
    '/host-api/push/send',
    '/kb/issues/close',
    '/kb/issues/comment',
    '/kb/issues/create',
    '/kb/self-heal/incidents',
    '/kb/self-heal/incidents/:id/ignore',
    '/kb/self-heal/runs',
    '/kb/self-heal/runs/:id/outcome',
    '/kb/self-heal/runs/:id/resolve',
    '/kb/sync/box/poll',
    '/kb/sync/box/start',
    '/kb/sync/devices/enroll',
    '/kb/sync/devices/enroll/cancel',
    '/kb/sync/devices/enroll/confirm',
    '/kb/sync/devices/enroll/poll',
    '/kb/sync/enabled',
    '/kb/sync/mega',
    '/kb/sync/publish',
    '/kb/sync/rotate',
    '/kb/sync/sftp',
    '/kb/sync/test',
  ]),
  ...rules('host', 'PUT', [
    '/bus/kinds/:kind',
    '/host-api/push/apns',
  ]),
  ...rules('host', 'DELETE', [
    '/bus/schedules/:id',
    '/host-api/devices/:id',
    '/host-api/push/apns',
    '/kb/self-heal/incidents',
    '/kb/sync/devices/:id',
  ]),
]);

/** The rule for a request, or null when no rule declares it. A literal path wins over a `:param` path. */
export function routeAuthorityFor(method, url) {
  const p = String(url || '').split('?')[0];
  return ROUTE_POLICY.find((r) => r.literal && r.method === method && r.path === p)
    ?? ROUTE_POLICY.find((r) => !r.literal && r.method === method && r.re.test(p))
    ?? null;
}

/** Apply one rule (or the request's rule). Public and unlisted requests pass here; see enforceRouteAuthority. */
export function authorizeRoute(db, req, { rule = routeAuthorityFor(req?.method, req?.url), userId = req?.user?.id } = {}) {
  if (!rule || rule.cls === 'public') return { ok: true, rule, member: null };
  const decision = authorizeAction(db, userId, rule.cls, { req });
  return decision.ok ? { ...decision, rule } : decision;
}

/**
 * The dispatcher form. Returns true when it answered the request: a refusal (403/429), or 404 for an
 * authenticated request no rule declares (deny by default, logged so the missing rule is found).
 * An unauthenticated request only reaches here on a public path; one with no rule is left to the router.
 */
export function enforceRouteAuthority(db, req, res, { logger = null } = {}) {
  const rule = routeAuthorityFor(req?.method, req?.url);
  if (!rule) {
    if (!req?.user) return false;
    try { logger?.error?.('route_policy_unlisted', { method: req.method, path: String(req.url || '').split('?')[0] }); } catch { /* logging only */ }
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    return true;
  }
  const decision = authorizeRoute(db, req, { rule });
  if (decision.ok) return false;
  sendJSON(res, decision.status, { error: { code: decision.code, message: decision.message } });
  return true;
}
```

Remove the now-unused `requireRole` import.

- [ ] **Step 4: Pass the logger at both dispatcher calls** — `extension/server.mjs`. Change both `enforceRouteAuthority(getDb({ logger }), req, res)` calls to:

```js
enforceRouteAuthority(getDb({ logger }), req, res, { logger: reqLog })
```

and change the comment above the second call to:

```js
  // Team authority for EVERY route (plan H1.2): server/route-authority.mjs gives each method + path one
  // action class; an authenticated request that no rule declares is refused 404 and logged. Runs AFTER
  // the rate limiter so a refused caller still spends its token; a disabled feature keeps its own
  // 404 feature_disabled.
```

- [ ] **Step 4b: Engineers pass the plugin / MCP / LLM-source gates** — `extension/routes/extension-routes.mjs`. Add `import { authorizeAction } from '../server/route-authority.mjs';` and `import { classRefusal, getMember } from '../kb/members.mjs';` (merge with existing imports). Replace every

```js
try { requireRole(db, req, 'admin'); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
```

(keep each line's indentation) with

```js
{ const d = authorizeAction(db, req.user?.id, 'install', { req }); if (!d.ok) { send(res, d.status, { error: { code: d.code, message: d.message } }); return; } }
```

and the force-flag form at ~line 1040, `if (force) { try { requireRole(db, req, 'admin'); } catch { force = false; } }`, with (no audit row for a probe):

```js
if (force && classRefusal(getMember(db, req.user?.id), 'install') !== null) force = false;
```

Update the header comment at line ~10 to say the gated routes use the `install` class (member + execute, plan H1.2). After this, `grep -n "requireRole" extension/routes/extension-routes.mjs` must print nothing; remove the unused `requireRole` import.

In `extension/tests/auth-routes.test.mjs`, the three loops that assert `must refuse a member` (~840, ~1304, ~1405) create their refused account as a member. Create it as a viewer instead (`grant(db, id, { teamRole: 'viewer', maxMode: 'read_only' })` from `./helpers/grant.mjs`), change the message to `must refuse a viewer`, keep `403 ROLE_DENIED`, and add one assertion per loop that a `member` + `execute` account is NOT refused with `ROLE_DENIED`. The `server.mjs admin routes refuse a member` test (~1908) is unchanged: `/admin/*` and `/metrics` stay admin.

- [ ] **Step 5: Update the old table test** — in `extension/tests/route-authority.test.mjs`, change the import line to `ROUTE_POLICY, authorizeRoute, enforceRouteAuthority, routeAuthorityFor,` and replace the test `'the table names the dangerous routes and their gate (role + max_mode + cap)'` with:

```js
test('the dangerous routes carry the class that gates them', () => {
  const cls = (m, p) => routeAuthorityFor(m, p)?.cls;
  assert.equal(cls('POST', '/kb/loop/agent-run'), 'model.exec');
  assert.equal(cls('POST', '/kb/providers/turn'), 'model.exec');
  assert.equal(cls('POST', '/kb/agent/dispatch'), 'model.exec');
  assert.equal(cls('POST', '/kb/project/install-skills'), 'install');
  assert.equal(cls('POST', '/kb/agent-sdk/update'), 'install');
  assert.equal(cls('POST', '/auth/me/repos'), 'fs.write');
  assert.equal(cls('DELETE', '/auth/me/repos'), 'fs.write');
  assert.equal(cls('POST', '/kb/complete'), 'model.read');
  assert.equal(cls('POST', '/agent/v2/stream'), 'model.ask');
  assert.equal(cls('POST', '/kb/agent/ask'), 'model.ask');
  assert.equal(cls('POST', '/admin/invites'), 'admin');
  assert.equal(cls('POST', '/kb/ingest-scip'), 'fs.write');
  assert.equal(cls('POST', '/auth/me/plugins/hook-trust'), 'install');
  assert.equal(cls('POST', '/auth/me/mcp-plugins/toggle'), 'install');
  assert.equal(cls('PUT', '/auth/me/workspace-trust'), 'install');
  assert.equal(cls('POST', '/kb/outcomes/retry-failed'), 'external.write');
  assert.equal(cls('POST', '/kb/summarize'), 'model.read');
  assert.equal(cls('GET', '/kb/loop/agent-run'), undefined, 'only the declared method');
  assert.ok(ROUTE_POLICY.length > 300);
});

test('an authenticated request no rule declares is refused 404 and logged', () => {
  const owner = user('owner', 'execute');
  const res = makeRes();
  const logged = [];
  const logger = { error: (event, data) => logged.push([event, data]) };
  assert.equal(enforceRouteAuthority(getDb(), makeReq({ method: 'GET', url: '/kb/no-such-route?q=1', user: owner }), res, { logger }), true);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
  assert.deepEqual(logged, [['route_policy_unlisted', { method: 'GET', path: '/kb/no-such-route' }]]);
});

test('a viewer may read their own data and Ask, but not run any other model route', () => {
  const viewer = user('viewer', 'read_only');
  assert.equal(enforceRouteAuthority(getDb(), makeReq({ method: 'GET', url: '/auth/me', user: viewer }), makeRes()), false);
  const res = makeRes();
  assert.equal(enforceRouteAuthority(getDb(), makeReq({ url: '/kb/summarize', user: viewer }), res), true);
  assert.equal(res.statusCode, 403);
});
```

The existing test `'install-skills is admin-only: a member is refused before the kit runs, an admin passes the gate'` encodes the old rule: rename it `'install-skills needs an engineer with execute: a viewer and a read_only member are refused, an execute member passes the gate'` and change its member case to expect the gate to pass (`member`, `execute`) and its refused cases to a viewer and a `read_only` member.

If an existing test in that file asserts a refusal message text that changed (`Your team role cannot run turns` → `Your team grant cannot run this`), update the expected text; keep its status, code and audit-reason assertions.

- [ ] **Step 6: Run the gates**

Run: `cd extension && node --test tests/route-policy-coverage.test.mjs tests/route-authority.test.mjs tests/action-classes.test.mjs && npx eslint server/route-authority.mjs server.mjs`
Expected: PASS.

Run (unsandboxed — it spawns servers): `make test` and `make contract-gates`
Expected: 0 failures. The live contract replay sends every fixture as an authorized user, so a `404 NOT_FOUND` in it means a served **method** has no rule. For each one: add the method + path to `ROUTE_POLICY` under the class of the inventory row for that path, and list it in the task report. Do not add a prefix or wildcard rule.

- [ ] **Step 7: Commit**

```bash
git add extension/server/route-authority.mjs extension/server.mjs extension/routes/extension-routes.mjs extension/tests/route-authority.test.mjs extension/tests/auth-routes.test.mjs extension/tests/route-policy-coverage.test.mjs
git commit -m "feat(team): every route declares its action class; undeclared routes are refused"
```

---

### Task 4: A viewer may only Ask; Host API commands check the class on every frame

Two things. (1) The user's rule "others only ask": a viewer's chat turn is forced to the read-only `ask` mode, on the desktop and on a paired phone or browser (today a viewer gets no chat at all on the Host API). (2) Pairing filters a device's capabilities once; a member demoted while a phone stays connected keeps chat until the next re-auth — check each frame.

**Files:**
- Modify: `extension/routes/agent-v2.mjs` (`runV2Turn`, the team clamp at ~573-595)
- Modify: `extension/tests/agent-v2-team-clamp.test.mjs` (append)
- Modify: `extension/routes/host-api/gateway.mjs` (`minimalFor`, ~line 30; the frame check after the capability check, ~line 404)
- Modify: `extension/tests/host-api-gateway.test.mjs` (two existing tests + append)

**Interfaces:**
- Consumes: `classRefusal` (Task 2) — the gateway passes no spend function; `chat.send` is capped inside the turn (`runV2Turn`).
- Produces: `COMMAND_CLASS` (exported, frozen): every command in `HOST_API_COMMANDS` → class or `null` (pairing and heartbeat).

- [ ] **Step 1: Write the failing tests.**

Append to `extension/tests/agent-v2-team-clamp.test.mjs` (it defines `member(role, maxMode)`, `stream(user, body, deps)` and `fakeTurn()`):

```js
test('a viewer may only Ask: an Execute request runs as ask, with no permission mode', async () => {
  const viewer = member('viewer', 'read_only');
  const t = fakeTurn();
  const { res } = await stream(viewer, { message: 'how does login work?', mode: 'execute', permissionMode: 'bypass', model: 'claude-sonnet-5' }, { runTurn: t.runTurn });
  assert.notEqual(res.statusCode, 403);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].mode, 'ask');
});

test('a viewer with max_mode none is still refused', async () => {
  const viewer = member('viewer', 'none');
  const t = fakeTurn();
  const { res } = await stream(viewer, { message: 'hi', model: 'claude-sonnet-5' }, { runTurn: t.runTurn });
  assert.equal(res.statusCode, 403);
  assert.equal(t.calls.length, 0);
});
```

Before running, open the file's `fakeTurn` and check the field the engine receives the mode under (`mode` in the call args); match it, keep the assertion that it is `ask`.

Then, in `extension/tests/host-api-gateway.test.mjs` (it already defines `harness`, `req`, `HELLO`, `READER`, `VIEWER`, `NO_TURNS`):
- change the test `'pairing as a viewer grants host + read + push only'` to `'pairing as a viewer grants Ask: host, chat, approvals and read'` expecting `['host', 'chat', 'approvals', 'read']` for both the result and the stored scopes;
- in `'a demoted member loses chat on the next token auth (stored scopes ∩ the filter)'`, demote to `NO_TURNS` instead of `VIEWER` (the expected `['host', 'read']` stays);
- append:

```js
test('every Host API command has a class (null only for pairing and heartbeat)', async () => {
  const { COMMAND_CLASS } = await import('../routes/host-api/gateway.mjs');
  const { HOST_API_COMMANDS } = await import('../routes/host-api/commands.generated.mjs');
  for (const name of Object.keys(HOST_API_COMMANDS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(COMMAND_CLASS, name), `${name} has no class`);
  }
  for (const name of ['host.hello', 'host.auth.pair', 'host.auth.token', 'host.auth.revoke', 'host.ping']) {
    assert.equal(COMMAND_CLASS[name], null, name);
  }
  assert.equal(COMMAND_CLASS['chat.send'], 'model.ask');
  assert.equal(COMMAND_CLASS['approvals.answer'], 'model.ask');
  assert.equal(COMMAND_CLASS['toolApprovals.answer'], 'model.exec');
});

test('a member demoted while connected loses chat on the very next frame', async () => {
  let current = READER;
  const t = harness({ read: true, member: () => current() });
  const s = {};
  await t.paired(s);
  current = NO_TURNS;
  await t.g.receive(s, req('c-send', 'chat.send', { text: 'hi' }));
  assert.equal(t.lastError(), 'denied');
  assert.equal(t.turns.length, 0);
  assert.ok(t.audits.some(([event]) => event === 'role_denied'));
  await t.g.receive(s, req('c-sessions', 'chat.sessions', {}));
  assert.equal(t.last().error, undefined, 'a max_mode none member may still read');
});

test('a viewer paired on a phone may Ask', async () => {
  const t = harness({ read: true, member: VIEWER });
  const s = {};
  await t.paired(s);
  await t.g.receive(s, req('c-send', 'chat.send', { text: 'what changed today?' }));
  assert.equal(t.turns.length, 1, 'the turn starts; runV2Turn forces it to ask');
});
```

Check `HOST_API_COMMANDS`'s import path with `grep -n "HOST_API_COMMANDS" extension/routes/host-api/gateway.mjs` and use the same module in the test.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test tests/host-api-gateway.test.mjs`
Expected: FAIL — `COMMAND_CLASS` is undefined; the demoted send is not refused.

- [ ] **Step 3a: Force Ask for a viewer** — `extension/routes/agent-v2.mjs`, in `runV2Turn`, directly after the existing `if (maxMode === 'read_only' && !restrictsTools(mode)) { ... }` block:

```js
  // User decision 2026-11-08 (plan H1.2): everyone but owners, admins and engineers may only Ask —
  // a read-only question with no edit or command tools — whatever mode or permission they asked for.
  if (member?.teamRole === 'viewer') {
    mode = 'ask';
    body.permissionMode = null;
    bypassGrants.revoke(userId, chatSessionId);
  }
```

This covers `POST /agent/v2/stream` and the Host API `chat.send` (both go through `runV2Turn`).

- [ ] **Step 3b: Let a viewer Ask over the Host API** — `extension/routes/host-api/gateway.mjs`, replace `MINIMAL_SCOPES` and `minimalFor` with:

```js
// ADR 0021 + plan H1.2: a max_mode none member, or a caller with no authority row (fail closed), is
// served host + read + push. A viewer may also Ask: chat + approvals (runV2Turn forces the turn to
// `ask`). compose and tool_approvals stay off for both.
const MINIMAL_SCOPES = ['host', 'read', 'push'];
const VIEWER_SCOPES = ['host', 'read', 'push', 'chat', 'approvals'];
function minimalFor(member, caps) {
  if (!member || member.maxMode === 'none') return caps.filter((c) => MINIMAL_SCOPES.includes(c));
  if (member.teamRole === 'viewer') return caps.filter((c) => VIEWER_SCOPES.includes(c));
  return caps;
}
```

- [ ] **Step 3c: The per-frame check** — `extension/routes/host-api/gateway.mjs`. Import `classRefusal` from `../../kb/members.mjs` (add it to the existing `kb/members.mjs` import if there is one). Add near `MINIMAL_SCOPES`:

```js
// Plan H1.2: each command's action class, checked on EVERY frame against the member's current row,
// so a demotion applies on the next frame, not at the next re-auth. null = pairing / heartbeat.
export const COMMAND_CLASS = Object.freeze({
  'host.hello': null,
  'host.auth.pair': null,
  'host.auth.token': null,
  'host.auth.revoke': null,
  'host.ping': null,
  'host.snapshot': 'self.read',
  'chat.snapshot': 'self.read',
  'chat.sessions': 'self.read',
  'chat.history': 'self.read',
  'usage.get': 'self.read',
  'chat.options': 'self.read',
  'push.config': 'self.read',
  'chat.cancel': 'self.write',
  'chat.history.clear': 'self.write',
  'chat.new': 'self.write',
  'push.register': 'self.write',
  'push.unregister': 'self.write',
  'chat.send': 'model.ask',
  'approvals.answer': 'model.ask',
  'toolApprovals.answer': 'model.exec',
});
```

Directly after the existing `if (capability && served.includes(capability) && !entry.grants?.has(capability)) { ... }` block (inside `if (entry.state.deviceId) {`), add:

```js
      const cls = COMMAND_CLASS[r.command];
      if (cls) {
        const { userId: u, deviceId: d } = entry.state;
        const refusal = classRefusal(deps.member(u), cls);
        if (refusal) {
          deps.log(`Host API v1 connection ${entry.num} refused ${r.command} (${refusal})`);
          audit('role_denied', { peer: entry.peer, userId: u, deviceId: d, detail: refusal, dedupeKey: `${d}:${refusal}` });
          return fail(s, r.id, 'denied', 'Your team role no longer allows this.');
        }
      }
```

If `audit` rejects an unknown event name, add `'role_denied'` wherever the gateway lists its audit events (`grep -n "scope_denied" extension/routes/host-api/*.mjs extension/server/*.mjs`).

- [ ] **Step 4: Run the Host API suites**

Run: `cd extension && node --test tests/host-api-*.test.mjs tests/agent-v2-team-clamp.test.mjs tests/agent-v2-routes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/agent-v2.mjs extension/tests/agent-v2-team-clamp.test.mjs extension/routes/host-api/gateway.mjs extension/tests/host-api-gateway.test.mjs
git commit -m "feat(team): a viewer may only Ask; Host API checks each command's class on every frame"
```

---

### Task 5: Background jobs act within the member's current grant

**Files:**
- Modify: `extension/routes/bus/executor.mjs` (`execute`, after the `users` existence check)
- Modify: `extension/agents/meeting-agent.mjs` (`tickRun` start; `_resetForTests`)
- Modify: `extension/agents/outcome-watcher.mjs` (the per-user poll loop)
- Modify: `extension/tests/command-bus.test.mjs`, `extension/tests/meeting-agent.test.mjs`, `extension/tests/outcome-watcher-refresh.test.mjs` (append)

**Interfaces:**
- Consumes: `classRefusal`, `getMember` (`kb/members.mjs`); `usedUsdMonth` (`kb/usage.mjs`).
- Produces: `KIND_CLASS` in `executor.mjs` (`review → 'model.read'`, `'sources.update' → 'external.read'`); `_setAuthorityForTests(fn)` in `meeting-agent.mjs` (fn: `(userId) => refusal | null`); `usersAllowedToPoll(db, userIds) → string[]` exported from `outcome-watcher.mjs`.

- [ ] **Step 1: Write the failing tests.**

Append to `extension/tests/command-bus.test.mjs` (it defines `reset`, `call`, `cmd`, `until`, `control`, `A`, `main`, `store`):

```js
test('a member demoted to viewer before the job runs is refused at execution: tier_denied, nothing runs', async () => {
  const { grant } = await import('./helpers/grant.mjs');
  await reset();
  grant(main.getDb(), A, { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 0 });
  try {
    const r = await call('POST', '/bus/commands', cmd());
    assert.equal(r.status, 202, r.text);
    const id = r.body.command.id;
    await until(async () => store.getCommand(A, id)?.state === 'failed');
    assert.equal(store.getCommand(A, id).error, 'tier_denied');
    assert.equal(control.calls.length, 0, 'the review never started');
  } finally {
    grant(main.getDb(), A, { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  }
});
```

Append to `extension/tests/meeting-agent.test.mjs`:

```js
test('a tick refuses to draft a question once the member may no longer run the model', async () => {
  reset();
  meetingAgent._setAuthorityForTests(() => 'role_denied');
  liveSessions.appendCaptions('user-1', 'sess-auth', [
    { speaker: 'Alice', text: 'agent, what do you think?', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-1', sessionId: 'sess-auth' });
  await new Promise((r) => setTimeout(r, 1700)); // one TICK_MS (1500) + slack
  assert.equal(meetingAgent.getRunBySessionId('sess-auth').lastDecision.reason, 'authority: role_denied');
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-auth' });
  reset();
});
```

Append to `extension/tests/outcome-watcher-refresh.test.mjs` (use its existing DB setup; import `registerUser` from `../server/users.mjs` and `getDb` from `../kb/db.mjs` if it does not already):

```js
test('the background poller skips a member who may no longer read external services', async () => {
  const { usersAllowedToPoll } = await import('../agents/outcome-watcher.mjs');
  const { grant } = await import('./helpers/grant.mjs');
  const mk = (e) => registerUser(getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
  const reader = mk('poll-reader@example.test');
  const viewer = mk('poll-viewer@example.test');
  grant(getDb(), reader, { teamRole: 'member', maxMode: 'read_only' });
  grant(getDb(), viewer, { teamRole: 'viewer', maxMode: 'read_only' });
  assert.deepEqual(usersAllowedToPoll(getDb(), [reader, viewer, 'no-such-user']), [reader]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test tests/command-bus.test.mjs tests/meeting-agent.test.mjs tests/outcome-watcher-refresh.test.mjs`
Expected: FAIL (the job runs; `_setAuthorityForTests` and `usersAllowedToPoll` are undefined).

- [ ] **Step 3: Implement the bus check** — `extension/routes/bus/executor.mjs`. Add imports `import { classRefusal, getMember } from '../../kb/members.mjs';` and `import { usedUsdMonth } from '../../kb/usage.mjs';` (skip any already imported). Add at module level:

```js
// Plan H1.2: the action class of each kind, re-checked when the job RUNS (a member demoted after
// enqueueing is refused). Reuses the existing tier_denied code: no new wire value.
const KIND_CLASS = Object.freeze({ review: 'model.read', 'sources.update': 'external.read' });
```

In `execute`, directly after `if (!getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) fail('not_found');`:

```js
      const kindClass = KIND_CLASS[kind];
      if (!kindClass) fail('kind_not_available');
      if (classRefusal(getMember(getDb(), userId), kindClass, () => usedUsdMonth(getDb(), userId))) fail('tier_denied');
```

- [ ] **Step 4: Implement the meeting-agent check** — `extension/agents/meeting-agent.mjs`. Add imports `import { getDb } from '../kb/db.mjs';`, `import { classRefusal, getMember } from '../kb/members.mjs';`, `import { usedUsdMonth } from '../kb/usage.mjs';` (skip any already imported). Add near the other module state:

```js
// Plan H1.2: the member's grant can change mid-meeting; every tick re-checks before any model work.
const dbAuthority = (userId) => classRefusal(getMember(getDb(), userId), 'model.read', () => usedUsdMonth(getDb(), userId));
let authority = dbAuthority;
/** Test seam: these tests run without a DB. */
export function _setAuthorityForTests(fn) { authority = fn; }
```

At the very start of `tickRun(run)`, before `const now = Date.now();`:

```js
  const refusal = authority(run.userId);
  if (refusal) {
    recordDecision(run, `authority: ${refusal}`);
    return;
  }
```

In `_resetForTests()`, add `authority = () => null;` (the suite has no DB; a test that needs a refusal sets one).

- [ ] **Step 5: Implement the poller filter** — `extension/agents/outcome-watcher.mjs`. Import `classRefusal` and `getMember` from `../kb/members.mjs`. Add:

```js
/** Plan H1.2: only members who may still read external services are polled with their credentials. */
export function usersAllowedToPoll(db, userIds) {
  return userIds.filter((userId) => classRefusal(getMember(db, userId), 'external.read') === null);
}
```

In the background poll, change `for (const userId of userIds) {` to `for (const userId of usersAllowedToPoll(db, userIds)) {` (use the `db` the loop already passes to `getSecrets`).

- [ ] **Step 6: Run the suites and lint**

Run: `cd extension && node --test tests/command-bus.test.mjs tests/bus-schedules.test.mjs tests/sources-update-bus.test.mjs tests/meeting-agent.test.mjs tests/outcome-watcher-refresh.test.mjs && npx eslint routes/bus/executor.mjs agents/meeting-agent.mjs agents/outcome-watcher.mjs`
Expected: PASS, eslint clean (agents may import `kb/`; routes may import `kb/`).

- [ ] **Step 7: Commit**

```bash
git add extension/routes/bus/executor.mjs extension/agents/meeting-agent.mjs extension/agents/outcome-watcher.mjs extension/tests/command-bus.test.mjs extension/tests/meeting-agent.test.mjs extension/tests/outcome-watcher-refresh.test.mjs
git commit -m "feat(team): background jobs re-check the member's grant when they act"
```

---

### Task 6: `/auth/me` reports permissions; the desktop chat hides what it would refuse (API 124)

**Files:**
- Modify: `extension/server/auth-routes.mjs:~680` (`GET /auth/me`)
- Modify: `extension/server.mjs` (`SERVER_API_VERSION` 123 → 124, changelog line)
- Modify: `schema/http/health-auth.schema.json` (`Me.member.permissions`), the `GET /auth/me 200` fixture
- Regenerate: `node scripts/gen-api-types.mjs`, `node scripts/gen-openapi.mjs`, `node scripts/http-inventory.mjs`
- Create: `ui/screens/shell/permissions.ts`, `ui/screens/shell/tests/permissions.test.mjs`
- Modify: `ui/screens/chat/ChatScreen.tsx`

**Interfaces:**
- Consumes: `permittedClasses` (Task 2).
- Produces: `GET /auth/me` → `member: { teamRole, maxMode, usdCapMonth, permissions: string[] } | null`. UI: `permissionsFromMe(body) → ReadonlySet<string> | null` (null = unknown, older core: allow everything; the server still enforces); `chatBlockReason(perms) → string | null`; `allowedModes(perms, modes) → modes`.

- [ ] **Step 1: Server — failing assertion.** In `extension/tests/route-authority.test.mjs` (or the `/auth/me` test in `auth-routes.test.mjs` that already checks `member`), add:

```js
test('/auth/me reports the member permissions', async () => {
  const { permittedClasses } = await import('../kb/members.mjs');
  assert.deepEqual(permittedClasses({ teamRole: 'member', maxMode: 'read_only', usdCapMonth: 0 }),
    ['self.read', 'self.write', 'model.ask', 'model.read', 'fs.read', 'external.read', 'host']);
});
```

and, in the existing `GET /auth/me` route test, assert `body.member.permissions` is an array containing `'self.read'`.

- [ ] **Step 2: Implement** — `extension/server/auth-routes.mjs`, the `GET /auth/me` handler. Import `permittedClasses` from `../kb/members.mjs` and change the `member:` line to:

```js
      member: m ? { teamRole: m.teamRole, maxMode: m.maxMode, usdCapMonth: m.usdCapMonth, permissions: permittedClasses(m) } : null,
```

`extension/server.mjs`: set `const SERVER_API_VERSION = 124;` and add the changelog line above the `v123` entry:

```js
//   v124 — Team Hub H1.2 (plan 2026-11-08), additive: GET /auth/me member.permissions (the action
//          classes the caller may use). Every route now has an action class; an authenticated request
//          no rule declares answers 404 NOT_FOUND. Refusals stay 403 ROLE_DENIED / 429 USD_CAP.
```

`schema/http/health-auth.schema.json`, `$defs.Me.properties.member.properties`: add

```json
"permissions": { "type": "array", "items": { "type": "string" }, "description": "Action classes the caller may use (kb/members.mjs CLASS_GRANTS), cap not applied. Plan H1.2, API 124." }
```

Update the `get-auth-me-200.json` fixture under `schema/http/fixtures/health-auth/` by capturing it from a real server the same way `ca0e55bf` captured the team fixtures (`git show --stat ca0e55bf` names the capture command), then regenerate api-types, openapi and the inventory.

- [ ] **Step 3: UI — failing test** — `ui/screens/shell/tests/permissions.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionsFromMe, chatBlockReason, allowedModes } from "../permissions.ts";

const modes = [{ id: "auto" }, { id: "ask" }, { id: "execute" }];

test("an older core (no permissions) is unknown: nothing is hidden", () => {
  assert.equal(permissionsFromMe({ id: "u", member: { teamRole: "owner" } }), null);
  assert.equal(chatBlockReason(null), null);
  assert.deepEqual(allowedModes(null, modes), modes);
});

test("a viewer may only Ask; a read-only member cannot pick Execute; no model class blocks chat", () => {
  const viewer = permissionsFromMe({ member: { permissions: ["self.read", "self.write", "model.ask", "host"] } });
  assert.equal(chatBlockReason(viewer), null);
  assert.deepEqual(allowedModes(viewer, modes).map((m) => m.id), ["ask"]);
  const none = permissionsFromMe({ member: { permissions: ["self.read", "self.write", "host"] } });
  assert.match(chatBlockReason(none), /team role/);
  const reader = permissionsFromMe({ member: { permissions: ["self.read", "self.write", "model.ask", "model.read"] } });
  assert.equal(chatBlockReason(reader), null);
  assert.deepEqual(allowedModes(reader, modes).map((m) => m.id), ["auto", "ask"]);
  const doer = permissionsFromMe({ member: { permissions: ["model.read", "model.exec"] } });
  assert.deepEqual(allowedModes(doer, modes), modes);
});
```

- [ ] **Step 4: Implement** — `ui/screens/shell/permissions.ts`

```ts
// Plan H1.2: the action classes the core says the caller may use (GET /auth/me member.permissions).
// Courtesy only — the core enforces every class; this hides what it would refuse. null = unknown
// (an older core): hide nothing.
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function permissionsFromMe(body: unknown): ReadonlySet<string> | null {
  if (!isRec(body) || !isRec(body.member) || !Array.isArray(body.member.permissions)) return null;
  return new Set(body.member.permissions.filter((p): p is string => typeof p === "string"));
}

export function chatBlockReason(perms: ReadonlySet<string> | null): string | null {
  return perms && !perms.has("model.ask") && !perms.has("model.read") ? "Your team role cannot run chat. Ask a team admin for access." : null;
}

/** Engineers (model.exec) get every mode; a read-only member loses Execute; a viewer only Asks. */
export function allowedModes<T extends { id: string }>(perms: ReadonlySet<string> | null, modes: readonly T[]): readonly T[] {
  if (!perms || perms.has("model.exec")) return modes;
  if (perms.has("model.read")) return modes.filter((m) => m.id !== "execute");
  return modes.filter((m) => m.id === "ask");
}
```

In `ui/screens/chat/ChatScreen.tsx`: load `/auth/me` once per screen and after each core restart (the same effect pattern as the model list, keyed on `[core, coreRestarts]`), store `permissionsFromMe(body)` in state (`null` on any error); pass `allowedModes(perms, MODES)` wherever the screen passes `MODES` to the mode picker, and when the result has exactly one mode, set the chat's mode to it (`setCurrent({ mode: "ask" })`) so a viewer's picker never shows Auto; and extend the composer's `disabledReason` expression so `chatBlockReason(perms)` comes first:

```tsx
disabledReason={chatBlockReason(perms) ?? (isEndedChat(sessions.find((s) => s.id === activeId)) ? ENDED_REASON : noProject ? "Open a project to send messages." : null)}
```

Use the screen's existing core client call for JSON (the same one `route.ts` uses for `GET /kb/providers/custom`), not a new fetch.

- [ ] **Step 5: Run the gates**

Run: `cd extension && node --test tests/route-authority.test.mjs tests/auth-routes.test.mjs` then `cd ../desktop && npx tsc --noEmit && node --test --experimental-strip-types ../ui/screens/shell/tests/permissions.test.mjs ../ui/screens/chat/tests/*.test.mjs` then (unsandboxed) `make contract-gates`
Expected: PASS.

- [ ] **Step 6: Commit** (two commits: contract, then UI)

```bash
git add extension/server/auth-routes.mjs extension/server.mjs schema/http extension/tests
git commit -m "feat(api): /auth/me reports the member's permitted action classes, API 124"
git add ui/screens/shell/permissions.ts ui/screens/shell/tests/permissions.test.mjs ui/screens/chat/ChatScreen.tsx
git commit -m "feat(chat): a viewer sees Ask only; hide modes the member's role cannot use"
```

---

### Task 7: End-to-end proof on a real server, then the docs

**Files:**
- Create: `extension/tests/route-policy-e2e.test.mjs`
- Modify: `docs/decisions/0021-team-hub.md`, `docs/explanation/invariants.md`, `extension/CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md`

- [ ] **Step 1: Write the e2e test** — `extension/tests/route-policy-e2e.test.mjs`. Copy `freePort`, `baseEnv`, `startServer` and `stopServer` verbatim from `extension/tests/invites-registration.test.mjs` (lines 25-80), then:

```js
// Plan H1.2 Task 7: the R-014 dangerous routes, on a real server, as a viewer and as a read-only
// member. Every refusal happens before any work: no engine, no spawn, no file write.
let dir; let dbPath; let server;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-policy-e2e-'));
  dbPath = path.join(dir, 'data.db');
  server = await startServer({});
});
after(async () => { await stopServer(server); fs.rmSync(dir, { recursive: true, force: true }); });

async function api(method, p, token, body) {
  const res = await fetch(`${server.url}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
async function register(email) {
  const r = await api('POST', '/auth/register', null, { email, password: PASSWORD, displayName: email });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { id: r.json.user.id, token: r.json.accessToken };
}

const DANGEROUS = [
  ['POST', '/kb/loop/agent-run', { message: 'x', repoRoot: '/tmp' }],
  ['POST', '/kb/ingest-scip', { scipPath: '/tmp/x.scip' }],
  ['POST', '/auth/me/plugins/hook-trust', {}],
  ['POST', '/auth/me/mcp-plugins/toggle', {}],
  ['PUT', '/auth/me/workspace-trust', {}],
  ['DELETE', '/kb/agent/project-memory', {}],
  ['POST', '/kb/outcomes/retry-failed', {}],
  ['POST', '/kb/summarize', {}],
  ['POST', '/generate-docx', {}],
  ['POST', '/kb/conflict-questions', {}],
  ['POST', '/kb/connect-git', {}],
  ['POST', '/kb/project/install-skills', {}],
  ['POST', '/auth/me/repos', { path: '/tmp' }],
  ['POST', '/kb/complete', {}],
  ['POST', '/generate-notes', {}],
  ['POST', '/kb/email/fetch', {}],
  ['POST', '/admin/invites', {}],
];

test('a viewer is refused every dangerous route with ROLE_DENIED; reading their own account still works', async () => {
  const owner = await register('owner@example.test');
  const v = await register('viewer@example.test');
  const patch = await api('PATCH', `/admin/members/${v.id}`, owner.token, { teamRole: 'viewer', maxMode: 'read_only' });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  for (const [method, p, body] of DANGEROUS) {
    const r = await api(method, p, v.token, body);
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error.code, 'ROLE_DENIED', `${method} ${p}`);
  }
  const me = await api('GET', '/auth/me', v.token);
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.member.permissions, ['self.read', 'self.write', 'model.ask', 'host']);
});

test('an engineer may install but not manage the team; a read-only member may not edit; an undeclared route is 404', async () => {
  const owner = await api('POST', '/auth/login', null, { email: 'owner@example.test', password: PASSWORD });
  const m = await register('reader@example.test');
  await api('PATCH', `/admin/members/${m.id}`, owner.json.accessToken, { teamRole: 'member', maxMode: 'read_only' });
  for (const [method, p, body] of [['POST', '/kb/loop/agent-run', { message: 'x', repoRoot: '/tmp' }], ['POST', '/auth/me/repos', { path: '/tmp' }]]) {
    const r = await api(method, p, m.token, body);
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  const eng = await register('engineer@example.test'); // solo default: member + execute
  const inv = await api('POST', '/admin/invites', eng.token, {});
  assert.equal(inv.status, 403, 'team management stays admin');
  const install = await api('POST', '/auth/me/plugins/hook-trust', eng.token, {});
  assert.notEqual(install.status, 403, 'an engineer passes the install gate (the handler may still answer 400 for the empty body)');
  const unknown = await api('GET', '/kb/no-such-route', m.token);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');
});
```

Match the register/login response field names (`user.id`, `accessToken`) to `POST /auth/register` in `extension/server/auth-routes.mjs` before running; keep the assertions.

- [ ] **Step 2: Run it** (unsandboxed — it binds a port)

Run: `cd extension && node --test tests/route-policy-e2e.test.mjs`
Expected: PASS. A route that answers 400 or 404 instead of 403 means its handler validated the body before the policy ran — that is a bug in the dispatcher order, not in the test; fix the order.

- [ ] **Step 3: Docs.**
  - `docs/decisions/0021-team-hub.md`: add a section "H1.2 — every route within its role" with the user decision ("admin and engineers need all, others only ask"), the Classes table from this plan, decisions D1–D5 as accepted, and the rule "a new route without a class is refused 404 and fails `route-policy-coverage.test.mjs`".
  - `docs/explanation/invariants.md`: replace the `9c2a3e76` team-authority line with: "Every HTTP route has exactly one action class in `extension/server/route-authority.mjs` `ROUTE_POLICY`; an authenticated request no rule declares answers 404. Host API commands (`COMMAND_CLASS`) and background jobs (bus executor, meeting agent, outcome poller) re-check the class when they act. Regression: R-014#1 (a viewer could run the Loop agent on the operator's login)."
  - `extension/CLAUDE.md`: in the Team Hub / authority section, add "Adding a route: add its method + path to `ROUTE_POLICY` under one class (see the class table in ADR 0021), or it will 404."
  - `docs/superpowers/MASTER-PLAN.md`: tick the H1.2 row (add it under Team Hub if absent) with this plan's path; run `node scripts/plan-status.mjs --fix` and `node scripts/user-needs.mjs` if the dashboard or user-needs counts change.

- [ ] **Step 4: Full gates** (unsandboxed)

Run: `make test && make contract-gates && make docs-check && make regression && cd desktop && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/tests/route-policy-e2e.test.mjs docs/decisions/0021-team-hub.md docs/explanation/invariants.md extension/CLAUDE.md docs/superpowers/MASTER-PLAN.md docs/superpowers
git commit -m "docs(team): every route within its role (H1.2), with an end-to-end proof"
```

---

## Not in this plan (tracked separately)

- Loop shell stages run from the working-tree `system/loop.json` with only a webview confirm (R-014 Worst #2) — a desktop-host change, not a core role check.
- `POST /kb/ingest-scip` accepts any `scipPath`; this plan makes it member + execute, but confining the path to allow-listed repos is its own fix.
- Per-project grants for members (ADR 0021 "later project grants").
