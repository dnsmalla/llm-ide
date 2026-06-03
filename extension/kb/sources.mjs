// External source ingestion — code chunks, tickets, QA pairs, docs.
// Sources are the non-meeting content the KB indexes: the planner /
// risk / code-sync agents read them at retrieval time, and they
// surface in the Library's "Sources" filter.
//
// Extracted from kb/db.mjs as part of the modularization sweep.

import { getDb, safeJSONStringify, requireUser } from './db.mjs';

const ALLOWED_SOURCE_KINDS = new Set(['code', 'ticket', 'qa', 'doc']);

// Upsert a batch of source items. Items with the same (kind, ref,
// chunk_idx) are replaced — re-indexing the same repo/issue/test
// produces a single up-to-date row per chunk rather than accumulating
// duplicates. Returns the number of rows written.
// Hard cap on a single ingest call.  An unbounded batch of, say,
// 100 000 code chunks would allocate all items in memory, hold a
// write transaction open for seconds (blocking all other DB writers),
// and could exhaust the SQLite page cache.  Callers that need to
// ingest large corpora should paginate.
const MAX_INGEST_BATCH = 5_000;

export function ingestSources(userId, items) {
  requireUser(userId);
  if (!Array.isArray(items) || items.length === 0) return 0;
  if (items.length > MAX_INGEST_BATCH) {
    throw new Error(
      `ingestSources: batch too large (${items.length} items, max ${MAX_INGEST_BATCH}). ` +
      'Split into smaller pages and call ingestSources once per page.',
    );
  }
  const db = getDb();
  // Sources are uniquely keyed (kind, ref, chunk_idx). Two different
  // tenants indexing the same path should NOT collide — we include
  // user_id in the conflict-detection by only matching against rows
  // owned by the same user, falling back to insert for cross-user
  // collisions. SQLite's ON CONFLICT only triggers on the unique
  // index match; since the index includes (kind, ref, chunk_idx), we
  // emulate per-user uniqueness by manual delete+insert under a tx.
  const tx = db.transaction((batch) => {
    let n = 0;
    const del = db.prepare(
      'DELETE FROM sources WHERE user_id = ? AND kind = ? AND ref = ? AND chunk_idx = ?'
    );
    const ins = db.prepare(`
      INSERT INTO sources (user_id, kind, ref, chunk_idx, title, body, meta, indexed_at)
      VALUES (@user_id, @kind, @ref, @chunk_idx, @title, @body, @meta, datetime('now'))
    `);
    for (const item of batch) {
      if (!item || !ALLOWED_SOURCE_KINDS.has(item.kind)) continue;
      const ref = String(item.ref || '').slice(0, 1000);
      const title = String(item.title || ref).slice(0, 500);
      const body = String(item.body || '').slice(0, 50_000);
      if (!ref || !title) continue;
      const chunk_idx = Number.isFinite(item.chunkIdx) ? item.chunkIdx : 0;
      del.run(userId, item.kind, ref, chunk_idx);
      const itemMeta = {
        ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
        ...(item.projectId ? { projectId: String(item.projectId).slice(0, 64) } : {}),
      };
      ins.run({
        user_id: userId,
        kind: item.kind,
        ref,
        chunk_idx,
        title,
        body,
        meta: safeJSONStringify(itemMeta),
      });
      n += 1;
    }
    return n;
  });
  return tx(items);
}

// Wipe all sources of a kind for a user — used when re-indexing a
// connector from scratch (e.g. "re-index local repo X" replaces every
// code row whose ref starts with the repo path).
export function deleteSourcesByPrefix(userId, kind, refPrefix) {
  requireUser(userId);
  if (!ALLOWED_SOURCE_KINDS.has(kind)) return 0;
  const db = getDb();
  const info = db.prepare(
    'DELETE FROM sources WHERE user_id = ? AND kind = ? AND ref LIKE ?'
  ).run(userId, String(kind), `${refPrefix}%`);
  return info.changes;
}
