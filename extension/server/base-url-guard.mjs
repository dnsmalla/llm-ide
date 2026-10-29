// SSRF guard for provider base URLs (the provider catalog's connections).
//
// Two postures, chosen by the catalog entry AND an explicit user opt-in, and a
// third switch the operator owns:
//
//   default       https only; every non-public address class is refused
//                 (loopback, RFC 1918, CGNAT, ULA, link-local, metadata, …).
//   allowPrivate  https or http, and loopback / RFC 1918 / CGNAT / ULA hosts
//                 are allowed: a local Ollama, LM Studio or a self-hosted
//                 gateway on the user's own network. Link-local, metadata,
//                 unspecified, multicast and reserved ranges stay refused in
//                 BOTH postures, after DNS as well as in the literal.
//   operator      `LLMIDE_ALLOW_PRIVATE_PROVIDERS` (see privateProvidersAllowed):
//                 a server bound beyond this machine refuses private targets
//                 unless the operator turns this on.
//
// Every IP spelling goes through ONE classifier (server/ip-classifier.mjs). The
// literal check here is the sync half; the connect-time half (DNS resolved,
// every address classified, the checked address is the one dialled) is
// server/pinned-fetch.mjs. A base URL may not carry a query or fragment, so a
// `#` or `?` cannot swallow the path a request URL is built from.

import { classifyIp, ipRefusal } from './ip-classifier.mjs';
import { config } from '../core/config.mjs';

/**
 * Whether private-network provider targets may be used at all. Explicit env
 * wins ('1' on, '0' off); unset means allowed exactly when the server is bound
 * to this machine only (no LLMIDE_ALLOW_REMOTE), which is when every request
 * comes from the local user.
 */
export function privateProvidersAllowed(env = process.env) {
  const v = String(env.LLMIDE_ALLOW_PRIVATE_PROVIDERS ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return !config.allowRemote;
}

export function isLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const c = classifyIp(h);
  return c.ip && c.reason === 'loopback address';
}

function isPrivateName(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

/**
 * Throw a clear Error when `url` may not be used as a provider base URL.
 * @param {string} url
 * @param {{ allowPrivate?: boolean }} [opts]
 * @returns {string} the URL without trailing slashes
 */
export function assertProviderBaseUrl(url, { allowPrivate = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Base URL is not a valid URL'); }
  if (/[?#]/.test(String(url))) throw new Error('Base URL must not contain a query string or fragment');
  if (parsed.username || parsed.password) throw new Error('Base URL must not contain credentials');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) {
    throw new Error(allowPrivate ? 'Base URL must use http or https' : 'Base URL must use https');
  }
  const c = classifyIp(host);
  if (c.ip) {
    const why = ipRefusal(host, { allowPrivate });
    if (why) throw new Error(`Base URL host is a ${why}`);
    if (parsed.protocol === 'http:' && c.class !== 'private') throw new Error('Plain http is only allowed for a local or private address');
  } else {
    if (isPrivateName(host) && !allowPrivate) throw new Error('Base URL points at a local or private address; this provider does not allow that');
    // Plain http only to a name that is private by construction; any other
    // hostname must use https (its resolved address is checked at connect time).
    if (parsed.protocol === 'http:' && !isPrivateName(host)) throw new Error('Plain http is only allowed for a local or private address');
  }
  return url.replace(/\/+$/, '');
}

/** Build `<base>/<path>` from a vetted base URL with the URL API (no string splicing of untrusted input). */
export function joinBaseUrl(base, path) {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}
