# Team Hub H1: Authority in the Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The core enforces team roles and per-member authority in one place, so it can later be exposed to a team (H2). A solo install behaves exactly as today.

**Architecture:** A `members` table (migration 0068) beside `users` carries `team_role` (`owner | admin | member | viewer`), `max_mode` (`none | read_only | execute`) and `usd_cap_month`. `extension/kb/members.mjs` owns it (every helper takes `userId` first). `server/auth.mjs` gains `requireRole(db, req, minRole)`; the six `requireAdmin` call sites become `requireRole(..., 'admin')`. `routes/agent-v2.mjs` clamps every turn to the member's `max_mode` right after mode resolution. The Host API gateway intersects served capabilities with the member's grants at pairing. Admins mint single-use invites; `POST /auth/register` accepts an invite while registration is closed. `LLMIDE_HUB=1` is parsed into `config.hub` (closes registration, sets new-member defaults to read-only); H2 does the rest of hub mode.

**Tech Stack:** Node 22 core (better-sqlite3, `node:crypto`), `node:test`. No new dependency. No desktop, web or iPhone screen in this plan.

**Spec:** ADR 0021 (`docs/decisions/0021-team-hub.md`), `plans/2026-11-07-team-hub-plan.md` §2–§4. House style: `plans/2026-11-07-self-heal-a-incidents.md` (route tests, API bump checklist).

## Global Constraints

- **Security first:** every new write route is JWT + `requireRole`; invites are 32 random bytes, stored as SHA-256, single use, 24 h, rate-limited by the `/auth/register` bucket; audit rows (`safeAudit`) for every grant change, invite mint/use and every **denied** turn (`outcome: 'denied'`, `action: 'team.deny'`, detail = `{ reason }`, never message text).
- **No regression for a solo install:** migration 0068 makes the earliest active non-legacy user `owner` with `max_mode='execute'`, `usd_cap_month=0` (0 = no cap); every other existing user becomes `member` with `execute`. Without `LLMIDE_HUB=1` a user registering with no invite (registration open) becomes `member` with `execute`. Only **invited** members and hub-mode registrations get the ADR 0021 defaults (`member`, `read_only`, 20).
- **Role order:** `viewer < member < admin < owner`. An admin cannot change an owner or make an owner; only an owner can; the last owner cannot be demoted, disabled or deleted (`409 LAST_OWNER`). A user cannot change their own role or grants (`403 SELF_GRANT`).
- **Turn clamp** (one place, `routes/agent-v2.mjs`, after `mode` is resolved and before the lock): `max_mode='none'` → `403 { error: { code: 'ROLE_DENIED' } }`; `read_only` → `mode = clampToReadOnly(mode)`, `body.permissionMode = null`, bypass grant revoked (`bypassGrants.revoke`); `execute` → unchanged. `startHostTurn` already clamps to read-only and keeps doing so; it additionally refuses `max_mode='none'`.
- **Host API:** at pairing (`gateway.mjs` ~418) `served` is filtered: `viewer`/`none` keeps `host` + `read` + `push` only (no `chat`, `approvals`, `tool_approvals`, `compose`); `read_only` and `execute` keep everything served. The `host.hello` reply is unchanged in shape.
- **USD cap:** `usd_cap_month` is enforced where `usdCapForModel` is consulted (`kb/usage.mjs:521`, `resolveModel`): the effective USD cap for the month window is `min(member cap, model_limits cap)` when both are non-zero, else whichever is non-zero. Over cap → the existing quota behaviour (same error code the UI already shows). `POST /kb/usage/limits` (`routes/router.mjs:1100`) stays self-service but may not exceed the member's cap: a chain row above it is clamped to it.
- **Numbers:** migration **0068** (head 0067). `SERVER_API_VERSION` 122 → **123**. If taken, use the next free number everywhere.
- **API bump checklist (Task 6):** `SERVER_API_VERSION` + changelog line in `extension/server.mjs`; `ALL_ENDPOINTS`; `ui/screens/shell/core-api-floor.ts`; `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`; `schema/http/team.schema.json` + fixtures; `extension/tests/http-contract-live.test.mjs` skip rows; `scripts/http-inventory.mjs`; regenerate `node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs`. `REQUIRED_ENDPOINTS` in the Chrome extension unchanged.
- **Migration:** append-only; `deleteUserCascade` deletes `members` and `invites` rows (`tests/user-delete-cascade.test.mjs`); migration head in `docs/explanation/architecture.md`, `docs/spec/cross-cutting.md`, `docs/spec/knowledge-base.md`.
- **Docs:** retire the "every user is an admin" wording in `extension/core/config.mjs:39-41`, `extension/server.mjs` (`server_remote_registration_open`), `docs/explanation/invariants.md:185`, `deploy/vps/README.md` Known limits: it now reads "every member runs within the grants in `members`; open registration on a reachable server still lets any peer become a member".
- Conventional Commits, one concern per commit, commit on `main`. Tests with `node:test` in the style of `extension/tests/auth-routes.test.mjs`.

## Task 1 — Migration 0068 + `kb/members.mjs`

**Files:** create `extension/kb/migrations/0068_team_members.sql`, `extension/kb/members.mjs`, `extension/tests/members.test.mjs`; modify `extension/kb/db.mjs` (`deleteUserCascade`), `extension/tests/user-delete-cascade.test.mjs`.

- [ ] Migration:

```sql
-- 0068: team members and invites (ADR 0021). users.role stays as the legacy flag.
CREATE TABLE IF NOT EXISTS members (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  team_role      TEXT NOT NULL DEFAULT 'member'
                   CHECK (team_role IN ('owner','admin','member','viewer')),
  max_mode       TEXT NOT NULL DEFAULT 'read_only'
                   CHECK (max_mode IN ('none','read_only','execute')),
  usd_cap_month  REAL NOT NULL DEFAULT 20 CHECK (usd_cap_month >= 0),  -- 0 = no cap
  granted_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
  id             TEXT PRIMARY KEY,                 -- 16-byte hex
  token_hash     TEXT NOT NULL UNIQUE,             -- sha256 hex of the 32-byte token
  email          TEXT,                             -- optional: bind to one address (NOCASE compare in code)
  team_role      TEXT NOT NULL DEFAULT 'member' CHECK (team_role IN ('admin','member','viewer')),
  max_mode       TEXT NOT NULL DEFAULT 'read_only' CHECK (max_mode IN ('none','read_only','execute')),
  usd_cap_month  REAL NOT NULL DEFAULT 20 CHECK (usd_cap_month >= 0),
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  used_by        TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(created_by, created_at DESC);
-- Bootstrap: the earliest active real user is the owner; everyone else keeps full power (no regression).
INSERT OR IGNORE INTO members (user_id, team_role, max_mode, usd_cap_month)
  SELECT id, 'member', 'execute', 0 FROM users WHERE id != 'legacy';
UPDATE members SET team_role = 'owner'
  WHERE user_id = (SELECT id FROM users WHERE id != 'legacy' AND status = 'active'
                   ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC LIMIT 1);
```

- [ ] `kb/members.mjs` exports: `ROLE_ORDER = { viewer: 0, member: 1, admin: 2, owner: 3 }`, `getMember(db, userId)` (→ `{ userId, teamRole, maxMode, usdCapMonth }` or `null`), `listMembers(db)` (joined with `users.email, display_name, status`, ordered by role then email), `ensureMember(db, userId, { teamRole, maxMode, usdCapMonth, grantedBy })` (insert-or-ignore; used by register), `setMember(db, actorId, userId, patch)` (transaction; applies the Global Constraints rules; throws `AppError` `LAST_OWNER` 409 / `SELF_GRANT` 403 / `ROLE_DENIED` 403 / `VALIDATION` 400), `ownerCount(db)`, `atLeast(role, minRole)`.
- [ ] `deleteUserCascade`: add `members`, `invites` (by `created_by`); cascade test enumerates both.
- [ ] Tests: bootstrap picks the admin-role user over an earlier plain user; a legacy row is never owner; `setMember` rules (last owner, self grant, admin cannot touch owner, owner can); validation of each enum.

## Task 2 — `requireRole` and the admin call sites

**Files:** modify `extension/server/auth.mjs`, `extension/server.mjs` (3 sites), `extension/routes/extension-routes.mjs` (4 sites), `extension/server/auth-routes.mjs` (`/auth/me`); tests `extension/tests/auth.test.mjs`, `extension/tests/auth-routes.test.mjs`.

- [ ] `auth.mjs`:

```js
import { getMember, atLeast } from '../kb/members.mjs';

// Enforced team authority (ADR 0021). Reads the members row on every call: it is one indexed
// primary-key read, and a grant change must apply on the next request, not at the next login.
export function requireRole(db, req, minRole = 'admin') {
  if (!req.user) throw errForbidden('Authentication required');
  const m = getMember(db, req.user.id);
  if (!m || !atLeast(m.teamRole, minRole)) throw errForbidden(`Requires team role ${minRole}`, 'ROLE_DENIED');
  req.member = m;
  return m;
}
// Kept for one release so out-of-tree callers fail loudly instead of silently passing.
export function requireAdmin() { throw new Error('requireAdmin was replaced by requireRole(db, req, "admin") (ADR 0021)'); }
```

  (If `errForbidden` has no code parameter, set `err.code = 'ROLE_DENIED'` after creating it.)
- [ ] Replace every `requireAdmin(req)` with `requireRole(kb.getDb(), req, 'admin')` (use the db handle each site already has). `/metrics` stays `admin`.
- [ ] `GET /auth/me` adds `member: { teamRole, maxMode, usdCapMonth }` (null when no row; never for `legacy`).
- [ ] Tests: a `member` gets 403 `ROLE_DENIED` on `POST /admin/backup`; the owner passes; `/auth/me` carries `member`.

## Task 3 — Turn clamp, Host API grants, USD cap

**Files:** modify `extension/routes/agent-v2.mjs` (stream handler after mode resolution; `startHostTurn`), `extension/routes/host-api/gateway.mjs` (~418), `extension/kb/usage.mjs` (`usdCapForModel`, `setLimits`), `extension/routes/router.mjs:1100`; tests `extension/tests/agent-v2-team-clamp.test.mjs`, `extension/tests/host-api-gateway-grants.test.mjs` (extend the existing gateway test file if one exists), `extension/tests/usage-member-cap.test.mjs`.

- [ ] After `mode` is final in the stream handler:

```js
// ADR 0021: the member's highest run mode caps whatever the client or classifier chose.
const member = getMember(kb.getDb(), userId);
const maxMode = member?.maxMode ?? 'execute';
if (maxMode === 'none') {
  safeAudit(kb.getDb(), { userId, requestId, ip: clientIp(req), action: 'team.deny', outcome: 'denied', detail: { reason: 'max_mode_none' } });
  send(res, 403, { error: { code: 'ROLE_DENIED', message: 'Your team role cannot run turns' } });
  return;
}
if (maxMode === 'read_only' && !restrictsTools(mode)) {
  mode = clampToReadOnly(mode);
  body.permissionMode = null;
  bypassGrants.revoke(userId, chatSessionId);
}
```

- [ ] `startHostTurn`: refuse `max_mode='none'` with the same 403 shape (via `onEvent` error or a thrown `AppError`, whichever the gateway already maps to an error frame).
- [ ] Gateway pairing: `const member = getMember(db, pinUser); const served2 = (!member || member.maxMode === 'none' || member.teamRole === 'viewer') ? served.filter(c => ['host','read','push'].includes(c)) : served;` then use `served2` for scopes. Re-auth (`host.auth.token`, ~436) recomputes from the stored scopes ∩ the same filter, so a demoted member loses `chat` on the next connect.
- [ ] `usdCapForModel`: fold in `members.usd_cap_month` as in Global Constraints. `setLimits`: clamp `usd` rows for the month window to the member cap when the cap is non-zero.
- [ ] Tests: viewer → 403 and an audit row with no text; read_only + `execute` requested → runs `ask`; execute member unchanged; pairing as viewer yields `host, read, push` only; member cap 5 with model cap 0 → effective 5; both set → the smaller.

## Task 4 — Invites and invited registration

**Files:** modify `extension/kb/members.mjs` (invite helpers), `extension/server/users.mjs` (`registerUser` gains `{ invite }`), `extension/server/auth-routes.mjs` (`/auth/register`), `extension/core/config.mjs` (`hub`), `extension/server.mjs` (boot: hub closes registration); tests `extension/tests/auth-routes.test.mjs`, `extension/tests/config.test.mjs` (or the existing config test).

- [ ] `members.mjs`: `createInvite(db, actorId, { email, teamRole, maxMode, usdCapMonth, ttlHours = 24 })` → `{ id, token }` (token = 32 random bytes base64url, stored as sha256 hex; an admin cannot mint `owner`; an `admin` invite needs an owner actor); `listInvites(db)` (never the token); `revokeInvite(db, actorId, id)`; `consumeInvite(db, token, { email, userId })` (transaction: hash lookup, unexpired, unused, email matches when bound; sets `used_at`, `used_by`; returns the grants; throws `INVITE_INVALID` 400).
- [ ] `config.mjs`: `hub: envBool('LLMIDE_HUB', false)`; `computeRegistrationOpen` returns `false` when `LLMIDE_HUB` is on (document it in the function comment, replacing the "every user is an admin" sentence).
- [ ] `POST /auth/register`: body gains optional `invite` (string). When `config.registrationOpen` is false and a valid `invite` is given, register and `ensureMember` with the invite's grants (`grantedBy = created_by`), consume it, audit `auth.register` with `detail: { invite: id }`. When registration is open and no invite: `ensureMember` with `{ teamRole: 'member', maxMode: config.hub ? 'read_only' : 'execute', usdCapMonth: config.hub ? 20 : 0 }`. An invalid invite while closed → 403 `REGISTRATION_CLOSED` (do not reveal whether the token existed). The first user ever keeps becoming the owner.
- [ ] Tests: closed registration + valid invite registers a `member` `read_only` 20; used twice → 403; expired → 403; email-bound invite with another email → 403; hub mode closes registration; open registration without hub gives `execute`.

## Task 5 — Admin member and invite routes

**Files:** create `extension/routes/team-routes.mjs` (dispatched from `server.mjs` like `self-heal.mjs`, always on, no feature group); tests `extension/tests/team-routes.test.mjs`.

- [ ] Routes (JWT + `requireRole(db, req, 'admin')`, bucket `kbWrite` for writes):
  - `GET /admin/members` → `{ members: [{ userId, email, displayName, status, teamRole, maxMode, usdCapMonth, updatedAt }] }`
  - `PATCH /admin/members/:userId` `{ teamRole?, maxMode?, usdCapMonth? }` → `{ member }` (via `setMember`; audit `team.grant` with the patch as detail)
  - `POST /admin/invites` `{ email?, teamRole?, maxMode?, usdCapMonth?, ttlHours? }` → `{ id, token, expiresAt }` (token shown once; audit `team.invite`)
  - `GET /admin/invites` → `{ invites: [{ id, email, teamRole, maxMode, usdCapMonth, createdBy, createdAt, expiresAt, usedAt }] }`
  - `DELETE /admin/invites/:id` → `{ revoked }` (audit `team.invite.revoke`)
- [ ] Validation: closed objects, enums as in the migration, `usdCapMonth` 0–100000, `ttlHours` 1–168, `email` ≤ 254 chars.
- [ ] Tests: each route as owner, admin, member (403), unauthenticated (401); admin cannot patch the owner; owner cannot demote the last owner; token never appears in `GET /admin/invites`.

## Task 6 — Contract, API 123, docs, gates

**Files:** `schema/http/team.schema.json` + fixtures, the API bump checklist files, `docs/explanation/invariants.md` (new invariant "Team authority is enforced in `requireRole`, the turn clamp and the gateway filter; never per route"), `docs/spec/knowledge-base.md` (tables `members`, `invites`), `docs/superpowers/MASTER-PLAN.md` (tick the H1 row), the four "every user is an admin" sites.

- [ ] API bump checklist in full; `v123 — Team Hub H1 (ADR 0021) …` changelog line listing the five routes, the `/auth/me.member` field, the `invite` register field, the 403 `ROLE_DENIED` turn refusal and the pairing filter.
- [ ] Gates: `make test`, `make regression`, `make docs-check`, `node scripts/plan-status.mjs --check`, `node scripts/user-needs.mjs --check`.
- [ ] Push after the gates; `gh run list --limit 6`; fix red first.
