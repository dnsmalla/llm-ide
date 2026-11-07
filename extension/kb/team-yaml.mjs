// Team Hub H1.1 (ADR 0021): auditable YAML user assignments.
//
// The file is the user's authority ledger, applied once at core boot:
//
//   <data dir>/team.yaml
//
// `members:` maps lower-cased account emails to exactly three grants (role,
// max_mode, usd_cap_month). An account NOT listed is a viewer with
// `read_only` and a 20 USD/month cap. The file holds USER ASSIGNMENTS ONLY;
// the permissions of a role stay in code (`members.mjs`, `requireRole`, the
// turn clamp, the gateway filter).
//
// The first boot that sees a real (non-legacy) account writes the file from
// the current `members` rows (so a solo owner stays owner) and never rewrites
// it afterwards. An install with no real accounts yet DEFERS generation:
// writing an empty file would make it authoritative at the next boot and
// demote the first registered owner (and the no_owner guard would refuse that
// boot), so the file appears on the first boot after registration. Later boots
// parse the user's file, apply it in one transaction and audit every actual
// change. An invalid file refuses the boot instead of running with stale or
// wider grants; unknown emails are reported and ignored (no user is ever
// created).
//
// The parser/serializer are a deliberately small, strict YAML subset: only
// `members:` → `<email>:` → the three scalar keys, two-space indentation,
// `#` comments, no anchors, aliases, sequences or flow maps. Unknown keys,
// duplicate emails/fields, tabs and malformed values are errors. No
// dependency is added for this schema.
//
// WRITE-THROUGH (R-013#2): because the file is authoritative at every boot,
// an admin-UI grant or an invited member's grant that the file did not repeat
// was reset by the next restart. So `PATCH /admin/members` and an invited
// registration call `persistTeamYaml` after their DB transaction: it rewrites
// the file atomically (0600, same generation path) from the current `members`
// rows, preserving entries for emails that have no account yet and the
// existing full-line comments. The request fails (and the grant / registration
// is rolled back) when the write fails, so DB and file never diverge on a
// completed request. The file stays the authority; an edit made while the core
// runs is replaced by the next API grant change, and applies at the next boot.
//
// Layer note: every db-writing helper takes the db handle first (kb
// convention). The module may not import `server/audit.mjs` (kb → core/kb
// only), so `applyTeamYaml` accepts an `audit` callback; the boot adapter
// (`server/team-boot.mjs`) supplies the existing `safeAudit` helper.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROLE_ORDER, MAX_MODES, MAX_USD_CAP_MONTH, getMember, ownerCount } from './members.mjs';

export const TEAM_YAML_FILENAME = 'team.yaml';

/** What an account that is absent from the file becomes. */
export const DEFAULT_VIEWER_ASSIGNMENT = Object.freeze({
  teamRole: 'viewer',
  maxMode: 'read_only',
  usdCapMonth: 20,
});

const ROLES = new Set(Object.keys(ROLE_ORDER));
const MODES = new Set(MAX_MODES);
// Rank of each max_mode, for the downgrade warning (none < read_only < execute).
const MODE_ORDER = Object.freeze(Object.fromEntries(MAX_MODES.map((mode, i) => [mode, i])));
const ENTRY_KEYS = new Set(['role', 'max_mode', 'usd_cap_month']);
const TOP_KEY = 'members';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAP_RE = /^\d+(?:\.\d+)?$/;
const MAX_EMAIL = 254;

export class TeamYamlError extends Error {
  constructor(message, { reason = 'invalid', line = null } = {}) {
    super(message);
    this.name = 'TeamYamlError';
    this.code = 'TEAM_YAML_INVALID';
    this.reason = reason;
    this.line = line;
  }
}

const invalid = (message, line = null, reason = 'invalid') =>
  new TeamYamlError(message, { reason, line });

// ── parser ────────────────────────────────────────────────────────────────

/**
 * Parse and validate the team.yaml text. Returns `[{ email, teamRole,
 * maxMode, usdCapMonth }]` sorted as written. Throws `TeamYamlError`
 * (`code: 'TEAM_YAML_INVALID'`) on anything outside the strict subset.
 */
export function parseTeamYaml(text) {
  if (typeof text !== 'string') throw invalid('team.yaml must be text', null, 'not_text');
  const source = text.replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  const assignments = [];
  const byEmail = new Map();
  let seenTop = false;
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const raw = lines[index];
    if (raw.includes('\t')) throw invalid('tabs are not allowed; indent with spaces', lineNo);
    const line = stripComment(raw, lineNo);
    if (line.trim() === '') continue;

    const indent = /^ */.exec(line)[0].length;
    if (indent % 2 !== 0) throw invalid('indentation must be a multiple of two spaces', lineNo);
    const depth = indent / 2;
    const content = line.slice(indent).trimEnd();

    if (depth === 0) {
      if (content !== `${TOP_KEY}:`) {
        const key = content.split(':')[0];
        throw invalid(`unknown top-level key "${key}" (only "${TOP_KEY}")`, lineNo);
      }
      if (seenTop) throw invalid(`duplicate "${TOP_KEY}:"`, lineNo);
      seenTop = true;
      current = null;
      continue;
    }

    if (!seenTop) throw invalid(`expected "${TOP_KEY}:" at the top level`, lineNo);

    if (depth === 1) {
      const match = /^(.+):$/.exec(content);
      if (!match) throw invalid('expected "<email>:" with no value', lineNo);
      const email = parseScalar(match[1].trim(), lineNo).trim().toLowerCase();
      if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
        throw invalid(`invalid email "${email}"`, lineNo);
      }
      if (byEmail.has(email)) throw invalid(`duplicate email "${email}"`, lineNo);
      current = { email, teamRole: null, maxMode: null, usdCapMonth: null, line: lineNo };
      assignments.push(current);
      byEmail.set(email, current);
      continue;
    }

    if (depth === 2) {
      if (!current) throw invalid('a grant line must follow an email', lineNo);
      const match = /^([a-z_]+):\s*(.*)$/.exec(content);
      if (!match) throw invalid('expected "<key>: <value>"', lineNo);
      const key = match[1];
      if (!ENTRY_KEYS.has(key)) throw invalid(`unknown grant key "${key}"`, lineNo);
      const value = parseScalar(match[2].trim(), lineNo);
      if (key === 'role') {
        if (current.teamRole !== null) throw invalid('duplicate "role"', lineNo);
        if (!ROLES.has(value)) throw invalid(`unknown role "${value}"`, lineNo);
        current.teamRole = value;
      } else if (key === 'max_mode') {
        if (current.maxMode !== null) throw invalid('duplicate "max_mode"', lineNo);
        if (!MODES.has(value)) throw invalid(`unknown max_mode "${value}"`, lineNo);
        current.maxMode = value;
      } else {
        if (current.usdCapMonth !== null) throw invalid('duplicate "usd_cap_month"', lineNo);
        if (!CAP_RE.test(value)) throw invalid('usd_cap_month must be a non-negative number', lineNo);
        const cap = Number(value);
        if (!Number.isFinite(cap) || cap < 0 || cap > MAX_USD_CAP_MONTH) {
          throw invalid(`usd_cap_month must be between 0 and ${MAX_USD_CAP_MONTH}`, lineNo);
        }
        current.usdCapMonth = cap;
      }
      continue;
    }

    throw invalid('unexpected indentation', lineNo);
  }

  if (!seenTop) throw invalid(`missing "${TOP_KEY}:"`, null, 'missing_members');
  if (assignments.length === 0) return [];
  for (const assignment of assignments) {
    if (assignment.teamRole === null || assignment.maxMode === null || assignment.usdCapMonth === null) {
      throw invalid(
        `entry "${assignment.email}" needs role, max_mode and usd_cap_month`,
        assignment.line,
        'missing_grant',
      );
    }
  }
  return assignments.map(({ line: _line, ...assignment }) => assignment);
}

/**
 * Remove a `#` comment that is outside quotes. A `#` only starts a comment at
 * the start of a line or after whitespace (YAML's rule); an unclosed quote is
 * an error, so a malformed line cannot silently lose its remainder.
 */
function stripComment(raw, lineNo) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote === "'") {
      if (char === "'") {
        if (raw[i + 1] === "'") i += 1; // escaped single quote
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '\\') i += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
    if (char === "'" || char === '"') quote = char;
  }
  if (quote) throw invalid('unterminated quoted value', lineNo);
  return raw;
}

/** A scalar is either a single/double-quoted string or one whitespace-free atom. */
function parseScalar(raw, lineNo) {
  if (raw === '') throw invalid('missing value', lineNo);
  if (raw[0] === "'" || raw[0] === '"') return parseQuoted(raw, lineNo);
  if (/\s/.test(raw)) throw invalid('a plain value cannot contain spaces', lineNo);
  if (/^[{[\]}&*!|>%@`,]/.test(raw)) throw invalid('unsupported YAML value', lineNo);
  return raw;
}

function parseQuoted(raw, lineNo) {
  const quote = raw[0];
  let out = '';
  let closed = false;
  let i = 1;
  for (; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote === "'" && char === "'") {
      if (raw[i + 1] === "'") { out += "'"; i += 1; continue; }
      closed = true;
      i += 1;
      break;
    }
    if (quote === '"' && char === '\\') {
      const escaped = raw[i + 1];
      const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      if (!(escaped in map)) throw invalid('unsupported escape in quoted value', lineNo);
      out += map[escaped];
      i += 1;
      continue;
    }
    if (quote === '"' && char === '"') { closed = true; i += 1; break; }
    out += char;
  }
  if (!closed) throw invalid('unterminated quoted value', lineNo);
  if (raw.slice(i).trim() !== '') throw invalid('unexpected text after quoted value', lineNo);
  return out;
}

// ── serializer ────────────────────────────────────────────────────────────

const HEADER = [
  '# Team Hub user assignments (ADR 0021, H1.1).',
  '# Edit this file, then restart the core. It is read once at boot, never watched.',
  '# An account NOT listed here is a viewer: max_mode read_only, 20 USD/month.',
  '# Keys per entry: role (owner|admin|member|viewer),',
  '#                 max_mode (none|read_only|execute),',
  '#                 usd_cap_month (0 = no cap, maximum 100000).',
  '# Emails are matched case-insensitively.',
  '#',
  '# PATCH /admin/members and an invited registration rewrite this file after their DB transaction,',
  '# so a grant made in the app survives the next core restart. An account listed here wins over the',
  '# row at the next boot. Entries for emails with no account are preserved.',
];
const HEADER_SET = new Set(HEADER);

/**
 * Serialize assignments to the strict subset. Validates every entry first, so
 * a bad row can never be written into the file the user audits.
 *
 * `comments` are full-line `#` comments from the file being replaced (an API
 * write-through). They are kept above `members:`; comments trailing an entry
 * are not preserved (the serializer writes canonical entries).
 */
export function serializeTeamYaml(assignments, { comments = [] } = {}) {
  if (!Array.isArray(assignments)) throw invalid('assignments must be an array');
  const clean = assignments.map(validateAssignment);
  clean.sort((a, b) => {
    const role = ROLE_ORDER[b.teamRole] - ROLE_ORDER[a.teamRole];
    if (role !== 0) return role;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
  const lines = [...HEADER];
  const seen = new Set();
  for (const comment of comments) {
    const line = typeof comment === 'string' ? comment.trim() : '';
    if (!line.startsWith('#') || HEADER_SET.has(line) || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  lines.push(`${TOP_KEY}:`);
  for (const assignment of clean) {
    lines.push(`  ${assignment.email}:`);
    lines.push(`    role: ${assignment.teamRole}`);
    lines.push(`    max_mode: ${assignment.maxMode}`);
    lines.push(`    usd_cap_month: ${formatCap(assignment.usdCapMonth)}`);
  }
  return `${lines.join('\n')}\n`;
}

function validateAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') throw invalid('assignment must be an object');
  const email = String(assignment.email ?? '').trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) throw invalid(`invalid email "${email}"`);
  if (!ROLES.has(assignment.teamRole)) throw invalid(`unknown role "${assignment.teamRole}"`);
  if (!MODES.has(assignment.maxMode)) throw invalid(`unknown max_mode "${assignment.maxMode}"`);
  const cap = Number(assignment.usdCapMonth);
  if (!Number.isFinite(cap) || cap < 0 || cap > MAX_USD_CAP_MONTH) {
    throw invalid(`usd_cap_month must be between 0 and ${MAX_USD_CAP_MONTH}`);
  }
  return { email, teamRole: assignment.teamRole, maxMode: assignment.maxMode, usdCapMonth: cap };
}

const formatCap = (cap) => String(Number(cap));

// ── boot application ──────────────────────────────────────────────────────

/**
 * The current authority of every real account, in the file's shape. A user
 * without a `members` row gets the least-privilege default. This is what the
 * first boot writes, so an existing solo owner stays owner.
 */
export function listTeamAssignments(db) {
  const rows = db.prepare(`
    SELECT u.id, u.email, m.team_role, m.max_mode, m.usd_cap_month
      FROM users u
      LEFT JOIN members m ON m.user_id = u.id
     WHERE u.id != 'legacy'
     ORDER BY u.email
  `).all();
  return rows.map((row) => ({
    userId: row.id,
    email: String(row.email).trim().toLowerCase(),
    teamRole: row.team_role ?? DEFAULT_VIEWER_ASSIGNMENT.teamRole,
    maxMode: row.max_mode ?? DEFAULT_VIEWER_ASSIGNMENT.maxMode,
    usdCapMonth: row.usd_cap_month == null ? DEFAULT_VIEWER_ASSIGNMENT.usdCapMonth : Number(row.usd_cap_month),
  }));
}

/**
 * Apply `<dir>/team.yaml` once. Creates the file from the current members when
 * it is missing AND a real account exists; an install with no real accounts yet
 * defers generation (`{ deferred: true }`, no file written) so the empty file
 * cannot demote the first registered owner at the next boot. Never rewrites an
 * existing file. Every actual grant change is written in one transaction and
 * reported through `audit` (the boot adapter maps that to the existing audit
 * helper with actor `team.yaml`).
 *
 * Throws `TeamYamlError` (`TEAM_YAML_INVALID`) for an unreadable or invalid
 * file, before changing any row. Unknown emails are reported, audited and
 * ignored; they never create users.
 */
export function applyTeamYaml(db, dir, { logger = null, audit = null } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('applyTeamYaml requires a db handle');
  if (typeof dir !== 'string' || dir === '') throw new TypeError('applyTeamYaml requires a directory');

  const file = path.join(dir, TEAM_YAML_FILENAME);
  let created = false;
  let source = 'file';
  let assignments;

  if (!fs.existsSync(file)) {
    const current = listTeamAssignments(db);
    // A fresh install has no real accounts yet. Writing an empty file here would make the next boot
    // refuse: the first registration creates the owner, but the file would not list them. Defer the
    // file until an account exists; then it is generated from that owner and never rewritten.
    if (current.length === 0) {
      if (logger) logger.info('team_yaml_deferred', { path: file, reason: 'no_real_users' });
      return {
        path: file, created: false, source: 'deferred', deferred: true,
        assignments: 0, users: 0, changes: [], unknownEmails: [],
      };
    }
    assignments = current.map(({ userId: _userId, ...assignment }) => assignment);
    const text = serializeTeamYaml(assignments);
    try {
      writeFileAtomic(file, text);
    } catch (err) {
      throw invalid(`cannot write ${file}: ${err.message}`, null, 'write_failed');
    }
    created = true;
    source = 'generated';
    report(audit, { action: 'team.yaml.generate', detail: { users: assignments.length } });
    if (logger) logger.info('team_yaml_generated', { path: file, users: assignments.length });
  } else {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw invalid(`cannot read ${file}: ${err.message}`, null, 'unreadable');
    }
    try {
      assignments = parseTeamYaml(text);
    } catch (err) {
      if (err instanceof TeamYamlError) {
        report(audit, {
          action: 'team.yaml.invalid',
          outcome: 'failure',
          detail: { reason: err.reason, line: err.line },
        });
      }
      throw err;
    }
  }

  const userRows = db.prepare(
    "SELECT id, email FROM users WHERE id != 'legacy' ORDER BY email",
  ).all();
  const usersByEmail = new Map(
    userRows.map((row) => [String(row.email).trim().toLowerCase(), row]),
  );
  const byEmail = new Map(assignments.map((assignment) => [assignment.email, assignment]));
  const unknownEmails = [...byEmail.keys()].filter((email) => !usersByEmail.has(email));
  for (const email of unknownEmails) {
    if (logger) logger.warn('team_yaml_unknown_email', { email });
    report(audit, {
      action: 'team.yaml.unknown_email',
      outcome: 'failure',
      detail: { email },
    });
  }

  const changes = [];
  const apply = db.transaction(() => {
    for (const row of userRows) {
      const email = String(row.email).trim().toLowerCase();
      const desired = byEmail.get(email) ?? DEFAULT_VIEWER_ASSIGNMENT;
      const current = getMember(db, row.id);
      if (current && sameGrant(current, desired)) continue;

      const from = current
        ? { teamRole: current.teamRole, maxMode: current.maxMode, usdCapMonth: Number(current.usdCapMonth) }
        : null;
      if (current) {
        db.prepare(`
          UPDATE members
             SET team_role = ?, max_mode = ?, usd_cap_month = ?, granted_by = NULL,
                 updated_at = datetime('now')
           WHERE user_id = ?
        `).run(desired.teamRole, desired.maxMode, Number(desired.usdCapMonth), row.id);
      } else {
        db.prepare(`
          INSERT INTO members (user_id, team_role, max_mode, usd_cap_month, granted_by)
          VALUES (?, ?, ?, ?, NULL)
        `).run(row.id, desired.teamRole, desired.maxMode, Number(desired.usdCapMonth));
      }

      const change = {
        userId: row.id,
        email,
        from,
        to: { teamRole: desired.teamRole, maxMode: desired.maxMode, usdCapMonth: Number(desired.usdCapMonth) },
      };
      changes.push(change);
      report(audit, {
        action: 'team.yaml.apply',
        userId: row.id,
        resource: row.id,
        detail: { email, from, to: change.to },
      });
    }

    // Fail closed (R-012#2): the file path bypasses the API's LAST_OWNER guard, and the API is the only
    // place that refuses demoting the last owner. A typo in an owner's email, an owner listed with another
    // role, or an empty `members:` would otherwise demote every owner to the default viewer and boot a
    // core nobody can administer. Throwing INSIDE the transaction rolls back every grant change; the
    // boot adapter turns it into `team_yaml_invalid` and exits 1.
    // An install with no real accounts yet (fresh DB, only the synthetic `legacy` user) is exempt: there
    // is nothing to demote, and the first registration is what creates the owner (`auth-routes.mjs`).
    if (userRows.length > 0 && ownerCount(db) === 0) {
      throw invalid(
        `refusing to apply ${file}: no account would keep the owner role — list this install's owner in the file `
        + '(an owner email typo, an owner listed with another role, or an empty members list)',
        null,
        'no_owner',
      );
    }
  });
  try {
    apply();
  } catch (err) {
    // The parser's own audit row is written above, before the transaction. This one covers the
    // transaction's fail-closed guard, and must be outside it: a row written inside would be rolled back.
    if (err instanceof TeamYamlError) {
      report(audit, {
        action: 'team.yaml.invalid',
        outcome: 'failure',
        detail: { reason: err.reason, line: err.line },
      });
    }
    throw err;
  }

  // team.yaml is authoritative at every boot: an admin-UI grant or an invited member's grant that the
  // file does not repeat is reset on restart. That is the design (ADR 0021 H1.1), but it must be visible,
  // so every narrower grant gets one warning naming the account and the before/after values (R-012#6).
  for (const change of changes) {
    if (!isDowngrade(change.from, change.to)) continue;
    if (logger) {
      logger.warn('team_yaml_downgrade', {
        email: change.email,
        from: change.from,
        to: change.to,
        message: 'team.yaml is authoritative at every boot: this account was reset to the narrower grant in the file.',
      });
    }
  }

  return {
    path: file,
    created,
    source,
    deferred: false,
    assignments: assignments.length,
    users: userRows.length,
    changes,
    unknownEmails,
  };
}

function sameGrant(current, desired) {
  return current.teamRole === desired.teamRole
    && current.maxMode === desired.maxMode
    && Number(current.usdCapMonth) === Number(desired.usdCapMonth);
}

// ── write-through (R-013#2) ────────────────────────────────────────────────

/** Every full-line `#` comment in `text`, trimmed (the serializer keeps them above `members:`). */
function fullLineComments(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#'));
}

/**
 * Merge the DB's current authority over an existing file: the DB wins for an
 * account it lists (it is newer — the boot applies the file, the API writes
 * it), while an entry whose email has no account is preserved (a grant the
 * user prepared for someone who has not registered yet). Pure; throws
 * `TeamYamlError` when the existing text is outside the strict subset.
 */
export function mergeTeamYamlAssignments(existingText, current) {
  const existing = existingText == null ? [] : parseTeamYaml(existingText);
  const known = new Set(current.map((assignment) => assignment.email));
  const preserved = existing.filter((assignment) => !known.has(assignment.email));
  return { assignments: [...current, ...preserved], preserved };
}

/**
 * Rewrite `<dir>/team.yaml` from the current `members` rows — the write-through
 * after an admin grant (`PATCH /admin/members`) or an invited registration.
 * Atomic (temp file, 0600, rename), same generation path as the boot file.
 *
 * `current` entries are the DB's authority. An existing file contributes its
 * unknown-email entries and its full-line comments; it is never replaced when
 * it cannot be parsed (fail closed: the user's audited file is left for repair).
 * Throws `TeamYamlError` (`code: 'TEAM_YAML_INVALID'`); the caller answers 500
 * and rolls the DB change back, so a completed request never leaves the file
 * and the DB disagreeing.
 */
export function persistTeamYaml(db, dir, { logger = null, audit = null, trigger = 'api' } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('persistTeamYaml requires a db handle');
  if (typeof dir !== 'string' || dir === '') throw new TypeError('persistTeamYaml requires a directory');

  const file = path.join(dir, TEAM_YAML_FILENAME);
  const current = listTeamAssignments(db).map(({ userId: _userId, ...assignment }) => assignment);
  let existingText = null;
  if (fs.existsSync(file)) {
    try {
      existingText = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw invalid(`cannot read ${file}: ${err.message}`, null, 'unreadable');
    }
  }

  // Nothing to write on a fresh install with no real accounts yet: an empty
  // file would be authoritative at the next boot (the boot defers it too).
  if (current.length === 0 && existingText == null) {
    if (logger) logger.info('team_yaml_deferred', { path: file, reason: 'no_real_users' });
    return { path: file, deferred: true, users: 0, preserved: 0, assignments: 0 };
  }

  let merged;
  try {
    merged = mergeTeamYamlAssignments(existingText, current);
  } catch (err) {
    if (err instanceof TeamYamlError) {
      report(audit, {
        action: 'team.yaml.invalid',
        outcome: 'failure',
        detail: { reason: err.reason, line: err.line },
      });
    }
    throw err;
  }
  // The file is authoritative at every boot, so never write one that would
  // leave the install with no owner (the boot's no_owner guard would then
  // refuse to start). The DB produced `current`, so this is a corruption guard.
  if (merged.assignments.length > 0
      && !merged.assignments.some((assignment) => assignment.teamRole === 'owner')) {
    const err = invalid(
      `refusing to write ${file}: no account would keep the owner role`,
      null,
      'no_owner',
    );
    report(audit, {
      action: 'team.yaml.invalid',
      outcome: 'failure',
      detail: { reason: err.reason, line: null },
    });
    throw err;
  }

  const text = serializeTeamYaml(merged.assignments, {
    comments: existingText == null ? [] : fullLineComments(existingText),
  });
  try {
    writeFileAtomic(file, text);
  } catch (err) {
    report(audit, {
      action: 'team.yaml.write',
      outcome: 'failure',
      detail: { trigger, reason: 'write_failed' },
    });
    throw invalid(`cannot write ${file}: ${err.message}`, null, 'write_failed');
  }
  report(audit, {
    action: 'team.yaml.write',
    detail: { trigger, users: current.length, preserved: merged.preserved.length },
  });
  if (logger) {
    logger.info('team_yaml_written', {
      path: file, trigger, users: current.length, preserved: merged.preserved.length,
    });
  }
  return {
    path: file,
    deferred: false,
    users: current.length,
    preserved: merged.preserved.length,
    assignments: merged.assignments.length,
  };
}

/** True when `to` grants strictly less than `from` in any dimension — the boot-time downgrade warning. */
function isDowngrade(from, to) {
  if (!from || !to) return false; // a row created now is not a downgrade
  if (ROLE_ORDER[to.teamRole] < ROLE_ORDER[from.teamRole]) return true;
  if (MODE_ORDER[to.maxMode] < MODE_ORDER[from.maxMode]) return true;
  return capIsTighter(from.usdCapMonth, to.usdCapMonth);
}

/** `usd_cap_month: 0` means no cap, so any non-zero cap below it is tighter; else a smaller cap is. */
function capIsTighter(fromCap, toCap) {
  const from = Number(fromCap);
  const to = Number(toCap);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (to === 0) return false; // no cap is the loosest grant possible
  if (from === 0) return to > 0;
  return to < from;
}

/** Audit must never change the boot decision: a throwing sink is a no-op. */
function report(audit, entry) {
  if (typeof audit !== 'function') return;
  try { audit(entry); } catch { /* the caller owns audit failure */ }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}
