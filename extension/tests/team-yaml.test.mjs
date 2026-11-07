// Team Hub H1.1 (ADR 0021): auditable YAML user assignments. Parser/validator,
// first-boot generation, the undefined-account default, fail-closed invalid
// files, unknown emails, idempotence and the audit rows.
//
// The DB is a scratch file; every file case gets its own directory so no test
// can see another's team.yaml.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-team-yaml-'));
const tmpDb = path.join(root, 'kb.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const kb = await import('../kb/db.mjs');
const {
  DEFAULT_VIEWER_ASSIGNMENT, TeamYamlError, applyTeamYaml, listTeamAssignments,
  mergeTeamYamlAssignments, parseTeamYaml, persistTeamYaml, serializeTeamYaml,
} = await import('../kb/team-yaml.mjs');
const { applyTeamYamlAtBoot } = await import('../server/team-boot.mjs');
const { safeAudit } = await import('../server/route-http.mjs');

/** The boot adapter's audit shape, for the write-through tests (actor team.yaml, no request). */
const teamAudit = (entry) => safeAudit(kb.getDb(), {
  userId: entry.userId ?? null, requestId: 'team.yaml', ip: 'test', userAgent: 'team.yaml',
  action: entry.action, resource: entry.resource ?? null, outcome: entry.outcome ?? 'success',
  detail: { actor: 'team.yaml', ...(entry.detail ?? {}) },
});

const noopLogger = { info() {}, warn() {}, error() {} };
let seq = 0;
let caseNo = 0;

function reset() {
  kb.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmpDb + suffix, { force: true }); } catch { /* ignore */ }
  }
  kb.getDb();
}

function dir() {
  const d = path.join(root, `case-${++caseNo}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function addUser(email, grant = null) {
  const id = `u-${++seq}`;
  kb.getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, 'N', 'x', 'user', 'active')",
  ).run(id, email);
  if (grant) {
    kb.getDb().prepare(
      'INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, ?, ?, ?)',
    ).run(id, grant.teamRole, grant.maxMode, grant.usdCapMonth);
  }
  return id;
}

const grantOf = (userId) => {
  const row = kb.getDb().prepare(
    'SELECT team_role, max_mode, usd_cap_month FROM members WHERE user_id = ?',
  ).get(userId);
  return row ? { teamRole: row.team_role, maxMode: row.max_mode, usdCapMonth: row.usd_cap_month } : null;
};

function writeYaml(d, text) {
  fs.writeFileSync(path.join(d, 'team.yaml'), text, 'utf8');
}

const auditRows = (action) => kb.getDb().prepare(
  `SELECT user_id, request_id, user_agent, resource, outcome, detail
     FROM audit_log WHERE action = ? ORDER BY id`,
).all(action).map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));

const entry = (email, teamRole, maxMode, usdCapMonth) => ({ email, teamRole, maxMode, usdCapMonth });

// ── parser / validator ────────────────────────────────────────────────────

test('parse accepts the documented subset, comments and quoted scalars', () => {
  const text = [
    '# Team Hub assignments',
    'members: # only key',
    '',
    '  alice@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0 # no cap',
    '  "bob@example.com":',
    "    role: 'member'",
    '    max_mode: "read_only"',
    '    usd_cap_month: 20',
    '',
  ].join('\n');
  assert.deepEqual(parseTeamYaml(text), [
    entry('alice@example.com', 'owner', 'execute', 0),
    entry('bob@example.com', 'member', 'read_only', 20),
  ]);
});

test('parse rejects unknown keys, duplicates, missing grants and malformed values', () => {
  const cases = {
    'unknown top-level key': 'roles:\n  alice@example.com:\n    role: owner\n',
    'duplicate members': 'members:\nmembers:\n',
    'missing members': '# empty\n',
    'duplicate email (case-insensitive)': [
      'members:',
      '  a@example.com:',
      '    role: viewer',
      '    max_mode: read_only',
      '    usd_cap_month: 20',
      '  A@EXAMPLE.COM:',
      '    role: viewer',
      '    max_mode: read_only',
      '    usd_cap_month: 20',
    ].join('\n'),
    'unknown grant key': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: 20\n    projects: 1\n',
    'duplicate grant key': 'members:\n  a@example.com:\n    role: viewer\n    role: member\n    max_mode: read_only\n    usd_cap_month: 20\n',
    'missing grant': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: read_only\n',
    'unknown role': 'members:\n  a@example.com:\n    role: root\n    max_mode: execute\n    usd_cap_month: 0\n',
    'unknown max_mode': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: bypass\n    usd_cap_month: 0\n',
    'negative cap': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: -1\n',
    'cap over the maximum': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: 100001\n',
    'non-numeric cap': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: lots\n',
    'scientific notation cap': 'members:\n  a@example.com:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: 1e3\n',
    'missing value': 'members:\n  a@example.com:\n    role:\n    max_mode: read_only\n    usd_cap_month: 20\n',
    'flow map': 'members:\n  a@example.com:\n    role: {owner: 1}\n    max_mode: execute\n    usd_cap_month: 0\n',
    'tab indentation': 'members:\n\ta@example.com:\n',
    'odd indentation': 'members:\n   a@example.com:\n',
    'invalid email': 'members:\n  not-an-email:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: 20\n',
    'unterminated quote': 'members:\n  "a@example.com:\n    role: viewer\n    max_mode: read_only\n    usd_cap_month: 20\n',
    'text after quoted value': 'members:\n  a@example.com:\n    role: "viewer" x\n    max_mode: read_only\n    usd_cap_month: 20\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(
      () => parseTeamYaml(text),
      (err) => err instanceof TeamYamlError && err.code === 'TEAM_YAML_INVALID',
      name,
    );
  }
});

test('serializer validates, sorts by role then email and round-trips', () => {
  const text = serializeTeamYaml([
    entry('z@example.com', 'member', 'read_only', 20),
    entry('a@example.com', 'owner', 'execute', 0),
    entry('m@example.com', 'admin', 'none', 100_000),
  ]);
  assert.match(text, /^# Team Hub user assignments/);
  assert.deepEqual(parseTeamYaml(text), [
    entry('a@example.com', 'owner', 'execute', 0),
    entry('m@example.com', 'admin', 'none', 100_000),
    entry('z@example.com', 'member', 'read_only', 20),
  ]);
  assert.throws(() => serializeTeamYaml([entry('a@example.com', 'root', 'execute', 0)]),
    (err) => err instanceof TeamYamlError);
  assert.throws(() => serializeTeamYaml([entry('not-an-email', 'viewer', 'read_only', 20)]),
    (err) => err instanceof TeamYamlError);
});

// ── first boot ────────────────────────────────────────────────────────────

test('first boot generates team.yaml from current members and preserves the solo owner', () => {
  reset();
  const d = dir();
  const owner = addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const admin = addUser('admin@example.com', { teamRole: 'admin', maxMode: 'read_only', usdCapMonth: 5 });
  const loose = addUser('loose@example.com');

  const result = applyTeamYaml(kb.getDb(), d, { logger: noopLogger });
  assert.equal(result.created, true);
  assert.equal(result.source, 'generated');

  const file = path.join(d, 'team.yaml');
  assert.ok(fs.existsSync(file), 'the file is written on first boot');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(parseTeamYaml(fs.readFileSync(file, 'utf8')), [
    entry('owner@example.com', 'owner', 'execute', 0),
    entry('admin@example.com', 'admin', 'read_only', 5),
    entry('loose@example.com', 'viewer', 'read_only', 20),
  ]);

  // The solo owner stays owner, other existing grants are untouched, and a user
  // without a members row gets the least-privilege row.
  assert.deepEqual(grantOf(owner), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  assert.deepEqual(grantOf(admin), { teamRole: 'admin', maxMode: 'read_only', usdCapMonth: 5 });
  assert.deepEqual(grantOf(loose), { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 20 });
  assert.deepEqual(listTeamAssignments(kb.getDb()).map((a) => a.email),
    ['admin@example.com', 'loose@example.com', 'owner@example.com']);
});

test('a second boot applies the same file without rewriting it or changing a row', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  addUser('member@example.com', { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });

  const first = applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger });
  assert.equal(first.created, true);
  const file = path.join(d, 'team.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const applyRows = auditRows('team.yaml.apply').length;

  const second = applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger });
  assert.equal(second.created, false);
  assert.equal(second.source, 'file');
  assert.equal(second.changes.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'an existing file is never rewritten');
  assert.equal(auditRows('team.yaml.apply').length, applyRows, 'no audit row without a change');
  assert.equal(auditRows('team.yaml.generate').length, 1);
});

// ── write-through (R-013#2) ───────────────────────────────────────────────

test('persistTeamYaml writes the DB authority through, preserving manual entries and full-line comments', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const member = addUser('member@example.com', { teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20 });
  // A file the user has edited: a future account's grant plus a comment. The API write must not lose either.
  writeYaml(d, [
    '# prepared for the new hire',
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  future@example.com:',
    '    role: admin',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  member@example.com:',
    '    role: viewer',           // the stale pre-PATCH grant
    '    max_mode: read_only',
    '    usd_cap_month: 9',
  ].join('\n'));
  // What PATCH wrote to the DB before the file write-through.
  kb.getDb().prepare("UPDATE members SET team_role = 'admin', max_mode = 'execute', usd_cap_month = 7 WHERE user_id = ?").run(member);

  const result = persistTeamYaml(kb.getDb(), d, { trigger: 'admin.patch', audit: teamAudit });
  assert.equal(result.users, 2);
  assert.equal(result.preserved, 1, 'the future (unknown-email) entry is kept');
  const text = fs.readFileSync(path.join(d, 'team.yaml'), 'utf8');
  assert.match(text, /^# prepared for the new hire$/m, 'the user comment survives');
  assert.deepEqual(parseTeamYaml(text), [
    entry('owner@example.com', 'owner', 'execute', 0),
    entry('future@example.com', 'admin', 'execute', 0),
    entry('member@example.com', 'admin', 'execute', 7),
  ], 'the DB wins for a listed account, the manual entry is preserved');
  assert.equal(fs.statSync(path.join(d, 'team.yaml')).mode & 0o777, 0o600);
  const writeRows = auditRows('team.yaml.write');
  assert.equal(writeRows.length, 1);
  assert.equal(writeRows[0].user_agent, 'team.yaml');
  assert.equal(writeRows[0].detail.actor, 'team.yaml');
  assert.equal(writeRows[0].detail.trigger, 'admin.patch');
  assert.equal(writeRows[0].detail.users, 2);
  assert.equal(writeRows[0].detail.preserved, 1);
});

test('persistTeamYaml refuses to overwrite an invalid file and leaves every grant to the boot', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const invalid = 'members:\n  owner@example.com:\n    role: root\n    max_mode: execute\n    usd_cap_month: 0\n';
  writeYaml(d, invalid);
  assert.throws(
    () => persistTeamYaml(kb.getDb(), d, { trigger: 'admin.patch', audit: teamAudit }),
    (err) => err instanceof TeamYamlError && err.code === 'TEAM_YAML_INVALID',
  );
  assert.equal(fs.readFileSync(path.join(d, 'team.yaml'), 'utf8'), invalid, 'the audited file is not clobbered');
  const rows = auditRows('team.yaml.invalid');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failure');
});

test('mergeTeamYamlAssignments keeps an unknown email but never a stale grant for a known account', () => {
  const merged = mergeTeamYamlAssignments([
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  ghost@example.com:',
    '    role: viewer',
    '    max_mode: read_only',
    '    usd_cap_month: 3',
  ].join('\n'), [entry('owner@example.com', 'admin', 'none', 0)]);
  assert.deepEqual(merged.assignments, [
    entry('owner@example.com', 'admin', 'none', 0),
    entry('ghost@example.com', 'viewer', 'read_only', 3),
  ]);
  assert.deepEqual(merged.preserved.map((a) => a.email), ['ghost@example.com']);
  assert.deepEqual(mergeTeamYamlAssignments(null, []).assignments, []);
});

// ── undefined accounts ────────────────────────────────────────────────────

test('an account not listed in the file becomes viewer / read_only / 20', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const member = addUser('member@example.com', { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });
  writeYaml(d, [
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
  ].join('\n'));

  const result = applyTeamYaml(kb.getDb(), d, { logger: noopLogger });
  assert.deepEqual(grantOf(member), DEFAULT_VIEWER_ASSIGNMENT);
  assert.deepEqual(result.changes, [{
    userId: member,
    email: 'member@example.com',
    from: { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 },
    to: { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 20 },
  }]);
});

test('a user without a members row is created as a viewer, or with the listed grant', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const unlisted = addUser('unlisted@example.com');
  const listed = addUser('listed@example.com');
  writeYaml(d, [
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  listed@example.com:',
    '    role: admin',
    '    max_mode: execute',
    '    usd_cap_month: 3',
  ].join('\n'));

  applyTeamYaml(kb.getDb(), d, { logger: noopLogger });
  assert.deepEqual(grantOf(unlisted), { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 20 });
  assert.deepEqual(grantOf(listed), { teamRole: 'admin', maxMode: 'execute', usdCapMonth: 3 });
});

// ── fail closed + unknown emails ─────────────────────────────────────────

test('an invalid file refuses the boot and leaves every grant unchanged', () => {
  reset();
  const d = dir();
  const owner = addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  writeYaml(d, 'members:\n  owner@example.com:\n    role: root\n    max_mode: execute\n    usd_cap_month: 0\n');

  assert.throws(
    () => applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger }),
    (err) => err instanceof TeamYamlError && err.code === 'TEAM_YAML_INVALID',
  );
  assert.deepEqual(grantOf(owner), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const rows = auditRows('team.yaml.invalid');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failure');
  assert.equal(rows[0].user_agent, 'team.yaml');
  assert.equal(rows[0].detail.actor, 'team.yaml');
  assert.ok(rows[0].detail.line > 0);
});

test('an unknown email is ignored, never creates a user, and is audited', () => {
  reset();
  const d = dir();
  const owner = addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  writeYaml(d, [
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  ghost@example.com:',
    '    role: admin',
    '    max_mode: execute',
    '    usd_cap_month: 0',
  ].join('\n'));

  const result = applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger });
  assert.deepEqual(result.unknownEmails, ['ghost@example.com']);
  assert.equal(kb.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ghost@example.com'").get().n, 0);
  assert.equal(kb.getDb().prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = 'ghost'").get().n, 0);
  assert.deepEqual(grantOf(owner), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const rows = auditRows('team.yaml.unknown_email');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failure');
  assert.equal(rows[0].detail.email, 'ghost@example.com');
});

// ── audit ─────────────────────────────────────────────────────────────────

test('every actual change is audited with actor team.yaml and from/to only', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const member = addUser('member@example.com', { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });
  writeYaml(d, [
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  member@example.com:',
    '    role: viewer',
    '    max_mode: read_only',
    '    usd_cap_month: 7',
  ].join('\n'));

  applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger });
  const rows = auditRows('team.yaml.apply');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, member);
  assert.equal(rows[0].resource, member);
  assert.equal(rows[0].request_id, 'team.yaml');
  assert.equal(rows[0].user_agent, 'team.yaml');
  assert.equal(rows[0].outcome, 'success');
  assert.deepEqual(rows[0].detail, {
    actor: 'team.yaml',
    email: 'member@example.com',
    from: { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 },
    to: { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 7 },
  });
  assert.ok(!JSON.stringify(rows[0].detail).includes('prompt'), 'never message text');
});

// ── fail closed: zero owners (R-012#2) ───────────────────────────────────

// ── fresh install: deferred generation, then the first owner ─────────────

test('a fresh install with no real accounts defers generation (no empty file)', () => {
  reset();
  const d = dir();
  const file = path.join(d, 'team.yaml');
  const events = [];
  const logger = { info: (event, detail) => events.push({ event, detail }), warn() {} };
  // Only the synthetic `legacy` user exists. An empty file would become authoritative at the next boot
  // and demote the first registered owner (and the no_owner guard would refuse that boot).
  const result = applyTeamYaml(kb.getDb(), d, { logger });
  assert.equal(result.deferred, true);
  assert.equal(result.created, false);
  assert.equal(result.source, 'deferred');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(events.map((e) => e.event), ['team_yaml_deferred']);
  assert.equal(events[0].detail.reason, 'no_real_users');
});

test('the first real account makes the next boot generate team.yaml; the boot after is idempotent', () => {
  reset();
  const d = dir();
  const file = path.join(d, 'team.yaml');
  assert.equal(applyTeamYaml(kb.getDb(), d, { logger: noopLogger }).deferred, true);

  // What the first registration does: the first real account becomes the owner (auth-routes).
  const owner = addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  const generated = applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger });
  assert.equal(generated.created, true);
  assert.equal(generated.deferred, false);
  assert.equal(generated.source, 'generated');
  assert.deepEqual(parseTeamYaml(fs.readFileSync(file, 'utf8')),
    [entry('owner@example.com', 'owner', 'execute', 0)]);
  assert.deepEqual(grantOf(owner), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });

  // A second boot applies the same file without rewriting it or generating again.
  const text = fs.readFileSync(file, 'utf8');
  const generateRows = auditRows('team.yaml.generate').length;
  const again = applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger });
  assert.equal(again.created, false);
  assert.equal(again.source, 'file');
  assert.equal(again.changes.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'an existing file is never rewritten');
  assert.equal(auditRows('team.yaml.generate').length, generateRows, 'no second generate');
});

test('a file that would leave no owner refuses the boot and rolls back every change', () => {
  const cases = {
    'owner email typo': [
      'members:',
      '  ownerr@example.com:',
      '    role: owner',
      '    max_mode: execute',
      '    usd_cap_month: 0',
      '  member@example.com:',
      '    role: admin',
      '    max_mode: execute',
      '    usd_cap_month: 0',
    ].join('\n'),
    'owner listed with another role': [
      'members:',
      '  owner@example.com:',
      '    role: admin',
      '    max_mode: execute',
      '    usd_cap_month: 0',
    ].join('\n'),
    'empty members': 'members:\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    reset();
    const d = dir();
    const owner = addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
    const member = addUser('member@example.com', { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });
    writeYaml(d, text);

    assert.throws(
      () => applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger: noopLogger }),
      (err) => err instanceof TeamYamlError && err.code === 'TEAM_YAML_INVALID' && err.reason === 'no_owner',
      name,
    );
    // The guard throws INSIDE the transaction: no partial grant change survives, not even a promotion.
    assert.deepEqual(grantOf(owner), { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 }, `${name}: owner unchanged`);
    assert.deepEqual(grantOf(member), { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 }, `${name}: member unchanged`);
    const rows = auditRows('team.yaml.invalid');
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].outcome, 'failure', name);
    assert.equal(rows[0].detail.reason, 'no_owner', name);
    assert.equal(rows[0].user_agent, 'team.yaml', name);
  }
});

// ── downgrade warning (R-012#6) ──────────────────────────────────────────

test('every boot-time downgrade logs one warning; an upgrade logs none', () => {
  reset();
  const d = dir();
  addUser('owner@example.com', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  addUser('admin@example.com', { teamRole: 'admin', maxMode: 'execute', usdCapMonth: 0 });
  addUser('viewer@example.com', { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 20 });
  writeYaml(d, [
    'members:',
    '  owner@example.com:',
    '    role: owner',
    '    max_mode: execute',
    '    usd_cap_month: 0',
    '  admin@example.com:',
    '    role: viewer',
    '    max_mode: read_only',
    '    usd_cap_month: 5',
    '  viewer@example.com:',
    '    role: admin',
    '    max_mode: execute',
    '    usd_cap_month: 0',
  ].join('\n'));

  const warnings = [];
  const logger = { info() {}, warn: (event, detail) => warnings.push({ event, detail }) };
  applyTeamYamlAtBoot({ db: kb.getDb(), dir: d, logger });

  const downgrades = warnings.filter((w) => w.event === 'team_yaml_downgrade');
  assert.equal(downgrades.length, 1, 'one per narrowed account, none for the promoted one');
  assert.equal(downgrades[0].detail.email, 'admin@example.com');
  assert.deepEqual(downgrades[0].detail.from, { teamRole: 'admin', maxMode: 'execute', usdCapMonth: 0 });
  assert.deepEqual(downgrades[0].detail.to, { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 5 });
  assert.match(downgrades[0].detail.message, /authoritative at every boot/);
});

after(() => {
  kb.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
