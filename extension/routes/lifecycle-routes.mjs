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
import { deleteSdkTranscripts, sdkTranscriptMtimeMs } from '../llm_agent/sdk/transcripts.mjs';
import { isChatTurnInFlight } from './agent-v2.mjs';

// Indirection so a test can make a chat "busy" without running a model turn.
let busyCheck = isChatTurnInFlight;
/** Test seam: replace (or, with no argument, restore) the in-flight-turn check. */
export function setBusyCheckForTesting(fn) { busyCheck = fn ?? isChatTurnInFlight; }
const isBusyNow = (userId, id) => busyCheck(userId, id);
import { deleteChatSession } from '../kb/chat-sessions.mjs';
import {
  listWorkingState, purgeWorkingState, enqueueSessionPurge, listSessionPurges,
  completeSessionPurge, failSessionPurge, sessionPurgeStatus, sdkIdsForChats,
  SESSION_PURGE_REASONS, MAX_PURGE_IDS, hasArchiveReceipt, recordMacArchiveReceipt, receiptIsStale,
} from '../kb/chat-lifecycle.mjs';

/**
 * Purge one chat in the documented order. `deleteTranscripts` is injectable so
 * the tests can make the file step fail (the replay is exercised against that).
 */
export function purgeChat(userId, chatSessionId, { deleteTranscripts = deleteSdkTranscripts, sdkIds = null, isBusy = isBusyNow } = {}) {
  // A turn running on this chat owns its SDK transcript and mapping: never purge under it. Checked here, in
  // the one place every purge path goes through, with nothing awaited between the check and the removal.
  if (isBusy(userId, chatSessionId)) return { purged: 0, transcripts: 0, busy: true };
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
export function replaySessionPurges(userId, { now = Date.now(), deleteTranscripts = deleteSdkTranscripts, isBusy = isBusyNow, transcriptMtime = sdkTranscriptMtimeMs } = {}) {
  const out = { done: 0, pending: 0, failed: 0, skippedReused: 0, notDue: 0, busy: 0 };
  for (const due of listSessionPurges(userId)) {
    if (due.state === 'failed') { out.failed += 1; continue; }
    if (Date.parse(due.dueAt) > now) { out.notDue += 1; continue; }
    if (tombstoneChatWasReused(due, transcriptMtime, userId)) {
      completeSessionPurge(userId, due.chatSessionId);
      out.skippedReused += 1;
      continue;
    }
    try {
      const r = purgeChat(userId, due.chatSessionId, { deleteTranscripts, sdkIds: due.sdkSessionIds, isBusy });
      if (r.busy) { out.busy += 1; continue; }      // a turn is running: not an attempt, not a failure; retried later
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

/**
 * DL16: was the chat used after the delete was requested? Looks at the mapping, chat rows and facts
 * (`lastActivityMs`) AND at the transcript files of the SDK ids the tombstone captured, so the guard still
 * works once the mapping itself is gone.
 */
export function tombstoneChatWasReused(due, transcriptMtime, userId) {
  if (due.lastActivityMs > due.requestedMs) return true;
  for (const sdk of due.sdkSessionIds ?? []) {
    if (transcriptMtime(userId, sdk) > due.requestedMs) return true;
  }
  return false;
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
    // A chat with a turn running, or whose receipt is older than the chat's last use, is NOT purged and is
    // reported: the caller treats both as "retry later", never as success.
    let purged = 0;
    const busy = [];
    const staleReceipt = [];
    for (const id of body.chatSessionIds) {
      if (isBusyNow(userId, id)) { busy.push(id); continue; }
      if (receiptIsStale(userId, id)) { staleReceipt.push(id); continue; }
      const r = purgeChat(userId, id);
      if (r.busy) { busy.push(id); continue; }
      purged += r.purged;
    }
    sendJSON(res, 200, { purged, busy, staleReceipt });
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
    // The tombstone (with the SDK ids) is durable before anything is removed. `requestedAt` is the user's delete
    // time (the Mac keeps it across retries); the earliest time wins, so the reuse guard stays meaningful.
    let askedAt = null;
    if (typeof body.requestedAt === 'string') {
      const t = Date.parse(body.requestedAt);
      if (Number.isFinite(t) && t <= Date.now() + 60_000 && t >= Date.now() - 365 * 86_400_000) askedAt = new Date(t).toISOString();
    }
    enqueueSessionPurge(userId, body.chatSessionId, reason, { requestedAt: askedAt });
    let purged;
    let busy = false;
    try {
      const tomb = listSessionPurges(userId).find((p) => p.chatSessionId === body.chatSessionId);
      if (tomb && tombstoneChatWasReused(tomb, sdkTranscriptMtimeMs, userId)) {
        // Used again after the delete was requested: keep it, drop the tombstone (DL16).
        completeSessionPurge(userId, body.chatSessionId);
        sendJSON(res, 202, { queued: true, purged: 'done', skippedReused: true });
        return true;
      }
      const r = purgeChat(userId, body.chatSessionId, { sdkIds: tomb?.sdkSessionIds ?? null });
      if (r.busy) {
        busy = true;
        purged = 'pending';                       // a turn is running: the tombstone stays, retried later
      } else {
        completeSessionPurge(userId, body.chatSessionId);
        purged = 'done';
      }
    } catch (err) {
      const r = failSessionPurge(userId, body.chatSessionId);
      purged = r?.state === 'failed' ? 'failed' : 'pending';
      console.error(`[lifecycle] session purge failed for ${body.chatSessionId}:`, err?.message || err);
    }
    sendJSON(res, 202, busy ? { queued: true, purged, busy: true } : { queued: true, purged });
    return true;
  }

  return false;
}
