// SyncStore over MEGA (design 8.3): the first adapter, by user decision 2026-11-05. It talks to a dedicated MEGA account
// used only for LLM-IDE and stores only sealed sync v1 envelopes; MEGA's own encryption sits underneath and is not relied
// on. One logged-in session is reused while the core runs (megajs keepalive keeps its file tree current). An expired
// session logs in again once. EAGAIN / ERATELIMIT / ETEMPUNAVAIL are retried twice (2 s, 8 s), then surface as
// SYNC_RATE_LIMITED for the scheduler's back-off. Operations run one at a time per store, so two callers never race to
// create the same folder. Deletes are permanent. The email and password never appear in a log line or an error.
import { Storage } from 'megajs';
import { checkPath, checkSize, MAX_FILE_BYTES } from './index.mjs';

export const DEFAULT_MEGA_FOLDER = 'llmide-sync';
const RETRY_DELAYS_MS = [2_000, 8_000];
const RATE_LIMITED = new Set([-3, -4, -6, -18, -19]); // EAGAIN, ERATELIMIT, ETOOMANY, ETEMPUNAVAIL, ETOOMANYCONNECTIONS
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const FOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const NETWORK_RE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR/;
const MESSAGES = {
  SYNC_AUTH_FAILED: 'MEGA refused the sync account login',
  SYNC_MFA_REQUIRED: 'The sync account has two-factor login on; use a dedicated MEGA account with it off',
  SYNC_RATE_LIMITED: 'MEGA asked LLM-IDE to slow down',
  SYNC_QUOTA: 'The MEGA account is over its storage or transfer quota',
  SYNC_UNREACHABLE: 'MEGA not reachable',
  SYNC_SESSION_EXPIRED: 'MEGA session expired',
  SYNC_TOO_LARGE: 'Sync file too large',
  SYNC_IO: 'MEGA operation failed',
};

const coded = (code) => Object.assign(new Error(MESSAGES[code] ?? MESSAGES.SYNC_IO), { code });

/** megajs reports API errors as plain Errors whose message reads "ENAME (-n): ..." (its ERRORS table). */
export function megaErrorNumber(e) {
  const m = /\((-\d+)\)/.exec(String(e?.message ?? ''));
  return m ? Number(m[1]) : null;
}

export function classifyMegaError(e, { duringLogin = false } = {}) {
  const n = megaErrorNumber(e);
  const text = `${e?.message ?? ''} ${e?.cause?.code ?? ''}`;
  if (n === -15) return 'SYNC_SESSION_EXPIRED';
  if (n === -26) return 'SYNC_MFA_REQUIRED';
  if (RATE_LIMITED.has(n) || /maybe caused by rate limit/.test(text)) return 'SYNC_RATE_LIMITED';
  if (n === -17 || n === -24 || /returned a 509 status/.test(text)) return 'SYNC_QUOTA';
  if (n === -16) return 'SYNC_AUTH_FAILED'; // EBLOCKED
  if (duringLogin && (n === -9 || /invalid credentials|Account version not supported/.test(text))) return 'SYNC_AUTH_FAILED';
  if (n === null && NETWORK_RE.test(text)) return 'SYNC_UNREACHABLE';
  return 'SYNC_IO';
}

const asCoded = (e, opts) => (String(e?.code ?? '').startsWith('SYNC_') ? e : coded(classifyMegaError(e, opts)));

export function validateMegaConfig(c) {
  if (!c || typeof c.email !== 'string' || !EMAIL_RE.test(c.email)) return 'email';
  if (typeof c.password !== 'string' || c.password.length < 1 || c.password.length > 1024) return 'password';
  if (typeof c.folder !== 'string' || !FOLDER_RE.test(c.folder) || c.folder === '.' || c.folder === '..') return 'folder';
  return null;
}

export function maskEmail(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  return at > 0 ? `${s[0]}***${s.slice(at)}` : '***';
}

function realLogin({ email, password }, { onLost }) {
  // A fresh options object each time: megajs deletes options.password once it has derived the key. autoload reads the
  // whole tree, which is small because the dedicated account holds only sync files. 2FA is never sent (spec 8.3).
  const storage = new Storage({ email, password, keepalive: true, autoload: true, userAgent: 'LLM-IDE-sync' });
  // The keepalive poll reports a dead session as an 'error' event on storage.api. Without a listener Node would throw
  // and take the core down; with it, the next operation logs in again.
  storage.api.on('error', onLost);
  return storage.ready.catch((e) => { try { storage.api.close(); } catch { /* already closed */ } throw e; });
}

export function createMegaStore(config, secrets, { login = realLogin, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const folderName = config?.folder || DEFAULT_MEGA_FOLDER;
  const gone = new Set();     // nodeIds this store deleted; hidden until MEGA's delete packet reaches the tree
  const watchers = new Set(); // { dir, onChange }
  let session = null;         // Promise<Storage> for the one live login
  let chain = Promise.resolve();

  const byAge = (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0); // stable sort: same second keeps upload order
  const live = (node) => (node?.children ?? []).filter((c) => !gone.has(c.nodeId));
  const filesNamed = (node, name) => live(node).filter((c) => !c.directory && c.name === name).sort(byAge); // last = newest
  const folderNamed = (node, name) => live(node).find((c) => c.directory && c.name === name) ?? null;

  /** 'a/b' for a folder below the sync folder; null outside it. */
  function pathBelowSyncFolder(node, cloudRoot) {
    const names = [];
    for (let n = node; n; n = n.parent) {
      if (n.parent === cloudRoot && n.name === folderName) return names.reverse().join('/');
      names.push(n.name);
    }
    return null;
  }
  function notify(st, file) {
    if (!watchers.size || !file) return;
    const dir = pathBelowSyncFolder(file.parent, st.root);
    for (const w of watchers) {
      if (w.dir === dir) { try { w.onChange(); } catch { /* a watcher's bug never breaks sync */ } }
    }
  }
  function attach(st) {
    st.on('add', (f) => notify(st, f));
    st.on('update', (f) => notify(st, f));
    st.on('delete', (f) => { gone.delete(f?.nodeId); notify(st, f); });
  }

  function storage() {
    if (!session) {
      const p = login({ email: secrets.email, password: secrets.password }, { onLost: () => {
        if (session !== p) return;
        session = null;
        p.then((st) => st.close()).catch(() => {});
      } })
        .then((st) => { attach(st); return st; })
        .catch((e) => { if (session === p) session = null; throw asCoded(e, { duringLogin: true }); });
      session = p;
    }
    return session;
  }
  function drop() {
    const old = session;
    session = null;
    old?.then((st) => st.close(), () => {}).catch(() => {});
  }
  async function attempt(fn) {
    let relogged = false;
    let retry = 0;
    for (;;) {
      try { return await fn(await storage()); } catch (e) {
        const err = asCoded(e);
        if (err.code === 'SYNC_SESSION_EXPIRED' && !relogged) { relogged = true; drop(); continue; }
        if (err.code === 'SYNC_RATE_LIMITED' && retry < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[retry++]); continue; }
        throw err.code === 'SYNC_SESSION_EXPIRED' ? coded('SYNC_AUTH_FAILED') : err;
      }
    }
  }
  const serial = (fn) => { const run = chain.then(() => attempt(fn)); chain = run.catch(() => {}); return run; };

  async function walk(st, segs, create) {
    let node = folderNamed(st.root, folderName) ?? await st.root.mkdir(folderName); // the sync folder: created on first use
    for (const name of segs) {
      const next = folderNamed(node, name);
      if (next) node = next;
      else if (create) node = await node.mkdir(name);
      else return null;
    }
    return node;
  }

  return {
    async put(path, bytes) {
      const segs = checkPath(path); checkSize(bytes);
      const data = Buffer.from(bytes);
      await serial(async (st) => {
        const dir = await walk(st, segs.slice(0, -1), true);
        const name = segs.at(-1);
        const older = filesNamed(dir, name);
        await dir.upload({ name, size: data.length }, data).complete; // readers see the old copy or the new one, never a mix
        for (const f of older) { await f.delete(true); gone.add(f.nodeId); }
      });
    },
    async get(path) {
      const segs = checkPath(path);
      return serial(async (st) => {
        const dir = await walk(st, segs.slice(0, -1), false);
        const f = dir && filesNamed(dir, segs.at(-1)).at(-1);
        if (!f) return null;
        if ((f.size ?? 0) > MAX_FILE_BYTES) throw coded('SYNC_TOO_LARGE');
        return f.downloadBuffer({});
      });
    },
    async list(dir) {
      const segs = checkPath(dir);
      return serial(async (st) => {
        const node = await walk(st, segs, false);
        if (!node) return [];
        const newest = new Map();
        for (const c of live(node).filter((x) => !x.directory).sort(byAge)) newest.set(c.name, c);
        return [...newest.values()].map((c) => ({ name: c.name, size: c.size ?? 0, mtimeMs: (c.timestamp ?? 0) * 1000 }));
      });
    },
    async remove(path) {
      const segs = checkPath(path);
      await serial(async (st) => {
        const dir = await walk(st, segs.slice(0, -1), false);
        for (const f of dir ? filesNamed(dir, segs.at(-1)) : []) { await f.delete(true); gone.add(f.nodeId); }
      });
    },
    async removeTree(dir) {
      const segs = checkPath(dir);
      await serial(async (st) => {
        const node = await walk(st, segs, false);
        if (node) { await node.delete(true); gone.add(node.nodeId); }
      });
    },
    watch(dir, onChange) {
      const w = { dir: checkPath(dir).join('/'), onChange };
      watchers.add(w);
      void serial(async () => {}).catch(() => {}); // make sure a session, and so the change feed, exists
      return () => { watchers.delete(w); };
    },
    describe() { return { kind: 'mega', root: folderName, account: maskEmail(secrets.email) }; },
    async close() {
      watchers.clear();
      const old = session;
      session = null;
      if (old) await old.then((st) => st.close(), () => {}).catch(() => {});
    },
  };
}
