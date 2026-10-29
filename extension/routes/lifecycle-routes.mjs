// Chat lifecycle routes (live-then-archive plan 3.2-3.5, Phase 1 T1.3). Always on;
// nothing in the chat flow calls them yet.
//
//   GET  /kb/agent/working-state                 -> { sessions: [{chatSessionId, sdkSession, factCount, updatedAt}] }
//   POST /agent/v2/sessions/purge                { chatSessionIds[], verified: true } -> { purged }
//   POST /kb/session-purges                      { chatSessionId, reason? } -> { queued, purged }
//   POST /kb/archive-receipts                    { chatSessionId, hash, count } -> { recorded }
//
// The archive routes (/kb/chat/sessions/:id/archive/begin|commit) live in
// routes/chat.mjs, next to the other session routes.
//
// Purging is server working state only: the agent session mapping, session-memory
// facts and the SDK transcript files. The Mac file (the transcript) is never
// touched here, and `verified: true` is required so a caller cannot purge the
// working state of a chat whose file it has not checked.
import { sendJSON, readBody, parseJSON, readJsonBody } from '../core/utils.mjs';
import { deleteSdkTranscripts } from '../llm_agent/sdk/transcripts.mjs';
import { deleteChatSession } from '../kb/chat-sessions.mjs';
import {
  listWorkingState, purgeWorkingState, enqueueSessionPurge, listSessionPurges,
  completeSessionPurge, failSessionPurge, SESSION_PURGE_REASONS, MAX_PURGE_IDS,
  hasArchiveReceipt, recordMacArchiveReceipt,
} from '../kb/chat-lifecycle.mjs';

/**
 * Purge one chat's working state (and its SDK transcripts), then its server chat
 * rows. Idempotent. Returns the SDK session ids removed.
 */
function purgeChat(userId, chatSessionId) {
  const { sdkSessionIds, purged } = purgeWorkingState(userId, [chatSessionId]);
  for (const sdk of sdkSessionIds) deleteSdkTranscripts(userId, sdk);
  deleteChatSession(userId, chatSessionId);
  return { purged, sdkSessionIds };
}

/**
 * Replay every tombstone this user still owes. A tombstone whose chat was used
 * after the delete was requested is dropped without purging (DL16: the chat is
 * live again). A failing replay keeps its tombstone and counts an attempt.
 * Returns { done, pending, skippedReused }.
 */
export function replaySessionPurges(userId) {
  const out = { done: 0, pending: 0, skippedReused: 0 };
  for (const due of listSessionPurges(userId)) {
    const reused = due.lastUsedAt && due.lastUsedAt > due.requestedAt;
    if (reused) {
      completeSessionPurge(userId, due.chatSessionId);
      out.skippedReused += 1;
      continue;
    }
    try {
      purgeChat(userId, due.chatSessionId);
      completeSessionPurge(userId, due.chatSessionId);
      out.done += 1;
    } catch (err) {
      failSessionPurge(userId, due.chatSessionId);
      console.error(`[lifecycle] session purge replay failed for ${due.chatSessionId}:`, err?.message || err);
      out.pending += 1;
    }
  }
  return out;
}

export async function handleLifecycleRoutes(req, res, { userId, url }) {
  const path = url.split('?')[0];

  if (req.method === 'GET' && path === '/kb/agent/working-state') {
    sendJSON(res, 200, listWorkingState(userId));
    return true;
  }

  if (req.method === 'POST' && path === '/agent/v2/sessions/purge') {
    const body = parseJSON(await readBody(req, 256 * 1024)) || {};
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
    const { purged, sdkSessionIds } = purgeWorkingState(userId, body.chatSessionIds);
    for (const sdk of sdkSessionIds) deleteSdkTranscripts(userId, sdk);
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
    const body = parseJSON(await readBody(req, 16 * 1024)) || {};
    const reason = body.reason === undefined ? 'user_delete' : body.reason;
    if (!SESSION_PURGE_REASONS.has(reason)) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: `reason must be one of ${[...SESSION_PURGE_REASONS].join(', ')}` } });
      return true;
    }
    if (typeof body.chatSessionId !== 'string' || !body.chatSessionId) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'chatSessionId is required' } });
      return true;
    }
    // Record the tombstone first (durable), then try to purge now. A failure
    // leaves the tombstone for the next replay.
    enqueueSessionPurge(userId, body.chatSessionId, reason);
    let purged = 'pending';
    try {
      purgeChat(userId, body.chatSessionId);
      completeSessionPurge(userId, body.chatSessionId);
      purged = 'done';
    } catch (err) {
      failSessionPurge(userId, body.chatSessionId);
      console.error(`[lifecycle] session purge failed for ${body.chatSessionId}:`, err?.message || err);
    }
    sendJSON(res, 202, { queued: true, purged });
    return true;
  }

  return false;
}
