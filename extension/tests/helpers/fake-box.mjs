// A fake Box API for tests (no network): OAuth token/revoke (single-use refresh tokens, exact client check), folders
// (409 conflicts as Box sends them), multipart upload and upload-new-version, downloads through a dl.boxcloud.com
// redirect, trash and purge, versions (premium only) and user events. fetch(url, init) answers like Box. Without
// init.redirect === 'manual' it follows the download redirect itself and drops Authorization on that cross-origin hop, as
// browsers and URLSession do; the download host answers 400 if a bearer reaches it.
export function createFakeBox({ clientId = 'cid0123456789abcdef', clientSecret = 'csec0123456789abcdef', login = 'sync@example.com', premium = false } = {}) {
  let n = 100;
  const newId = () => String(++n);
  const nodes = new Map([['0', { id: '0', type: 'folder', name: 'All Files', parent: null, trashed: false }]]);
  const codes = new Set(); const access = new Set(); const refresh = new Set(); const downloads = new Map();
  const events = []; const failures = [];
  const fake = {
    clientId, clientSecret, login, nodes, calls: [], uploads: [], purges: 0, versionDeletes: 0, revoked: [],
    issueCode() { const c = `code${newId()}`; codes.add(c); return c; },
    grant() { const r = `rt-token-${newId()}`; refresh.add(r); return r; },
    expireAccess() { access.clear(); },
    revokeRefresh() { refresh.clear(); },
    failNext(match, status, { headers = {}, body = {} } = {}) { failures.push({ match, status, headers, body }); },
    children(folderId) { return [...nodes.values()].filter((x) => x.parent === folderId && !x.trashed); },
    /** Test setup: create the folders on `path` and the file (or overwrite it, like a new version). */
    seed(path, data) {
      const names = path.split('/');
      let cur = nodes.get('0');
      for (const name of names.slice(0, -1)) {
        let next = fake.children(cur.id).find((x) => x.type === 'folder' && x.name === name);
        if (!next) { next = { id: newId(), type: 'folder', name, parent: cur.id, trashed: false }; nodes.set(next.id, next); }
        cur = next;
      }
      const old = fake.children(cur.id).find((x) => x.type === 'file' && x.name === names.at(-1));
      if (old) { old.data = Buffer.from(data); old.mtime = Date.now(); return; }
      const x = { id: newId(), type: 'file', name: names.at(-1), parent: cur.id, data: Buffer.from(data), versions: [], mtime: Date.now(), trashed: false };
      nodes.set(x.id, x);
    },
    find(path) {
      let cur = nodes.get('0');
      for (const name of path.split('/')) { cur = fake.children(cur.id).find((x) => x.name === name); if (!cur) return null; }
      return cur;
    },
    fetch: (url, init = {}) => follow(String(url), init),
  };
  const json = (status, body = {}, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const entry = (x) => ({ type: x.type, id: x.id, name: x.name, ...(x.type === 'file' ? { size: x.data.length, modified_at: new Date(x.mtime).toISOString() } : {}) });
  const log = (event_type, x) => events.push({ event_type, source: { type: x.type, id: x.id, parent: { id: x.parent } } });
  const tree = (x, fn) => { fn(x); for (const c of [...nodes.values()].filter((y) => y.parent === x.id)) tree(c, fn); };
  const header = (init, name) => new Headers(init.headers ?? {}).get(name);
  const form = (init) => new URLSearchParams(typeof init.body === 'string' ? init.body : Buffer.from(init.body ?? '').toString());
  function tokens() {
    const a = `at-token-${newId()}`; const r = `rt-token-${newId()}`; // Box-like length (SP7 parseTokens wants >= 8)
    access.add(a); refresh.add(r);
    return json(200, { access_token: a, refresh_token: r, expires_in: 3600, token_type: 'bearer' });
  }
  function multipart(init) {
    const boundary = /boundary=(\S+)/.exec(header(init, 'content-type') ?? '')?.[1];
    const buf = Buffer.from(init.body);
    const sep = Buffer.from(`--${boundary}`);
    const parts = {};
    for (let at = buf.indexOf(sep); at >= 0;) {
      const next = buf.indexOf(sep, at + sep.length);
      if (next < 0) break;
      const part = buf.subarray(at + sep.length + 2, next - 2);
      const split = part.indexOf('\r\n\r\n');
      const name = /name="([^"]+)"/.exec(part.subarray(0, split).toString())?.[1];
      if (name) parts[name] = Buffer.from(part.subarray(split + 4));
      at = next;
    }
    return { attributes: JSON.parse(parts.attributes?.toString() || '{}'), file: parts.file ?? null };
  }
  async function follow(url, init) {
    const res = await answer(url, init);
    if (res.status !== 302 || init.redirect === 'manual') return res;
    const h = new Headers(init.headers ?? {}); h.delete('authorization');
    return answer(res.headers.get('location'), { ...init, headers: h });
  }
  async function answer(url, init) {
    const u = new URL(url); const method = (init.method || 'GET').toUpperCase(); const p = u.pathname;
    fake.calls.push(`${method} ${u.host}${p}`);
    const f = failures.findIndex((x) => `${method} ${p}`.startsWith(x.match));
    if (f >= 0) { const x = failures.splice(f, 1)[0]; return json(x.status, x.body, x.headers); }
    if (u.host === 'api.box.com' && p === '/oauth2/token') {
      const q = form(init);
      if (q.get('client_id') !== clientId || q.get('client_secret') !== clientSecret) return json(400, { error: 'invalid_client', error_description: 'The client credentials are invalid' });
      if (q.get('grant_type') === 'authorization_code' && codes.delete(q.get('code'))) return tokens();
      if (q.get('grant_type') === 'refresh_token' && refresh.delete(q.get('refresh_token'))) return tokens();
      return json(400, { error: 'invalid_grant', error_description: 'Invalid grant' });
    }
    if (u.host === 'api.box.com' && p === '/oauth2/revoke') {
      const t = form(init).get('token'); refresh.delete(t); access.delete(t); fake.revoked.push(t); return json(200, {});
    }
    if (u.host === 'dl.boxcloud.com') {
      if (header(init, 'authorization')) return json(400, { code: 'bearer_sent_to_download_host' });
      const x = nodes.get(downloads.get(p.split('/').at(-1)));
      return x && !x.trashed ? new Response(x.data, { status: 200, headers: { 'content-length': String(x.data.length) } }) : json(404);
    }
    const bearer = /^Bearer (.+)$/.exec(header(init, 'authorization') ?? '')?.[1];
    if (!bearer || !access.has(bearer)) return json(401, { type: 'error', status: 401, code: 'unauthorized' });
    let m;
    if (method === 'GET' && p === '/2.0/users/me') return json(200, { type: 'user', id: '7', login });
    if (method === 'GET' && (m = /^\/2\.0\/folders\/(\w+)\/items$/.exec(p))) {
      const d = nodes.get(m[1]);
      if (!d || d.trashed || d.type !== 'folder') return json(404, { code: 'not_found' });
      const all = fake.children(d.id).map(entry);
      const limit = Number(u.searchParams.get('limit') ?? 100); const offset = Number(u.searchParams.get('offset') ?? 0);
      return json(200, { total_count: all.length, entries: all.slice(offset, offset + limit), limit, offset });
    }
    if (method === 'POST' && u.host === 'api.box.com' && p === '/2.0/folders') {
      const b = JSON.parse(String(init.body)); const parent = nodes.get(b.parent?.id);
      if (!parent || parent.trashed) return json(404, { code: 'not_found' });
      const dup = fake.children(parent.id).find((x) => x.name === b.name);
      if (dup) return json(409, { code: 'item_name_in_use', context_info: { conflicts: [entry(dup)] } });
      const x = { id: newId(), type: 'folder', name: b.name, parent: parent.id, trashed: false };
      nodes.set(x.id, x); log('ITEM_CREATE', x);
      return json(201, entry(x));
    }
    if (method === 'POST' && u.host === 'upload.box.com' && (m = /^\/api\/2\.0\/files(?:\/(\w+))?\/content$/.exec(p))) {
      const { attributes, file } = multipart(init);
      if (!file) return json(400, { code: 'bad_request' });
      if (m[1]) {
        const x = nodes.get(m[1]);
        if (!x || x.trashed) return json(404, { code: 'not_found' });
        if (premium) x.versions.push({ id: newId(), data: x.data });
        x.data = file; x.mtime = Date.now(); fake.uploads.push(file); log('ITEM_UPLOAD', x);
        return json(201, { total_count: 1, entries: [entry(x)] });
      }
      const parent = nodes.get(attributes.parent?.id);
      if (!parent || parent.trashed) return json(404, { code: 'not_found' });
      const dup = fake.children(parent.id).find((x) => x.name === attributes.name);
      if (dup) return json(409, { code: 'item_name_in_use', context_info: { conflicts: entry(dup) } });
      const x = { id: newId(), type: 'file', name: attributes.name, parent: parent.id, data: file, versions: [], mtime: Date.now(), trashed: false };
      nodes.set(x.id, x); fake.uploads.push(file); log('ITEM_UPLOAD', x);
      return json(201, { total_count: 1, entries: [entry(x)] });
    }
    if (method === 'GET' && (m = /^\/2\.0\/files\/(\w+)\/content$/.exec(p))) {
      const x = nodes.get(m[1]);
      if (!x || x.trashed) return json(404, { code: 'not_found' });
      const t = `t${newId()}`; downloads.set(t, x.id);
      return new Response(null, { status: 302, headers: { location: `https://dl.boxcloud.com/d/1/${t}` } });
    }
    if (method === 'GET' && (m = /^\/2\.0\/files\/(\w+)\/versions$/.exec(p))) {
      const x = nodes.get(m[1]);
      if (!x || x.trashed) return json(404, { code: 'not_found' });
      return json(200, { total_count: x.versions.length, entries: x.versions.map((v) => ({ type: 'file_version', id: v.id })) });
    }
    if (method === 'DELETE' && (m = /^\/2\.0\/files\/(\w+)\/versions\/(\w+)$/.exec(p))) {
      const x = nodes.get(m[1]); const i = x?.versions.findIndex((v) => v.id === m[2]) ?? -1;
      if (i < 0) return json(404, { code: 'not_found' });
      x.versions.splice(i, 1); fake.versionDeletes += 1;
      return json(204);
    }
    if (method === 'DELETE' && (m = /^\/2\.0\/(files|folders)\/(\w+)$/.exec(p))) {
      const x = nodes.get(m[2]);
      if (!x || x.trashed) return json(404, { code: 'not_found' });
      if (m[1] === 'folders' && u.searchParams.get('recursive') !== 'true' && fake.children(x.id).length) return json(400, { code: 'folder_not_empty' });
      tree(x, (y) => { y.trashed = true; }); log('ITEM_TRASH', x);
      return json(204);
    }
    if (method === 'DELETE' && (m = /^\/2\.0\/(files|folders)\/(\w+)\/trash$/.exec(p))) {
      const x = nodes.get(m[2]);
      if (!x || !x.trashed) return json(404, { code: 'not_trashed' });
      tree(x, (y) => nodes.delete(y.id)); fake.purges += 1;
      return json(204);
    }
    if (method === 'GET' && p === '/2.0/events') {
      const pos = u.searchParams.get('stream_position');
      const from = pos === 'now' ? events.length : Number(pos) || 0;
      return json(200, { chunk_size: events.length - from, next_stream_position: events.length, entries: events.slice(from) });
    }
    return json(404, { code: 'not_found' });
  }
  return fake;
}
