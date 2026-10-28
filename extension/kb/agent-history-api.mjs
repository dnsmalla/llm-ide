// The data behind the agent-history routes (Stage 1c, plan section 3):
// the storage report (GET /kb/storage), the recent runs for the System view
// (/kb/os/state agents.recentRuns) and the signed previews that a real clear
// must present (POST /kb/agent-history/clear, plan 2.9).
//
// Every function takes userId first and is scoped to that user. The storage
// report sizes the agent history per user (storageStats) and counts the main
// DB groups per user (knowledgeCounts). Per-group BYTES for the main-DB groups
// are not reported: SQLite sizes whole files and tables (dbstat is per-file,
// not per-user), so those groups carry rows only and bytes: null.

import crypto from 'node:crypto';
import { getDb } from './db.mjs';
import { knowledgeCounts } from './os-state.mjs';
import { agentStoreStatus, flushAgentQueue, getAgentDb } from './agent-db.mjs';
import { storageStats, DEFAULT_RETENTION_DAYS } from './agent-store.mjs';

export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const RECENT_RUNS_LIMIT = 20;

// Per process. A key id is carried in every token: a preview signed before a
// restart (another key id) is reported as EXPIRED, the same answer as a timed-out
// one, so the page asks for a new dry run in both cases.
let previewKey = crypto.randomBytes(32);
let keyId = crypto.randomBytes(6).toString('hex');
// previewId -> expiry (ms) of the previews a real clear has already consumed.
const used = new Map();

/** Test seam: a new key, as after a restart. Previews signed before it are expired. */
export function rotatePreviewKeyForTests() {
  previewKey = crypto.randomBytes(32);
  keyId = crypto.randomBytes(6).toString('hex');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (userId, scope, beforeDays, payload) => crypto.createHmac('sha256', previewKey)
  .update([userId, scope, beforeDays ?? '', payload].join('|'))
  .digest('hex');

/**
 * Sign the counts a dry run reported, for this user and scope. The token
 * carries the counts, so the real clear can check that the rows it would
 * delete are the rows the user saw. Returns { previewId, expiresAt }.
 */
export function issuePreview(userId, { scope, beforeDays = null, counts, now = Date.now() }) {
  const expiresAt = now + PREVIEW_TTL_MS;
  const payload = b64url(JSON.stringify({ c: counts, e: expiresAt, k: keyId }));
  return {
    previewId: `${payload}.${mac(userId, scope, beforeDays, payload)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Check a previewId for this user, scope and cutoff. Returns { ok: true,
 * counts } or { ok: false, reason }:
 *   invalid   not ours: wrong user, scope or cutoff, a tampered or malformed
 *             token, or a preview a real clear already used (single use)
 *   expired   past its five minutes, or signed before a restart
 * With `consume`, a successful check marks the preview used, so a replay is
 * refused until the preview would have expired anyway.
 */
export function checkPreview(userId, previewId, { scope, beforeDays = null, now = Date.now(), consume = false } = {}) {
  for (const [id, exp] of used) if (exp < now) used.delete(id);
  if (typeof previewId !== 'string') return { ok: false, reason: 'invalid' };
  const dot = previewId.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'invalid' };
  const payload = previewId.slice(0, dot);
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!body || typeof body.e !== 'number' || !body.c || typeof body.k !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  // A key id that is not ours is a preview from before a restart: expired. The
  // claim is not authenticated, but nothing is accepted on it: a forged claim
  // can only ask the user for a new dry run.
  if (body.k !== keyId || now > body.e) return { ok: false, reason: 'expired' };
  // Then the signature, over the same payload and this user, scope and cutoff.
  const given = Buffer.from(previewId.slice(dot + 1), 'utf8');
  const want = Buffer.from(mac(userId, scope, beforeDays, payload), 'utf8');
  // Compare byte lengths: timingSafeEqual throws on unequal lengths, and a
  // multibyte string can have the same character count with other bytes.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: 'invalid' };
  }
  if (used.has(previewId)) return { ok: false, reason: 'invalid' };
  if (consume) used.set(previewId, body.e);
  return { ok: true, counts: body.c };
}

const sum = (rows, keys) => keys.reduce((n, k) => n + (Number(rows?.[k]) || 0), 0);

/** The GET /kb/storage report for one user. Never throws; a down store is reported. */
export function storageReport(userId, { db = getDb(), now = new Date() } = {}) {
  const agent = storageStats(userId, { db: getAgentDb() ?? undefined, now });
  const counts = knowledgeCounts(db, userId);
  const indexedChunks = counts.sources.total;
  const sourceKinds = counts.sources.byKind.length;
  const codeRepos = counts.codeGraph.length;
  const store = agentStoreStatus();
  const u = agent.ok ? agent.user : null;
  const agentRows = u ? sum(u.rows, ['agent_runs', 'agent_tool_events', 'turn_composition', 'activity']) : 0;
  const group = (key, label, rows, extra = {}) => ({
    key, label, rows, bytes: null, bytesApprox: null, lastCleanedAt: null, retentionDays: null, actions: [], ...extra,
  });
  return {
    generatedAt: now.toISOString(),
    groups: [
      group('agent_history', 'Agent history', agentRows, {
        bytes: u ? u.bytesApprox : null,
        bytesApprox: u ? true : null,
        lastCleanedAt: u ? u.lastClearedAt : null,
        retentionDays: u ? u.retentionDays : DEFAULT_RETENTION_DAYS,
        actions: ['clear', 'compact'],
      }),
      group('search_index', 'Search index', indexedChunks),
      group('code_graph', 'Code graph', codeRepos),
      group('sources', 'Sources', sourceKinds),
      group('meetings', 'Meetings', counts.meetings.count),
    ],
    agentHistory: u ? {
      rawFromDay: u.rawOldestDay,
      rawRows: agentRows,
      rolledDays: u.rolledDays,
      oldestDay: u.rolledOldestDay,
      quarantinedAt: store.historyResetAt,
      droppedRows: store.droppedRows,
      watermark: u.lastRolledDay,
    } : null,
    agentStore: { health: store.health, state: store.state },
  };
}

/** The newest agent runs of one user, for the System view. No prompt or error text. */
export function recentRuns(userId, { limit = RECENT_RUNS_LIMIT } = {}) {
  const db = getAgentDb();
  if (!db) return [];
  flushAgentQueue();
  const n = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || RECENT_RUNS_LIMIT));
  return db.prepare(
    `SELECT run_id, source, engine, status, started_at, ended_at, duration_ms, tool_calls,
            input_tokens, output_tokens, model, error_code
       FROM agent_runs WHERE user_id = ? ORDER BY started_at DESC, run_id DESC LIMIT ?`,
  ).all(userId, n).map((r) => ({
    id: r.run_id,
    source: r.source,
    engine: r.engine,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
    toolCalls: r.tool_calls || 0,
    model: r.model,
    errorCode: r.error_code,
  }));
}
