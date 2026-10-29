// A fetch that cannot be talked into a private address by DNS.
//
// The hostname is resolved ONCE per connection, by the `lookup` hook of the
// socket itself; EVERY address the resolver returns is classified
// (server/ip-classifier.mjs) and, if any is refused, the connection is never
// made; otherwise the socket dials exactly the checked address (there is no
// second resolution a rebinding answer could change). IP-literal hosts are
// classified before any socket exists. Redirects are refused (the key rides in
// Authorization). A refusal is an error with `code: 'SSRF_BLOCKED'`; callers
// abort on it and never substitute a fallback that continues to the host.
//
// Used by the model list, the connection test and the adapter's chat requests,
// so one rule covers every request a provider connection makes.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import { classifyIp, ipRefusal } from './ip-classifier.mjs';
import { privateProvidersAllowed } from './base-url-guard.mjs';

export class SsrfBlockedError extends Error {
  constructor(message) { super(`SSRF guard: ${message}`); this.name = 'SsrfBlockedError'; this.code = 'SSRF_BLOCKED'; }
}

let testTransport = null;
/** Test seam (NODE_ENV=test only): route tests stand in for the network here; pinned-fetch.test.mjs covers the real thing. */
export function _setPinnedFetchForTests(fn) { testTransport = fn; }

export const systemResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * @param {{ allowPrivate?: boolean, resolver?: (host: string) => Promise<Array<{address: string, family: number}>>,
 *           gate?: () => boolean }} [o]
 *   `allowPrivate`: the connection's own opt-in; `gate`: the operator switch
 *   (defaults to privateProvidersAllowed). Private targets need BOTH.
 * @returns {typeof fetch}
 */
export function makePinnedFetch({ allowPrivate = false, resolver = systemResolver, gate = privateProvidersAllowed } = {}) {
  if (testTransport && process.env.NODE_ENV === 'test') return testTransport;
  return function pinnedFetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      const effective = allowPrivate && gate();
      let url;
      try { url = new URL(String(input)); } catch (e) { reject(e); return; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') { reject(new SsrfBlockedError(`unsupported scheme ${url.protocol}`)); return; }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const literal = ipRefusal(host, { allowPrivate: effective });
      if (literal) { reject(new SsrfBlockedError(literal)); return; }
      if (url.protocol === 'http:' && !(classifyIp(host).ip || host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost'))) {
        reject(new SsrfBlockedError('plain http is only allowed for a local or private address')); return;
      }
      let blocked = null;
      const lookup = (hostname, options, cb) => {
        const done = typeof options === 'function' ? options : cb;
        const wantAll = typeof options === 'object' && options?.all;
        Promise.resolve(resolver(hostname)).then((list) => {
          const addrs = (Array.isArray(list) ? list : [list]).filter(Boolean);
          if (!addrs.length) { done(Object.assign(new Error(`could not resolve ${hostname}`), { code: 'ENOTFOUND' })); return; }
          for (const a of addrs) {
            const why = ipRefusal(a.address, { allowPrivate: effective });
            if (why) { blocked = new SsrfBlockedError(`${hostname} resolves to a ${why}`); done(blocked); return; }
          }
          if (wantAll) done(null, addrs.map((a) => ({ address: a.address, family: a.family || (a.address.includes(':') ? 6 : 4) })));
          else done(null, addrs[0].address, addrs[0].family || (addrs[0].address.includes(':') ? 6 : 4));
        }, (err) => done(err));
      };
      const headers = {};
      for (const [k, v] of new Headers(init.headers || {})) headers[k] = v;
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
        path: `${url.pathname}${url.search}`, method: init.method || 'GET', headers, lookup, agent: false,
        signal: init.signal,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy();
          reject(new TypeError('fetch failed', { cause: new Error('redirect refused') }));
          return;
        }
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else if (v != null) h.set(k, v);
        }
        const noBody = [101, 204, 205, 304].includes(res.statusCode);
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: h }));
      });
      req.on('error', (err) => reject(blocked || err));
      const body = init.body;
      if (body != null) req.write(typeof body === 'string' || body instanceof Uint8Array ? body : Buffer.from(body));
      req.end();
    });
  };
}
