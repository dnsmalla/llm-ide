// Turning the SDK's running usage totals into one turn's usage.
//
// Since Agent SDK 0.3.277 a resumed session's `result.modelUsage` "continues
// from the totals its transcript saved … so the first result already carries
// the earlier turns" (sdk.d.ts). A v2 chat resumes one SDK session per chat,
// so each turn's modelUsage is the chat's running total, and metering it as
// the turn's usage would count every earlier turn again on every turn.
//
// This keeps, per SDK session, the totals the last metered turn ended at, and
// meters the difference. It is in-process: after a server restart (or an
// evicted entry) a resumed turn has no baseline, and the caller falls back to
// the turn's own streamed usage instead of guessing.

const MAX_SESSIONS = 500;
const baselines = new Map();

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'];

/** The running totals `sdkSessionId` ended its last turn at, or null. */
export function usageBaselineFor(sdkSessionId) {
  if (typeof sdkSessionId !== 'string' || !sdkSessionId) return null;
  return baselines.get(sdkSessionId) ?? null;
}

export function recordUsageBaseline(sdkSessionId, byModel, { previousSdkSessionId } = {}) {
  if (typeof sdkSessionId !== 'string' || !sdkSessionId || !Array.isArray(byModel)) return;
  if (previousSdkSessionId && previousSdkSessionId !== sdkSessionId) baselines.delete(previousSdkSessionId);
  baselines.delete(sdkSessionId);
  baselines.set(sdkSessionId, byModel.map((m) => ({ ...m })));
  while (baselines.size > MAX_SESSIONS) baselines.delete(baselines.keys().next().value);
}

/**
 * This turn's per-model usage: `current` running totals minus `baseline`.
 * A model whose totals went DOWN (a /clear reset the running total) is taken
 * as-is — its whole current total is this turn's.
 */
export function usageDelta(current, baseline) {
  const base = new Map((Array.isArray(baseline) ? baseline : []).map((m) => [m.model, m]));
  return (Array.isArray(current) ? current : []).map((m) => {
    const b = base.get(m.model);
    if (!b) return { ...m };
    const reset = FIELDS.some((f) => (m[f] ?? 0) < (b[f] ?? 0));
    if (reset) return { ...m };
    const out = { model: m.model };
    for (const f of FIELDS) out[f] = (m[f] ?? 0) - (b[f] ?? 0);
    return out;
  }).filter((m) => FIELDS.some((f) => m[f] > 0));
}

export function __resetUsageBaselinesForTest() {
  baselines.clear();
}
