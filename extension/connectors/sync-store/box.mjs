// SyncStore over Box (design 8.2, SP6). One dedicated folder (default "llmide-sync") under the account's All Files.
// Auth: the user's own Box OAuth app; the refresh token is single use, so every rotation goes to onRefreshToken (the
// vault) before its access token is used. HTTP: the Library connector's layer (connectors/box.mjs: pinned fetch, Box host
// allowlist, redirect re-validation with the bearer dropped off-origin, byte caps, 429 back-off, one 401 re-auth).
// Replace = upload a new version of the same file (atomic for readers), then delete the old versions (D8). Deletes purge
// the trash. Operations run one at a time per store. Only sealed envelopes are stored; secrets never reach an error.
import { randomBytes } from 'node:crypto';
import { checkPath, checkSize, MAX_FILE_BYTES } from './index.mjs';
import { API, UPLOAD_API, boxRequest, postToken, buildRefreshForm, readJson, readCappedBuffer } from '../box.mjs';
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';

export const DEFAULT_BOX_FOLDER = 'llmide-sync';
export const BOX_APP_RE = /^[A-Za-z0-9]{16,128}$/;
const FOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_WAIT_MS = 10_000; // longer Box retry-after: hand the wait to the scheduler's back-off
const PAGE = 1000;
const MESSAGES = {
  SYNC_AUTH_FAILED: 'Box refused the saved sign-in',
  SYNC_RATE_LIMITED: 'Box asked LLM-IDE to slow down',
  SYNC_QUOTA: 'The Box account is out of storage',
  SYNC_UNREACHABLE: 'Box not reachable',
  SYNC_TOO_LARGE: 'Sync file too large',
  SYNC_STALE: 'Box folder moved',
  SYNC_IO: 'Box operation failed',
};
const coded = (code) => Object.assign(new Error(MESSAGES[code] ?? MESSAGES.SYNC_IO), { code });
const isSync = (e) => String(e?.code ?? '').startsWith('SYNC_');

export function validateBoxConfig(c) {
  if (!c || typeof c.clientId !== 'string' || !BOX_APP_RE.test(c.clientId)) return 'clientId';
  if (typeof c.clientSecret !== 'string' || !BOX_APP_RE.test(c.clientSecret)) return 'clientSecret';
  if (typeof c.folder !== 'string' || !FOLDER_RE.test(c.folder) || c.folder === '.' || c.folder === '..') return 'folder';
  return null;
}

export function classifyBoxStatus(status, body = {}) {
  const code = String(body?.code ?? '');
  if (status === 401) return 'SYNC_AUTH_FAILED';
  if (status === 429) return 'SYNC_RATE_LIMITED';
  if (code === 'storage_limit_exceeded' || status === 507) return 'SYNC_QUOTA';
  if (code === 'file_size_limit_exceeded' || status === 413) return 'SYNC_TOO_LARGE';
  if (status >= 500) return 'SYNC_UNREACHABLE';
  return 'SYNC_IO';
}

const conflictId = (j) => { const c = j?.context_info?.conflicts; const id = Array.isArray(c) ? c[0]?.id : c?.id; return id ? String(id) : null; };

function oauthSession({ clientId, clientSecret, refreshToken }, { fetchImpl, onRefreshToken }) {
  let access = null;
  let refresh = refreshToken;
  let inflight = null;
  const renew = () => (inflight ??= (async () => {
    let data;
    try { data = await postToken(buildRefreshForm({ clientId, clientSecret, refreshToken: refresh }), { fetchImpl }); } catch (e) {
      if (e?.status === 429) throw coded('SYNC_RATE_LIMITED');
      throw coded(e?.code === 'BOX_AUTH_FAILED' && e.status >= 400 && e.status < 500 ? 'SYNC_AUTH_FAILED' : 'SYNC_UNREACHABLE');
    }
    if (typeof data.refresh_token !== 'string' || typeof data.access_token !== 'string') throw coded('SYNC_AUTH_FAILED');
    refresh = data.refresh_token;
    onRefreshToken(refresh); // single use: the vault holds the new one before its access token is used
    access = data.access_token;
    return access;
  })().finally(() => { inflight = null; }));
  return { ensure: async () => access ?? renew(), refresh: renew };
}

export function createBoxStore(config, secrets, { fetchImpl = makePinnedFetch(), retryDelayMs, onRefreshToken = () => {}, watchMs = 30_000 } = {}) {
  const folderName = config?.folder || DEFAULT_BOX_FOLDER;
  const session = oauthSession({ clientId: config?.clientId, clientSecret: secrets?.clientSecret, refreshToken: secrets?.refreshToken }, { fetchImpl, onRefreshToken });
  const folders = new Map(); // folder path below the sync folder ('' = the sync folder) -> Box folder id
  const watchers = new Set();
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

  async function call(url, opts = {}) {
    try { return await boxRequest(session, url, { ...opts, fetchImpl, retryDelayMs, maxWaitMs: MAX_WAIT_MS }); } catch (e) {
      if (isSync(e)) throw e;
      throw coded(e?.code === 'BOX_FETCH_REFUSED' ? 'SYNC_IO' : 'SYNC_UNREACHABLE');
    }
  }
  async function fail(res) { throw coded(classifyBoxStatus(res.status, await readJson(res).catch(() => ({})))); }
  /** Retry once with an empty folder cache when a cached folder id went stale (deleted or moved outside this store). */
  async function fresh(fn) {
    try { return await fn(); } catch (e) {
      if (e?.code !== 'SYNC_STALE') throw e;
      folders.clear();
      try { return await fn(); } catch (e2) { throw e2?.code === 'SYNC_STALE' ? coded('SYNC_IO') : e2; }
    }
  }
  async function children(id) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await call(`${API}/folders/${encodeURIComponent(id)}/items?fields=id,name,type,size,modified_at&limit=${PAGE}&offset=${offset}`);
      if (res.status === 404) throw coded('SYNC_STALE');
      if (!res.ok) await fail(res);
      const entries = (await readJson(res)).entries;
      const page = Array.isArray(entries) ? entries : [];
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }
  async function mkdir(parentId, name) {
    const res = await call(`${API}/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent: { id: parentId } }) });
    const j = await readJson(res);
    if (res.ok && j.id) return String(j.id);
    if (res.status === 409 && conflictId(j)) return conflictId(j); // a concurrent create won: use it
    if (res.status === 404) throw coded('SYNC_STALE');
    throw coded(classifyBoxStatus(res.status, j));
  }
  /** The id of the folder at `segs` below the sync folder; null when absent and `create` is false. */
  async function folderId(segs, create) {
    let id = folders.get('');
    if (!id) {
      id = (await children('0')).find((e) => e.type === 'folder' && e.name === folderName)?.id ?? (create ? await mkdir('0', folderName) : null);
      if (!id) return null;
      id = String(id); folders.set('', id);
    }
    let key = '';
    for (const name of segs) {
      key = key ? `${key}/${name}` : name;
      let next = folders.get(key);
      if (!next) {
        next = (await children(id)).find((e) => e.type === 'folder' && e.name === name)?.id ?? (create ? await mkdir(id, name) : null);
        if (!next) return null;
        next = String(next); folders.set(key, next);
      }
      id = next;
    }
    return id;
  }
  async function fileIn(dirId, name) { return (await children(dirId)).find((e) => e.type === 'file' && e.name === name) ?? null; }
  function multipart(attributes, data) {
    const boundary = `llmide${randomBytes(12).toString('hex')}`;
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\n\r\n${JSON.stringify(attributes)}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    return { body: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
  }
  async function upload(url, attributes, data) {
    const { body, type } = multipart(attributes, data);
    return call(url, { method: 'POST', headers: { 'Content-Type': type }, body });
  }
  async function purgeOldVersions(fileId) {
    const res = await call(`${API}/files/${encodeURIComponent(fileId)}/versions?fields=id&limit=1000`);
    if (res.status === 403 || res.status === 404) return; // free plans keep no versions
    if (!res.ok) await fail(res);
    for (const v of (await readJson(res)).entries ?? []) {
      const d = await call(`${API}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      if (!d.ok && d.status !== 404) await fail(d);
    }
  }
  async function purge(kind, id) {
    const del = await call(`${API}/${kind}/${encodeURIComponent(id)}${kind === 'folders' ? '?recursive=true' : ''}`, { method: 'DELETE' });
    if (!del.ok && del.status !== 404) await fail(del);
    const tr = await call(`${API}/${kind}/${encodeURIComponent(id)}/trash`, { method: 'DELETE' });
    if (!tr.ok && tr.status !== 404) await fail(tr);
  }

  return {
    async put(path, bytes) {
      const segs = checkPath(path); checkSize(bytes);
      const data = Buffer.from(bytes);
      const name = segs.at(-1);
      await serial(() => fresh(async () => {
        const dir = await folderId(segs.slice(0, -1), true);
        const res = await upload(`${UPLOAD_API}/files/content`, { name, parent: { id: dir } }, data);
        if (res.ok) return;
        if (res.status === 404) throw coded('SYNC_STALE');
        if (res.status !== 409) await fail(res);
        const id = conflictId(await readJson(res));
        if (!id) throw coded('SYNC_IO');
        const again = await upload(`${UPLOAD_API}/files/${encodeURIComponent(id)}/content`, { name }, data); // readers see old or new bytes
        if (!again.ok) await fail(again);
        await purgeOldVersions(id);
      }));
    },
    async get(path) {
      const segs = checkPath(path);
      return serial(() => fresh(async () => {
        const dir = await folderId(segs.slice(0, -1), false);
        const f = dir && await fileIn(dir, segs.at(-1));
        if (!f) return null;
        if ((f.size ?? 0) > MAX_FILE_BYTES) throw coded('SYNC_TOO_LARGE');
        const res = await call(`${API}/files/${encodeURIComponent(f.id)}/content`);
        if (res.status === 404) return null;
        if (!res.ok) await fail(res);
        try { return await readCappedBuffer(res, MAX_FILE_BYTES); } catch { throw coded('SYNC_TOO_LARGE'); }
      }));
    },
    async list(dir) {
      const segs = checkPath(dir);
      return serial(() => fresh(async () => {
        const id = await folderId(segs, false);
        if (!id) return [];
        return (await children(id)).filter((e) => e.type === 'file')
          .map((e) => ({ name: e.name, size: e.size ?? 0, mtimeMs: Date.parse(e.modified_at ?? '') || 0 }));
      }));
    },
    async remove(path) {
      const segs = checkPath(path);
      await serial(() => fresh(async () => {
        const dir = await folderId(segs.slice(0, -1), false);
        const f = dir && await fileIn(dir, segs.at(-1));
        if (f) await purge('files', f.id);
      }));
    },
    async removeTree(dir) {
      const segs = checkPath(dir);
      const key = segs.join('/');
      await serial(() => fresh(async () => {
        const id = await folderId(segs, false);
        if (id) await purge('folders', id);
        for (const k of [...folders.keys()]) if (k === key || k.startsWith(`${key}/`)) folders.delete(k);
      }));
    },
    // shortcut: polls GET /events every watchMs instead of Box's long-poll realtime server; switch to long-poll if the
    // scheduler starts using watch (today it polls the store itself and never calls this).
    watch(dir, onChange) {
      const segs = checkPath(dir);
      const w = { stopped: false, timer: null };
      watchers.add(w);
      let pos = 'now';
      const tick = async () => {
        try {
          const id = await serial(() => folderId(segs, false));
          const res = await call(`${API}/events?stream_type=changes&stream_position=${encodeURIComponent(pos)}&limit=100`);
          if (res.ok) {
            const j = await readJson(res);
            if (pos !== 'now' && id && (j.entries ?? []).some((e) => String(e?.source?.parent?.id ?? '') === id)) { try { onChange(); } catch { /* a watcher's bug never breaks sync */ } }
            if (j.next_stream_position != null) pos = String(j.next_stream_position);
          }
        } catch { /* the caller still polls */ }
        if (!w.stopped) { w.timer = setTimeout(() => { void tick(); }, watchMs); w.timer.unref?.(); }
      };
      void tick();
      return () => { w.stopped = true; clearTimeout(w.timer); watchers.delete(w); };
    },
    describe() { return { kind: 'box', root: folderName, account: config?.account ?? '' }; },
    async close() { for (const w of watchers) { w.stopped = true; clearTimeout(w.timer); } watchers.clear(); },
  };
}
