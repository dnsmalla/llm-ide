// Fake gitlab.com and Box APIs behind one fetch (no network). Every call is recorded. `queue(prefix, ...fns)` answers
// the next calls whose URL starts with `prefix` with `fn()` first (429, 401, 202...). Tokens rotate like the real ones:
// each exchange or refresh issues `<p>-access-<n>` / `<p>-refresh-<n>` and the old refresh token stops working.
const te = (s) => new TextEncoder().encode(s);
export const BOX_SECRET = 'boxsecret0123456789abcdef';

export function createFakeSources() {
  const gen = { gitlab: 1, box: 1 };
  const tokens = { gitlab: 'gitlab-access-1', box: 'box-access-1' };
  const calls = []; const canned = [];
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const bytes = (b) => new Response(b, { status: 200 });

  function oauth(p, init) {
    const f = new URLSearchParams(init.body); calls.at(-1).form = Object.fromEntries(f);
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== 'good-code-123' || !f.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
      if (p === 'box' && f.get('client_secret') !== BOX_SECRET) return json({ error: 'invalid_client' }, 400);
    } else if (f.get('grant_type') === 'refresh_token') {
      if (f.get('refresh_token') !== `${p}-refresh-${gen[p]}`) return json({ error: 'invalid_grant' }, 400);
    } else return json({ error: 'unsupported_grant_type' }, 400);
    gen[p] += 1; tokens[p] = `${p}-access-${gen[p]}`;
    return json({ access_token: tokens[p], refresh_token: `${p}-refresh-${gen[p]}`, expires_in: p === 'gitlab' ? 7200 : 3600, token_type: 'bearer', ...(p === 'gitlab' ? { scope: 'read_api read_repository' } : {}) });
  }

  const gitFiles = new Map([
    ['README.md', te('# Demo\n\n<script>alert(1)</script>\n')], ['src/app.ts', te('export const x = 1;\n')],
    ['logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])], ['big.txt', new Uint8Array(1_048_576 + 10).fill(97)], ['doc.pdf', te('%PDF-1.4\n')],
  ]);
  const project = { id: 7, name: 'demo', path_with_namespace: 'dee/demo', default_branch: 'main', web_url: 'https://gitlab.com/dee/demo' };
  function gitlab(u, init) {
    if (u.pathname === '/oauth/token') return oauth('gitlab', init);
    if (u.pathname === '/oauth/revoke') { calls.at(-1).form = Object.fromEntries(new URLSearchParams(init.body)); return json({}); }
    if (init?.headers?.Authorization !== `Bearer ${tokens.gitlab}`) return json({ message: '401 Unauthorized' }, 401);
    const p = u.pathname;
    if (p === '/api/v4/projects') {
      const all = [project, { id: 8, name: 'empty', path_with_namespace: 'dee/empty', default_branch: null, web_url: 'https://gitlab.com/dee/empty' }, { id: 'bad' }, { ...project, web_url: 'https://evil.example/x' }];
      const q = u.searchParams.get('search');
      return json(q ? all.filter((x) => typeof x.name === 'string' && x.name.includes(q)) : all, 200, { 'x-next-page': '' });
    }
    if (p === '/api/v4/projects/7/repository/tree') {
      if (u.searchParams.get('path') === 'src') return json([{ id: 's1', name: 'app.ts', type: 'blob', path: 'src/app.ts' }], 200, { 'x-next-page': '' });
      if (u.searchParams.get('page') === '2') return json([{ id: 'b3', name: 'logo.png', type: 'blob', path: 'logo.png' }, { id: 'b4', name: 'big.txt', type: 'blob', path: 'big.txt' }, { id: 'b5', name: 'doc.pdf', type: 'blob', path: 'doc.pdf' }], 200, { 'x-next-page': '' });
      return json([{ id: 't1', name: 'src', type: 'tree', path: 'src' }, { id: 'b1', name: 'README.md', type: 'blob', path: 'README.md' }, { id: 'c1', name: 'vendor', type: 'commit', path: 'vendor' }], 200, { 'x-next-page': '2' });
    }
    const raw = /^\/api\/v4\/projects\/7\/repository\/files\/([^/]+)\/raw$/.exec(p); // pathname keeps %2F encoded
    if (raw) { const f = gitFiles.get(decodeURIComponent(raw[1])); return f ? bytes(f) : json({ message: '404 File Not Found' }, 404); }
    if (p === '/api/v4/projects/7/search') return json([{ basename: 'app', data: 'export const x = 1;', path: 'src/app.ts', filename: 'src/app.ts', ref: 'main', startline: 1 }, { basename: 'app', data: 'again', path: 'src/app.ts', filename: 'src/app.ts', ref: 'main', startline: 9 }]);
    return json({ message: '404 Not Found' }, 404);
  }

  const boxFiles = new Map([['21', te('# Notes\n')], ['23', te('%PDF-1.4\n')], ['24', new Uint8Array([0, 1, 2])]]);
  const REP = 'https://dl.boxcloud.com/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/{+asset_path}';
  function box(u, init) {
    if (u.hostname === 'api.box.com' && u.pathname === '/oauth2/token') return oauth('box', init);
    if (u.pathname === '/oauth2/revoke') { calls.at(-1).form = Object.fromEntries(new URLSearchParams(init.body)); return json({}); }
    if (init?.headers?.Authorization !== `Bearer ${tokens.box}`) return json({ type: 'error', status: 401, code: 'unauthorized' }, 401);
    const p = u.pathname;
    if (p === '/2.0/folders/0/items') return json({ total_count: 3, entries: [{ type: 'folder', id: '11', name: 'Specs' }, { type: 'file', id: '21', name: 'notes.md', size: 8 }, { type: 'web_link', id: '31', name: 'Link' }] });
    if (p === '/2.0/folders/11/items') return json({ entries: [{ type: 'file', id: '22', name: 'plan.docx', size: 5000 }, { type: 'file', id: '23', name: 'deck.pdf', size: 9 }, { type: 'file', id: '25', name: 'scan.docx', size: 10 }, { type: 'file', id: '24', name: 'raw.txt', size: 3 }] });
    if (p === '/2.0/folders/12/items') { const off = Number(u.searchParams.get('offset')); return json({ entries: Array.from({ length: off === 0 ? 100 : 3 }, (_, i) => ({ type: 'file', id: String(1000 + off + i), name: `f${off + i}.txt`, size: 1 })) }); }
    const content = /^\/2\.0\/files\/(\d+)\/content$/.exec(p);
    if (content) { const f = boxFiles.get(content[1]); return f ? bytes(f) : json({ code: 'not_found' }, 404); }
    if (p === '/2.0/files/22') return json({ representations: { entries: [{ representation: 'extracted_text', status: { state: 'pending' }, info: { url: 'https://api.box.com/2.0/internal_files/22/versions/1/representations/extracted_text' }, content: { url_template: REP } }] } });
    if (p === '/2.0/internal_files/22/versions/1/representations/extracted_text') return json({ status: { state: 'success' }, content: { url_template: REP } });
    if (p === '/2.0/files/25') return json({ representations: { entries: [] } });
    if (u.hostname === 'dl.boxcloud.com' && p === '/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/') return bytes(te('Plan text from Box'));
    if (p === '/2.0/search') return json({ entries: [{ type: 'file', id: '22', name: 'plan.docx', size: 5000, path_collection: { entries: [{ id: '0', name: 'All Files' }, { id: '11', name: 'Specs' }] } }] });
    return json({ code: 'not_found' }, 404);
  }

  async function fetchImpl(input, init = {}) {
    const url = String(input); const u = new URL(url);
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
    const i = canned.findIndex((c) => url.startsWith(c.prefix));
    if (i >= 0) { const c = canned[i]; const fn = c.responses.shift(); if (!c.responses.length) canned.splice(i, 1); return fn(); }
    if (u.hostname === 'gitlab.com') return gitlab(u, init);
    if (u.hostname === 'api.box.com' || u.hostname === 'dl.boxcloud.com') return box(u, init);
    throw new TypeError('fetch failed');
  }
  return { fetchImpl, calls, tokens, json, queue(prefix, ...responses) { canned.push({ prefix, responses }); } };
}
