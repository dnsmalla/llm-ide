// The derived note index (kb/note-index.mjs, plan 3.8). Always on: the index
// is a data store, not a feature, so no LLMIDE_FEATURES group owns it.
//
//   POST   /kb/index/notes                 { projectId?, notes[≤100] } -> { upserted, unchanged, skippedHidden, truncated }
//   POST   /kb/index/reconcile             { projectId?, manifest[], prune? } -> { missing[], stale[], extra[], pruned }
//   POST   /kb/index/scan                  { projectId?, scanId, index, total, complete?, prune?, entries[≤500] } -> { missing[], stale[], extra[], pruned, received, total, complete }
//   DELETE /kb/index/notes/:key?projectId= -> { deleted }
//   GET    /kb/index/search?q=&limit=&projectId= -> { results: [{ noteKey, title, snippet, date, kind, projectId }] }
//   GET    /kb/index/status?projectId=     -> { notes, ftsRows, consistent, lastIndexedAt }
//
// Nothing calls these yet (T2.1 wires the Mac). Every route is scoped to the
// authenticated user; the router passes userId.
import { sendJSON, readJsonBody, decodeParam } from '../core/utils.mjs';
import { upsertNotes, reconcileNotes, deleteNote, indexStatus, scanNoteChunk, searchNotes, PROJECT_ID_MAX } from '../kb/note-index.mjs';

// Upserts carry bodies, so they get the tightest limit: 1 MB (50 notes of at
// most 512 KiB each is 25 MB, so the byte cap is the real bound on a batch).
const BATCH_BYTES = 1024 * 1024;

export async function handleIndexRoutes(req, res, { userId, url }) {
  const path = url.split('?')[0];
  if (!path.startsWith('/kb/index/')) return false;
  const u = new URL(url, 'http://127.0.0.1');

  if (req.method === 'POST' && path === '/kb/index/notes') {
    const body = await readJsonBody(req, BATCH_BYTES);
    const result = upsertNotes(userId, body.notes, { projectId: body.projectId ?? '' });
    sendJSON(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && path === '/kb/index/reconcile') {
    const body = await readJsonBody(req, BATCH_BYTES);
    const result = reconcileNotes(userId, {
      projectId: body.projectId ?? '',
      manifest: body.manifest,
      keep: body.keep,
      prune: body.prune === true,
      allowEmpty: body.allowEmpty === true,
    });
    sendJSON(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && path === '/kb/index/scan') {
    const body = await readJsonBody(req, BATCH_BYTES);
    sendJSON(res, 200, await scanNoteChunk(userId, body));
    return true;
  }

  if (req.method === 'DELETE' && path.startsWith('/kb/index/notes/')) {
    const noteKey = decodeParam(path.slice('/kb/index/notes/'.length));
    const deleted = deleteNote(userId, { projectId: u.searchParams.get('projectId') ?? '', noteKey });
    sendJSON(res, 200, { deleted });
    return true;
  }

  if (req.method === 'GET' && path === '/kb/index/search') {
    const q = u.searchParams.get('q');
    const limitRaw = u.searchParams.get('limit');
    const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw);
    const projectId = u.searchParams.has('projectId') ? u.searchParams.get('projectId') : undefined;
    const bad = typeof q !== 'string' || q.length === 0 || q.length > 200
      || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50))
      || (projectId !== undefined && projectId.length > PROJECT_ID_MAX);
    if (bad) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'q (1-200 characters) is required; limit is an integer 1-50; projectId at most 200 characters' } });
      return true;
    }
    sendJSON(res, 200, { results: searchNotes(userId, { q, limit, projectId }) });
    return true;
  }

  if (req.method === 'GET' && path === '/kb/index/status') {
    const projectId = u.searchParams.has('projectId') ? u.searchParams.get('projectId') : undefined;
    sendJSON(res, 200, indexStatus(userId, { projectId }));
    return true;
  }

  return false;
}
