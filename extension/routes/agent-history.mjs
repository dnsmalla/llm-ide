// The agent-history routes (Stage 1c, plan section 3.1). Always on: the ledger
// serves budgets and agent_chat is always on, so no LLMIDE_FEATURES group owns
// these (plan Q5).
//
//   GET  /kb/storage                        the storage report (all groups)
//   GET  /kb/agent-history/settings         retention days (7..365)
//   PUT  /kb/agent-history/settings         { retentionDays }, clamped
//   POST /kb/agent-history/clear            { scope, beforeDays?, dryRun, previewId? }
//                                           dryRun returns the counts and a previewId;
//                                           a real clear needs the previewId of this
//                                           user, scope and cutoff, and refuses
//                                           (409 preview_stale) if the counts moved.
//   POST /kb/agent-history/compact          incremental compaction; 409 busy while a
//                                           chat turn or meeting-agent run is in flight
//
// Every route is scoped to the authenticated user (userId from the router).
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { getAgentDb } from '../kb/agent-db.mjs';
import {
  clearHistory, compact, getRetentionSettings, setRetentionDays,
} from '../kb/agent-store.mjs';
import { checkPreview, issuePreview, storageReport } from '../kb/agent-history-api.mjs';
import { anyChatTurnInFlight } from './agent-v2.mjs';
import { anyMeetingRunInFlight } from '../agents/meeting-agent.mjs';

const SCOPES = new Set(['raw', 'all']);
const MAX_BEFORE_DAYS = 3650;

function fail(res, status, code, message) {
  sendJSON(res, status, { error: { code, message } });
  return true;
}

function storeDown(res) {
  return fail(res, 503, 'AGENT_STORE_UNAVAILABLE', 'The agent history store is not available. Restart the server to reopen it.');
}

export async function handleAgentHistoryRoutes(req, res, { userId, url }) {
  const path = url.split('?')[0];
  if (req.method === 'GET' && path === '/kb/storage') {
    sendJSON(res, 200, storageReport(userId));
    return true;
  }
  if (req.method === 'GET' && path === '/kb/agent-history/settings') {
    sendJSON(res, 200, getRetentionSettings(userId, { db: getAgentDb() ?? undefined }));
    return true;
  }
  if (req.method === 'PUT' && path === '/kb/agent-history/settings') {
    const body = parseJSON(await readBody(req, 4 * 1024)) || {};
    if (!Number.isInteger(body.retentionDays)) {
      return fail(res, 400, 'VALIDATION_FAILED', 'retentionDays must be a whole number of days (7 to 365)');
    }
    if (!getAgentDb()) return storeDown(res);
    sendJSON(res, 200, setRetentionDays(userId, body.retentionDays));
    return true;
  }
  if (req.method === 'POST' && path === '/kb/agent-history/clear') {
    const body = parseJSON(await readBody(req, 4 * 1024)) || {};
    if (!SCOPES.has(body.scope)) return fail(res, 400, 'VALIDATION_FAILED', "scope must be 'raw' or 'all'");
    if (body.beforeDays != null && !(Number.isInteger(body.beforeDays) && body.beforeDays >= 0 && body.beforeDays <= MAX_BEFORE_DAYS)) {
      return fail(res, 400, 'VALIDATION_FAILED', `beforeDays must be a whole number from 0 to ${MAX_BEFORE_DAYS}`);
    }
    const scope = body.scope;
    const beforeDays = body.beforeDays ?? null;
    if (!getAgentDb()) return storeDown(res);
    if (body.dryRun !== false) {
      const preview = clearHistory(userId, { scope, beforeDays, dryRun: true });
      const signed = issuePreview(userId, { scope, beforeDays, counts: preview.wouldDelete });
      sendJSON(res, 200, { dryRun: true, scope, beforeDays, wouldDelete: preview.wouldDelete, total: preview.total, ...signed });
      return true;
    }
    if (typeof body.previewId !== 'string' || !body.previewId) {
      return fail(res, 400, 'PREVIEW_REQUIRED', 'A real clear needs the previewId from a dry run (dryRun: true) first');
    }
    // consume: a preview is single use, whatever the clear then answers.
    const checked = checkPreview(userId, body.previewId, { scope, beforeDays, consume: true });
    if (!checked.ok) {
      return fail(res, 400, checked.reason === 'expired' ? 'PREVIEW_EXPIRED' : 'PREVIEW_INVALID',
        checked.reason === 'expired' ? 'The preview expired; run a new dry run' : 'The previewId does not match this user, scope and cutoff');
    }
    const result = clearHistory(userId, { scope, beforeDays, dryRun: false, expectCounts: checked.counts });
    if (!result.ok) {
      return fail(res, 409, 'preview_stale', 'The history changed since the preview; run a new dry run');
    }
    sendJSON(res, 200, { dryRun: false, scope, beforeDays, deleted: result.deleted, total: result.total });
    return true;
  }
  if (req.method === 'POST' && path === '/kb/agent-history/compact') {
    if (!getAgentDb()) return storeDown(res);
    const result = await compact({ inFlight: () => anyChatTurnInFlight() || anyMeetingRunInFlight() });
    if (result.ok) {
      sendJSON(res, 200, { ok: true, mode: result.mode, pagesFreed: result.pagesFreed, bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter, ms: result.ms });
      return true;
    }
    if (result.reason === 'busy') return fail(res, 409, 'busy', 'A chat turn or meeting-agent run is in flight; compact later');
    if (result.reason === 'disk_space') return fail(res, 507, 'disk_space', 'Not enough free disk space to compact the agent history');
    if (result.reason === 'unavailable') return storeDown(res);
    return fail(res, 500, 'INTERNAL_ERROR', 'Compaction failed');
  }
  return false;
}

