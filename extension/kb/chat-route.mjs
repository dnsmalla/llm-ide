// The per-chat route record of the session router (K1 Phase 6b, plan section 14).
//
// One row per (user, chat): which provider/model the chat is pinned to, the
// session token cap, and the token counters the cap is enforced against. It
// lives in the MAIN db on purpose: a limit must fail CLOSED, and agent.db is
// "history, never enforcement" (it may be down). The switch HISTORY goes to
// agent.db through its write queue and can be lost without changing routing.
//
// Conventions kept from kb/agent-sessions.mjs: `db` first, `userId` second,
// every statement scoped `WHERE user_id = ?`. Counters hold BILLABLE tokens
// the way kb/usage.mjs counts them (input + output + cache write); cache
// reads are tracked and shown, never counted against the cap (Q-R1).
//
// Nothing here reads a flag: the callers (routes/agent-v2.mjs,
// core/router-flags.mjs) decide whether the router runs at all.

import { requireUser, lazyPrepare } from './db.mjs';
import { enqueueAgentWrite, getAgentDb, flushAgentQueue, localDay } from './agent-db.mjs';

export const MAX_TOKEN_LIMIT = 1_000_000_000_000;   // 1e12: far above any real chat, far below 2^53
const MAX_COUNT = 1_000_000_000;                    // one turn's counter increment is clamped to this
const WARM_KEEP = 8;
const ID_MAX = 200;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const ROUTE_EVENT_KINDS = new Set(['switch', 'cap_reached', 'cap_changed', 'cooldown', 'handoff_built']);

/** A refusal the route handler maps to an HTTP status. `extra` rides in the body. */
export class RouteError extends Error {
  constructor(code, message, status, extra = null) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const invalid = (message) => new RouteError('VALIDATION_FAILED', message, 400);

function requireChatId(chatSessionId) {
  if (typeof chatSessionId !== 'string' || !chatSessionId || chatSessionId.length > ID_MAX) {
    throw invalid('chatSessionId is required');
  }
  return chatSessionId;
}

// Control characters never belong in a provider or model id.
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
function cleanId(value, field) {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const v = value.trim();
  if (v.length > ID_MAX || hasControl(v)) throw invalid(`${field} is not a valid id`);
  return v;
}

/**
 * Validate a token limit from a client. `undefined` = leave it alone;
 * `null` or `0` = no cap; else a whole number of billable tokens.
 * Negative, fractional, non-numeric and absurd values are refused (never
 * clamped: a silently clamped cap would not be the cap the user typed).
 */
export function parseTokenLimit(v) {
  if (v === undefined) return undefined;
  if (v === null || v === 0) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalid('tokenLimit must be a whole number of tokens, or null');
  if (v > MAX_TOKEN_LIMIT) throw invalid(`tokenLimit may not exceed ${MAX_TOKEN_LIMIT}`);
  return v;
}

const count = (v) => Math.max(0, Math.min(MAX_COUNT, Math.trunc(Number(v) || 0)));
const safeJson = (s, dflt) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : dflt; } catch { return dflt; } };

/** Billable tokens of a row: input + output + cache write (never cache reads). */
export function billableOf(row) {
  return (row?.tokens_in ?? 0) + (row?.tokens_out ?? 0) + (row?.tokens_cache_write ?? 0);
}

function shape(row, chatSessionId) {
  if (!row) return null;
  const billable = billableOf(row);
  const limit = row.token_limit ?? null;
  return {
    chatSessionId,
    provider: row.provider,
    model: row.model,
    pinned: row.provider !== '',
    pinnedBy: row.pinned_by,
    tokenLimit: limit,
    used: {
      in: row.tokens_in, out: row.tokens_out, cacheWrite: row.tokens_cache_write,
      cacheRead: row.tokens_cache_read, billable,
    },
    remaining: limit === null ? null : Math.max(0, limit - billable),
    stickyUntil: row.sticky_until ?? null,
    warm: safeJson(row.warm_json, {}),
    handoffUpTo: row.handoff_up_to ?? null,
    switchSeq: row.switch_seq,
    pending: row.pending_json ? safeJson(row.pending_json, null) : null,
    updatedAt: row.updated_at,
  };
}

const SELECT = 'SELECT * FROM chat_session_route WHERE user_id = ? AND chat_session_id = ?';

function readRow(db, userId, chatSessionId) {
  return lazyPrepare(db, SELECT).get(userId, chatSessionId);
}

/** The route of one chat, or null. Throws when the store cannot be read (the caller fails closed). */
export function getRoute(db, userId, chatSessionId) {
  requireUser(userId);
  requireChatId(chatSessionId);
  return shape(readRow(db, userId, chatSessionId), chatSessionId);
}

/** The server-held handoff note of a chat with no Mac file, or null. Never part of the wire route. */
export function getServerHandoffNote(db, userId, chatSessionId) {
  requireUser(userId);
  requireChatId(chatSessionId);
  return readRow(db, userId, chatSessionId)?.handoff_note ?? null;
}

/**
 * Create or change a route. One transaction, compare-and-set on `switch_seq`.
 *
 * patch: { provider?, model?, tokenLimit? (null/0 clears), tokensUsed? (seed), ifSeq? }
 *  - provider and model travel together ('' and '' = unpinned, the client's own pick governs).
 *  - While a turn runs (`inFlight`) a provider/model change is stored as PENDING and applied at the
 *    next turn start; the limit changes at once (raising the cap must work mid-chat).
 *  - `tokensUsed` re-seeds the counter after a quit purged the row (Q-R2). It is honoured only for a
 *    row that does not exist yet or has no usage; a live row's counters are the server's truth.
 *  - A stale `ifSeq` is refused with ROUTE_CONFLICT carrying the current row.
 *
 * @returns {{ route: object, appliesAt: 'now'|'next_turn', changed: boolean, switched: object|null, limitChanged: boolean }}
 */
export function putRoute(db, userId, chatSessionId, patch = {}, { inFlight = false, pinnedBy = 'user' } = {}) {
  requireUser(userId);
  requireChatId(chatSessionId);
  if (!patch || typeof patch !== 'object') throw invalid('body must be an object');
  const hasProvider = patch.provider !== undefined;
  const hasModel = patch.model !== undefined;
  if (hasProvider !== hasModel) throw invalid('provider and model are set together');
  const provider = hasProvider ? cleanId(patch.provider, 'provider') : undefined;
  const model = hasModel ? cleanId(patch.model, 'model') : undefined;
  if (hasProvider && (provider === '') !== (model === '')) throw invalid('provider and model must both be set, or both empty');
  const limit = parseTokenLimit(patch.tokenLimit);
  let seed = null;
  if (patch.tokensUsed !== undefined) {
    if (typeof patch.tokensUsed !== 'number' || !Number.isSafeInteger(patch.tokensUsed) || patch.tokensUsed < 0) throw invalid('tokensUsed must be a whole number');
    seed = Math.min(patch.tokensUsed, MAX_TOKEN_LIMIT);
  }
  let ifSeq = null;
  if (patch.ifSeq !== undefined && patch.ifSeq !== null) {
    if (!Number.isSafeInteger(patch.ifSeq) || patch.ifSeq < 0) throw invalid('ifSeq must be a whole number');
    ifSeq = patch.ifSeq;
  }

  const tx = db.transaction(() => {
    const cur = readRow(db, userId, chatSessionId);
    const curSeq = cur ? cur.switch_seq : 0;
    if (ifSeq !== null && ifSeq !== curSeq) {
      throw new RouteError('ROUTE_CONFLICT', 'The route changed since you read it', 409, { current: shape(cur, chatSessionId) });
    }
    if (!cur) {
      const seedIn = seed ? Math.min(seed, MAX_COUNT) : 0;
      lazyPrepare(db, `
        INSERT INTO chat_session_route
          (user_id, chat_session_id, provider, model, pinned_by, token_limit, tokens_in, switch_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(userId, chatSessionId, provider ?? '', model ?? '', pinnedBy, limit ?? null, seedIn);
      return {
        route: shape(readRow(db, userId, chatSessionId), chatSessionId), appliesAt: 'now', changed: true,
        switched: provider ? { from: null, to: { provider, model } } : null,
        limitChanged: limit != null,
      };
    }
    const sets = [];
    const args = [];
    let appliesAt = 'now';
    let switched = null;
    let changed = false;
    if (hasProvider) {
      const same = provider === cur.provider && model === cur.model;
      if (inFlight && !same) {
        sets.push('pending_json = ?');
        args.push(JSON.stringify({ provider, model, pinnedBy, requestedAt: new Date().toISOString() }));
        appliesAt = 'next_turn';
        changed = true;
      } else if (!same) {
        sets.push('provider = ?', 'model = ?', 'pinned_by = ?', 'pending_json = NULL');
        args.push(provider, model, pinnedBy);
        switched = { from: { provider: cur.provider, model: cur.model }, to: { provider, model } };
        changed = true;
      } else if (cur.pending_json) {
        sets.push('pending_json = NULL');   // re-pinning the current pick cancels a pending change
        changed = true;
      }
    }
    let limitChanged = false;
    if (limit !== undefined && limit !== (cur.token_limit ?? null)) {
      sets.push('token_limit = ?');
      args.push(limit);
      limitChanged = true;
      changed = true;
    }
    if (seed && billableOf(cur) === 0) {
      sets.push('tokens_in = ?');
      args.push(Math.min(seed, MAX_COUNT));
      changed = true;
    }
    if (changed) {
      lazyPrepare(db, `
        UPDATE chat_session_route SET ${sets.join(', ')}, switch_seq = switch_seq + 1, updated_at = ${NOW_SQL}
         WHERE user_id = ? AND chat_session_id = ?
      `).run(...args, userId, chatSessionId);
    }
    return { route: shape(readRow(db, userId, chatSessionId), chatSessionId), appliesAt, changed, switched, limitChanged };
  });
  return tx();
}

/**
 * Apply a pending provider/model change at a turn's start. Returns the new route and what changed
 * (null when nothing was pending). Idempotent.
 */
export function applyPending(db, userId, chatSessionId) {
  requireUser(userId);
  requireChatId(chatSessionId);
  return db.transaction(() => {
    const cur = readRow(db, userId, chatSessionId);
    const pending = cur?.pending_json ? safeJson(cur.pending_json, null) : null;
    if (!cur || !pending || typeof pending.provider !== 'string' || typeof pending.model !== 'string') {
      if (cur?.pending_json) {
        lazyPrepare(db, 'UPDATE chat_session_route SET pending_json = NULL WHERE user_id = ? AND chat_session_id = ?').run(userId, chatSessionId);
      }
      return { route: shape(cur, chatSessionId), switched: null };
    }
    lazyPrepare(db, `
      UPDATE chat_session_route
         SET provider = ?, model = ?, pinned_by = ?, pending_json = NULL, switch_seq = switch_seq + 1, updated_at = ${NOW_SQL}
       WHERE user_id = ? AND chat_session_id = ?
    `).run(pending.provider, pending.model, pending.pinnedBy === 'router' ? 'router' : 'user', userId, chatSessionId);
    return {
      route: shape(readRow(db, userId, chatSessionId), chatSessionId),
      switched: { from: { provider: cur.provider, model: cur.model }, to: { provider: pending.provider, model: pending.model } },
    };
  })();
}

/**
 * Add one finished turn's tokens to the counters and refresh the warm marker. ONE statement for the
 * counters (so two writers cannot lose an update) and the row is created if the chat has none yet.
 * Called once per turn, from a `finally` (see routes/agent-v2.mjs); `usage` is what the model reported.
 */
export function commitTurnUsage(db, userId, chatSessionId, usage, { provider = '', model = '', now = new Date(), ttlMs = 0 } = {}) {
  requireUser(userId);
  requireChatId(chatSessionId);
  const inTok = count(usage?.inputTokens);
  const outTok = count(usage?.outputTokens);
  const cw = count(usage?.cacheCreationTokens);
  const cr = count(usage?.cacheReadTokens);
  const touch = now.toISOString();
  const until = ttlMs > 0 ? new Date(now.getTime() + ttlMs).toISOString() : null;
  const key = `${provider}|${model}`;
  return db.transaction(() => {
    const cur = readRow(db, userId, chatSessionId);
    if (!cur) {
      lazyPrepare(db, `
        INSERT INTO chat_session_route
          (user_id, chat_session_id, provider, model, pinned_by, tokens_in, tokens_out, tokens_cache_write, tokens_cache_read,
           warm_json, sticky_until)
        VALUES (?, ?, '', '', 'router', ?, ?, ?, ?, ?, ?)
      `).run(userId, chatSessionId, inTok, outTok, cw, cr, provider ? JSON.stringify({ [key]: touch }) : '{}', until);
    } else {
      let warm = safeJson(cur.warm_json, {});
      if (provider) {
        warm[key] = touch;
        const keep = Object.entries(warm).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, WARM_KEEP);
        warm = Object.fromEntries(keep);
      }
      lazyPrepare(db, `
        UPDATE chat_session_route
           SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
               tokens_cache_write = tokens_cache_write + ?, tokens_cache_read = tokens_cache_read + ?,
               warm_json = ?, sticky_until = COALESCE(?, sticky_until), updated_at = ${NOW_SQL}
         WHERE user_id = ? AND chat_session_id = ?
      `).run(inTok, outTok, cw, cr, JSON.stringify(warm), until, userId, chatSessionId);
    }
    return shape(readRow(db, userId, chatSessionId), chatSessionId);
  })();
}

/** Remove a chat's route (quit-archive purge, delete everywhere, account delete). Idempotent; returns rows removed. */
export function deleteRoute(db, userId, chatSessionId) {
  requireUser(userId);
  requireChatId(chatSessionId);
  return lazyPrepare(db, 'DELETE FROM chat_session_route WHERE user_id = ? AND chat_session_id = ?')
    .run(userId, chatSessionId).changes;
}

/** Chat ids that hold a route row for this user (the working-state listing). */
export function listRouteChatIds(db, userId) {
  requireUser(userId);
  return lazyPrepare(db, 'SELECT chat_session_id AS id FROM chat_session_route WHERE user_id = ?').all(userId).map((r) => r.id);
}

// --- switch history (agent.db, best effort) ---------------------------------

/**
 * Queue one history event. Never throws and never blocks; a lost row changes no routing.
 * Metadata only: no prompt, no note text.
 */
export function recordRouteEvent(userId, chatSessionId, ev) {
  try {
    requireUser(userId);
    if (typeof chatSessionId !== 'string' || !chatSessionId || !ROUTE_EVENT_KINDS.has(ev?.kind)) return false;
    const s = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const now = new Date();
    return enqueueAgentWrite('route_events',
      `INSERT INTO agent_route_events
         (user_id, chat_session_id, day, at, kind, from_provider, from_model, to_provider, to_model, reason,
          cold_prefill_tokens, handoff_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, chatSessionId.slice(0, ID_MAX), localDay(now), now.toISOString(), ev.kind,
        s(ev.fromProvider, 128), s(ev.fromModel, 200), s(ev.toProvider, 128), s(ev.toModel, 200), s(ev.reason, 32),
        Number.isFinite(ev.coldPrefillTokens) ? count(ev.coldPrefillTokens) : null,
        Number.isFinite(ev.handoffChars) ? count(ev.handoffChars) : null]);
  } catch {
    return false;
  }
}

/** This chat's switch history, newest first. `degraded: true` when agent.db is down (never an error). */
export function listRouteEvents(userId, chatSessionId, { limit = 100, db } = {}) {
  requireUser(userId);
  try {
    if (!db) flushAgentQueue();
    const handle = db ?? getAgentDb();
    if (!handle) return { events: [], degraded: true };
    const n = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rows = handle.prepare(`
      SELECT id, at, kind, from_provider, from_model, to_provider, to_model, reason, cold_prefill_tokens, handoff_chars
        FROM agent_route_events WHERE user_id = ? AND chat_session_id = ? ORDER BY at DESC, id DESC LIMIT ?
    `).all(userId, chatSessionId, n);
    return {
      events: rows.map((r) => ({
        id: r.id, at: r.at, kind: r.kind,
        fromProvider: r.from_provider, fromModel: r.from_model, toProvider: r.to_provider, toModel: r.to_model,
        reason: r.reason, coldPrefillTokens: r.cold_prefill_tokens, handoffChars: r.handoff_chars,
      })),
      degraded: false,
    };
  } catch {
    return { events: [], degraded: true };
  }
}
