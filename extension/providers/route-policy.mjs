// Session router policy (K1 Phase 6b, plan 14.3). Pure functions: no I/O, no clock of their own
// (every function takes `now`), so the policy is testable without a server.
//
// What the router decides, and what it never does:
//   - A chat pinned to a provider/model keeps it. The client's own pick governs an unpinned chat.
//   - The pick changes ONLY on a user change, a rate limit, a provider error or the cap. The
//     rate-limit and error cases are the existing start-of-turn fallback (provider-fallback.mjs,
//     which the caller runs after this); the cap is a stop, not a switch.
//   - It NEVER switches because a cache went cold (user answer Q-R3, 2026-10-30). Warmth is only
//     used to PRICE a switch for the UI ("about N tokens on the next turn") and to decide whether
//     the Claude SDK session can be resumed.
//   - The pick is made once, at turn start. Nothing here is consulted mid-stream.

const MIN = 60_000;

/**
 * Prompt-cache lifetime per provider. `source` says how much to trust the number:
 *   'user_figure'  the user's own figure, not re-verified in this repo
 *   'assumed'      no provider documentation read yet; 10 minutes. An unverified TTL only changes
 *                  when a switch is CHEAP, never whether it is allowed or correct.
 * The bench rows in plan 14.11 turn 'assumed' into measured values.
 */
export const CACHE_TTL = Object.freeze({
  anthropic: { minutes: 5, extendedMinutes: 60, source: 'user_figure' },
  openrouter: { minutes: 10, source: 'user_figure' },
  openai: { minutes: 10, source: 'assumed' },
  google: { minutes: 10, source: 'assumed' },
  deepseek: { minutes: 10, source: 'assumed' },
  groq: { minutes: 10, source: 'assumed' },
  xai: { minutes: 10, source: 'assumed' },
  mistral: { minutes: 10, source: 'assumed' },
  together: { minutes: 10, source: 'assumed' },
  cerebras: { minutes: 10, source: 'assumed' },
  // A local KV cache has no TTL concept: nothing is lost by switching, so no stickiness is needed.
  ollama: { minutes: 0, source: 'assumed' },
  'openai-compatible': { minutes: 10, source: 'assumed' },
});
const DEFAULT_TTL = Object.freeze({ minutes: 10, source: 'assumed' });
const SKEW_TOLERANCE_MS = MIN;

/** The catalog id of a provider string: `custom:cat-groq` -> `groq`, `claude`/`anthropic` -> `anthropic`. */
export function catalogIdOf(provider) {
  if (!provider || provider === 'claude' || provider === 'anthropic') return 'anthropic';
  const m = /^custom:cat-(.+)$/.exec(provider);
  return m ? m[1] : null;
}

/** Cache TTL for a provider, in ms, with its trust level. `extended` is the 1 h Anthropic option. */
export function cacheTtl(provider, { extended = false } = {}) {
  const entry = CACHE_TTL[catalogIdOf(provider)] ?? DEFAULT_TTL;
  const minutes = extended && entry.extendedMinutes ? entry.extendedMinutes : entry.minutes;
  return { ms: minutes * MIN, source: entry.source };
}

const keyOf = (provider, model) => `${provider}|${model}`;

/**
 * Is the cache of (provider, model) warm for this chat right now?
 * A stamp from the future (clock moved back) beyond a minute of tolerance is not trusted: it counts
 * as cold, because "warm for an unknowable time" would hold a stale pick or skip a needed warning.
 */
export function isWarm(warm, provider, model, now, { extended = false } = {}) {
  const ttl = cacheTtl(provider, { extended });
  if (ttl.ms === 0) return false;
  const stamp = Date.parse(warm?.[keyOf(provider, model)] ?? '');
  if (!Number.isFinite(stamp)) return false;
  const age = now.getTime() - stamp;
  if (age < -SKEW_TOLERANCE_MS) return false;
  return age < ttl.ms;
}

/** The (provider, model) a chat last touched (newest stamp in `warm`), or null. */
export function lastTouched(warm) {
  let best = null;
  for (const [k, v] of Object.entries(warm ?? {})) {
    const t = Date.parse(v);
    if (!Number.isFinite(t)) continue;
    if (!best || t > best.t) best = { k, t };
  }
  if (!best) return null;
  const i = best.k.indexOf('|');
  return { provider: best.k.slice(0, i), model: best.k.slice(i + 1), at: new Date(best.t).toISOString() };
}

/**
 * The route pick for a turn that is about to start. Never throws.
 *
 * @param {{ route: object|null, requested: {provider: string, model: string|null}, now?: Date }} o
 * @returns {{ provider: string, model: string|null, source: 'route'|'request', pinned: boolean, changed: boolean,
 *             freshSession: boolean, cold: boolean, coldReason: string|null }}
 *   freshSession: the previous turn ran on another provider, so the Claude SDK session (if any) must
 *   not be resumed: the turn is seeded like an ended chat (plan 3.4), never from a cold transcript.
 */
export function pickRoute({ route, requested, now = new Date() }) {
  const pinned = !!route?.pinned;
  const pick = pinned
    ? { provider: route.provider, model: route.model, source: 'route' }
    : { provider: requested.provider, model: requested.model ?? null, source: 'request' };
  const last = lastTouched(route?.warm);
  const sameProvider = !last || catalogIdOf(last.provider) === catalogIdOf(pick.provider);
  const warm = isWarm(route?.warm, pick.provider, pick.model ?? '', now);
  let cold = false;
  let coldReason = null;
  const changed = !!last && (last.provider !== pick.provider || last.model !== (pick.model ?? ''));
  if (changed) {
    cold = !warm;
    coldReason = cold ? 'switch' : null;
  } else if (last && !warm) {
    cold = true;
    coldReason = 'expired';
  }
  return { ...pick, pinned, changed, freshSession: !!last && !sameProvider, cold, coldReason };
}

/**
 * The cost of moving a chat to `target`, for the UI warning and the history row. Warm target = the
 * cache is still there (cheap); otherwise the next turn pays one cold prefill of the handoff note
 * plus the last turns, estimated from the chat's context size.
 *
 * @returns {{ cold: boolean, estimatedPrefillTokens: number }}
 */
export function switchCost({ route, target, contextTokens = 0, handoffTokens = 1500, now = new Date() }) {
  const warm = isWarm(route?.warm, target.provider, target.model, now);
  if (warm) return { cold: false, estimatedPrefillTokens: 0 };
  // A cold switch sends the handoff, never the old transcript; it can never cost more than the transcript itself.
  const est = Math.max(0, Math.min(Math.trunc(contextTokens) || handoffTokens, handoffTokens));
  return { cold: true, estimatedPrefillTokens: est };
}

/**
 * The session cap check, one rule used before a turn and (as `remaining`) as the mid-turn ceiling.
 * @returns {{ blocked: boolean, used: number, limit: number|null, remaining: number|null, warn80: boolean }}
 */
export function capState(route) {
  const limit = route?.tokenLimit ?? null;
  const used = route?.used?.billable ?? 0;
  if (limit === null) return { blocked: false, used, limit: null, remaining: null, warn80: false };
  return { blocked: used >= limit, used, limit, remaining: Math.max(0, limit - used), warn80: used >= limit * 0.8 };
}
