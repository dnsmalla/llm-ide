// Per-user scheduling overlay for repository issues.
//
// GitHub issues have no start/due/estimate/dependency fields, so a gantt
// can't be drawn from GitHub data alone. This module is OUR overlay store:
// scheduling metadata keyed by (provider, repo, issueNumber), entirely in
// our system. The Mac app reads issues from the provider API and merges
// these rows client-side. GitLab already has native scheduling, so rows are
// written for provider='github' in practice — the column stays generic.
//
// Mirrors plans.mjs conventions (genId, transaction-wrapped upsert,
// requireUser tenancy scoping, null clears a field).

import { getDb, genId, safeJSONStringify, safeParseMeta, lazyPrepare, requireUser } from './db.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_PROVIDERS = new Set(['github', 'gitlab']);

// Normalize + validate a YYYY-MM-DD date. undefined → leave unchanged
// (caller decides); null → clear; a malformed string throws.
function normDate(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${field} must be a YYYY-MM-DD date or null`);
  }
  return value;
}

function normEstimate(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('estimateDays must be a non-negative number or null');
  }
  return n;
}

// dependsOn is a list of provider issue numbers. Coerce to a deduped array
// of positive integers; anything non-numeric is rejected.
function normDependsOn(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error('dependsOn must be an array of issue numbers');
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('dependsOn must contain positive integer issue numbers');
    }
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Repo keys: GitHub is exactly owner/name; GitLab may nest groups (2..20
// segments, 255 chars max). Each segment is the provider-legal charset
// (alphanumerics plus . _ -) and never "." or "..", so the key can't shape a
// path when the client interpolates it into a provider API URL.
const REPO_SEG_RE = /^[A-Za-z0-9._-]+$/;
function assertRepo(provider, repo) {
  const segs = typeof repo === 'string' ? repo.split('/') : [];
  const maxSegs = provider === 'gitlab' ? 20 : 2;
  const ok = typeof repo === 'string'
    && repo.length <= 255
    && segs.length >= 2 && segs.length <= maxSegs
    && (provider === 'gitlab' || segs.length === 2)
    && segs.every((seg) => REPO_SEG_RE.test(seg) && seg !== '.' && seg !== '..');
  if (!ok) {
    throw new Error(provider === 'gitlab'
      ? 'repo must be "owner/name" or a nested "group/.../name" (2 to 20 segments)'
      : 'repo must be "owner/name"');
  }
}

function assertKey(provider, repo, issueNumber) {
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new Error(`provider must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}`);
  }
  assertRepo(provider, repo);
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('issueNumber must be a positive integer');
  }
  return n;
}

function rowToSchedule(r) {
  return {
    provider: r.provider,
    repo: r.repo,
    issueNumber: r.issue_number,
    startDate: r.start_date,
    dueDate: r.due_date,
    estimateDays: r.estimate_days,
    dependsOn: safeParseMeta(r.depends_on) || [],
    updatedAt: r.updated_at,
  };
}

/// All schedule overlays for one repo (one provider), for this user. An empty repo means every cached
/// repository for the provider — the Gantt's "All repositories" view, matching the Issues listing.
export function listIssueSchedules(userId, { provider, repo } = {}) {
  requireUser(userId);
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new Error(`provider must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}`);
  }
  const db = getDb();
  const allRepos = repo == null || repo === '';
  if (!allRepos) assertRepo(provider, repo);
  const rows = allRepos
    ? lazyPrepare(db,
        'SELECT * FROM issue_schedule WHERE user_id = ? AND provider = ? ORDER BY repo, issue_number'
      ).all(userId, provider)
    : lazyPrepare(db,
        'SELECT * FROM issue_schedule WHERE user_id = ? AND provider = ? AND repo = ? ORDER BY issue_number'
      ).all(userId, provider, repo);
  return rows.map(rowToSchedule);
}

/// Create or replace one issue's schedule overlay. Each field is fully
/// replaced (null clears it). Returns the stored schedule.
export function upsertIssueSchedule(userId, { provider, repo, issueNumber, startDate, dueDate, estimateDays, dependsOn } = {}) {
  requireUser(userId);
  const num = assertKey(provider, repo, issueNumber);
  const start = normDate(startDate, 'startDate');
  const due = normDate(dueDate, 'dueDate');
  const est = normEstimate(estimateDays);
  const deps = safeJSONStringify(normDependsOn(dependsOn));

  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM issue_schedule WHERE user_id = ? AND provider = ? AND repo = ? AND issue_number = ?'
    ).get(userId, provider, repo, num);
    if (existing) {
      db.prepare(
        `UPDATE issue_schedule SET start_date = ?, due_date = ?, estimate_days = ?, depends_on = ?,
           updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(start, due, est, deps, existing.id);
    } else {
      db.prepare(
        `INSERT INTO issue_schedule (id, user_id, provider, repo, issue_number, start_date, due_date, estimate_days, depends_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(genId('isch'), userId, provider, repo, num, start, due, est, deps);
    }
    const r = db.prepare(
      'SELECT * FROM issue_schedule WHERE user_id = ? AND provider = ? AND repo = ? AND issue_number = ?'
    ).get(userId, provider, repo, num);
    return rowToSchedule(r);
  })();
}

/// Remove one issue's schedule overlay. Returns true if a row was deleted.
export function deleteIssueSchedule(userId, { provider, repo, issueNumber } = {}) {
  requireUser(userId);
  const num = assertKey(provider, repo, issueNumber);
  const db = getDb();
  const info = db.prepare(
    'DELETE FROM issue_schedule WHERE user_id = ? AND provider = ? AND repo = ? AND issue_number = ?'
  ).run(userId, provider, repo, num);
  return info.changes > 0;
}
