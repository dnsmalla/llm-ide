// Box document source — Pattern A connector (peer of git.mjs).
// Client-Credentials-Grant auth → recursive folder list → per-file
// extracted_text representation → chunk → ingest into `sources` (kind='doc').
// Every request goes through the pinned fetch (server/pinned-fetch.mjs): DNS is
// resolved once and every address classified, so no hostname can be talked into
// a private address. Content URLs come out of API JSON and redirect, so they are
// UNTRUSTED: https only, allowlisted Box hosts only, redirects followed by hand
// (max MAX_REDIRECTS hops, each hop re-validated and re-pinned), and the bearer
// token is dropped the moment a hop leaves the origin it was sent to. Bodies are
// size-capped. Tests stub global.fetch (honoured by the pin under NODE_ENV=test).
import { chunkLines, } from './git.mjs';
import { makePinnedFetch } from '../server/pinned-fetch.mjs';
import { ingestSources, deleteSourcesByPrefix, getDb, MAX_INGEST_BATCH } from '../kb/db.mjs';

const TOKEN_URL = 'https://api.box.com/oauth2/token';
const API = 'https://api.box.com/2.0';
const FETCH_DEADLINE_MS = 30_000;
const MAX_FILES = 2000;      // safety cap (mirrors git's fence caps)
const MAX_DEPTH = 10;        // subfolder recursion cap
const PAGE_LIMIT = 1000;     // Box folder-items page size
const REP_POLL_ATTEMPTS = 5; // extracted_text may be 'pending' briefly
const DEFAULT_POLL_MS = 1500;
const EXTRACT_CONCURRENCY = 8; // parallel extracted_text fetches; a folder of pending reps otherwise serializes past the route budget

const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 8 * 1024 * 1024;   // folder pages / representation info
const MAX_TEXT_BYTES = 10 * 1024 * 1024;  // one file's extracted text
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Box API / download hosts a request (or redirect hop) may touch. https only. */
export function isAllowedBoxUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const h = url.hostname.toLowerCase();
  return h === 'api.box.com' || h === 'box.com' || h.endsWith('.box.com') || h === 'boxcloud.com' || h.endsWith('.boxcloud.com');
}

function refuse(msg) { return Object.assign(new Error(`Box fetch refused: ${msg}`), { code: 'BOX_FETCH_REFUSED' }); }

// Every GET is bounded by its own deadline (B3): a hung Box API call (or a
// never-responding content URL) can otherwise block the whole request up to
// the 300s socket cap. Callers may pass their own `signal` to override.
// `fetchImpl` is a test seam; production uses a fresh pinned fetch.
async function boxFetch(url, { token, headers, signal, fetchImpl } = {}) {
  const ctrl = signal ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS) : null;
  const doFetch = fetchImpl || makePinnedFetch();
  try {
    let current = String(url);
    let bearer = token;
    for (let hop = 0; ; hop++) {
      if (!isAllowedBoxUrl(current)) throw refuse(`host not allowed (${hop ? 'redirect' : 'request'})`);
      const res = await doFetch(current, {
        method: 'GET',
        headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(headers || {}) },
        redirect: 'manual',
        signal: signal || ctrl?.signal,
      });
      if (!REDIRECT_STATUSES.has(res.status)) return res;
      const loc = res.headers?.get?.('location');
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      if (!loc) throw refuse('redirect without a location');
      if (hop >= MAX_REDIRECTS) throw refuse('too many redirects');
      const next = new URL(loc, current).toString();
      // The token never leaves the origin it was sent to (pre-signed download URLs need none).
      if (new URL(next).origin !== new URL(current).origin) bearer = null;
      current = next;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Read a body with a hard byte cap. Test doubles without a stream fall back to text()/json().
async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) { try { await res.body?.cancel?.(); } catch { /* ignore */ } throw refuse(`response larger than ${max} bytes`); }
  const reader = res.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw refuse(`response larger than ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readJson(res) {
  const t = await readCapped(res, MAX_JSON_BYTES);
  if (t === null) return res.json().catch(() => ({}));
  try { return JSON.parse(t); } catch { return {}; }
}
async function readText(res) {
  const t = await readCapped(res, MAX_TEXT_BYTES);
  return t === null ? res.text() : t;
}

const MAX_HTTP_RETRIES = 3;

function retryAfterMs(res) {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) ? Math.max(0, secs * 1000) : null;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Map `fn` over `items` with at most `limit` concurrent in-flight calls,
// preserving input order in the results. Errors propagate (the caller's fn
// swallows per-item failures so one bad file can't sink the whole index).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// A Box "session" holds the CCG access token and can refresh it on demand.
// CCG tokens live ~60min; a large folder index can outlast one, so requests
// must be able to re-auth mid-run (#6).
function makeSession(creds) {
  let token = null;
  return {
    async ensure() { if (!token) ({ accessToken: token } = await exchangeCCGToken(creds)); return token; },
    async refresh() { ({ accessToken: token } = await exchangeCCGToken(creds)); return token; },
  };
}

// Authenticated GET with 429/Retry-After backoff (#7) and a one-time 401
// token refresh (#6). `retryDelayMs` overrides the backoff base (tests pass 0).
async function boxGet(session, url, { headers, retryDelayMs, fetchImpl } = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await session.ensure();
    const res = await boxFetch(url, { token, headers, fetchImpl });
    if (res.status === 429 && attempt < MAX_HTTP_RETRIES) {
      await sleep(retryDelayMs ?? retryAfterMs(res) ?? 1000 * (attempt + 1));
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await session.refresh();
      continue;
    }
    return res;
  }
}

export { boxFetch as _boxFetchForTests, readCapped as _readCappedForTests };

/** Pure: form body for the CCG token request. */
export function buildTokenForm({ clientId, clientSecret, subjectType, subjectId }) {
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    box_subject_type: subjectType,
    box_subject_id: subjectId,
  }).toString();
}

/** Exchange CCG creds for a short-lived access token. */
async function exchangeCCGToken(creds, _opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const res = await makePinnedFetch()(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenForm(creds),
      signal: ctrl.signal,
    });
    const data = await readJson(res);
    if (!res.ok || !data.access_token) {
      throw new Error(`Box auth failed: ${data.error_description || data.error || res.status}`);
    }
    return { accessToken: data.access_token };
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: split a folder-items response into files + subfolders. */
export function parseFolderItems(json) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const files = [];
  const folders = [];
  for (const e of entries) {
    if (e?.type === 'file') files.push({ id: String(e.id), name: e.name || String(e.id), modifiedAt: e.modified_at || null });
    else if (e?.type === 'folder') folders.push({ id: String(e.id), name: e.name || String(e.id) });
  }
  return { files, folders };
}

/**
 * List a folder recursively (paginated), returning flat file records with
 * paths. `state.truncated` is set true when a MAX_FILES/MAX_DEPTH cap cut the
 * walk short (B5), so the caller can tell the user the index is incomplete.
 */
async function listFolderRecursive(session, folderId, { depth = 0, prefix = '', acc = [], state, retryDelayMs } = {}) {
  const st = state || { truncated: false };
  if (depth > MAX_DEPTH) { st.truncated = true; return acc; }
  if (acc.length >= MAX_FILES) { st.truncated = true; return acc; }
  let offset = 0;
  for (;;) {
    const url = `${API}/folders/${encodeURIComponent(folderId)}/items?fields=id,name,type,modified_at&limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await boxGet(session, url, { retryDelayMs });
    const json = await readJson(res);
    if (!res.ok) throw new Error(`Box folder list failed: ${json.message || res.status}`);
    // Page length is the reliable end-of-list signal (B4): breaking on
    // `total_count || 0` stops after page 1 whenever Box omits total_count,
    // silently dropping later pages. A full page means "maybe more".
    const pageLen = Array.isArray(json?.entries) ? json.entries.length : 0;
    const { files, folders } = parseFolderItems(json);
    for (const f of files) {
      if (acc.length >= MAX_FILES) { st.truncated = true; return acc; }
      acc.push({ ...f, path: prefix ? `${prefix}/${f.name}` : f.name });
    }
    for (const sub of folders) {
      if (acc.length >= MAX_FILES) { st.truncated = true; return acc; }
      await listFolderRecursive(session, sub.id, { depth: depth + 1, prefix: prefix ? `${prefix}/${sub.name}` : sub.name, acc, state: st, retryDelayMs });
    }
    offset += PAGE_LIMIT;
    if (pageLen < PAGE_LIMIT) break;
  }
  return acc;
}

/** Fetch a file's extracted text, or null when no text representation exists. */
async function fetchExtractedText(session, fileId, opts = {}) {
  const pollMs = opts.pollDelayMs ?? DEFAULT_POLL_MS;
  const retryDelayMs = opts.retryDelayMs;
  const infoUrl = `${API}/files/${encodeURIComponent(fileId)}?fields=representations`;
  const res = await boxGet(session, infoUrl, { headers: { 'X-Rep-Hints': '[extracted_text]' }, retryDelayMs });
  const json = await readJson(res);
  if (!res.ok) return null;
  const rep = (json?.representations?.entries || []).find(r => r.representation === 'extracted_text');
  if (!rep) return null;
  let state = rep.status?.state;
  let contentTemplate = rep.content?.url_template;
  const infoTemplate = rep.info?.url;
  for (let attempt = 0; state === 'pending' && attempt < REP_POLL_ATTEMPTS; attempt++) {
    if (pollMs > 0) await new Promise(r => setTimeout(r, pollMs));
    if (!infoTemplate) break;
    const pr = await boxGet(session, infoTemplate, { retryDelayMs });
    const pj = await readJson(pr);
    state = pj?.status?.state;
    contentTemplate = pj?.content?.url_template || contentTemplate;
  }
  if (state !== 'success' || !contentTemplate) return null;
  const contentUrl = contentTemplate.replace('{+asset_path}', '');
  const cr = await boxGet(session, contentUrl, { retryDelayMs });
  if (!cr.ok) return null;
  return await readText(cr);
}

/** Pure: turn one file's text into doc source-rows via chunkLines. */
export function toSourceRows({ folderId, fileId, name, modifiedAt, path, text }) {
  const chunks = chunkLines(text || '');
  return chunks.map((c, idx) => ({
    kind: 'doc',
    ref: `box:${folderId}:${fileId}`,
    chunkIdx: idx,
    title: name,
    body: c.body,
    meta: { folderId, fileId, path, modifiedAt, startLine: c.startLine, endLine: c.endLine },
  }));
}

/** Verify creds + folder access: exchange a token and read one page. */
export async function boxTest(creds, opts = {}) {
  const session = makeSession(creds);
  const url = `${API}/folders/${encodeURIComponent(creds.folderId)}?fields=name,item_collection`;
  const res = await boxGet(session, url, { retryDelayMs: opts.retryDelayMs });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`Box folder access failed: ${json.message || res.status}`);
  return { ok: true, folderName: json.name || creds.folderId, itemCount: json.item_collection?.total_count ?? 0 };
}

/**
 * Index a Box folder into the KB (wholesale re-index). Returns:
 *   indexed   — chunk-rows written (ingestSources' count)
 *   files     — files that produced rows (had extractable text)
 *   skipped   — files with no text representation
 *   truncated — true when a MAX_FILES/MAX_DEPTH cap cut the walk short (B5)
 */
export async function indexBoxFolder(userId, creds, opts = {}) {
  const session = makeSession(creds);
  const state = { truncated: false };
  const files = await listFolderRecursive(session, creds.folderId, { state, retryDelayMs: opts.retryDelayMs });
  // Fetch each file's extracted text with bounded concurrency. Sequential
  // fetching serializes REP_POLL_ATTEMPTS×poll waits per pending file and can
  // outrun the route's 240s budget on a large folder; parallelism keeps it fast
  // while capping simultaneous Box requests. Ordering is preserved so per-file
  // chunk output stays deterministic.
  const limit = opts.concurrency ?? EXTRACT_CONCURRENCY;
  const texts = await mapWithConcurrency(files, limit, async (f) => {
    try {
      return await fetchExtractedText(session, f.id, opts);
    } catch {
      return null;
    }
  });
  const items = [];
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const text = texts[i];
    if (!text) { skipped += 1; continue; }
    items.push(...toSourceRows({ folderId: creds.folderId, fileId: f.id, name: f.name, modifiedAt: f.modifiedAt, path: f.path, text }));
  }
  const indexed = replaceBoxIndex(userId, creds.folderId, items);
  return { indexed, files: files.length - skipped, skipped, truncated: state.truncated };
}

/**
 * Swap a folder's indexed rows for `items` atomically. Delete + ingest share
 * one transaction so a failure mid-ingest rolls back to the old index instead
 * of leaving it empty; ingestSources caps a single call, so slice inside it.
 */
export function replaceBoxIndex(userId, folderId, items) {
  return getDb().transaction(() => {
    deleteSourcesByPrefix(userId, 'doc', `box:${folderId}:`);
    let total = 0;
    for (let i = 0; i < items.length; i += MAX_INGEST_BATCH) {
      total += ingestSources(userId, items.slice(i, i + MAX_INGEST_BATCH));
    }
    return total;
  })();
}
