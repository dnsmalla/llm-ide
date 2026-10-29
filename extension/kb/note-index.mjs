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
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { redactSecretsForStorage } from '../core/redact-secrets.mjs';
import { errValidation } from '../core/errors.mjs';

export const BODY_CAP_BYTES = 200 * 1024;   // Q12 default: full redacted text, capped
export const TITLE_MAX = 500;
export const NOTE_KEY_MAX = 512;
export const PROJECT_ID_MAX = 200;
export const MAX_BATCH = 100;               // plan 3.8: POST /kb/index/notes batch size
export const MAX_MANIFEST = 20000;
const PARTICIPANTS_MAX = 200;
const META_MAX_CHARS = 4096;
const KINDS = new Set(['meeting']);         // other kinds need a later flag (token bench)

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
  const body = input.body === undefined ? '' : str(input.body, 'body', 16 * 1024 * 1024);
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
  if (notes.length > MAX_BATCH) throw errValidation(`at most ${MAX_BATCH} notes per batch`);
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

/**
 * Compare a manifest of (noteKey, contentHash) with the index for one project.
 * Reports missing (in the manifest, not indexed), stale (indexed with another
 * hash) and extra (indexed, not in the manifest). `prune` deletes the extras.
 */
export function reconcileNotes(userId, { projectId = '', manifest, prune = false } = {}) {
  requireUser(userId);
  if (!Array.isArray(manifest)) throw errValidation('manifest must be an array');
  if (manifest.length > MAX_MANIFEST) throw errValidation(`manifest holds at most ${MAX_MANIFEST} entries`);
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
  const extra = [...indexed.keys()].filter((k) => !seen.has(k));
  let pruned = 0;
  if (prune && extra.length > 0) {
    const del = lazyPrepare(db, 'DELETE FROM note_index WHERE user_id = ? AND project_id = ? AND note_key = ?');
    const tx = db.transaction((keys) => {
      for (const k of keys) pruned += del.run(userId, pid, k).changes;
    });
    tx(extra);
  }
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
