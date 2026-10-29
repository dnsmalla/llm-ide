// The session router's HTTP-facing half (K1 Phase 6b, plan section 14). routes/agent-v2.mjs calls
// into this module at four points of a turn and for three small routes:
//
//   beginRouteTurn   before the model is called: fail-closed cap check, pending switch, the pick
//   createRouteTurn  the per-turn accountant: counters committed ONCE on every exit path
//   runAdapterTurn   a catalog (non-Anthropic) provider's turn through providers/adapter
//   handleRoute*     GET/PUT /agent/v2/session/route and GET .../route/history
//
// Everything here is dead code unless LLMIDE_ROUTER=on (core/router-flags.mjs): with the flag off,
// `beginRouteTurn` answers `{ enabled: false }` before touching any table, so a turn is exactly
// what it was before this phase.

import { routerEnabled, routerCapEnabled } from '../core/router-flags.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { logger } from '../core/logger.mjs';
import {
  RouteError, getRoute, putRoute, applyPending, commitTurnUsage, listRouteEvents, recordRouteEvent,
} from '../kb/chat-route.mjs';
import { pickRoute, capState, cacheTtl, switchCost } from '../providers/route-policy.mjs';
import { AGENT_SDK_PROVIDER } from '../llm_agent/sdk/constants.mjs';

const log = logger.child({ component: 'agent-v2-router' });

/** The providers a v2 chat can be pinned to: Claude, or a connected catalog / custom provider. */
function normalizePinnedProvider(provider) {
  if (provider === '' || provider === undefined) return provider;
  if (provider === 'claude' || provider === AGENT_SDK_PROVIDER) return AGENT_SDK_PROVIDER;
  if (typeof provider === 'string' && provider.startsWith('custom:')) return provider;
  throw new RouteError('VALIDATION_FAILED', 'provider must be "anthropic" or a connected custom:<id> provider', 400);
}

/** True for a catalog connection: the Claude engine cannot run it, the adapter does. */
export function isAdapterProvider(provider) {
  return typeof provider === 'string' && provider.startsWith('custom:cat-');
}

const unavailable = (err) => {
  log.warn('route_store_unavailable', { code: err?.code, message: String(err?.message || err).slice(0, 160) });
  return new RouteError('ROUTE_UNAVAILABLE', 'The chat route store is unavailable, so this turn was not started. Try again.', 503);
};

/**
 * The route decision for a turn that is about to start.
 *
 * `apply: false` is the cheap early probe (before the classifier's model call): it reads and checks the
 * cap but changes nothing. `apply: true` is the authoritative one, made with the chat's lock held: it
 * applies a pending switch and returns the pick.
 *
 * Fails CLOSED: with the router on, a route row that cannot be read refuses the turn (503
 * ROUTE_UNAVAILABLE) before any model call. A chat at its cap is refused with 402 SESSION_TOKEN_LIMIT.
 *
 * @returns {{ enabled: false } | { enabled: true, route: object|null, pick: object, switched: object|null,
 *            capOn: boolean, cap: object, refusal: object|null }}
 */
export function beginRouteTurn({ db, userId, chatSessionId, requested, apply = false, now = new Date(), env = process.env }) {
  if (!routerEnabled(env)) return { enabled: false };
  let route;
  let switched = null;
  try {
    if (apply) {
      const a = applyPending(db, userId, chatSessionId);
      route = a.route;
      switched = a.switched;
    } else {
      route = getRoute(db, userId, chatSessionId);
    }
  } catch (err) {
    throw unavailable(err);
  }
  const capOn = routerCapEnabled(env);
  const cap = capState(route);
  const pick = pickRoute({ route, requested, now });
  const refusal = capOn && cap.blocked
    ? { status: 402, code: 'SESSION_TOKEN_LIMIT', message: 'This chat reached its session token limit. Raise the limit to continue.', used: cap.used, limit: cap.limit }
    : null;
  return { enabled: true, route, pick, switched, capOn, cap, refusal };
}

/** Write a refusal from `beginRouteTurn` or a RouteError as the pre-stream JSON error. */
export function sendRouteRefusal(req, res, refusal) {
  req.rateLimitRefund?.();   // a refusal is not a turn (same rule as TURN_IN_PROGRESS)
  sendJSON(res, refusal.status, {
    error: { code: refusal.code, message: refusal.message, ...(refusal.used !== undefined ? { details: { used: refusal.used, limit: refusal.limit } } : {}) },
  });
}

const billableOf = (u) => (Number(u?.inputTokens) || 0) + (Number(u?.outputTokens) || 0) + (Number(u?.cacheCreationTokens) || 0);

/**
 * The per-turn accountant. `commit(usage)` adds the turn's tokens to the chat's counters exactly ONCE
 * (the route calls it on every exit path; later calls are no-ops), so a turn can never be counted
 * twice. A crash before the commit can under-count by at most this one turn, never over-count.
 * It also emits the `session_budget` notice and the cap history rows.
 */
export function createRouteTurn({ db, userId, chatSessionId, begin, provider, model, send, now = () => new Date() }) {
  let committed = false;
  const before = begin.cap;
  return {
    get committed() { return committed; },
    commit(usage, answered = null) {
      if (committed || !begin.enabled) return null;
      const touched = billableOf(usage) > 0 || Number(usage?.cacheReadTokens) > 0;
      if (!touched) return null;
      committed = true;
      try {
        const route = commitTurnUsage(db, userId, chatSessionId, usage, {
          provider: answered?.provider ?? provider, model: answered?.model ?? model, now: now(), ttlMs: cacheTtl(answered?.provider ?? provider).ms,
        });
        const after = capState(route);
        if (begin.capOn && after.limit !== null) {
          if (after.blocked) {
            send({ type: 'notice', kind: 'session_budget', level: 'warning', text: 'This chat reached its session token limit.',
              data: { used: after.used, limit: after.limit, remaining: 0, level: 'reached' } });
            recordRouteEvent(userId, chatSessionId, { kind: 'cap_reached', toProvider: provider, toModel: model, reason: 'cap' });
          } else if (after.warn80 && !before.warn80) {
            send({ type: 'notice', kind: 'session_budget', level: 'info', text: 'This chat used 80 percent of its session token limit.',
              data: { used: after.used, limit: after.limit, remaining: after.remaining, level: 'warn80' } });
          }
        }
        return route;
      } catch (err) {
        // The turn already ran; a bookkeeping failure must not fail it. The next turn's pre-check reads
        // the same store and fails closed if it is really down.
        log.warn('route_commit_failed', { code: err?.code, message: String(err?.message || err).slice(0, 160) });
        return null;
      }
    },
  };
}

/** The `route_switch` notice (and its history row) for a turn whose pick differs from the last turn's. */
export function routeSwitchNotice({ userId, chatSessionId, begin, provider, model, reason = 'user', now = new Date() }) {
  if (!begin.enabled) return null;
  if (!begin.switched && !begin.pick.changed) return null;
  const from = begin.switched?.from ?? null;
  const cost = switchCost({ route: begin.route, target: { provider, model }, now });
  recordRouteEvent(userId, chatSessionId, {
    kind: 'switch', fromProvider: from?.provider, fromModel: from?.model, toProvider: provider, toModel: model,
    reason, coldPrefillTokens: cost.estimatedPrefillTokens,
  });
  return {
    type: 'notice', kind: 'route_switch', level: 'info',
    text: `This chat now runs on ${model || provider}.${cost.cold ? ' The prompt cache starts cold on this turn.' : ''}`,
    data: { from, to: { provider, model }, reason, cold: cost.cold, estimatedPrefillTokens: cost.estimatedPrefillTokens },
  };
}

/**
 * A turn on a catalog provider (custom:cat-*): the adapter, not the Claude engine. Lazy import, like
 * the engine, so the AI SDK never joins the boot path. Returns the shape runV2Stream expects, plus
 * `metered: true` because runProviderTurn writes its own ledger row.
 */
export async function runAdapterTurn(args) {
  const { runProviderTurn } = await import('../llm_agent/adapter/provider-turn.mjs');
  const out = await runProviderTurn({
    userId: args.userId, provider: args.provider, model: args.model, message: args.message,
    history: args.history, mode: args.mode, agentContext: args.agentContext,
    onEvent: args.onEvent, signal: args.signal, maxBillableTokens: args.maxBillableTokens,
  });
  const u = out.usageTotals ?? {};
  return {
    usageTotals: {
      inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0, cacheCreationTokens: u.cacheCreationTokens ?? 0,
      turns: out.steps ?? null, stopReason: out.capStop ? 'session_cap' : (out.finishReason ?? null),
    },
    metered: true,
    // The pick the fallback may have changed; the route's counters name what really answered.
    answered: { provider: out.provider, model: out.model },
  };
}

// --- GET/PUT /agent/v2/session/route and GET .../route/history ----------------

const EMPTY_USED = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, billable: 0 };

/** The wire shape of a route: flat, with the two switches the client needs to draw its control. */
export function routeWire(route, chatSessionId, env = process.env) {
  const base = route ?? {
    chatSessionId, provider: '', model: '', pinned: false, pinnedBy: 'user', tokenLimit: null, used: EMPTY_USED,
    remaining: null, stickyUntil: null, warm: {}, switchSeq: 0, handoffUpTo: null, pending: null, updatedAt: null,
  };
  const { handoffUpTo: _drop, ...rest } = base;
  void _drop;
  return { enabled: routerEnabled(env), capEnforced: routerCapEnabled(env), ...rest };
}

const sendRouteError = (res, err) => {
  if (err instanceof RouteError) {
    sendJSON(res, err.status, { error: { code: err.code, message: err.message, ...(err.extra ? { details: err.extra } : {}) } });
    return true;
  }
  throw err;
};

function chatIdFromQuery(url) {
  try { return new URL(url, 'http://local').searchParams.get('chatSessionId') ?? ''; } catch { return ''; }
}

/** GET /agent/v2/session/route?chatSessionId= */
export function handleRouteGet(req, res, userId, db, env = process.env) {
  const chatSessionId = chatIdFromQuery(req.url || '');
  if (!chatSessionId || chatSessionId.length > 200) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'chatSessionId is required' } });
    return true;
  }
  // Router off: nothing is read; the client sees `enabled: false` and hides its control.
  if (!routerEnabled(env)) { sendJSON(res, 200, routeWire(null, chatSessionId, env)); return true; }
  try {
    sendJSON(res, 200, routeWire(getRoute(db, userId, chatSessionId), chatSessionId, env));
  } catch (err) {
    if (err instanceof RouteError) return sendRouteError(res, err);
    sendRouteError(res, unavailable(err));
  }
  return true;
}

/** PUT /agent/v2/session/route  { chatSessionId, provider?, model?, tokenLimit?, tokensUsed?, ifSeq? } */
export async function handleRoutePut(req, res, userId, db, { isChatTurnInFlight, env = process.env } = {}) {
  const body = parseJSON(await readBody(req, 16 * 1024)) || {};
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : '';
  if (!chatSessionId) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'chatSessionId is required' } });
    return true;
  }
  if (!routerEnabled(env)) {
    sendJSON(res, 409, { error: { code: 'ROUTER_DISABLED', message: 'The session router is off on this server (LLMIDE_ROUTER).' } });
    return true;
  }
  try {
    const patch = { tokenLimit: body.tokenLimit, tokensUsed: body.tokensUsed, ifSeq: body.ifSeq };
    if (body.provider !== undefined || body.model !== undefined) {
      patch.provider = normalizePinnedProvider(body.provider);
      patch.model = body.model;
    }
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    const inFlight = typeof isChatTurnInFlight === 'function' && isChatTurnInFlight(userId, chatSessionId);
    const before = getRoute(db, userId, chatSessionId);
    const out = putRoute(db, userId, chatSessionId, patch, { inFlight });
    const cost = out.switched?.to?.provider
      ? switchCost({ route: before, target: out.switched.to })
      : null;
    if (out.switched) {
      recordRouteEvent(userId, chatSessionId, {
        kind: 'switch', fromProvider: out.switched.from?.provider, fromModel: out.switched.from?.model,
        toProvider: out.switched.to.provider, toModel: out.switched.to.model, reason: 'user',
        coldPrefillTokens: cost?.estimatedPrefillTokens,
      });
    }
    if (out.limitChanged) {
      recordRouteEvent(userId, chatSessionId, { kind: 'cap_changed', reason: 'user' });
    }
    sendJSON(res, 200, {
      ...routeWire(out.route, chatSessionId, env), appliesAt: out.appliesAt, changed: out.changed,
      ...(cost ? { coldSwitch: cost.cold, estimatedPrefillTokens: cost.estimatedPrefillTokens } : {}),
    });
  } catch (err) {
    if (err instanceof RouteError) return sendRouteError(res, err);
    sendRouteError(res, unavailable(err));
  }
  return true;
}

/** GET /agent/v2/session/route/history?chatSessionId= (from agent.db; `degraded: true` when it is down). */
export function handleRouteHistory(req, res, userId) {
  const chatSessionId = chatIdFromQuery(req.url || '');
  if (!chatSessionId || chatSessionId.length > 200) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'chatSessionId is required' } });
    return true;
  }
  sendJSON(res, 200, listRouteEvents(userId, chatSessionId));
  return true;
}
