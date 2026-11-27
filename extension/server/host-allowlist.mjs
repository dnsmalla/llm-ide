// Host-header allowlist for the loopback core.
//
// Why: the core binds 127.0.0.1, but a web page can point attacker.example at 127.0.0.1 (DNS rebinding) and
// then talk to the core SAME-ORIGIN, where CORS does not apply. A browser always sends the attacker's name in
// `Host`, so refusing every non-loopback Host closes that route. Only the hostname is compared (a port says
// nothing about who the caller is), so `ssh -L` forwards on another local port keep working.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const PORT_RE = /^\d{1,5}$/;

/**
 * Splits a Host header into a normalised hostname, or null when it is malformed.
 *
 * @param {string} value Raw Host header value (`name`, `name:port`, `[v6]`, `[v6]:port`).
 * @returns {string | null} Lower-case hostname without port or one trailing dot; IPv6 stays bracketed.
 */
function parseHostname(value) {
  let hostPart;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest !== '' && !(rest.startsWith(':') && PORT_RE.test(rest.slice(1)))) return null;
    // URL canonicalises every spelling of an IPv6 literal, so `[0:0:0:0:0:0:0:1]` and `[::1]` compare equal.
    try { hostPart = new URL(`http://${value.slice(0, end + 1)}`).hostname; } catch { return null; }
    return /^\[[0-9a-f:.]+\]$/.test(hostPart) ? hostPart : null;
  }
  const colon = value.indexOf(':');
  if (colon >= 0) {
    if (value.indexOf(':', colon + 1) >= 0 || !PORT_RE.test(value.slice(colon + 1))) return null;
    hostPart = value.slice(0, colon);
  } else {
    hostPart = value;
  }
  hostPart = hostPart.toLowerCase();
  if (hostPart.endsWith('.')) hostPart = hostPart.slice(0, -1);
  return NAME_RE.test(hostPart) ? hostPart : null;
}

function isLoopbackName(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const m = IPV4_RE.exec(hostname);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) && octets[0] === 127;
}

// config.allowedHosts is one array for the process lifetime, so normalise it once per array, not per request.
const normalizedExtras = new WeakMap();

/**
 * Normalises the operator's `LLMIDE_ALLOWED_HOSTS` entries the same way a Host header is normalised.
 *
 * @param {string[]} entries Comma-split env entries.
 * @returns {Set<string>} Hostnames; entries that do not parse are dropped (they could never match).
 */
function extraHosts(entries) {
  if (!Array.isArray(entries)) return new Set();
  let set = normalizedExtras.get(entries);
  if (!set) {
    set = new Set(entries.map((entry) => parseHostname(String(entry).trim())).filter(Boolean));
    normalizedExtras.set(entries, set);
  }
  return set;
}

/**
 * Decides whether a request's Host header may reach the core.
 *
 * Pre: `settings.allowedHosts` holds the raw comma-split env entries (`config.allowedHosts`).
 * Post: a missing or empty header is allowed (not a browser vector); a malformed one is refused; the whole
 * check is off for a hub or a remote-mode core, which legitimately see a proxy or LAN Host.
 *
 * @param {string | undefined} hostHeader The raw `Host` header.
 * @param {{ hub?: boolean, allowRemote?: boolean, allowedHosts?: string[] }} settings Config slice.
 * @returns {boolean} True when the request may proceed.
 */
export function isHostAllowed(hostHeader, settings = {}) {
  if (settings.hub || settings.allowRemote) return true;
  if (hostHeader === undefined || hostHeader === null || hostHeader === '') return true;
  if (typeof hostHeader !== 'string') return false;
  const hostname = parseHostname(hostHeader);
  if (hostname === null) return false;
  return isLoopbackName(hostname) || extraHosts(settings.allowedHosts).has(hostname);
}
