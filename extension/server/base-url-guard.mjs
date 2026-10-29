// SSRF guard for provider base URLs (the provider catalog's connections).
//
// Two postures, chosen by the catalog entry AND an explicit user opt-in:
//
//   default       https only; localhost, loopback, RFC-1918 and link-local are
//                 refused (the same rule as providers.mjs assertSafeBaseUrl,
//                 which stays as it is for the legacy custom providers).
//   allowPrivate  https or http, and loopback / RFC-1918 / unique-local hosts
//                 are allowed: a local Ollama, LM Studio or a self-hosted
//                 gateway on the user's own LAN. Link-local (169.254/16,
//                 fe80::/10: cloud metadata) and the unspecified address stay
//                 refused in BOTH postures, and a URL with credentials in it
//                 is refused always.
//
// Pure and synchronous: the literal checks only. Callers that fetch also
// resolve DNS through providers.mjs assertSafeBaseUrlResolved for the strict
// posture; a private-network opt-in is the user's own statement that the
// address is theirs.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Parts(host) {
  const m = IPV4.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

function isLinkLocalOrUnspecified(host) {
  const v4 = ipv4Parts(host);
  if (v4) return (v4[0] === 169 && v4[1] === 254) || (v4[0] === 0);
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return /^fe[89ab][0-9a-f]:/.test(h) || h === '::';
}

function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const v4 = ipv4Parts(h);
  if (v4) {
    return v4[0] === 127 || v4[0] === 10 || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31)
      || (v4[0] === 192 && v4[1] === 168);
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h);
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
  if (parsed.username || parsed.password) throw new Error('Base URL must not contain credentials');
  const host = parsed.hostname.toLowerCase();
  if (isLinkLocalOrUnspecified(host)) throw new Error('Base URL points at a link-local or unspecified address, which is never allowed');
  if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) {
    throw new Error(allowPrivate ? 'Base URL must use http or https' : 'Base URL must use https');
  }
  if (!allowPrivate && isPrivateHost(host)) {
    throw new Error('Base URL points at a local or private address; this provider does not allow that');
  }
  if (parsed.protocol === 'http:' && !isPrivateHost(host)) {
    throw new Error('Plain http is only allowed for a local or private address');
  }
  return url.replace(/\/+$/, '');
}
