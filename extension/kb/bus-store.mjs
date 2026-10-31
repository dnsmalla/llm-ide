// Command bus persistence (migration 0058, spec: docs/spec/command-bus.md). Data access only: every per-user helper
// takes userId first and filters on it, so another user's command or event reads as not found. The bus executor
// (routes/bus/) owns the policy; this module owns the invariants that must hold under a crash:
//   - idempotency: UNIQUE (user_id, idem), same kind and args returns the original, different args is a conflict;
//   - the event log: seq per command from 1, gap-free (assigned inside one transaction), exactly one terminal event and
//     nothing after it, bounded rows and bytes per command (a terminal event is always accepted);
//   - a job exists only once a command may run; jobs.id = bus_commands.id.
import crypto from 'node:crypto';
import { getDb } from './db.mjs';
import { enqueueJob, getJob } from './job-queue.mjs';
import { redactSecrets } from '../core/redact-secrets.mjs';

const nowIso = () => new Date().toISOString();
const jparse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const busError = (code, message, details) => Object.assign(new Error(message), { code, details });

/** Mirror of schema/bus/registry.json errorCodes (scripts/conformance-bus.mjs checks they agree). */
export const ERROR_CODES = Object.freeze([
  'invalid_args', 'unknown_kind', 'unsupported_version', 'tier_denied', 'switch_off', 'needs_desktop_approval',
  'expired', 'duplicate', 'idem_conflict', 'engine_not_logged_in', 'engine_no_key', 'rate_limited', 'quota_exceeded',
  'payload_too_large', 'desktop_busy', 'not_found', 'kind_not_available', 'project_not_registered', 'project_not_allowed',
  'engine_failed', 'read_only_violated', 'interrupted', 'timeout', 'cancelled', 'server_restarted', 'internal',
]);

export const BUS_LIMITS = Object.freeze({
  maxEventPayloadBytes: 16 * 1024,
  maxEventsPerCommand: 5000,
  maxEventBytesPerCommand: 4 * 1024 * 1024,
  maxPendingApprovals: 20,
  maxActiveCommands: 20,
  retentionDays: 7,
});

// ---------- redaction ----------

const CRED_KEY = /token|secret|password|apikey|api_key|authorization|credential/i;
/** Redact every string leaf and credential-named key of a JSON value. Pure; never throws. */
export function redactValue(v, depth = 0) {
  if (depth > 8) return '...';
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = CRED_KEY.test(k) ? '[redacted]' : redactValue(x, depth + 1);
    return o;
  }
  return v;
}

const sizeOf = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

/** Fit a payload under the per-event byte cap by shortening its largest field; the shape stays valid. */
export function fitPayload(type, payload, max = BUS_LIMITS.maxEventPayloadBytes) {
  let p = redactValue(payload ?? {});
  if (sizeOf(p) <= max) return p;
  if (type === 'chunk' && typeof p.text === 'string') p = { text: p.text.slice(0, Math.max(0, max - 64)) };
  else if (type === 'ended') p = { state: p.state, result: { truncated: true } };
  else if (type === 'data') p = { name: String(p.name ?? '').slice(0, 100), value: { truncated: true } };
  else if (type === 'progress') p = { step: String(p.step ?? '').slice(0, 500) };
  else if (type === 'error') p = { code: p.code, message: String(p.message ?? '').slice(0, 500) };
  else p = {};
  while (sizeOf(p) > max && typeof p.text === 'string' && p.text.length > 16) p = { text: p.text.slice(0, Math.floor(p.text.length / 2)) };
  return p;
}

// ---------- kind flags ----------

export function isKindEnabled(userId, kind) {
  const r = getDb().prepare('SELECT enabled FROM bus_kind_flags WHERE user_id = ? AND kind = ?').get(userId, kind);
  return !!r?.enabled;
}
export function setKindEnabled(userId, kind, enabled) {
  getDb().prepare(`INSERT INTO bus_kind_flags (user_id, kind, enabled, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`).run(userId, kind, enabled ? 1 : 0, nowIso());
  return !!enabled;
}
export function listKindFlags(userId) {
  const m = {};
  for (const r of getDb().prepare('SELECT kind, enabled FROM bus_kind_flags WHERE user_id = ?').all(userId)) m[r.kind] = !!r.enabled;
  return m;
}

// ---------- events ----------

const shapeEvent = (r) => ({ v: 1, cmd: r.job_id, seq: r.seq, type: r.type, payload: jparse(r.payload_json, {}), terminal: !!r.terminal, at: r.at });

/**
 * Append one event. Returns the stored event, or null when it was refused: the command already has its terminal event,
 * or a non-terminal event hit the row/byte cap (a single `progress` marker `events_truncated` is written at the cap, so
 * seq stays gap-free and the reader can see that output was cut). A terminal event is always accepted.
 */
export function appendEvent(userId, cmdId, { type, payload, terminal = false, at = Date.now() }) {
  const db = getDb();
  return db.transaction(() => {
    const own = db.prepare('SELECT 1 FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, cmdId);
    if (!own) return null;
    const agg = db.prepare('SELECT COALESCE(MAX(seq),0) AS last, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, COALESCE(MAX(terminal),0) AS term FROM job_events WHERE job_id = ?').get(cmdId);
    if (agg.term) return null;
    const p = fitPayload(type, payload);
    const json = JSON.stringify(p);
    const bytes = Buffer.byteLength(json, 'utf8');
    let useType = type; let useJson = json; let useBytes = bytes; let useTerminal = terminal;
    if (!terminal) {
      const over = agg.n >= BUS_LIMITS.maxEventsPerCommand - 2 || agg.bytes + bytes > BUS_LIMITS.maxEventBytesPerCommand - 8192;
      if (over) {
        const marked = db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'progress' AND payload_json LIKE '%events_truncated%'").get(cmdId);
        if (marked) return null;
        useType = 'progress'; useJson = JSON.stringify({ step: 'events_truncated' }); useBytes = Buffer.byteLength(useJson, 'utf8'); useTerminal = false;
      }
    }
    const seq = agg.last + 1;
    db.prepare('INSERT INTO job_events (job_id, seq, user_id, type, payload_json, terminal, bytes, at) VALUES (?,?,?,?,?,?,?,?)')
      .run(cmdId, seq, userId, useType, useJson, useTerminal ? 1 : 0, useBytes, at);
    return { v: 1, cmd: cmdId, seq, type: useType, payload: jparse(useJson, {}), terminal: useTerminal, at };
  })();
}

/** Events with seq > after, oldest first, at most `limit`. Per user. */
export function listEvents(userId, cmdId, after = 0, limit = 500) {
  const n = Math.max(1, Math.min(1000, Math.floor(limit) || 500));
  return getDb().prepare('SELECT * FROM job_events WHERE user_id = ? AND job_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(userId, cmdId, Math.max(0, Math.floor(after) || 0), n).map(shapeEvent);
}
export function lastSeq(userId, cmdId) {
  return getDb().prepare('SELECT COALESCE(MAX(seq),0) AS s FROM job_events WHERE user_id = ? AND job_id = ?').get(userId, cmdId).s;
}
export function hasTerminal(userId, cmdId) {
  return !!getDb().prepare('SELECT 1 FROM job_events WHERE user_id = ? AND job_id = ? AND terminal = 1').get(userId, cmdId);
}

// ---------- commands ----------

const shapeRow = (r, job) => {
  if (!r) return null;
  let state = r.state;
  if (state === 'enqueued') state = job?.state ?? 'queued';
  return {
    id: r.id, kind: r.kind, tier: r.tier, state, idem: r.idem, originClient: r.origin_client,
    approvalReason: r.approval_reason, approvedBy: r.approved_by, ttlAt: r.ttl_at, createdAt: r.created_at,
    startedAt: job?.startedAt ?? null, finishedAt: job?.finishedAt ?? null,
    error: job?.error ?? null, result: job?.result ?? null, jobId: job ? job.id : null,
  };
};

export function getCommand(userId, id) {
  const r = getDb().prepare('SELECT * FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id);
  if (!r) return null;
  return shapeRow(r, r.state === 'enqueued' ? getJob(userId, id) : null);
}
export function getCommandArgs(userId, id) {
  const r = getDb().prepare('SELECT args_json FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id);
  return r ? jparse(r.args_json, {}) : null;
}

// The state a caller sees is the command's own state, or for an enqueued command the job's (queued when the job row is
// missing). The filter below mirrors `shapeRow` in SQL so the state is applied BEFORE the LIMIT.
const OWN_STATES = new Set(['awaiting_approval', 'denied', 'expired']);
const JOB_STATES_VISIBLE = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted']);

export function listCommands(userId, { state, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  let where = 'c.user_id = ?';
  if (state) {
    if (OWN_STATES.has(state)) where += ` AND c.state = '${state}'`;
    else if (state === 'cancelled') where += " AND (c.state = 'cancelled' OR (c.state = 'enqueued' AND j.state = 'cancelled'))";
    else if (state === 'queued') where += " AND c.state = 'enqueued' AND (j.id IS NULL OR j.state = 'queued')";
    else if (JOB_STATES_VISIBLE.has(state)) where += ` AND c.state = 'enqueued' AND j.state = '${state}'`;
    else return [];
  }
  const rows = getDb().prepare(`SELECT c.* FROM bus_commands c LEFT JOIN jobs j ON j.id = c.id AND j.user_id = c.user_id
    WHERE ${where} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`).all(userId, n);
  return rows.map((r) => shapeRow(r, r.state === 'enqueued' ? getJob(userId, r.id) : null));
}

export function listPendingApprovals(userId) {
  return getDb().prepare("SELECT * FROM bus_commands WHERE user_id = ? AND state = 'awaiting_approval' ORDER BY created_at, rowid").all(userId)
    .map((r) => ({ ...shapeRow(r, null), args: jparse(r.args_json, {}) }));
}

export const argsHashOf = (kind, args) => crypto.createHash('sha256').update(JSON.stringify([kind, args])).digest('hex');

/**
 * Accept one command. Order inside one transaction: idempotency (same kind+args returns the original, different
 * is IDEM_CONFLICT), quotas, the row, the job (when it may run now), the first events.
 * @returns {{ command, created: boolean }}
 */
export function createCommand(userId, { kind, tier, idem, args, originClient, needsApproval, approvalReason, lane, ttlMs, jobPayload }) {
  const db = getDb();
  const argsJson = JSON.stringify(args ?? {});
  const hash = argsHashOf(kind, args ?? {});
  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM bus_commands WHERE user_id = ? AND idem = ?').get(userId, idem);
    if (prior) {
      if (prior.kind !== kind || prior.args_hash !== hash) throw busError('IDEM_CONFLICT', 'that idempotency key was used for a different command');
      return { command: getCommand(userId, prior.id), created: false };
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM bus_commands WHERE user_id = ? AND state = 'awaiting_approval'").get(userId).n;
    if (needsApproval && pending >= BUS_LIMITS.maxPendingApprovals) throw busError('QUOTA_EXCEEDED', 'too many commands are waiting for approval', { limit: BUS_LIMITS.maxPendingApprovals });
    const active = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND state IN ('queued','running') AND id IN (SELECT id FROM bus_commands WHERE user_id = ?)").get(userId, userId).n + pending;
    if (active >= BUS_LIMITS.maxActiveCommands) throw busError('QUOTA_EXCEEDED', 'too many queued or running commands', { limit: BUS_LIMITS.maxActiveCommands });
    const id = crypto.randomUUID();
    const ttlAt = new Date(Date.now() + ttlMs).toISOString();
    db.prepare(`INSERT INTO bus_commands (id, user_id, kind, tier, idem, args_hash, args_json, origin_client, approval_reason, state, ttl_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, kind, tier, idem, hash, argsJson, originClient, needsApproval ? approvalReason ?? 'tier' : null, needsApproval ? 'awaiting_approval' : 'enqueued', ttlAt);
    if (!needsApproval) enqueueJob(userId, { id, kind, lane, payload: jobPayload ?? { args } });
    appendEvent(userId, id, { type: 'accepted', payload: { kind, tier, state: needsApproval ? 'awaiting_approval' : 'queued' } });
    if (needsApproval) appendEvent(userId, id, { type: 'needs_approval', payload: { tier, reason: approvalReason ?? 'tier' } });
    return { command: getCommand(userId, id), created: true };
  })();
}

/** awaiting_approval -> enqueued (job created). Throws NOT_FOUND / NOT_PENDING / EXPIRED. */
export function approveCommand(userId, id, { approvedBy, lane, jobPayload, now = Date.now() }) {
  const db = getDb();
  const out = db.transaction(() => {
    const r = db.prepare('SELECT * FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id);
    if (!r) throw busError('NOT_FOUND', 'command not found');
    if (r.state === 'expired') return { expired: true };
    if (r.state !== 'awaiting_approval') throw busError('NOT_PENDING', 'this command is not waiting for approval', { state: r.state });
    if (Date.parse(r.ttl_at) < now) { expireOne(userId, id); return { expired: true }; } // committed, so the expiry sticks
    db.prepare("UPDATE bus_commands SET state='enqueued', approved_by=?, decided_at=? WHERE user_id=? AND id=?").run(approvedBy, nowIso(), userId, id);
    enqueueJob(userId, { id, kind: r.kind, lane, payload: jobPayload ?? { args: jparse(r.args_json, {}) } });
    appendEvent(userId, id, { type: 'progress', payload: { step: 'approved' } });
    return { command: getCommand(userId, id) };
  })();
  if (out.expired) throw busError('EXPIRED', 'this command expired before it was approved');
  return out.command;
}

export function denyCommand(userId, id, { deniedBy }) {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare('SELECT * FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id);
    if (!r) throw busError('NOT_FOUND', 'command not found');
    if (r.state !== 'awaiting_approval') throw busError('NOT_PENDING', 'this command is not waiting for approval', { state: r.state });
    db.prepare("UPDATE bus_commands SET state='denied', approved_by=?, decided_at=? WHERE user_id=? AND id=?").run(deniedBy, nowIso(), userId, id);
    appendEvent(userId, id, { type: 'error', terminal: true, payload: { code: 'tier_denied', message: 'denied on the desktop' } });
    return getCommand(userId, id);
  })();
}

/** Owner cancels a command that is still waiting for approval. */
export function cancelPending(userId, id) {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare('SELECT state FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id);
    if (!r) return { ok: false, reason: 'not_found' };
    if (r.state !== 'awaiting_approval') return { ok: false, reason: 'not_pending', state: r.state };
    db.prepare("UPDATE bus_commands SET state='cancelled', decided_at=? WHERE user_id=? AND id=?").run(nowIso(), userId, id);
    appendEvent(userId, id, { type: 'ended', terminal: true, payload: { state: 'cancelled' } });
    return { ok: true };
  })();
}

export function terminalEvent(userId, id) {
  const r = getDb().prepare('SELECT * FROM job_events WHERE user_id = ? AND job_id = ? AND terminal = 1').get(userId, id);
  return r ? shapeEvent(r) : null;
}

function expireOne(userId, id) {
  const db = getDb();
  db.prepare("UPDATE bus_commands SET state='expired', decided_at=? WHERE user_id=? AND id=? AND state='awaiting_approval'").run(nowIso(), userId, id);
  appendEvent(userId, id, { type: 'error', terminal: true, payload: { code: 'expired', message: 'expired before it was approved' } });
}

/** Expire this user's overdue approvals (cheap; called on reads). Returns the count. */
export function expireStale(userId, now = Date.now()) {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM bus_commands WHERE user_id = ? AND state = 'awaiting_approval' AND ttl_at < ?").all(userId, new Date(now).toISOString());
  for (const r of rows) expireOne(userId, r.id);
  return rows.length;
}
export function expireStaleAllSystem(now = Date.now()) {
  const rows = getDb().prepare("SELECT id, user_id FROM bus_commands WHERE state = 'awaiting_approval' AND ttl_at < ?").all(new Date(now).toISOString());
  for (const r of rows) expireOne(r.user_id, r.id);
  return rows.length;
}

/**
 * Make the log agree with the job row: a job that is finished but has no terminal event gets one (crash between the job
 * write and the event write, boot sweep, a settle that ran before this module was wired). Idempotent.
 * @returns {boolean} true when an event was written
 */
export function ensureTerminal(userId, id) {
  const r = getDb().prepare('SELECT state FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id);
  if (!r || r.state !== 'enqueued' || hasTerminal(userId, id)) return false;
  const job = getJob(userId, id);
  if (!job) return false;
  const ev = terminalFor(job.state, job.result, job.error);
  if (!ev) return false;
  return !!appendEvent(userId, id, { ...ev, terminal: true });
}

/** The terminal event for a finished job, or null while it is still live. */
export function terminalFor(state, result, error) {
  if (state === 'succeeded') return { type: 'ended', payload: { state: 'succeeded', ...(result && typeof result === 'object' ? { result } : {}) } };
  if (state === 'cancelled') {
    if (error === 'server_quit') return { type: 'error', payload: { code: 'server_restarted', message: 'the server stopped while this command ran' } };
    return { type: 'ended', payload: { state: 'cancelled' } };
  }
  if (state === 'interrupted') return { type: 'error', payload: { code: 'interrupted', message: 'the server restarted while this command ran' } };
  if (state === 'failed') {
    const e = String(error || '');
    const code = e === 'too_many_attempts' ? 'interrupted' : (ERROR_CODES.includes(e) ? e : 'engine_failed');
    return { type: 'error', payload: { code, message: code === 'engine_failed' ? 'the engine failed' : code.replace(/_/g, ' ') } };
  }
  return null;
}

/** Terminal events for every finished bus job that lacks one (run at boot after the sweep). */
export function backfillTerminalsSystem() {
  const rows = getDb().prepare(`SELECT c.user_id, c.id FROM bus_commands c JOIN jobs j ON j.id = c.id
    WHERE c.state = 'enqueued' AND j.state IN ('succeeded','failed','cancelled','interrupted')
      AND NOT EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = c.id AND e.terminal = 1)`).all();
  let n = 0;
  for (const r of rows) if (ensureTerminal(r.user_id, r.id)) n += 1;
  return n;
}

/** Drop finished commands (and their events) older than the retention window. Returns the count. */
export function purgeOldCommandsSystem(now = Date.now(), days = BUS_LIMITS.retentionDays) {
  const db = getDb();
  const cutoff = new Date(now - days * 86400_000).toISOString();
  const rows = db.prepare(`SELECT c.id FROM bus_commands c LEFT JOIN jobs j ON j.id = c.id
    WHERE c.created_at < ? AND (c.state IN ('denied','expired','cancelled') OR (c.state = 'enqueued' AND (j.id IS NULL OR j.state IN ('succeeded','failed','cancelled','interrupted'))))`).all(cutoff);
  db.transaction(() => {
    for (const r of rows) {
      db.prepare('DELETE FROM job_events WHERE job_id = ?').run(r.id);
      db.prepare('DELETE FROM bus_commands WHERE id = ?').run(r.id);
      db.prepare("DELETE FROM jobs WHERE id = ? AND state IN ('succeeded','failed','cancelled','interrupted')").run(r.id);
    }
  })();
  return rows.length;
}
