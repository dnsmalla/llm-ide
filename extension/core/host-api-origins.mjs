// Host API v1 web Origin allowlist (Plan 6 decision 6). The same rule as the Mac's HostApiV1Origins.swift, both
// pinned by schema/host-api/v1/fixtures/security/origins.json. Entries: an exact loopback http origin with a port
// (local web development) or an exact https DNS origin (the later VPS domain). Everything else is dropped by name.
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;
const HTTPS = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([0-9]{1,5}))?$/;

const portOk = (p) => Number(p) >= 1 && Number(p) <= 65535;

function normalise(entry) {
  const e = entry.trim().toLowerCase();
  const lo = LOOPBACK.exec(e);
  if (lo) return portOk(lo[2]) ? e : null;
  const h = HTTPS.exec(e);
  if (!h || /^[0-9.]+$/.test(h[1])) return null; // an IP-literal https entry is never a stable web origin
  if (h[2] === undefined) return e;
  if (!portOk(h[2])) return null;
  return h[2] === '443' ? `https://${h[1]}` : e; // browsers omit the default port
}

/** LLMIDE_HOST_API_WEB_ORIGINS -> frozen, de-duplicated list; every dropped entry is logged by name. */
export function parseOriginAllowlist(raw, log = () => {}) {
  const out = [];
  for (const entry of String(raw ?? '').split(',')) {
    if (!entry.trim()) continue;
    const n = normalise(entry);
    if (n === null) log(`[config] LLMIDE_HOST_API_WEB_ORIGINS: dropping ${JSON.stringify(entry.trim())} (only http://localhost|127.0.0.1|[::1]:<port> or https://<dns-name>[:port])`);
    else if (!out.includes(n)) out.push(n);
  }
  return Object.freeze(out);
}

/** The packaged desktop webview is a native client, not a browser page. These three origins are the app's own origin
 *  on macOS/Linux and Windows; a browser cannot forge them, and the pairing/token check still runs. */
const NATIVE = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

/** No Origin (iOS, CLI) passes; a listed or native-webview one passes; anything else, including a non-string or a
 *  comma-joined duplicate header (never equal to one entry), is refused. */
export function originRefused(headers, allowlist) {
  const origin = headers?.origin;
  if (origin === undefined) return false;
  if (typeof origin !== 'string') return true;
  const o = origin.toLowerCase();
  if (NATIVE.has(o)) return false;
  return !allowlist.includes(o);
}
