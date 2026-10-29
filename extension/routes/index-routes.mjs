// The derived note index (kb/note-index.mjs, plan 3.8). Always on: the index
// is a data store, not a feature, so no LLMIDE_FEATURES group owns it.
//
//   POST   /kb/index/notes                 { projectId?, notes[≤100] } -> { upserted, unchanged, skippedHidden, truncated }
//   POST   /kb/index/reconcile             { projectId?, manifest[], prune? } -> { missing[], stale[], extra[], pruned }
//   POST   /kb/index/scan                  { projectId?, scanId, index, total, complete?, prune?, entries[≤500] } -> { missing[], stale[], extra[], pruned, received, total, complete }
//   DELETE /kb/index/notes/:key?projectId= -> { deleted }
//   GET    /kb/index/status?projectId=     -> { notes, ftsRows, consistent, lastIndexedAt }
//
// Nothing calls these yet (T2.1 wires the Mac). Every route is scoped to the
// authenticated user; the router passes userId.
import { sendJSON, readJsonBody, decodeParam } from '../core/utils.mjs';
import { upsertNotes, reconcileNotes, deleteNote, indexStatus, scanNoteChunk } from '../kb/note-index.mjs';

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
      prune: body.prune === true,
    });
    sendJSON(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && path === '/kb/index/scan') {
    const body = await readJsonBody(req, BATCH_BYTES);
    sendJSON(res, 200, scanNoteChunk(userId, body));
    return true;
  }

  if (req.method === 'DELETE' && path.startsWith('/kb/index/notes/')) {
    const noteKey = decodeParam(path.slice('/kb/index/notes/'.length));
    const deleted = deleteNote(userId, { projectId: u.searchParams.get('projectId') ?? '', noteKey });
    sendJSON(res, 200, { deleted });
    return true;
  }

  if (req.method === 'GET' && path === '/kb/index/status') {
    const projectId = u.searchParams.has('projectId') ? u.searchParams.get('projectId') : undefined;
    sendJSON(res, 200, indexStatus(userId, { projectId }));
    return true;
  }

  return false;
}
