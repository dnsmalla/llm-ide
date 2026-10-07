/**
 * Route health: is a routed provider able to run right now?
 *
 * Two caches, both in memory (per server process) and both consulted by the
 * tier resolver (providers/tier-routing.mjs) without ever blocking a model
 * call:
 *
 *  1. CLI probe — for a keyless OpenAI/Google tier the route runs the
 *     provider's logged-in CLI (codex / gemini). A binary merely on PATH is
 *     not enough (a codex npm shim whose native binary is missing exits 1 on
 *     every call), so the probe runs `<bin> --version` with the same minimal
 *     env and bin lookup the real spawn uses. Success is trusted ~10 min,
 *     failure ~60 s. A provider never probed (or being re-probed after a
 *     failure) answers from the cache only and starts the probe in the
 *     background; "never probed" counts as unusable, so the first routed call
 *     after a restart takes the default path rather than waiting.
 *
 *  2. Negative cache — a routed call that failed at runtime (runClaude's
 *     route fallback, or a CLI that could not run) marks `(user, provider,
 *     model)` failed — ~10 min when broken, ~60 s when transient — so the
 *     next call (e.g. a JSON-retry right after) and the Settings status skip
 *     it instead of failing again.
 */

import { execFile } from 'node:child_process';
import { logger } from '../core/logger.mjs';
import { providerHasCli, cliBinFor, minimalCliEnv } from './providers.mjs';

const log = logger.child({ component: 'route-health' });

const PROBE_OK_TTL_MS = 10 * 60_000;
const PROBE_FAIL_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_GUARD_SLACK_MS = 1_000;
// How long a failed route is skipped: a broken one (auth, missing/logged-out
// CLI, rejected model) ~10 min; a transient one (429, 5xx, network) ~60 s.
export const ROUTE_BROKEN_TTL_MS = 10 * 60_000;
export const ROUTE_TRANSIENT_TTL_MS = 60_000;

// bin → { ok: boolean, at: number }
const probeResults = new Map();
// bin → Promise<boolean> (in-flight probe; deduplicates concurrent callers)
const probesInFlight = new Map();
// `${userId}|${provider}|${model}` → { reason, at, ttlMs }
const routeFailures = new Map();

function defaultProbeRunner(bin, { timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(bin, ['--version'], { env: minimalCliEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 },
        (err) => resolve(!err));
    } catch {
      resolve(false);
      return;
    }
    child.stdin?.end();
  });
}

let probeRunner = defaultProbeRunner;

/** Test seam: replace the probe (`async (bin, { timeoutMs }) => boolean`); null restores the real one. */
export function _setCliProbeRunnerForTests(fn) {
  probeRunner = typeof fn === 'function' ? fn : defaultProbeRunner;
}

/** Test seam: forget every probe result, in-flight probe and route failure. */
export function _resetRouteHealthForTests() {
  probeResults.clear();
  probesInFlight.clear();
  routeFailures.clear();
}

/**
 * Probe `provider`'s CLI now (deduplicated per bin) and cache the answer.
 * Resolves true when `<bin> --version` exits 0 within `timeoutMs`. Never
 * rejects. For callers that may wait (the Settings status path, tests).
 */
export function probeCli(provider, { now, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!providerHasCli(provider)) return Promise.resolve(false);
  const bin = cliBinFor(provider);
  const pending = probesInFlight.get(bin);
  if (pending) return pending;
  // Outer guard: if the runner never settles (execFile's callback lost, a
  // child that ignores the kill), the probe still answers `false` shortly
  // after its own timeout and frees the in-flight slot for the next probe.
  let guard;
  const run = Promise.race([
    Promise.resolve().then(() => probeRunner(bin, { timeoutMs })),
    new Promise((resolve) => { guard = setTimeout(() => resolve(false), timeoutMs + PROBE_GUARD_SLACK_MS); }),
  ])
    .catch(() => false)
    .finally(() => clearTimeout(guard))
    .then((ok) => {
      probeResults.set(bin, { ok: Boolean(ok), at: now ?? Date.now() });
      if (!ok) log.warn('provider_cli_probe_failed', { provider, bin });
      return Boolean(ok);
    })
    .finally(() => { probesInFlight.delete(bin); });
  probesInFlight.set(bin, run);
  return run;
}

/**
 * The cached health of `provider`'s CLI: 'ok' | 'failed' | 'unverified'.
 * Reads the cache only — never waits. An expired or missing answer starts a
 * background probe; while it runs, an expired answer is still returned and a
 * missing one is 'unverified'. Key-only providers are always 'failed'.
 */
export function cliHealth(provider, { now = Date.now() } = {}) {
  if (!providerHasCli(provider)) return 'failed';
  const bin = cliBinFor(provider);
  const hit = probeResults.get(bin);
  const fresh = hit && now - hit.at < (hit.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS);
  if (!fresh) probeCli(provider);
  if (!hit) return 'unverified';
  return hit.ok ? 'ok' : 'failed';
}

/**
 * Wait (at most `timeoutMs`) for the in-flight probes of `providers`. Only
 * for paths where a short wait is acceptable (GET /kb/routing-tiers), never
 * for a model call.
 */
export async function awaitCliProbes(providers, timeoutMs = PROBE_TIMEOUT_MS) {
  const pending = [...new Set(providers)]
    .filter((p) => providerHasCli(p))
    .map((p) => probesInFlight.get(cliBinFor(p)))
    .filter(Boolean);
  if (pending.length === 0) return;
  let timer;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

/**
 * Record that the route `(provider, model)` failed at runtime for `userId`.
 * Keyed by model too, so one bad model id does not take the provider's other
 * tiers offline. `via` picks the status reason: 'cli' → 'cli_failed',
 * otherwise 'route_failed'. `ttlMs` defaults to the broken-route window.
 */
export function markRouteFailed(userId, provider, model, via, { now = Date.now(), ttlMs = ROUTE_BROKEN_TTL_MS } = {}) {
  routeFailures.set(`${userId || ''}|${provider}|${model || ''}`, {
    reason: via === 'cli' ? 'cli_failed' : 'route_failed', at: now, ttlMs,
  });
}

/** The live failure reason for `(userId, provider, model)`, or null. */
export function routeFailure(userId, provider, model, { now = Date.now() } = {}) {
  const key = `${userId || ''}|${provider}|${model || ''}`;
  const hit = routeFailures.get(key);
  if (!hit) return null;
  if (now - hit.at >= hit.ttlMs) {
    routeFailures.delete(key);
    return null;
  }
  return hit.reason;
}
