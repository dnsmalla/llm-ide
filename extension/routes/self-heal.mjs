// Self-Heal routes (plan A: docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md; plan B, the fix runs:
// docs/superpowers/plans/2026-11-07-self-heal-b-fix-loop.md; contract schema/http/self-heal.schema.json).
// server.mjs imports this module only while config.selfHeal is on (LLMIDE_SELF_HEAL=1, which the Tauri host passes
// only in a debug build). Otherwise every path answers 404 feature_disabled before this module loads. Every route
// needs the JWT AND the bus host proof, so only the desktop UI of the core the host spawned reaches the store.
// Nothing here logs incident text.
//
//   GET    /kb/self-heal/incidents              { incidents }          the user's incidents, newest first
//   POST   /kb/self-heal/incidents              { recorded, skipped }  record 1-50 reports (an unusable one, or one an
//                                                                       open fix run produced, is skipped)
//   POST   /kb/self-heal/incidents/:id/ignore   { ignored }            mark one ignored (not while fixing or proposed)
//   DELETE /kb/self-heal/incidents              { deleted }            remove all but fixing / proposed
//   POST   /kb/self-heal/runs                   { runId, incidentIds, batch }  start the user's one fix run
//   POST   /kb/self-heal/runs/:id/outcome       { proposed }           the run's result; ends it
//   POST   /kb/self-heal/runs/:id/resolve       { updated }            the user applied or discarded its proposal
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { send, readJson } from '../server/route-http.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { BATCH_MAX, parseResults, renderBatch } from '../core/self-heal-batch.mjs';
import { buildTrustedRoots } from '../llm_agent/tools/handlers/repo-files.mjs';
import {
  applyRunOutcome, clearIncidents, ignoreIncident, listIncidents, recordIncident, reopenIncidents, resolveProposal, triageIncidents,
} from '../kb/incidents.mjs';

export const MAX_BATCH = 50;
export const DEFAULT_PER_RUN = 5;
export const MAX_PER_RUN = 20;
/** A run that never posts its outcome (the page reloaded, the app quit) frees itself after this (the Mac's 4 h window). */
export const RUN_LEASE_MS = 4 * 60 * 60 * 1000;
const BODY_MAX = 4 * 1024 * 1024;
const IGNORE_RE = /^\/kb\/self-heal\/incidents\/([0-9a-f]{16})\/ignore$/;
const RUN_RE = /^\/kb\/self-heal\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(outcome|resolve)$/;
const FLAGS = ['verifyPassed', 'hasChanges', 'agentDown', 'aborted'];
const PROPOSAL_KEYS = ['mainRepo', 'worktreePath', 'branch', 'baseCommit'];
const fail = (res, status, code, message, details) => {
  send(res, status, { error: { code, message, ...(details ? { details } : {}) } });
  return true;
};
const samePath = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());

// userId → { runId, ids, startedAt }. In memory on purpose: a core restart ends every run, and the boot step
// reopenOrphanedIncidents puts their `fixing` incidents back to `new`.
const runs = new Map();

/** The user's open fix run, or null. A run past its lease is dropped here and its incidents go back to `new`. */
export function activeRun(userId, now = Date.now()) {
  const r = runs.get(userId);
  if (!r) return null;
  if (now - r.startedAt < RUN_LEASE_MS) return r;
  runs.delete(userId);
  reopenIncidents(userId, r.ids);
  return null;
}

// What a fix run itself produces (the Mac's SuppressionScope.selfHealRun): the core's own log and server errors. A
// crash or a Chat or Loop error cannot come from this run (it is not a Loop run) and is still recorded.
export const suppressedDuringRun = (report) => report?.source === 'log' || report?.source === 'server';

/** The outcome body, validated; null when anything is malformed. The proposal branch must be this run's. */
function readOutcome(body, runId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (FLAGS.some((k) => body[k] !== undefined && typeof body[k] !== 'boolean')) return null;
  if (body.batch != null && (typeof body.batch !== 'string' || body.batch.length > BATCH_MAX)) return null;
  let proposal = null;
  if (body.proposal != null) {
    const p = body.proposal;
    if (typeof p !== 'object' || PROPOSAL_KEYS.some((k) => typeof p[k] !== 'string' || !p[k] || p[k].length > 1024)) return null;
    if (p.branch !== `self-heal/${runId}` || !/^[0-9a-f]{40,64}$/.test(p.baseCommit)) return null;
    proposal = { mainRepo: p.mainRepo, worktreePath: p.worktreePath, branch: p.branch, baseCommit: p.baseCommit };
  }
  return {
    batch: body.batch ?? '',
    flags: { verifyPassed: body.verifyPassed === true, hasChanges: body.hasChanges === true, agentDown: body.agentDown === true, aborted: body.aborted === true },
    proposal,
  };
}

export async function handleSelfHealRoute(req, res, { env = process.env } = {}) {
  const path = String(req.url || '').split('?')[0];
  if (!verifyBusHostProof(req, env)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const userId = req.user?.id;
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');
  const json = async () => {
    try { return await readJson(req, BODY_MAX); } catch { return undefined; }
  };

  if (req.method === 'GET' && path === '/kb/self-heal/incidents') {
    send(res, 200, { incidents: listIncidents(userId) });
    return true;
  }
  if (req.method === 'POST' && path === '/kb/self-heal/incidents') {
    const body = await json();
    if (body === undefined) return fail(res, 400, 'VALIDATION_FAILED', 'Body must be valid JSON');
    const list = body?.incidents;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) {
      return fail(res, 400, 'VALIDATION_FAILED', `incidents must be an array of 1 to ${MAX_BATCH} reports`);
    }
    const open = activeRun(userId) !== null;
    let recorded = 0;
    for (const item of list) if (!(open && suppressedDuringRun(item)) && recordIncident(userId, item)) recorded += 1;
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

  if (req.method === 'POST' && path === '/kb/self-heal/runs') {
    const body = await json();
    const repoRoot = body?.repoRoot;
    if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || repoRoot.length > 4096) {
      return fail(res, 400, 'VALIDATION_FAILED', 'repoRoot must be an absolute path');
    }
    const max = body.max == null ? DEFAULT_PER_RUN : body.max;
    if (!Number.isInteger(max) || max < 1 || max > MAX_PER_RUN) {
      return fail(res, 400, 'VALIDATION_FAILED', `max must be an integer from 1 to ${MAX_PER_RUN}`);
    }
    const open = activeRun(userId);
    if (open) return fail(res, 409, 'RUN_ACTIVE', 'A Self-Heal run is already in progress', { runId: open.runId });
    // The Loop agent accepts a worktree only of an allow-listed repo: refuse before the host makes one.
    let real = null;
    try { real = realpathSync(repoRoot); } catch { /* refused below */ }
    if (!real || !buildTrustedRoots(userId).some((t) => samePath(t, real))) {
      return fail(res, 409, 'REPO_NOT_ALLOWED', 'Add the source checkout under Settings → Repositories first');
    }
    const picked = triageIncidents(userId, max);
    if (picked.length === 0) {
      send(res, 200, { runId: null, incidentIds: [], batch: null });
      return true;
    }
    const runId = randomUUID();
    const ids = picked.map((i) => i.id);
    runs.set(userId, { runId, ids, startedAt: Date.now() });
    send(res, 200, { runId, incidentIds: ids, batch: renderBatch(picked) });
    return true;
  }
  const run = req.method === 'POST' ? RUN_RE.exec(path) : null;
  if (run) {
    const [, runId, action] = run;
    const body = await json();
    if (action === 'outcome') {
      const open = runs.get(userId);
      if (!open || open.runId !== runId) return fail(res, 409, 'RUN_NOT_ACTIVE', 'That Self-Heal run is not in progress');
      const o = readOutcome(body, runId);
      if (!o) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid outcome');
      runs.delete(userId);
      const runSucceeded = o.flags.verifyPassed && o.flags.hasChanges && o.proposal !== null;
      const proposed = applyRunOutcome(userId, open.ids, parseResults(o.batch), { runSucceeded, agentDown: o.flags.agentDown, aborted: o.flags.aborted }, o.proposal);
      send(res, 200, { proposed });
      return true;
    }
    if (body?.result !== 'applied' && body?.result !== 'discarded') {
      return fail(res, 400, 'VALIDATION_FAILED', 'result must be applied or discarded');
    }
    send(res, 200, { updated: resolveProposal(userId, `self-heal/${runId}`, body.result === 'applied') });
    return true;
  }
  return fail(res, 404, 'NOT_FOUND', 'Unknown Self-Heal route');
}
