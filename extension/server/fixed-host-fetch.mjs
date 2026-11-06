// Pinned fetch for a call whose host is fixed: by code (api.anthropic.com, slack.com, ...) or by the operator
// (JEV_AI_BASE_URL). On top of server/pinned-fetch.mjs (DNS resolved once by the socket, every address
// classified, only the checked address dialled, private targets refused) it adds, per call:
//   - an exact host list: https only, port 443, no userinfo, hostname in `hosts`;
//   - no redirects: the 3xx comes back (redirect 'manual') and is refused here, so a key or token in the
//     request never reaches a Location host (the cross-origin token drop in its strictest form);
//   - a response size cap: reading past `maxBytes` fails with FETCH_REFUSED.
// makePinnedFetch() is called per request so its NODE_ENV=test seam sees a test's fake transport.
import { makePinnedFetch } from './pinned-fetch.mjs';
export const DEFAULT_MAX_BYTES = 1024 * 1024;
function refuse(msg) { return Object.assign(new Error(`fixed-host fetch refused: ${msg}`), { code: 'FETCH_REFUSED' }); }
/** The parsed URL when it is https on 443 to a listed host and carries no userinfo, else null. */
function allowedUrl(input, hosts) {
  let u;
  try { u = new URL(String(input)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return hosts.includes(u.hostname.toLowerCase()) ? u : null;
}
/** Wraps a Response so that reading more than `maxBytes` of its body fails. */
export function capBody(res, maxBytes) {
  // shortcut: test doubles are plain objects ({ ok, json }); the real pinned fetch always returns a Response.
  if (!(res instanceof Response) || !res.body) return res;
  let seen = 0;
  const body = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > maxBytes) ctl.error(refuse(`response larger than ${maxBytes} bytes`));
      else ctl.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
/**
 * @param {string | URL} input
 * @param {RequestInit} [init]
 * @param {{ hosts: string[], maxBytes?: number }} o  lowercase hostnames this one call may reach
 * @returns {Promise<Response>}
 */
export async function fixedHostFetch(input, init = {}, { hosts, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw refuse('no host allowlist');
  const url = allowedUrl(input, hosts);
  if (!url) throw refuse('host not allowed');
  const res = await makePinnedFetch()(url.href, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw refuse(`redirect ${res.status} not followed`);
  }
  return capBody(res, maxBytes);
}
