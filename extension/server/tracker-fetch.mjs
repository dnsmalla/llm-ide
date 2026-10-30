// Pinned fetch for issue-tracker hosts (GitHub, Linear, Backlog): connectors/issues.mjs,
// agents/dispatcher.mjs, agents/outcome-providers.mjs.
//
// One rule, reused from the provider layer rather than invented a second time:
// every request resolves the host once, classifies EVERY address and dials only
// the checked one (server/pinned-fetch.mjs, server/ip-classifier.mjs). Hosted
// trackers (github.com, api.linear.app, <space>.backlog.{com,jp,tool}) are public
// and just work. A tracker on a private address (a self-hosted GitLab or Backlog
// on 10.x) is refused unless BOTH switches the provider catalog already uses are
// on: the caller passes `allowPrivate: true` (the connection's explicit
// private-network opt-in) AND the operator gate LLMIDE_ALLOW_PRIVATE_PROVIDERS
// permits it (privateProvidersAllowed). Link-local and cloud-metadata addresses
// stay refused in every mode. Today none of the three callers can be pointed at a
// non-hosted host (their hosts are fixed or validated against BACKLOG_TLD_RE), so
// none passes `allowPrivate`; the option exists so a self-hosted tracker config,
// when one is added, reuses the same two switches.
//
// Redirects: a credentialed request is never replayed to another host. By default
// any 3xx is refused (POSTs and the Backlog query-string key). A read-only GET may
// opt in with `followSameHost` (GitHub answers a renamed repo with a 301 to the
// same host): each hop is re-pinned, must keep the same scheme (no https to http downgrade) and host, at most 3.
//
// Errors: messages are passed through redactWithKey(secret) so a token or
// apiKey that rides in a URL or an echoed body never reaches a log or a response.

import { makePinnedFetch } from './pinned-fetch.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';

const MAX_SAME_HOST_HOPS = 3;
const HINT = ' (a tracker on a private network needs the connection\'s private-network opt-in and LLMIDE_ALLOW_PRIVATE_PROVIDERS)';

function refusedRedirect() {
  return new TypeError('fetch failed', { cause: new Error('redirect refused') });
}

/**
 * @param {{ allowPrivate?: boolean, secret?: string, followSameHost?: boolean,
 *           resolver?: Function, gate?: () => boolean }} [o]
 * @returns {typeof fetch}
 */
export function makeTrackerFetch({ allowPrivate = false, secret, followSameHost = false, resolver, gate } = {}) {
  const opts = { allowPrivate };
  if (resolver) opts.resolver = resolver;
  if (gate) opts.gate = gate;
  const pinned = makePinnedFetch(opts);

  const scrub = (err) => {
    if (err && typeof err.message === 'string') {
      let m = redactWithKey(err.message, secret);
      if (err.code === 'SSRF_BLOCKED' && /private|loopback|RFC 1918|carrier-grade|unique-local/i.test(m)) m += HINT;
      if (m !== err.message) { try { err.message = m; } catch { /* read-only message: keep as is */ } }
    }
    return err;
  };

  return async function trackerFetch(input, init = {}) {
    try {
      const method = String(init.method || 'GET').toUpperCase();
      if (!followSameHost || method !== 'GET' || init.redirect === 'manual') return await pinned(input, init);
      let url = new URL(String(input));
      for (let hop = 0; ; hop += 1) {
        const res = await pinned(url.href, { ...init, redirect: 'manual' });
        if (res.status < 300 || res.status >= 400) return res;
        try { await res.body?.cancel(); } catch { /* ignore */ }
        const loc = res.headers.get('location');
        if (!loc || hop >= MAX_SAME_HOST_HOPS) throw refusedRedirect();
        const next = new URL(loc, url);
        if (next.protocol !== url.protocol || next.host !== url.host) throw refusedRedirect();
        url = next;
      }
    } catch (err) {
      throw scrub(err);
    }
  };
}
