// Derived note index (live-then-archive, plan 3.8, Phase 1 T1.2).
//
// A rebuildable, per-user, project-scoped copy of the Mac app's meeting-note
// metadata and a REDACTED, capped body. It holds no unique data: every row can
// be recomputed from the Mac file, and drop-and-rebuild is the proof. Nothing
// in the existing meeting or chat flow calls this module yet (T2/T3 wire it).
//
// Every helper takes userId first and scopes every statement by user_id.
// Redaction happens here, when body_text is built (plan 3.9, Q4): the Mac
// files stay raw, the index copy is what the models may replay.
import { getDb, requireUser, lazyPrepare, buildSearchFilter, searchFilterSql } from './db.mjs';
import { redactSecretsForStorage } from '../core/redact-secrets.mjs';
import { AppError, errValidation } from '../core/errors.mjs';

export const BODY_CAP_BYTES = 200 * 1024;   // Q12 default: full redacted text, capped
export const TITLE_MAX = 500;
export const NOTE_KEY_MAX = 512;
export const PROJECT_ID_MAX = 200;
export const MAX_BATCH = 50;                // notes per POST /kb/index/notes (DoS bound)
export const MAX_NOTE_BODY_BYTES = 512 * 1024; // raw body per note, before redaction
export const MAX_MANIFEST = 20000;
const PARTICIPANTS_MAX = 200;
const META_MAX_CHARS = 4096;
// 'meeting' is the Mac's meeting notes; the rest let the Library index its other sources (the column is free text,
// so no migration is needed). An unknown kind is refused, never stored.
export const KINDS = new Set(['meeting', 'note', 'email', 'slack', 'document', 'repo', 'plan', 'other']);

const nowIso = () => new Date().toISOString();

/** Cap a string to `cap` UTF-8 bytes without splitting a character. */
export function capUtf8(text, cap = BODY_CAP_BYTES) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= cap) return { text: s, truncated: false };
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > cap) break;
    out += ch;
    bytes += n;
  }
  return { text: out, truncated: true };
}

function str(v, field, max) {
  if (typeof v !== 'string') throw errValidation(`${field} must be a string`);
  if (v.length > max) throw errValidation(`${field} is longer than ${max} characters`);
  return v;
}

/** A note key is a relative, forward-slash path under the project root. */
export function checkNoteKey(noteKey) {
  const k = str(noteKey, 'noteKey', NOTE_KEY_MAX);
  if (!k || k.startsWith('/') || k.includes('\\') || k.includes('\0')
    || k.split('/').some((seg) => seg === '..' || seg === '')) {
    throw errValidation('noteKey must be a relative path under the project root');
  }
  return k;
}

function projectIdOf(v) {
  if (v === undefined || v === null || v === '') return '';
  return str(v, 'projectId', PROJECT_ID_MAX);
}

/**
 * Validate and normalise one note. Throws errValidation on a bad shape.
 * Returns null for a hidden note (never indexed; counted by the caller).
 */
export function normaliseNote(input, defaultProjectId = '') {
  if (!input || typeof input !== 'object') throw errValidation('each note must be an object');
  if (input.hidden === true) return null;
  const kind = input.kind === undefined ? 'meeting' : input.kind;
  if (!KINDS.has(kind)) throw errValidation(`unsupported kind: ${kind}`);
  const participants = input.participants === undefined ? [] : input.participants;
  if (!Array.isArray(participants) || participants.length > PARTICIPANTS_MAX
    || participants.some((p) => typeof p !== 'string' || p.length > 200)) {
    throw errValidation('participants must be an array of up to 200 strings');
  }
  const durationSec = input.durationSec === undefined ? 0 : input.durationSec;
  if (!Number.isInteger(durationSec) || durationSec < 0) throw errValidation('durationSec must be a non-negative integer');
  const mtimeMs = input.mtimeMs === undefined ? 0 : input.mtimeMs;
  if (!Number.isInteger(mtimeMs) || mtimeMs < 0) throw errValidation('mtimeMs must be a non-negative integer');
  const meta = input.meta === undefined ? {} : input.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw errValidation('meta must be an object');
  const metaJson = redactSecretsForStorage(JSON.stringify(meta));
  if (metaJson.length > META_MAX_CHARS) throw errValidation('meta is too large');
  const body = input.body === undefined ? '' : str(input.body, 'body', MAX_NOTE_BODY_BYTES);
  if (Buffer.byteLength(body, 'utf8') > MAX_NOTE_BODY_BYTES) throw errValidation('body is larger than 512 KiB');
  const redacted = redactSecretsForStorage(body);
  const capped = capUtf8(redacted, BODY_CAP_BYTES);
  return {
    projectId: projectIdOf(input.projectId ?? defaultProjectId),
    noteKey: checkNoteKey(input.noteKey),
    kind,
    title: redactSecretsForStorage(str(input.title, 'title', TITLE_MAX)),
    date: str(input.date, 'date', 64),
    durationSec,
    participants: JSON.stringify(participants.map((p) => redactSecretsForStorage(p))),
    bodyText: capped.text,
    bodyTruncated: capped.truncated,
    contentHash: str(input.contentHash, 'contentHash', 128),
    mtimeMs,
    meta: metaJson,
  };
}

const UPSERT_SQL = `
  INSERT INTO note_index
    (user_id, project_id, note_key, kind, title, date, duration_sec, participants,
     body_text, content_hash, mtime_ms, meta, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, project_id, note_key) DO UPDATE SET
    kind = excluded.kind,
    title = excluded.title,
    date = excluded.date,
    duration_sec = excluded.duration_sec,
    participants = excluded.participants,
    body_text = excluded.body_text,
    content_hash = excluded.content_hash,
    mtime_ms = excluded.mtime_ms,
    meta = excluded.meta,
    indexed_at = excluded.indexed_at
  WHERE note_index.content_hash IS NOT excluded.content_hash
     OR note_index.title IS NOT excluded.title
     OR note_index.date IS NOT excluded.date
     OR note_index.duration_sec IS NOT excluded.duration_sec
     OR note_index.participants IS NOT excluded.participants
     OR note_index.body_text IS NOT excluded.body_text
     OR note_index.meta IS NOT excluded.meta
     OR note_index.mtime_ms IS NOT excluded.mtime_ms
`;

/**
 * Upsert a batch (at most MAX_BATCH notes) in one transaction. Idempotent: an
 * unchanged note writes nothing, so re-sending a batch reports `unchanged`.
 * Hidden notes are skipped and counted, never stored.
 */
export function upsertNotes(userId, notes, { projectId = '' } = {}) {
  requireUser(userId);
  if (!Array.isArray(notes)) throw errValidation('notes must be an array');
  if (notes.length > MAX_BATCH) {
    throw new AppError('BATCH_TOO_LARGE', `at most ${MAX_BATCH} notes per batch`, { status: 400 });
  }
  const db = getDb();
  const stmt = lazyPrepare(db, UPSERT_SQL);
  const counts = { upserted: 0, unchanged: 0, skippedHidden: 0, truncated: 0, removed: 0 };
  const del = lazyPrepare(db, 'DELETE FROM note_index WHERE user_id = ? AND project_id = ? AND note_key = ?');
  const tx = db.transaction((rows) => {
    for (const raw of rows) {
      const n = normaliseNote(raw, projectId);
      if (!n) {
        // A note that is hidden now (it was indexed while visible) leaves the
        // index: its row and, by trigger, its FTS row are removed.
        counts.skippedHidden += 1;
        counts.removed += del.run(userId, projectIdOf(raw.projectId ?? projectId), checkNoteKey(raw.noteKey)).changes;
        continue;
      }
      if (n.bodyTruncated) counts.truncated += 1;
      const changes = stmt.run(
        userId, n.projectId, n.noteKey, n.kind, n.title, n.date, n.durationSec, n.participants,
        n.bodyText, n.contentHash, n.mtimeMs, n.meta, nowIso(),
      ).changes;
      if (changes > 0) counts.upserted += 1; else counts.unchanged += 1;
    }
  });
  tx(notes);
  return counts;
}

/** Keys the caller holds back from pruning (unindexable on the Mac). Bounded and checked. */
export const MAX_KEEP = 20000;
function keepSetOf(keep) {
  if (keep === undefined || keep === null) return new Set();
  if (!Array.isArray(keep) || keep.length > MAX_KEEP) throw errValidation(`keep must be an array of at most ${MAX_KEEP} keys`);
  return new Set(keep.map((k) => checkNoteKey(k)));
}

/** Records that (user, project) had a complete pass now (changed or not). */
export function recordReconciledPass(userId, projectId = '', now = new Date()) {
  lazyPrepare(getDb(), `INSERT INTO note_index_pass (user_id, project_id, last_reconciled_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id, project_id) DO UPDATE SET last_reconciled_at = excluded.last_reconciled_at`)
    .run(userId, projectIdOf(projectId), now.toISOString());
}

/** The last complete pass of (user, project), or null. */
export function lastReconciledAt(userId, projectId = '') {
  const row = lazyPrepare(getDb(), 'SELECT last_reconciled_at AS t FROM note_index_pass WHERE user_id = ? AND project_id = ?')
    .get(userId, projectIdOf(projectId));
  return row ? row.t : null;
}

/**
 * Compare a manifest of (noteKey, contentHash) with the index for one project.
 * Reports missing (in the manifest, not indexed), stale (indexed with another hash) and
 * extra (indexed, named by neither the manifest nor `keep`). `prune` deletes the extras.
 * An empty manifest with prune is refused (409 EMPTY_MANIFEST_REFUSED) unless allowEmpty:
 * an emptied or unmounted folder must not look like "every note was deleted".
 */
export function reconcileNotes(userId, { projectId = '', manifest, keep, prune = false, allowEmpty = false, now = new Date() } = {}) {
  requireUser(userId);
  if (!Array.isArray(manifest)) throw errValidation('manifest must be an array');
  if (manifest.length > MAX_MANIFEST) throw errValidation(`manifest holds at most ${MAX_MANIFEST} entries`);
  if (typeof prune !== 'boolean' || typeof allowEmpty !== 'boolean') throw errValidation('prune and allowEmpty must be booleans');
  if (prune && manifest.length === 0 && !allowEmpty) {
    throw new AppError('EMPTY_MANIFEST_REFUSED', 'an empty manifest does not prune unless allowEmpty is true', { status: 409 });
  }
  const kept = keepSetOf(keep);
  const pid = projectIdOf(projectId);
  const db = getDb();
  const indexed = new Map(lazyPrepare(db,
    'SELECT note_key, content_hash FROM note_index WHERE user_id = ? AND project_id = ?',
  ).all(userId, pid).map((r) => [r.note_key, r.content_hash]));
  const missing = [];
  const stale = [];
  const seen = new Set();
  for (const e of manifest) {
    const key = checkNoteKey(e?.noteKey);
    const hash = str(e?.contentHash, 'contentHash', 128);
    seen.add(key);
    if (!indexed.has(key)) missing.push(key);
    else if (indexed.get(key) !== hash) stale.push(key);
  }
  const extra = [...indexed.keys()].filter((k) => !seen.has(k) && !kept.has(k));
  let pruned = 0;
  if (prune && extra.length > 0) {
    const del = lazyPrepare(db, 'DELETE FROM note_index WHERE user_id = ? AND project_id = ? AND note_key = ?');
    db.transaction((keys) => { for (const k of keys) pruned += del.run(userId, pid, k).changes; })(extra);
  }
  recordReconciledPass(userId, pid, now);
  return { missing, stale, extra, pruned };
}

/** Delete one note's row (and, by trigger, its FTS row). Returns true if it existed. */
export function deleteNote(userId, { projectId = '', noteKey } = {}) {
  requireUser(userId);
  const key = checkNoteKey(noteKey);
  return lazyPrepare(getDb(),
    'DELETE FROM note_index WHERE user_id = ? AND project_id = ? AND note_key = ?',
  ).run(userId, projectIdOf(projectId), key).changes > 0;
}

/**
 * Rebuild the note FTS rows and their map from note_index (the source of truth).
 * Deletes ONLY kind 'note' rows: the map's rowids are not trusted, because a
 * rebuild of the `search` table renumbers rows and a stale map would point at
 * another row. Any migration that rebuilds `search` must call this (see the
 * header of migration 0050 and docs/explanation/invariants.md).
 */
export function rebuildNoteIndexSearch(db = getDb()) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM search WHERE kind = 'note'").run();
    db.prepare('DELETE FROM note_index_search').run();
    const rows = db.prepare('SELECT id, title, body_text FROM note_index').all();
    const ins = db.prepare(`INSERT INTO search (meeting_id, entity_id, kind, title, body)
      VALUES (char(1) || 'note:' || CAST(? AS INTEGER), NULL, 'note', ?, ?)`);  // CAST: a JS number binds as REAL (note:1.0)
    const map = db.prepare('INSERT INTO note_index_search (note_id, search_rowid) VALUES (?, ?)');
    for (const r of rows) {
      const rowid = Number(ins.run(r.id, r.title, r.body_text).lastInsertRowid);
      map.run(r.id, rowid);
    }
    return rows.length;
  });
  return tx();
}

/**
 * Index health for one user (optionally one project): the note count, how many
 * of them have a map entry, and how many of those map entries point at the
 * note's own FTS row. consistent is true only when all three agree, so a stale
 * map (a renumbered `search` table) is reported instead of hidden.
 */
export function indexStatus(userId, { projectId } = {}) {
  requireUser(userId);
  const db = getDb();
  const pid = projectId === undefined ? null : projectIdOf(projectId);
  const scope = pid === null ? '' : ' AND n.project_id = ?';
  const args = pid === null ? [userId] : [userId, pid];
  const notes = db.prepare(`SELECT COUNT(*) AS n, MAX(indexed_at) AS last FROM note_index n WHERE n.user_id = ?${scope}`).get(...args);
  const mapped = db.prepare(`
    SELECT COUNT(*) AS n FROM note_index_search m
      JOIN note_index n ON n.id = m.note_id
     WHERE n.user_id = ?${scope}
  `).get(...args).n;
  const verified = db.prepare(`
    SELECT COUNT(*) AS n FROM note_index n
      JOIN note_index_search m ON m.note_id = n.id
      JOIN search s ON s.rowid = m.search_rowid
     WHERE n.user_id = ?${scope}
       AND s.kind = 'note' AND s.meeting_id = char(1) || 'note:' || n.id
  `).get(...args).n;
  return {
    notes: notes.n,
    ftsRows: verified,
    consistent: notes.n === mapped && mapped === verified,
    lastIndexedAt: notes.last ?? null,
  };
}

/**
 * Internal FTS search over the derived note rows (kind 'note'), for the shadow
 * compare and the Phase 3 read path. The public search() never returns these rows
 * until Phase 3. The owner filter runs in SQL, before LIMIT: FTS is shared by every
 * user, so filtering after LIMIT would starve a user whose matches rank low (the
 * window fills with other users' rows). Returns [{ noteId, meetingId, title, date,
 * projectId, rank }], best first.
 */
export function noteIndexHits(userId, { q, limit = 10, projectId, db = getDb() } = {}) {
  requireUser(userId);
  const filter = buildSearchFilter(q);
  const cap = Math.max(1, Math.min(Number(limit) || 10, 100));
  const pid = projectId === undefined ? null : projectIdOf(projectId);
  const parse = (meta) => { try { return JSON.parse(meta) || {}; } catch { return {}; } };
  const row = (n) => {
    const meta = parse(n.meta);
    return {
      noteId: n.id,
      meetingId: typeof meta.meetingId === 'string' ? meta.meetingId : null,
      title: n.title,
      date: n.date,
      projectId: n.project_id,
      rank: n.rank ?? null,
    };
  };
  // A query with no searchable token lists the newest rows, as search() does for meetings.
  if (!filter) {
    return lazyPrepare(db, `
      SELECT id, title, date, project_id, meta FROM note_index
       WHERE user_id = ? AND (? IS NULL OR project_id = ?)
       ORDER BY date DESC LIMIT ?`).all(userId, pid, pid, cap).map(row);
  }
  // Every FTS match is ranked (bm25), then owner rows are taken in rank order. The FTS row of a note
  // names its note id (meeting_id = char(1) || 'note:' || id), so ownership is checked by primary key
  // in bounded batches. Nothing proportional to the whole library is built per query, and no other
  // user's rows can fill the window (the rank walk continues until `cap` owned rows are found).
  const where = searchFilterSql(filter);
  const matches = lazyPrepare(db, `SELECT meeting_id AS mid, ${where.rank} AS rank
    FROM search WHERE ${where.where} AND kind = 'note'`).all(...where.params);
  const ordered = [];
  for (const m of matches) {
    const id = Number(String(m.mid).slice(String(m.mid).indexOf('note:') + 5));
    if (Number.isInteger(id)) ordered.push({ id, rank: m.rank });
  }
  ordered.sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0));
  const out = [];
  const LOOKUP = 400;
  for (let i = 0; i < ordered.length && out.length < cap; i += LOOKUP) {
    const part = ordered.slice(i, i + LOOKUP);
    const rankOf = new Map(part.map((p) => [p.id, p.rank]));
    const sql = `SELECT id, title, date, project_id, meta FROM note_index
       WHERE user_id = ? AND id IN (${part.map(() => '?').join(',')})${pid === null ? '' : ' AND project_id = ?'}`;
    const params = [userId, ...part.map((p) => p.id)];
    if (pid !== null) params.push(pid);
    const found = lazyPrepare(db, sql).all(...params).map((n) => ({ ...n, rank: rankOf.get(n.id) }));
    found.sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0));
    for (const n of found) {
      if (out.length >= cap) break;
      out.push(row(n));
    }
  }
  return out;
}

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;
const SNIPPET_CHARS = 200;
// Control characters, bidi overrides/isolates, and zero-width characters: never shown, never kept.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** A plain-text excerpt of a (redacted) note body around the first matched word; no markup is interpreted. */
export function snippetOf(body, q) {
  const text = redactSecretsForStorage(String(body ?? '')).replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const words = String(q ?? '').toLowerCase().split(/[^\p{L}\p{M}\p{N}_]+/u).filter((w) => w.length >= 2);
  let at = -1;
  for (const w of words) { const i = lower.indexOf(w); if (i !== -1 && (at === -1 || i < at)) at = i; }
  const start = at === -1 ? 0 : Math.max(0, at - 60);
  let out = [...text.slice(start)].slice(0, SNIPPET_CHARS).join('');
  if (start > 0) out = `…${out}`;
  if (start + out.length < text.length) out = `${out}…`;
  return out;
}

/**
 * The route's note search: ranked hits with { noteKey, title, snippet, date, kind } (and projectId). User-scoped in SQL
 * (noteIndexHits), limit 1..SEARCH_LIMIT_MAX. A query with no searchable word (2+ characters) returns nothing.
 */
export function searchNotes(userId, { q, limit = SEARCH_LIMIT_DEFAULT, projectId, db = getDb() } = {}) {
  requireUser(userId);
  if (!buildSearchFilter(q)) return [];
  const cap = Math.max(1, Math.min(Number(limit) || SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX));
  const hits = noteIndexHits(userId, { q, limit: cap, projectId, db });
  if (hits.length === 0) return [];
  const rows = lazyPrepare(db, `SELECT id, note_key, kind, body_text FROM note_index
     WHERE user_id = ? AND id IN (${hits.map(() => '?').join(',')})`).all(userId, ...hits.map((h) => h.noteId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const h of hits) {
    const r = byId.get(h.noteId);
    if (!r) continue;
    out.push({
      noteKey: r.note_key, title: h.title, snippet: snippetOf(r.body_text, q), date: h.date, kind: r.kind, projectId: h.projectId,
    });
  }
  return out;
}

/** The internal note search (kept for callers of the earlier name). */
export const searchNoteIndex = noteIndexHits;

// ---------------------------------------------------------------------------
// Chunked scan (live-then-archive Phase 2, plan 3.8). A library too large for one reconcile is
// sent as chunks of one scan. Chunks classify (missing, stale) and record the keys and the entry
// count they carried. The FINAL chunk (complete: true) declares totalEntries and may carry `keep`
// (keys the Mac could not index: never pruned) and allowEmpty. The server compares the received
// counts with totalEntries (409 SCAN_TOTAL_MISMATCH otherwise), refuses an all-empty scan with
// prune unless allowEmpty (409 EMPTY_SCAN_REFUSED), and prunes only the rows that the chunks and
// `keep` did not name. Scan state is in memory with an idle TTL: a restart or an expiry is a 409.
// ---------------------------------------------------------------------------

export const MAX_SCAN_CHUNKS = 100;          // 100 chunks x 500 notes = 50 000 notes per scan
export const MAX_SCAN_CHUNK_ENTRIES = 500;
export const SCAN_TTL_MS = 15 * 60 * 1000;   // idle time before a scan is forgotten
export const MAX_OPEN_SCANS = 4;             // per user, so a client cannot exhaust memory
export const PRUNE_BATCH = 2000;             // rows deleted per transaction; the loop yields between them
const SCAN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SCAN_LOOKUP_CHUNK = 400;               // keys per IN (...) lookup (bound-parameter safety)
const scans = new Map();                     // userId\0projectId\0scanId -> state

function sweepScans(now) {
  for (const [key, s] of scans) if (now - s.touched > SCAN_TTL_MS) scans.delete(key);
}

/** Test seam: forget every open scan. */
export function resetNoteIndexScans() {
  scans.clear();
}

/** A new scan for (user, project) abandons the earlier unfinished ones: a retry never hits SCAN_LIMIT. */
function abandonScansOf(userId, pid, keepScanId) {
  const prefix = `${userId}\u0000${pid}\u0000`;
  for (const k of [...scans.keys()]) {
    if (k.startsWith(prefix) && k !== `${prefix}${keepScanId}`) scans.delete(k);
  }
}

function indexedHashes(db, userId, pid, keys) {
  const found = new Map();
  for (let i = 0; i < keys.length; i += SCAN_LOOKUP_CHUNK) {
    const part = keys.slice(i, i + SCAN_LOOKUP_CHUNK);
    const sql = `SELECT note_key, content_hash FROM note_index
                  WHERE user_id = ? AND project_id = ? AND note_key IN (${part.map(() => '?').join(',')})`;
    for (const r of db.prepare(sql).all(userId, pid, ...part)) found.set(r.note_key, r.content_hash);
  }
  return found;
}

/** Deletes `keys` in batches of PRUNE_BATCH, yielding to the event loop between batches. */
async function pruneInBatches(db, userId, pid, keys) {
  const del = db.prepare('DELETE FROM note_index WHERE user_id = ? AND project_id = ? AND note_key = ?');
  let pruned = 0;
  for (let i = 0; i < keys.length; i += PRUNE_BATCH) {
    const part = keys.slice(i, i + PRUNE_BATCH);
    db.transaction(() => { for (const k of part) pruned += del.run(userId, pid, k).changes; })();
    if (i + PRUNE_BATCH < keys.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return pruned;
}

/**
 * One chunk of a scan. Non-final: { missing, stale, extra: [], pruned: 0, received, total, complete: false }.
 * Final: the same plus extra, pruned, received = total, complete: true. Throws:
 *   400 VALIDATION_FAILED for a malformed chunk,
 *   429 SCAN_LIMIT when the user already has MAX_OPEN_SCANS open scans,
 *   409 SCAN_INCOMPLETE when a chunk never arrived, SCAN_TOTAL_MISMATCH when the received entry
 *       counts differ from totalEntries, EMPTY_SCAN_REFUSED for an all-empty prune without allowEmpty.
 *   Nothing is pruned on any refusal.
 */
export async function scanNoteChunk(userId, input, { now = Date.now() } = {}) {
  requireUser(userId);
  const body = input && typeof input === 'object' ? input : {};
  const pid = projectIdOf(body.projectId);
  const scanId = body.scanId;
  if (typeof scanId !== 'string' || !SCAN_ID_RE.test(scanId)) throw errValidation('scanId must be 8 to 64 letters, digits or dashes');
  const { index, total } = body;
  if (!Number.isInteger(total) || total < 1 || total > MAX_SCAN_CHUNKS) throw errValidation(`total must be 1 to ${MAX_SCAN_CHUNKS}`);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw errValidation('index must be 0 to total-1');
  const complete = body.complete === undefined ? false : body.complete;
  const prune = body.prune === undefined ? false : body.prune;
  const allowEmpty = body.allowEmpty === undefined ? false : body.allowEmpty;
  if (typeof complete !== 'boolean' || typeof prune !== 'boolean' || typeof allowEmpty !== 'boolean') {
    throw errValidation('complete, prune and allowEmpty must be booleans');
  }
  if (prune && !complete) throw errValidation('prune is only allowed on the final chunk (complete: true)');
  if (!complete && (body.totalEntries !== undefined || body.keep !== undefined || body.allowEmpty !== undefined)) {
    throw errValidation('totalEntries, keep and allowEmpty belong to the final chunk (complete: true)');
  }
  if (complete && (!Number.isInteger(body.totalEntries) || body.totalEntries < 0)) {
    throw errValidation('the final chunk must declare totalEntries (a non-negative integer)');
  }
  if (!Array.isArray(body.entries) || body.entries.length > MAX_SCAN_CHUNK_ENTRIES) {
    throw errValidation(`entries must be an array of at most ${MAX_SCAN_CHUNK_ENTRIES}`);
  }
  const entries = body.entries.map((e) => ({
    noteKey: checkNoteKey(e?.noteKey),
    contentHash: str(e?.contentHash, 'contentHash', 128),
  }));
  const kept = complete ? keepSetOf(body.keep) : new Set();

  sweepScans(now);
  const key = [userId, pid, scanId].join('\u0000');
  let s = scans.get(key);
  if (!s) {
    abandonScansOf(userId, pid, scanId);
    let open = 0;
    for (const k of scans.keys()) if (k.startsWith(`${userId}\u0000`)) open += 1;
    if (open >= MAX_OPEN_SCANS) throw new AppError('SCAN_LIMIT', 'too many open index scans; wait for them to finish', { status: 429 });
    s = { total, counts: new Map(), seen: new Set(), touched: now };
    scans.set(key, s);
  } else if (s.total !== total) {
    throw errValidation('total differs from the first chunk of this scan');
  }
  s.touched = now;

  const db = getDb();
  const held = indexedHashes(db, userId, pid, entries.map((e) => e.noteKey));
  const missing = [];
  const stale = [];
  for (const e of entries) {
    s.seen.add(e.noteKey);
    if (!held.has(e.noteKey)) missing.push(e.noteKey);
    else if (held.get(e.noteKey) !== e.contentHash) stale.push(e.noteKey);
  }
  s.counts.set(index, entries.length);

  if (!complete) {
    return { missing, stale, extra: [], pruned: 0, received: s.counts.size, total, complete: false };
  }
  scans.delete(key);
  if (s.counts.size !== total) {
    throw new AppError('SCAN_INCOMPLETE', `the scan is missing ${total - s.counts.size} of ${total} chunks; nothing was pruned`, { status: 409 });
  }
  const received = [...s.counts.values()].reduce((sum, n) => sum + n, 0);
  if (received !== body.totalEntries) {
    throw new AppError('SCAN_TOTAL_MISMATCH', `the chunks carry ${received} entries but the scan declared ${body.totalEntries}; nothing was pruned`, { status: 409 });
  }
  if (prune && received === 0 && !allowEmpty) {
    throw new AppError('EMPTY_SCAN_REFUSED', 'an all-empty scan does not prune unless allowEmpty is true', { status: 409 });
  }
  // The prune set is computed in full before any row is deleted.
  const extra = db.prepare('SELECT note_key FROM note_index WHERE user_id = ? AND project_id = ?')
    .all(userId, pid).map((r) => r.note_key).filter((k) => !s.seen.has(k) && !kept.has(k)).sort();
  const pruned = prune && extra.length > 0 ? await pruneInBatches(db, userId, pid, extra) : 0;
  recordReconciledPass(userId, pid, new Date(now));
  return { missing, stale, extra, pruned, received: total, total, complete: true };
}
