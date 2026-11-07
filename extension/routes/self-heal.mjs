// Self-Heal incident routes (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md; contract
// schema/http/self-heal.schema.json). server.mjs imports this module only while config.selfHeal is on
// (LLMIDE_SELF_HEAL=1, which the Tauri host passes only in a debug build). Otherwise every path answers
// 404 feature_disabled before this module loads. Every route needs the JWT AND the bus host proof, so only the desktop
// UI of the core the host spawned reaches the store. Nothing here logs incident text.
//
//   GET    /kb/self-heal/incidents              { incidents }          the user's incidents, newest first
//   POST   /kb/self-heal/incidents              { recorded, skipped }  record 1-50 reports (an unusable one is skipped)
//   POST   /kb/self-heal/incidents/:id/ignore   { ignored }            mark one ignored (not while fixing or proposed)
//   DELETE /kb/self-heal/incidents              { deleted }            remove all but fixing / proposed
import { send, readJson } from '../server/route-http.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { clearIncidents, ignoreIncident, listIncidents, recordIncident } from '../kb/incidents.mjs';

export const MAX_BATCH = 50;
const BODY_MAX = 4 * 1024 * 1024;
const IGNORE_RE = /^\/kb\/self-heal\/incidents\/([0-9a-f]{16})\/ignore$/;
const fail = (res, status, code, message) => { send(res, status, { error: { code, message } }); return true; };

export async function handleSelfHealRoute(req, res, { env = process.env } = {}) {
  const path = String(req.url || '').split('?')[0];
  if (!verifyBusHostProof(req, env)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const userId = req.user?.id;
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');

  if (req.method === 'GET' && path === '/kb/self-heal/incidents') {
    send(res, 200, { incidents: listIncidents(userId) });
    return true;
  }
  if (req.method === 'POST' && path === '/kb/self-heal/incidents') {
    let body;
    try { body = await readJson(req, BODY_MAX); } catch { return fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON'); }
    const list = body?.incidents;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) {
      return fail(res, 400, 'VALIDATION_FAILED', `incidents must be an array of 1 to ${MAX_BATCH} reports`);
    }
    let recorded = 0;
    for (const item of list) if (recordIncident(userId, item)) recorded += 1;
    send(res, 200, { recorded, skipped: list.length - recorded });
    return true;
  }
  const ignore = req.method === 'POST' ? IGNORE_RE.exec(path) : null;
  if (ignore) {
    send(res, 200, { ignored: ignoreIncident(userId, ignore[1]) });
    return true;
  }
  if (req.method === 'DELETE' && path === '/kb/self-heal/incidents') {
    send(res, 200, { deleted: clearIncidents(userId) });
    return true;
  }
  return fail(res, 404, 'NOT_FOUND', 'Unknown Self-Heal route');
}
