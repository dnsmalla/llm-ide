// Tests for kb/members.mjs + migration 0068 (ADR 0021). The bootstrap SQL is
// re-run here after seeding users: on a fresh DB the migration has no users to
// promote, so this is the only way to exercise the ordering rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_members-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const members = await import('../kb/members.mjs');
const { ROLE_ORDER, getMember, listMembers, ensureMember, setMember, ownerCount, atLeast, assertDeletable } =
  members;

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'kb', 'migrations', '0068_team_members.sql'), 'utf8',
);

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

let seq = 0;
function seedUser({ id, email, role = 'user', status = 'active', createdAt = '2026-01-01 00:00:00' }) {
  const handle = db.getDb();
  handle.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, status, created_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?)`,
  ).run(id ?? `u-${++seq}`, email ?? `u${seq}@example.com`, 'Name', role, status, createdAt);
  return id ?? `u-${seq}`;
}

function seedMember(userId, teamRole, maxMode = 'execute', usdCapMonth = 0) {
  db.getDb().prepare(
    'INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, ?, ?, ?)',
  ).run(userId, teamRole, maxMode, usdCapMonth);
  return userId;
}

/** Re-run 0068's bootstrap statements (idempotent by design) over the seeded users. */
function rerunBootstrap() {
  db.getDb().exec(MIGRATION_SQL);
}

const code = (c) => (e) => e.code === c;

// ── Bootstrap ──────────────────────────────────────────────────────────────

test('bootstrap makes the admin-role user owner even when a plain user came first', () => {
  reset();
  const first = seedUser({ email: 'first@example.com', role: 'user',  createdAt: '2026-01-01 00:00:00' });
  const admin = seedUser({ email: 'admin@example.com', role: 'admin', createdAt: '2026-02-01 00:00:00' });
  rerunBootstrap();

  assert.equal(getMember(db.getDb(), admin).teamRole, 'owner');
  assert.equal(getMember(db.getDb(), admin).maxMode, 'execute');
  assert.equal(getMember(db.getDb(), admin).usdCapMonth, 0);
  assert.equal(getMember(db.getDb(), first).teamRole, 'member');
  // No regression: everyone else keeps full power.
  assert.equal(getMember(db.getDb(), first).maxMode, 'execute');
  assert.equal(ownerCount(db.getDb()), 1);
});

test('bootstrap takes the earliest active user within the same role', () => {
  reset();
  const earlier = seedUser({ email: 'earlier@example.com', createdAt: '2026-01-01 00:00:00' });
  const later = seedUser({ email: 'later@example.com', createdAt: '2026-03-01 00:00:00' });
  rerunBootstrap();
  assert.equal(getMember(db.getDb(), earlier).teamRole, 'owner');
  assert.equal(getMember(db.getDb(), later).teamRole, 'member');
});

test('a disabled admin does not outrank the earliest active plain user', () => {
  reset();
  const disabledAdmin = seedUser({ email: 'off@example.com', role: 'admin', status: 'disabled', createdAt: '2026-01-01 00:00:00' });
  const active = seedUser({ email: 'on@example.com', createdAt: '2026-02-01 00:00:00' });
  rerunBootstrap();
  assert.equal(getMember(db.getDb(), active).teamRole, 'owner');
  assert.equal(getMember(db.getDb(), disabledAdmin).teamRole, 'member');
});

test('the legacy row is never the owner and never gets a members row', () => {
  reset();
  const handle = db.getDb();
  // Migration 0002 seeds the disabled `legacy` row on every fresh DB.
  const legacy = handle.prepare("SELECT id, role, status FROM users WHERE id = 'legacy'").get();
  assert.deepEqual(legacy, { id: 'legacy', role: 'user', status: 'disabled' });
  const real = seedUser({ email: 'real@example.com', createdAt: '2026-01-01 00:00:00' });
  rerunBootstrap();

  assert.equal(getMember(handle, 'legacy'), null);
  assert.equal(getMember(handle, real).teamRole, 'owner');
});

test('bootstrap on an install with no real user promotes nobody', () => {
  reset();
  rerunBootstrap();
  assert.equal(ownerCount(db.getDb()), 0);
});

test('migration creates the invites table with the ADR 0021 enums', () => {
  reset();
  const handle = db.getDb();
  // The CHECK constraints reject an unknown role / mode.
  assert.throws(() => handle.prepare(
    "INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES ('nope', 'root', 'execute', 0)",
  ).run(), /CHECK/);
  const u = seedUser({ email: 'invitee@example.com' });
  assert.throws(() => handle.prepare(
    "INSERT INTO invites (id, token_hash, team_role, created_by, expires_at) VALUES ('i1', 'h1', 'owner', ?, datetime('now'))",
  ).run(u), /CHECK/);
});

// ── getMember / listMembers / ensureMember ─────────────────────────────────

test('getMember returns null without a row and the camelCase grant with one', () => {
  reset();
  const u = seedUser({ email: 'member@example.com' });
  assert.equal(getMember(db.getDb(), u), null);
  seedMember(u, 'viewer', 'read_only', 5);
  assert.deepEqual(getMember(db.getDb(), u), { userId: u, teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 5 });
});

test('listMembers orders by role then email and joins the users row', () => {
  reset();
  const memberB = seedUser({ email: 'b@example.com' });
  const owner = seedUser({ email: 'z@example.com' });
  const memberA = seedUser({ email: 'a@example.com' });
  const admin = seedUser({ email: 'y@example.com' });
  seedMember(memberB, 'member', 'execute', 0);
  seedMember(owner, 'owner', 'execute', 0);
  seedMember(memberA, 'member', 'read_only', 20);
  seedMember(admin, 'admin', 'execute', 10);

  const rows = listMembers(db.getDb());
  assert.deepEqual(rows.map((r) => r.email), ['z@example.com', 'y@example.com', 'a@example.com', 'b@example.com']);
  assert.equal(rows[0].teamRole, 'owner');
  assert.equal(rows[2].maxMode, 'read_only');
  assert.equal(rows[2].usdCapMonth, 20);
  assert.equal(rows[2].status, 'active');
  assert.ok(rows[2].displayName);
  assert.ok(rows[2].updatedAt);
});

test('ensureMember inserts once and never overwrites an existing grant', () => {
  reset();
  const u = seedUser({ email: 'ensure@example.com' });
  const created = ensureMember(db.getDb(), u, { teamRole: 'viewer', maxMode: 'none', usdCapMonth: 1, grantedBy: null });
  assert.equal(created.teamRole, 'viewer');
  const again = ensureMember(db.getDb(), u, { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  assert.equal(again.teamRole, 'viewer');
  assert.equal(again.maxMode, 'none');
  assert.equal(again.usdCapMonth, 1);
});

test('ensureMember validates its enums', () => {
  reset();
  const u = seedUser({ email: 'bad-ensure@example.com' });
  assert.throws(() => ensureMember(db.getDb(), u, { teamRole: 'root' }), code('VALIDATION'));
  assert.throws(() => ensureMember(db.getDb(), u, { maxMode: 'write' }), code('VALIDATION'));
  assert.throws(() => ensureMember(db.getDb(), u, { usdCapMonth: -1 }), code('VALIDATION'));
});

// ── setMember rules ────────────────────────────────────────────────────────

test('owner can change a member role, mode and cap', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'owner@example.com' }), 'owner');
  const target = seedMember(seedUser({ email: 'target@example.com' }), 'member', 'execute', 0);
  const out = setMember(db.getDb(), owner, target, { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 5 });
  assert.deepEqual(out, { userId: target, teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 5 });
});

test('an admin can change members but not an owner, and cannot make one', () => {
  reset();
  const admin = seedMember(seedUser({ email: 'admin@example.com' }), 'admin');
  const owner = seedMember(seedUser({ email: 'owner@example.com' }), 'owner');
  const member = seedMember(seedUser({ email: 'm@example.com' }), 'member');

  assert.equal(setMember(db.getDb(), admin, member, { maxMode: 'none' }).maxMode, 'none');
  assert.throws(() => setMember(db.getDb(), admin, owner, { maxMode: 'none' }), code('ROLE_DENIED'));
  assert.throws(() => setMember(db.getDb(), admin, member, { teamRole: 'owner' }), code('ROLE_DENIED'));
  // Granting `admin` is allowed for an admin.
  assert.equal(setMember(db.getDb(), admin, member, { teamRole: 'admin' }).teamRole, 'admin');
});

test('an owner can promote a second owner, and either can then be demoted', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'o1@example.com' }), 'owner');
  const other = seedMember(seedUser({ email: 'o2@example.com' }), 'member');
  setMember(db.getDb(), owner, other, { teamRole: 'owner' });
  assert.equal(ownerCount(db.getDb()), 2);
  assert.equal(setMember(db.getDb(), owner, other, { teamRole: 'member' }).teamRole, 'member');
});

test('the last owner cannot be demoted (LAST_OWNER 409)', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'only@example.com' }), 'owner');
  // The only owner demoting themselves is refused before SELF_GRANT, with the code the UI shows.
  let thrown = null;
  try { setMember(db.getDb(), owner, owner, { teamRole: 'admin' }); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected a refusal');
  assert.equal(thrown.code, 'LAST_OWNER');
  assert.equal(thrown.status, 409);
});

test('the last-owner guard does not fire once a second owner exists', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'o1@example.com' }), 'owner');
  const second = seedMember(seedUser({ email: 'o2@example.com' }), 'owner');
  setMember(db.getDb(), owner, second, { teamRole: 'member' });
  assert.equal(getMember(db.getDb(), second).teamRole, 'member');
  assert.equal(ownerCount(db.getDb()), 1);
});

test('a user cannot change their own role or grants (SELF_GRANT 403)', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'self@example.com' }), 'owner');
  assert.throws(() => setMember(db.getDb(), owner, owner, { maxMode: 'read_only' }), code('SELF_GRANT'));
  // With a second owner the last-owner guard no longer fires, so the self-grant rule answers.
  seedMember(seedUser({ email: 'peer@example.com' }), 'owner');
  assert.throws(() => setMember(db.getDb(), owner, owner, { teamRole: 'admin' }), code('SELF_GRANT'));
});

test('a member or viewer cannot change anyone (ROLE_DENIED 403)', () => {
  reset();
  const member = seedMember(seedUser({ email: 'plain@example.com' }), 'member');
  const viewer = seedMember(seedUser({ email: 'viewer@example.com' }), 'viewer');
  const owner = seedMember(seedUser({ email: 'boss@example.com' }), 'owner');
  assert.throws(() => setMember(db.getDb(), member, owner, { maxMode: 'none' }), code('ROLE_DENIED'));
  assert.throws(() => setMember(db.getDb(), viewer, member, { maxMode: 'none' }), code('ROLE_DENIED'));
  // No members row at all = no authority.
  const nobody = seedUser({ email: 'nobody@example.com' });
  assert.throws(() => setMember(db.getDb(), nobody, member, { maxMode: 'none' }), code('ROLE_DENIED'));
});

test('setMember validates every enum and rejects an empty patch', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'v@example.com' }), 'owner');
  const target = seedMember(seedUser({ email: 't@example.com' }), 'member');
  assert.throws(() => setMember(db.getDb(), owner, target, { teamRole: 'root' }), code('VALIDATION'));
  assert.throws(() => setMember(db.getDb(), owner, target, { maxMode: 'bypass' }), code('VALIDATION'));
  assert.throws(() => setMember(db.getDb(), owner, target, { usdCapMonth: -1 }), code('VALIDATION'));
  assert.throws(() => setMember(db.getDb(), owner, target, { usdCapMonth: 100_001 }), code('VALIDATION'));
  assert.throws(() => setMember(db.getDb(), owner, target, { usdCapMonth: 'lots' }), code('VALIDATION'));
  assert.throws(() => setMember(db.getDb(), owner, target, {}), code('VALIDATION'));
  assert.throws(() => setMember(db.getDb(), owner, 'no-such-user', { maxMode: 'none' }), code('NOT_FOUND'));
});

// ── assertDeletable (R-009#1) ───────────────────────────────────────────────

test('an admin cannot delete an owner; an owner may delete another owner', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'del-owner@example.com' }), 'owner');
  const second = seedMember(seedUser({ email: 'del-owner2@example.com' }), 'owner');
  const admin = seedMember(seedUser({ email: 'del-admin@example.com' }), 'admin');
  assert.throws(() => assertDeletable(db.getDb(), admin, owner), code('ROLE_DENIED'));
  assert.throws(() => assertDeletable(db.getDb(), admin, owner), (e) => e.status === 403);
  assert.doesNotThrow(() => assertDeletable(db.getDb(), owner, second));
});

test('the last owner cannot delete themselves; with a second owner either may', () => {
  reset();
  const owner = seedMember(seedUser({ email: 'del-last@example.com' }), 'owner');
  assert.throws(() => assertDeletable(db.getDb(), owner, owner), code('LAST_OWNER'));
  const second = seedMember(seedUser({ email: 'del-peer@example.com' }), 'owner');
  assert.doesNotThrow(() => assertDeletable(db.getDb(), owner, owner));
  assert.doesNotThrow(() => assertDeletable(db.getDb(), second, second));
});

test('a non-owner target and a target without a members row are always deletable', () => {
  reset();
  const admin = seedMember(seedUser({ email: 'del-admin2@example.com' }), 'admin');
  const member = seedMember(seedUser({ email: 'del-member@example.com' }), 'member');
  const noRow = seedUser({ email: 'del-norow@example.com' });
  assert.doesNotThrow(() => assertDeletable(db.getDb(), admin, member));
  assert.doesNotThrow(() => assertDeletable(db.getDb(), admin, noRow));
  assert.doesNotThrow(() => assertDeletable(db.getDb(), member, member));
});

test('atLeast follows the role order and refuses unknown roles', () => {
  assert.equal(atLeast('owner', 'admin'), true);
  assert.equal(atLeast('admin', 'admin'), true);
  assert.equal(atLeast('member', 'admin'), false);
  assert.equal(atLeast('viewer', 'member'), false);
  assert.equal(atLeast('root', 'member'), false);
  assert.equal(atLeast('member', 'root'), false);
  assert.deepEqual(ROLE_ORDER, { viewer: 0, member: 1, admin: 2, owner: 3 });
});

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
