// Box document source — Pattern A connector (peer of git.mjs).
// Client-Credentials-Grant auth → recursive folder list → per-file
// extracted_text representation → chunk → ingest into `sources` (kind='doc').
// Network is global fetch (fixed host api.box.com, so no SSRF surface),
// mirroring agents/slack-source.mjs. Tests stub global.fetch.
import { chunkLines, } from './git.mjs';
import { ingestSources, deleteSourcesByPrefix } from '../kb/db.mjs';

const TOKEN_URL = 'https://api.box.com/oauth2/token';
const API = 'https://api.box.com/2.0';
const FETCH_DEADLINE_MS = 30_000;
const MAX_FILES = 2000;      // safety cap (mirrors git's fence caps)
const MAX_DEPTH = 10;        // subfolder recursion cap
const PAGE_LIMIT = 1000;     // Box folder-items page size
const REP_POLL_ATTEMPTS = 5; // extracted_text may be 'pending' briefly
const DEFAULT_POLL_MS = 1500;

// Every GET is bounded by its own deadline (B3): a hung Box API call (or a
// never-responding content URL) can otherwise block the whole request up to
// the 300s socket cap. Callers may pass their own `signal` to override.
async function boxFetch(url, { token, headers, signal } = {}) {
  const ctrl = signal ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS) : null;
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(headers || {}) },
      signal: signal || ctrl?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
export async function exchangeCCGToken(creds, _opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenForm(creds),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
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
async function listFolderRecursive(token, folderId, { depth = 0, prefix = '', acc = [], state } = {}) {
  const st = state || { truncated: false };
  if (depth > MAX_DEPTH) { st.truncated = true; return acc; }
  if (acc.length >= MAX_FILES) { st.truncated = true; return acc; }
  let offset = 0;
  for (;;) {
    const url = `${API}/folders/${encodeURIComponent(folderId)}/items?fields=id,name,type,modified_at&limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await boxFetch(url, { token });
    const json = await res.json().catch(() => ({}));
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
      await listFolderRecursive(token, sub.id, { depth: depth + 1, prefix: prefix ? `${prefix}/${sub.name}` : sub.name, acc, state: st });
    }
    offset += PAGE_LIMIT;
    if (pageLen < PAGE_LIMIT) break;
  }
  return acc;
}

/** Fetch a file's extracted text, or null when no text representation exists. */
export async function fetchExtractedText(token, fileId, opts = {}) {
  const pollMs = opts.pollDelayMs ?? DEFAULT_POLL_MS;
  const infoUrl = `${API}/files/${encodeURIComponent(fileId)}?fields=representations`;
  const res = await boxFetch(infoUrl, { token, headers: { 'X-Rep-Hints': '[extracted_text]' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const rep = (json?.representations?.entries || []).find(r => r.representation === 'extracted_text');
  if (!rep) return null;
  let state = rep.status?.state;
  let contentTemplate = rep.content?.url_template;
  const infoTemplate = rep.info?.url;
  for (let attempt = 0; state === 'pending' && attempt < REP_POLL_ATTEMPTS; attempt++) {
    if (pollMs > 0) await new Promise(r => setTimeout(r, pollMs));
    if (!infoTemplate) break;
    const pr = await boxFetch(infoTemplate, { token });
    const pj = await pr.json().catch(() => ({}));
    state = pj?.status?.state;
    contentTemplate = pj?.content?.url_template || contentTemplate;
  }
  if (state !== 'success' || !contentTemplate) return null;
  const contentUrl = contentTemplate.replace('{+asset_path}', '');
  const cr = await boxFetch(contentUrl, { token });
  if (!cr.ok) return null;
  return await cr.text();
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
export async function boxTest(creds) {
  const { accessToken } = await exchangeCCGToken(creds);
  const url = `${API}/folders/${encodeURIComponent(creds.folderId)}?fields=name,item_collection`;
  const res = await boxFetch(url, { token: accessToken });
  const json = await res.json().catch(() => ({}));
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
  const { accessToken } = await exchangeCCGToken(creds);
  const state = { truncated: false };
  const files = await listFolderRecursive(accessToken, creds.folderId, { state });
  const items = [];
  let skipped = 0;
  for (const f of files) {
    let text = null;
    try {
      text = await fetchExtractedText(accessToken, f.id, opts);
    } catch {
      text = null;
    }
    if (!text) { skipped += 1; continue; }
    items.push(...toSourceRows({ folderId: creds.folderId, fileId: f.id, name: f.name, modifiedAt: f.modifiedAt, path: f.path, text }));
  }
  deleteSourcesByPrefix(userId, 'doc', `box:${creds.folderId}:`);
  const indexed = ingestSources(userId, items);
  return { indexed, files: files.length - skipped, skipped, truncated: state.truncated };
}
