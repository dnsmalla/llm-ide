// Google Drive connector, Pattern A (index into `sources` + scheduled re-fetch), Drive REST API v3, read-only.
// Plan 2026-10-31-google-connectors-plan.md sections 3 to 6.
//
// Metadata first (drive.metadata.readonly): every file gets a findable note (name, type, modified time, folder path, link).
// Content is indexed ONLY for files under folders the user ticked, and only when the account was granted drive.readonly:
// Google Docs and Slides through files.export, Sheets as CSV (the first sheet; a Drive limitation), and a small allowlist
// of plain text types through alt=media. Everything else stays metadata-only. Exports are capped (10 MiB on the wire,
// 200 KB of text kept, 1 MiB for CSV); a file over the cap keeps its metadata note and says so.
//
// Cursor: `changes.getStartPageToken` read BEFORE the first listing (so nothing that changes during the listing is missed),
// then `changes.list` by page token. An invalid token restarts a bounded bootstrap, which drops what it did not see again
// only after the pass finished. Trashed and removed files delete their rows (tombstones). Shared drives are off by default.
//
// The core never fetches a URL found in Drive data (`webViewLink`, `exportLinks`, thumbnail links, ...): every request is
// built from the API base plus a file id.
import { googleCall, apiUrl, GoogleApiError } from './google-fetch.mjs';
import { escapeMarkdownText } from './html-to-markdown.mjs';
import { chunkLines } from '../git.mjs';
import { ingestSources, deleteSourcesByRef, deleteSourcesOlderThan } from '../../kb/sources.mjs';
import { getDb } from '../../kb/db.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const LIMITS = Object.freeze({
  maxFilesPerRun: 1000, bootstrapTotalFiles: 20_000, maxFolders: 50, folderLookupsPerRun: 500, maxPathDepth: 20,
  exportBytes: 10 * 1024 * 1024, mediaBytes: 2 * 1024 * 1024, contentChars: 200_000, csvBytes: 1024 * 1024, contentConcurrency: 3,
});

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const MEDIA_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv']);
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,parents,size,webViewLink,trashed,driveId';
const ID_RE = /^[A-Za-z0-9_-]{5,100}$/;

/** Validate and clamp the per-account Drive options. */
export function normalizeDriveOptions(o = {}) {
  const folderIds = Array.isArray(o.folderIds) ? [...new Set(o.folderIds.map(String).filter((s) => ID_RE.test(s)))].slice(0, LIMITS.maxFolders) : [];
  return { folderIds, includeSharedDrives: o.includeSharedDrives === true };
}

export const fileRef = (accountId, fileId) => `gdrive:${accountId}:${fileId}`;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const oneLine = (s, n = 300) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Text from Drive is third-party content: drop image syntax and data: URIs, and neutralise raw HTML. */
export function neutralizeDriveText(t) {
  return String(t ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image omitted]')
    .replace(/\[[^\]]*\]:\s*<?data:[^\s>]*>?/gi, '')
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{20,}/gi, '[data omitted]')
    .replace(/</g, '\\<');
}

const capText = (s, maxChars) => (s.length > maxChars ? `${s.slice(0, maxChars)}\n\n[...truncated]` : s);

/** Pure: a file's rows. `content` null means metadata-only. */
export function fileToRows(file, { accountId, path, content, contentNote, csv = false }) {
  const name = redactSecretsForStorage(oneLine(file.name, 300)) || '(untitled)';
  const lines = [`# ${escapeMarkdownText(name)}`, '', `Type: ${escapeMarkdownText(oneLine(file.mimeType, 100))}`];
  if (file.modifiedTime) lines.push(`Modified: ${escapeMarkdownText(oneLine(file.modifiedTime, 40))}`);
  if (file.size) lines.push(`Size: ${escapeMarkdownText(oneLine(file.size, 20))} bytes`);
  if (path) lines.push(`Folder: ${escapeMarkdownText(path)}`);
  if (file.webViewLink) lines.push(`Link (text only): ${escapeMarkdownText(oneLine(file.webViewLink, 500))}`);
  if (contentNote) lines.push('', `[${contentNote}]`);
  if (typeof content === 'string' && content) {
    if (csv) lines.push('', '```csv', content.replace(/\n+$/, '').replace(/```/g, "'''"), '```'); else lines.push('', content);
  }
  const text = redactSecretsForStorage(lines.join('\n'));
  const meta = {
    source: 'gdrive', untrusted: true, accountId, fileId: file.id, mimeType: file.mimeType, modifiedTime: file.modifiedTime || null,
    path: redactSecretsForStorage(path || ''), link: file.webViewLink ? oneLine(file.webViewLink, 500) : null, content: typeof content === 'string' && !!content,
    sharedDrive: !!file.driveId,
  };
  const ref = fileRef(accountId, file.id);
  return chunkLines(text).map((c, idx) => ({ kind: 'doc', ref, chunkIdx: idx, title: name, body: c.body, meta: { ...meta, startLine: c.startLine, endLine: c.endLine } }));
}

const parseCursor = (c) => { try { const v = JSON.parse(c); return v && typeof v === 'object' ? v : null; } catch { return null; } };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); } }));
  return out;
}

/**
 * One capped Drive run.
 * @param {{ session: object, userId: string, accountId: string, cursor: string|null, options: object, contentGranted: boolean,
 *   now?: number, sleepImpl?: Function, limits?: object }} o
 * @returns {Promise<{ nextCursor: string, mode: 'bootstrap'|'changes', pending: boolean, stats: object }>}
 */
export async function syncDrive({ session, userId, accountId, cursor, options: rawOptions, contentGranted, now = Date.now(), sleepImpl, limits = {} }) {
  const lim = { ...LIMITS, ...limits };
  const options = normalizeDriveOptions(rawOptions);
  const ticked = new Set(options.folderIds);
  const contentEnabled = contentGranted === true && ticked.size > 0;
  const call = (url, o = {}) => googleCall(session, url, { sleepImpl, ...o });
  const stats = { files: 0, removed: 0, withContent: 0, metadataOnly: 0, skippedShared: 0, contentSkipped: 0, restarted: false, truncated: false };

  // folder id -> { name, parents }; resolved lazily, bounded per run
  const folders = new Map(); let lookups = 0;
  const folderOf = async (id) => {
    if (folders.has(id)) return folders.get(id);
    if (lookups >= lim.folderLookupsPerRun) return null;
    lookups += 1;
    const f = await call(apiUrl(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { fields: 'id,name,parents,mimeType', supportsAllDrives: true }), { allow404: true });
    const info = f ? { name: oneLine(f.name, 120), parents: Array.isArray(f.parents) ? f.parents : [] } : { name: '', parents: [], root: true };
    folders.set(id, info);
    return info;
  };
  const place = async (file) => {
    const names = []; let isTicked = false; let cur = file.parents?.[0]; let complete = true;
    for (let d = 0; cur && d < lim.maxPathDepth; d++) {
      if (ticked.has(cur)) isTicked = true;
      const f = await folderOf(cur);
      if (!f) { complete = false; break; }
      if (f.root) break;
      if (f.name) names.unshift(f.name);
      cur = f.parents[0];
    }
    if (cur && ticked.has(cur)) isTicked = true;
    return { path: names.join('/').slice(0, 400), ticked: isTicked, complete };
  };

  const fetchContent = async (file) => {
    const mime = file.mimeType;
    try {
      if (mime === DOC) {
        let t;
        try { t = await call(apiUrl(`${DRIVE_API}/files/${encodeURIComponent(file.id)}/export`, { mimeType: 'text/markdown' }), { raw: true, maxBytes: lim.exportBytes }); }
        catch (e) { if (e?.status === 400 || e?.reason === 'exportFormatNotSupported') t = await call(apiUrl(`${DRIVE_API}/files/${encodeURIComponent(file.id)}/export`, { mimeType: 'text/plain' }), { raw: true, maxBytes: lim.exportBytes }); else throw e; }
        return { content: capText(neutralizeDriveText(t), lim.contentChars) };
      }
      if (mime === SLIDES) {
        const t = await call(apiUrl(`${DRIVE_API}/files/${encodeURIComponent(file.id)}/export`, { mimeType: 'text/plain' }), { raw: true, maxBytes: lim.exportBytes });
        return { content: capText(neutralizeDriveText(t), lim.contentChars) };
      }
      if (mime === SHEET) {
        const t = await call(apiUrl(`${DRIVE_API}/files/${encodeURIComponent(file.id)}/export`, { mimeType: 'text/csv' }), { raw: true, maxBytes: lim.exportBytes });
        const cut = Buffer.byteLength(t) > lim.csvBytes;
        const body = cut ? `${Buffer.from(t).subarray(0, lim.csvBytes).toString('utf8').replace(/\ufffd+$/, '')}\n[...truncated]` : t;
        return { content: body, csv: true, note: 'first sheet only' };
      }
      if (MEDIA_TEXT.has(mime) && Number(file.size) <= lim.mediaBytes) {
        const t = await call(apiUrl(`${DRIVE_API}/files/${encodeURIComponent(file.id)}`, { alt: 'media', supportsAllDrives: true }), { raw: true, maxBytes: lim.mediaBytes });
        return mime === 'text/csv' ? { content: capText(t, lim.csvBytes), csv: true } : { content: capText(neutralizeDriveText(t), lim.contentChars) };
      }
      return { content: null };
    } catch (e) {
      if (e?.code === 'GOOGLE_FETCH_REFUSED') return { content: null, note: 'content larger than the size limit, not indexed' };
      if (e?.status === 403 || e?.status === 404) return { content: null, note: 'content not available' };
      throw e;
    }
  };

  const processFiles = async (items) => {
    const rows = []; const refs = [];
    const todo = [];
    for (const it of items) {
      const file = it.file || it; const id = it.fileId || file?.id;
      if (!id) continue;
      const ref = fileRef(accountId, id);
      if (it.removed === true || file?.trashed === true) { refs.push(ref); stats.removed += 1; continue; }
      if (!file || typeof file !== 'object' || !file.mimeType) continue;
      if (file.mimeType === FOLDER) { folders.set(id, { name: oneLine(file.name, 120), parents: Array.isArray(file.parents) ? file.parents : [] }); continue; }
      if (file.driveId && !options.includeSharedDrives) { stats.skippedShared += 1; continue; }
      todo.push({ file: { ...file, id }, ref });
    }
    const placed = [];
    for (const t of todo) placed.push(await place(t.file)); // sequential: shares the folder cache and the lookup budget
    const contents = await mapLimit(todo, lim.contentConcurrency, async (t) => {
      const i = todo.indexOf(t);
      if (!contentEnabled || !placed[i].ticked) return null;
      return fetchContent(t.file);
    });
    todo.forEach((t, i) => {
      const c = contents[i];
      const content = c?.content ?? null;
      const note = c?.note || (contentEnabled && placed[i].ticked && content === null && c ? 'content not indexed for this type' : null);
      if (content) stats.withContent += 1; else stats.metadataOnly += 1;
      if (contentEnabled && !placed[i].ticked) stats.contentSkipped += 1;
      refs.push(t.ref);
      rows.push(...fileToRows(t.file, { accountId, path: placed[i].path, content, contentNote: note, csv: c?.csv === true }));
      stats.files += 1;
    });
    if (refs.length) getDb().transaction(() => { for (const r of refs) deleteSourcesByRef(userId, 'doc', r); if (rows.length) ingestSources(userId, rows); })();
    return refs.length;
  };

  const startBootstrap = async () => {
    const r = await call(apiUrl(`${DRIVE_API}/changes/startPageToken`, { supportsAllDrives: true }));
    if (!r?.startPageToken) throw new GoogleApiError('GOOGLE_BAD_JSON', 'Google answered with a malformed response');
    return { startToken: String(r.startPageToken), bootstrap: { pageToken: null, done: 0, startedAt: sqlTime(now) } };
  };

  let cur = parseCursor(cursor);
  let budget = lim.maxFilesPerRun;
  let restarts = 0;
  if (!cur || !cur.startToken) cur = await startBootstrap();
  for (;;) {
    try {
      if (cur.bootstrap) {
        const bs = { ...cur.bootstrap };
        while (budget > 0 && bs.done < lim.bootstrapTotalFiles) {
          const page = await call(apiUrl(`${DRIVE_API}/files`, {
            q: 'trashed = false', pageSize: Math.min(contentEnabled ? 100 : 1000, budget), pageToken: bs.pageToken || undefined, supportsAllDrives: true,
            includeItemsFromAllDrives: options.includeSharedDrives, fields: `nextPageToken,files(${FILE_FIELDS})`,
          }));
          const n = await processFiles(Array.isArray(page.files) ? page.files : []);
          budget -= Math.max(n, 1); bs.done += n; bs.pageToken = page.nextPageToken || null;
          if (!bs.pageToken) break;
        }
        const capped = bs.done >= lim.bootstrapTotalFiles;
        if (capped) stats.truncated = true;
        const finished = !bs.pageToken || capped;
        if (finished) {
          deleteSourcesOlderThan(userId, 'doc', `gdrive:${accountId}:`, bs.startedAt);
          return { nextCursor: JSON.stringify({ startToken: cur.startToken }), mode: 'bootstrap', pending: false, stats };
        }
        return { nextCursor: JSON.stringify({ startToken: cur.startToken, bootstrap: bs }), mode: 'bootstrap', pending: true, stats };
      }
      // changes feed
      let token = cur.pageToken || cur.startToken;
      for (;;) {
        const page = await call(apiUrl(`${DRIVE_API}/changes`, {
          pageToken: token, pageSize: contentEnabled ? 100 : 500, includeRemoved: true, supportsAllDrives: true, includeItemsFromAllDrives: options.includeSharedDrives,
          fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
        }));
        const n = await processFiles(Array.isArray(page.changes) ? page.changes : []);
        budget -= Math.max(n, 1);
        if (page.nextPageToken) {
          token = String(page.nextPageToken);
          if (budget <= 0) return { nextCursor: JSON.stringify({ startToken: cur.startToken, pageToken: token }), mode: 'changes', pending: true, stats };
          continue;
        }
        return { nextCursor: JSON.stringify({ startToken: String(page.newStartPageToken || token) }), mode: 'changes', pending: false, stats };
      }
    } catch (e) {
      // An invalid or expired page token: restart a bounded bootstrap once (unverified which status Drive uses, so 400/404/410 all count).
      if (!cur.bootstrap && (e?.status === 400 || e?.status === 404 || e?.status === 410) && restarts < 1) {
        restarts += 1; stats.restarted = true; cur = await startBootstrap(); continue;
      }
      throw e;
    }
  }
}

/** The user's shared drives, for the options picker. */
export async function listSharedDrives({ session, sleepImpl }) {
  const page = await googleCall(session, apiUrl(`${DRIVE_API}/drives`, { pageSize: 100, fields: 'drives(id,name)' }), { sleepImpl });
  return (Array.isArray(page.drives) ? page.drives : []).filter((d) => d?.id).map((d) => ({ id: String(d.id), name: oneLine(d.name, 200) }));
}

/** Folders directly under a parent (default root), for the folder picker. Names only, no content. */
export async function listFolders({ session, parentId, sleepImpl }) {
  const parent = parentId && ID_RE.test(parentId) ? parentId : 'root';
  const page = await googleCall(session, apiUrl(`${DRIVE_API}/files`, {
    q: `'${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`, pageSize: 200, orderBy: 'name', supportsAllDrives: true, fields: 'files(id,name)',
  }), { sleepImpl });
  return (Array.isArray(page.files) ? page.files : []).filter((f) => f?.id).map((f) => ({ id: String(f.id), name: oneLine(f.name, 200) }));
}
