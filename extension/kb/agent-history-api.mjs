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
// Per process: a preview is only good for five minutes, so a restart (which
// makes a new key) simply asks the user to preview again.
const PREVIEW_KEY = crypto.randomBytes(32);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (userId, scope, beforeDays, payload) => crypto.createHmac('sha256', PREVIEW_KEY)
  .update([userId, scope, beforeDays ?? '', payload].join('|'))
  .digest('hex');

/**
 * Sign the counts a dry run reported, for this user and scope. The token
 * carries the counts, so the real clear can check that the rows it would
 * delete are the rows the user saw. Returns { previewId, expiresAt }.
 */
export function issuePreview(userId, { scope, beforeDays = null, counts, now = Date.now() }) {
  const expiresAt = now + PREVIEW_TTL_MS;
  const payload = b64url(JSON.stringify({ c: counts, e: expiresAt }));
  return {
    previewId: `${payload}.${mac(userId, scope, beforeDays, payload)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Check a previewId for this user, scope and cutoff. Returns { ok: true,
 * counts } or { ok: false, reason: 'invalid' | 'expired' }. A preview issued
 * for another user, another scope or another cutoff is 'invalid'.
 */
export function checkPreview(userId, previewId, { scope, beforeDays = null, now = Date.now() } = {}) {
  if (typeof previewId !== 'string') return { ok: false, reason: 'invalid' };
  const dot = previewId.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'invalid' };
  const payload = previewId.slice(0, dot);
  const given = previewId.slice(dot + 1);
  const want = mac(userId, scope, beforeDays, payload);
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
    return { ok: false, reason: 'invalid' };
  }
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!body || typeof body.e !== 'number' || !body.c) return { ok: false, reason: 'invalid' };
  if (now > body.e) return { ok: false, reason: 'expired' };
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
