// Cross-provider fallback for provider-catalog connections.
//
// The same-provider chain (kb/usage.mjs: per-model limits, quota flags, the
// reactive 429 step-down in providers.mjs) stays as it is. This adds ONE thing
// on top, and only when the user turned it on: an ordered list of provider
// connections to try when the requested one is rate-limited or cannot do the
// job.
//
// The decision is made ONCE, at the START of a turn, from state the app
// already keeps (quota_state flags, the last rate-limit header snapshot). It is
// never revisited mid-stream: a turn that began on a model finishes on it, and
// the next turn is where a different provider can be chosen. Every switch is
// returned as `switched` with a reason, for the caller to surface; nothing is
// ever switched silently. OFF by default (settings.fallbackEnabled).
//
// This module offers an ORDERED list, nothing more: it does not spread load
// across free tiers or rotate keys, and a user's own list is the only source of
// candidates (see docs/spec/provider-catalog.md, "Terms of use").

import { getDb } from '../kb/db.mjs';
import { windowStart, toSqliteLocal, getRateLimits } from '../kb/usage.mjs';
import { catalogEntry, modelCapability } from '../server/provider-catalog.mjs';
import { getConnection, getSettings } from '../server/provider-connections.mjs';
import { limitNear } from '../kb/learned-limits.mjs';

function quotaFlagged(db, userId, provider, model, now) {
  try {
    const starts = ['daily', 'monthly'].map((k) => toSqliteLocal(windowStart(k, now)));
    const row = db.prepare(
      `SELECT 1 FROM quota_state
        WHERE user_id=? AND provider=? AND model=? AND exhausted=1 AND window_start IN (?, ?) LIMIT 1`,
    ).get(userId, provider, model, starts[0], starts[1]);
    return !!row;
  } catch { return false; }
}

// A header snapshot that says zero requests or tokens remain AND whose reset
// is still ahead. An absent or unparseable reset counts as "not limited": the
// snapshot is advisory and a stale zero must not park a provider for ever.
const cooldowns = new Map();   // `${userId}|${provider}` → until (ms epoch)
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * Note that a provider just answered 429, so the NEXT turn's pick skips it for
 * a short time (honouring Retry-After, capped). In memory by design: a restart
 * forgets it, and a wrong guess costs one rate-limited turn, not a wrong answer.
 */
export function noteProviderRateLimited(userId, provider, retryAfterMs = DEFAULT_COOLDOWN_MS) {
  if (cooldowns.size > 500) cooldowns.delete(cooldowns.keys().next().value);
  const ms = Math.min(Math.max(Number(retryAfterMs) || DEFAULT_COOLDOWN_MS, 1000), MAX_COOLDOWN_MS);
  cooldowns.set(`${userId}|${provider}`, Date.now() + ms);
}

/** Test seam. */
export function _clearCooldownsForTests() { cooldowns.clear(); }

function rateLimited(userId, provider, now) {
  const until = cooldowns.get(`${userId}|${provider}`);
  if (until && until > now.getTime()) return true;
  const snap = getRateLimits(userId, provider);
  if (!snap) return false;
  const fresh = now.getTime() - Date.parse(snap.capturedAt) < 10 * 60_000;
  if (!fresh) return false;
  return [snap.requests, snap.tokens].some((b) => b && b.remaining === 0
    && (b.reset == null || !Number.isFinite(Date.parse(b.reset)) || Date.parse(b.reset) > now.getTime()));
}

function defaultModelFor(entry, needsTools, overrides, connId) {
  const pick = (entry?.models || []).find((m) => !needsTools
    || modelCapability(entry, m.id, { override: overrides[`${connId}/${m.id}`] }).toolsSupported);
  return pick?.id ?? null;
}

/**
 * Choose the provider and model for a turn that is about to start.
 *
 * @param {string} userId
 * @param {{ provider: string, model: string, needsTools?: boolean, now?: Date, db?: object }} req
 * @returns {{ provider: string, model: string, switched: boolean, reason?: string,
 *             exhausted?: boolean, skipped: Array<{provider: string, reason: string}> }}
 */
export function pickTurnProvider(userId, { provider, model, needsTools = false, now = new Date(), db = getDb() } = {}) {
  const requested = { provider, model, switched: false, skipped: [] };
  const settings = getSettings(userId, db);
  if (!settings.fallbackEnabled || !settings.fallbackOrder.length) return requested;

  const candidates = [{ provider, model }];
  for (const e of settings.fallbackOrder) {
    if (e.provider !== provider) candidates.push({ provider: e.provider, model: e.model ?? null });
  }
  const skipped = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const conn = getConnection(c.provider, userId, db);
    if (!conn || !conn.enabled) { skipped.push({ provider: c.provider, reason: 'not_connected' }); continue; }
    const entry = catalogEntry(conn.catalogId);
    if (entry?.keyRequired && !conn.hasKey) { skipped.push({ provider: c.provider, reason: 'no_key' }); continue; }
    const m = c.model || defaultModelFor(entry, needsTools, settings.toolOverrides, conn.id);
    if (!m) { skipped.push({ provider: c.provider, reason: 'no_suitable_model' }); continue; }
    if (needsTools && !modelCapability(entry, m, { override: settings.toolOverrides[`${conn.id}/${m}`] }).toolsSupported) {
      skipped.push({ provider: c.provider, reason: 'no_tools' }); continue;
    }
    if (quotaFlagged(db, userId, c.provider, m, now)) { skipped.push({ provider: c.provider, reason: 'quota' }); continue; }
    if (rateLimited(userId, c.provider, now)) { skipped.push({ provider: c.provider, reason: 'rate_limited' }); continue; }
    // Learned per-key limit (LLMIDE_ROUTER_LEARN=on): at 90 percent of a limit this key has shown, skip it
    // for this turn and park it briefly so the next picks agree. Never mid-stream; only to the user's own list.
    const near = limitNear(db, userId, c.provider, m, now);
    if (near.near) {
      noteProviderRateLimited(userId, c.provider, 30_000);
      skipped.push({ provider: c.provider, reason: 'limit_near' });
      continue;
    }
    if (i === 0) return { ...requested, skipped };
    return {
      provider: c.provider, model: m, switched: true, skipped,
      reason: `${skipped[0]?.provider ?? provider} was ${String(skipped[0]?.reason ?? 'unavailable').replace('_', ' ')}; using ${conn.name}`,
    };
  }
  // Nothing eligible: run on what was asked for and let its own error be the answer.
  return { ...requested, exhausted: true, skipped };
}
