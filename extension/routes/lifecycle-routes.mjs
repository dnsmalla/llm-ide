// Chat lifecycle routes (live-then-archive plan 3.2-3.5). Always on; nothing in
// the chat flow calls them yet.
//
//   GET  /kb/agent/working-state                 -> { sessions, purges }
//   POST /agent/v2/sessions/purge                { chatSessionIds[], verified: true } -> { purged }   (receipt required)
//   POST /kb/session-purges                      { chatSessionId, reason? } -> 202 { queued, purged }
//   POST /kb/archive-receipts                    { chatSessionId, hash, count } -> { recorded }
//
// The archive routes (/kb/chat/sessions/:id/archive/begin|commit) live in
// routes/chat.mjs, next to the other session routes.
//
// Ordering of every purge (the one place it is written): (1) capture the SDK
// session ids, (2) delete the transcript FILES (idempotent), (3) delete the DB
// rows (mapping, session memory, chat row) in one transaction, (4) complete the
// tombstone. A crash after (1) or (2) leaves a tombstone that replays the same
// steps, so nothing is orphaned. The Mac chat file is never touched here.
import { sendJSON, readJsonBody } from '../core/utils.mjs';
import { deleteSdkTranscripts } from '../llm_agent/sdk/transcripts.mjs';
import { deleteChatSession } from '../kb/chat-sessions.mjs';
import {
  listWorkingState, purgeWorkingState, enqueueSessionPurge, listSessionPurges,
  completeSessionPurge, failSessionPurge, sessionPurgeStatus, sdkIdsForChats,
  SESSION_PURGE_REASONS, MAX_PURGE_IDS, hasArchiveReceipt, recordMacArchiveReceipt,
} from '../kb/chat-lifecycle.mjs';

/**
 * Purge one chat in the documented order. `deleteTranscripts` is injectable so
 * the tests can make the file step fail (the replay is exercised against that).
 */
export function purgeChat(userId, chatSessionId, { deleteTranscripts = deleteSdkTranscripts, sdkIds = null } = {}) {
  // The tombstone's ids (captured before any removal) plus the mapping as it is now.
  const ids = [...new Set([...(sdkIds ?? []), ...sdkIdsForChats(userId, [chatSessionId])])];
  for (const sdk of ids) deleteTranscripts(userId, sdk);
  const { purged } = purgeWorkingState(userId, [chatSessionId]);
  deleteChatSession(userId, chatSessionId);
  return { purged, transcripts: ids.length };
}

/**
 * Replay every tombstone this user still owes. Rules, in order, for each one:
 *   - a 'failed' tombstone is terminal: it is counted, not retried;
 *   - a tombstone whose next attempt is later than now waits;
 *   - the reuse guard (DL16) applies to EVERY delete path: a chat used after its
 *     delete was requested keeps its files, rows and memory; the tombstone goes;
 *   - otherwise the chat is purged in order; a failure records an attempt with
 *     backoff, and after the cap the tombstone becomes 'failed'.
 * Returns counts. Not wired to a timer (T4.3 owns that).
 */
export function replaySessionPurges(userId, { now = Date.now(), deleteTranscripts = deleteSdkTranscripts } = {}) {
  const out = { done: 0, pending: 0, failed: 0, skippedReused: 0, notDue: 0 };
  for (const due of listSessionPurges(userId)) {
    if (due.state === 'failed') { out.failed += 1; continue; }
    if (Date.parse(due.dueAt) > now) { out.notDue += 1; continue; }
    if (due.lastActivityMs > due.requestedMs) {
      completeSessionPurge(userId, due.chatSessionId);
      out.skippedReused += 1;
      continue;
    }
    try {
      purgeChat(userId, due.chatSessionId, { deleteTranscripts, sdkIds: due.sdkSessionIds });
      completeSessionPurge(userId, due.chatSessionId);
      out.done += 1;
    } catch (err) {
      const r = failSessionPurge(userId, due.chatSessionId, { now });
      if (r?.state === 'failed') out.failed += 1; else out.pending += 1;
      console.error(`[lifecycle] session purge replay failed for ${due.chatSessionId} (attempt ${r?.attempts}):`, err?.message || err);
    }
  }
  return out;
}

export async function handleLifecycleRoutes(req, res, { userId, url }) {
  const path = url.split('?')[0];

  if (req.method === 'GET' && path === '/kb/agent/working-state') {
    sendJSON(res, 200, { ...listWorkingState(userId), purges: sessionPurgeStatus(userId) });
    return true;
  }

  if (req.method === 'POST' && path === '/agent/v2/sessions/purge') {
    const body = await readJsonBody(req, 256 * 1024);
    if (body.verified !== true) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'verified must be true: check the Mac file before purging' } });
      return true;
    }
    if (!Array.isArray(body.chatSessionIds) || body.chatSessionIds.length > MAX_PURGE_IDS) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: `chatSessionIds must be an array of up to ${MAX_PURGE_IDS}` } });
      return true;
    }
    // A purge needs proof that each chat's transcript is in a file: an archive
    // receipt (a server commit, or the Mac's own verified file, POST
    // /kb/archive-receipts). All or nothing: any chat without one refuses the batch.
    const missing = body.chatSessionIds.filter((id) => typeof id !== 'string' || !id || !hasArchiveReceipt(userId, id));
    if (missing.length > 0) {
      sendJSON(res, 409, {
        error: {
          code: 'NO_RECEIPT',
          message: 'a chat has no archive receipt, so its working state was not purged',
          details: { missing: missing.slice(0, 50) },
        },
      });
      return true;
    }
    let purged = 0;
    for (const id of body.chatSessionIds) purged += purgeChat(userId, id).purged;
    sendJSON(res, 200, { purged });
    return true;
  }

  // POST /kb/archive-receipts — the Mac app's own verification of the file it wrote
  // for a chat (the hash and message count it computed from that file).
  if (req.method === 'POST' && path === '/kb/archive-receipts') {
    const body = await readJsonBody(req, 16 * 1024);
    recordMacArchiveReceipt(userId, body.chatSessionId, { hash: body.hash, count: body.count });
    sendJSON(res, 200, { recorded: true });
    return true;
  }

  if (req.method === 'POST' && path === '/kb/session-purges') {
    const body = await readJsonBody(req, 16 * 1024);
    const reason = body.reason === undefined ? 'user_delete' : body.reason;
    if (!SESSION_PURGE_REASONS.has(reason)) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: `reason must be one of ${[...SESSION_PURGE_REASONS].join(', ')}` } });
      return true;
    }
    if (typeof body.chatSessionId !== 'string' || !body.chatSessionId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'chatSessionId is required' } });
      return true;
    }
    // The tombstone (with the SDK ids) is durable before anything is removed.
    enqueueSessionPurge(userId, body.chatSessionId, reason);
    let purged;
    try {
      const tomb = listSessionPurges(userId).find((p) => p.chatSessionId === body.chatSessionId);
      purgeChat(userId, body.chatSessionId, { sdkIds: tomb?.sdkSessionIds ?? null });
      completeSessionPurge(userId, body.chatSessionId);
      purged = 'done';
    } catch (err) {
      const r = failSessionPurge(userId, body.chatSessionId);
      purged = r?.state === 'failed' ? 'failed' : 'pending';
      console.error(`[lifecycle] session purge failed for ${body.chatSessionId}:`, err?.message || err);
    }
    sendJSON(res, 202, { queued: true, purged });
    return true;
  }

  return false;
}
