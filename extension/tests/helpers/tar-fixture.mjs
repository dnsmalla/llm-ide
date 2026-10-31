// Builds in-memory .tar.gz archives for tests (what codeload.github.com serves),
// including hostile ones. No network, no tar binary.
import zlib from 'node:zlib';

function header({ name, size = 0, type = '0', linkname = '' }) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => h.write(s.slice(0, len), off, 'utf8');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  h.fill(0x20, 148, 156);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/**
 * @param {Array<{ path: string, content?: string|Buffer, type?: string, linkname?: string }>} entries
 *   paths are used verbatim (so a hostile one can be written); `root` is NOT added automatically.
 */
export function makeTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf8');
    const type = e.type ?? (e.path.endsWith('/') ? '5' : '0');
    parts.push(header({ name: e.path, size: type === '0' ? data.length : 0, type, linkname: e.linkname }));
    if (type === '0' && data.length) {
      parts.push(data);
      parts.push(Buffer.alloc((512 - (data.length % 512)) % 512, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** A repo wrapped like GitHub does: <repo>-<sha>/... */
export function repoArchive(files, root = 'repo-0123456') {
  return makeTarGz([{ path: `${root}/` }, ...Object.entries(files).map(([p, content]) => ({ path: `${root}/${p}`, content }))]);
}

/** A fetch that serves fixtures by URL and records every URL asked for. */
export function fixtureFetch(routes) {
  const calls = [];
  const compareCalls = [];
  const fn = async (url, init = {}) => {
    // Commit-reachability checks (compare API) are tracked apart from `calls`; by default every commit is "behind"
    // (reachable) unless the routes name that exact URL (or a `compare:` prefix key).
    const cm = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.([0-9a-f]{40})(?:\?|$)/.exec(String(url));
    if (cm) {
      compareCalls.push({ url: String(url), init });
      const hit = routes[String(url)] ?? routes[`compare:${cm[1]}/${cm[2]}:${cm[4]}`];
      if (hit === undefined) return new Response(JSON.stringify({ status: 'behind', merge_base_commit: { sha: cm[4] } }), { status: 200 });
      if (typeof hit === 'function') return hit(url, init);
      if (hit instanceof Response) return hit;
      return new Response(hit, { status: 200 });
    }
    calls.push({ url: String(url), init });
    const hit = routes[String(url)];
    if (hit === undefined) return new Response('not found', { status: 404 });
    if (typeof hit === 'function') return hit(url, init);
    if (hit instanceof Response) return hit;
    return new Response(hit, { status: 200 });
  };
  fn.calls = calls;
  fn.compareCalls = compareCalls;
  return fn;
}

/** Wrap an ad-hoc fetch fixture so commit-reachability (compare API) checks answer "behind" (reachable). */
export function withCompare(inner) {
  return async (url, init) => {
    const m = /\/compare\/.+\.\.\.([0-9a-f]{40})(?:\?|$)/.exec(String(url));
    if (m && String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify({ status: 'behind', merge_base_commit: { sha: m[1] } }), { status: 200 });
    return inner(url, init);
  };
}
