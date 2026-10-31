// Persisted job queue (migration 0055). Data access only: every per-user helper
// takes userId first. The *System helpers are the runner's own cross-user
// operations (claim, boot sweep) and are never reachable from a request.
import crypto from 'node:crypto';
import { getDb } from './db.mjs';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const nowIso = () => new Date().toISOString();

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const shape = (r) => !r ? null : ({
  id: r.id, userId: r.user_id, kind: r.kind, lane: r.lane, state: r.state,
  payload: parse(r.payload_json) ?? {}, result: parse(r.result_json), error: r.error,
  attempts: r.attempts, cancelRequested: !!r.cancel_requested,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_ACTIVE_JOBS_PER_USER = 100; // queued + running
export const MAX_ATTEMPTS = 3;
const jobError = (code, message) => Object.assign(new Error(message), { code });

export function enqueueJob(userId, { kind, lane, payload = {} }) {
  if (!userId) throw new Error('enqueueJob: userId required');
  if (!kind || !lane) throw new Error('enqueueJob: kind and lane required');
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) throw jobError('payload_too_large', `job payload is over ${MAX_PAYLOAD_BYTES} bytes`);
  const id = crypto.randomUUID();
  const db = getDb();
  db.transaction(() => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND state IN ('queued','running')").get(userId).n;
    if (n >= MAX_ACTIVE_JOBS_PER_USER) throw jobError('quota_exceeded', 'too many queued or running jobs; wait for some to finish');
    db.prepare('INSERT INTO jobs (id, user_id, kind, lane, payload_json) VALUES (?,?,?,?,?)').run(id, userId, String(kind), String(lane), body);
  })();
  return getJob(userId, id);
}

export function getJob(userId, id) {
  return shape(getDb().prepare('SELECT * FROM jobs WHERE user_id = ? AND id = ?').get(userId, id));
}

export function listJobs(userId, { state, lane, limit = 50 } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (state) { where.push('state = ?'); args.push(state); }
  if (lane) { where.push('lane = ?'); args.push(lane); }
  const n = Math.max(1, Math.min(500, Math.floor(limit) || 50));
  return getDb().prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ${n}`)
    .all(...args).map(shape);
}

/** Queued job -> cancelled now; running job -> cancel_requested (the runner aborts it). */
export function requestCancel(userId, id) {
  const db = getDb();
  return db.transaction(() => {
    const j = db.prepare('SELECT state FROM jobs WHERE user_id = ? AND id = ?').get(userId, id);
    if (!j) return { ok: false, reason: 'not_found' };
    if (j.state === 'queued') {
      db.prepare("UPDATE jobs SET state='cancelled', finished_at=?, updated_at=?, error='cancelled' WHERE user_id=? AND id=?")
        .run(nowIso(), nowIso(), userId, id);
      return { ok: true, was: 'queued' };
    }
    if (j.state === 'running') {
      db.prepare('UPDATE jobs SET cancel_requested=1, updated_at=? WHERE user_id=? AND id=?').run(nowIso(), userId, id);
      return { ok: true, was: 'running' };
    }
    return { ok: false, reason: 'already_finished', state: j.state };
  })();
}

/**
 * Atomically take the oldest queued job whose (user, lane) has nothing running,
 * skipping lanes in `busyLanes` is unnecessary: the partial unique index makes
 * the DB the lane lock. Returns the claimed job or null.
 */
export function claimNextJobSystem() {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT q.* FROM jobs q
      WHERE q.state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id = q.user_id AND r.lane = q.lane AND r.state = 'running')
      ORDER BY q.created_at, q.rowid LIMIT 1`).get();
    if (!row) return null;
    db.prepare("UPDATE jobs SET state='running', started_at=?, updated_at=?, attempts=attempts+1 WHERE id=? AND state='queued'")
      .run(nowIso(), nowIso(), row.id);
    return shape(db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id));
  })();
}

/** Running -> terminal. Returns false if the row is no longer running (already settled). */
export function finishJobSystem(id, state, { result, error } = {}) {
  if (!TERMINAL.has(state)) throw new Error(`finishJobSystem: bad state ${state}`);
  const r = getDb().prepare(
    "UPDATE jobs SET state=?, result_json=?, error=?, finished_at=?, updated_at=? WHERE id=? AND state='running'"
  ).run(state, result === undefined ? null : JSON.stringify(result), error ?? null, nowIso(), nowIso(), id);
  return r.changes > 0;
}

/**
 * Boot sweep: rows still 'running' belong to a process that no longer exists.
 * Resumable kinds go back to 'queued' (attempts is kept); the rest become
 * 'interrupted'. A row with cancel_requested is cancelled, never requeued; a resumable row that already ran
 * `maxAttempts` times is failed ('too_many_attempts'). Returns {requeued, interrupted, cancelled, failed} ids.
 */
export function sweepInterruptedSystem(resumableKinds = [], { maxAttempts = MAX_ATTEMPTS } = {}) {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, kind, attempts, cancel_requested FROM jobs WHERE state='running'").all();
    const out = { requeued: [], interrupted: [], cancelled: [], failed: [] };
    const end = (id, state, error) => db.prepare('UPDATE jobs SET state=?, error=?, finished_at=?, updated_at=? WHERE id=?').run(state, error, nowIso(), nowIso(), id);
    for (const { id, kind, attempts, cancel_requested: cancelRequested } of rows) {
      if (cancelRequested) { end(id, 'cancelled', 'cancelled'); out.cancelled.push(id); } // the user asked: never run it again
      else if (resumableKinds.includes(kind)) {
        if (attempts >= maxAttempts) { end(id, 'failed', 'too_many_attempts'); out.failed.push(id); } // poison job: stop the crash loop
        else {
          db.prepare("UPDATE jobs SET state='queued', started_at=NULL, updated_at=? WHERE id=?").run(nowIso(), id);
          out.requeued.push(id);
        }
      } else { end(id, 'interrupted', 'server_restarted'); out.interrupted.push(id); }
    }
    return out;
  })();
}

export function hasQueuedJobsSystem() {
  return !!getDb().prepare("SELECT 1 FROM jobs WHERE state='queued' LIMIT 1").get();
}
