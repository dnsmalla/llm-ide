// What the route does with the SDK signals the engine surfaces as `notice`
// events (events.mjs mapNotice): audit a permission denial, record the
// subscription limit signal, note a model fallback. Everything here is
// best-effort bookkeeping: it never throws into the turn, and it never changes
// which model runs or what a budget allows.
//
// Dependencies are injected so a test needs no database.

import { recordSubscriptionLimit } from '../../kb/usage.mjs';
import { recordAudit } from '../../server/audit.mjs';
import { recordActivity } from '../../kb/activity.mjs';

export function createNoticeEffects({ userId, turnId, db, log, deps = {} }) {
  const d = {
    recordSubscriptionLimit, recordAudit, recordActivity, ...deps,
  };
  const seenFallbacks = new Set();
  let lastLimitKey = null;
  const safe = (fn) => { try { fn(); } catch { /* best effort */ } };

  return function observe(ev) {
    if (!ev || ev.type !== 'notice' || !userId) return;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};

    if (ev.kind === 'rate_limit') {
      safe(() => d.recordSubscriptionLimit(userId, {
        status: data.status, rateLimitType: data.rateLimitType, resetsAt: data.resetsAt ?? undefined,
        utilization: data.utilization ?? undefined, isUsingOverage: data.isUsingOverage,
      }));
      // The store keeps the latest value, so a signal that flaps allowed ->
      // rejected -> allowed leaves the truth in place. Only a CHANGE is logged.
      const key = `${data.status}|${data.rateLimitType}`;
      if (key !== lastLimitKey) {
        lastLimitKey = key;
        if (data.status && data.status !== 'allowed') {
          safe(() => log?.warn?.('agent_v2_rate_limit', { turnId, status: data.status, rateLimitType: data.rateLimitType }));
        }
      }
      return;
    }

    if (ev.kind === 'permission_denied') {
      safe(() => d.recordAudit(db, {
        userId, requestId: turnId, action: 'agent.permission_denied',
        resource: typeof data.toolName === 'string' ? data.toolName : null, outcome: 'denied',
        detail: { reasonType: data.reasonType ?? null, subagent: data.subagent === true },
      }));
      return;
    }

    if (ev.kind === 'model_fallback') {
      const key = `${data.fromModel}>${data.toModel}`;
      if (seenFallbacks.has(key)) return;
      seenFallbacks.add(key);
      safe(() => d.recordActivity({
        userId, kind: 'model_fallback',
        title: `Switched ${data.fromModel} -> ${data.toModel} (model refusal)`,
        detail: { from: data.fromModel, to: data.toModel, reason: 'refusal', category: data.category ?? null },
      }));
      return;
    }

    if (ev.kind === 'refusal') {
      safe(() => d.recordAudit(db, {
        userId, requestId: turnId, action: 'agent.model_refusal', resource: data.fromModel ?? null,
        outcome: 'denied', detail: { category: data.category ?? null },
      }));
      return;
    }

    if (ev.kind === 'retry') {
      safe(() => log?.warn?.('agent_v2_api_retry', {
        turnId, attempt: data.attempt, maxRetries: data.maxRetries, errorStatus: data.errorStatus,
      }));
    }
  };
}
