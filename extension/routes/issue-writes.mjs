// Hosted issue writes for the desktop Issues board and the Gantt row detail (feature gantt_issues, reached through
// issue-schedule.mjs): POST /kb/issues/create, /kb/issues/comment and /kb/issues/close. Nothing else is written: no
// edit, reopen, labels or arbitrary API path. Desktop only (bus host proof). The token comes from the vault
// (github.token / gitlab.token) and is never returned, logged or audited. Hosts are fixed (api.github.com, gitlab.com).
// A write reaches only an issue or repo already on the caller's board: an imported ticket row whose stored URL is on
// that provider's web host (kb.findTicket). Audit rows carry the action, repo/number and outcome, never the text.
import * as kb from '../kb/db.mjs';
import { authorizeAction, projectScopeRefusal } from '../server/route-authority.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { getSecret } from '../server/vault.mjs';
import { safeAudit, clientIp } from '../server/route-http.mjs';
import { NAME, WEB_ORIGIN, parseIssueWrite, parseIssueUpdate, updateIssue, callProvider, onceForIdem, recordCreatedIssue } from '../agents/issue-writer.mjs';

// The writer lives in agents/ (the Sources -> Issue task calls it too); these names keep their old import path.
export { ISSUE_LIMITS, IDEM_TTL_MS, parseIssueWrite, parseIssueUpdate, providerCall, mapProviderFailure, onceForIdem, _resetIssueWriteIdemForTests } from '../agents/issue-writer.mjs';
const fail = (res, status, code, message) => { sendJSON(res, status, { error: { code, message } }); return true; };

/** POST /kb/issues/{create,comment,close}. false for anything else (the caller keeps dispatching). */
export async function handleIssueWriteRoutes(req, res, { userId, url }) {
  const path = String(url || '').split('?')[0];
  const op = req.method === 'POST' && path === '/kb/issues/create' ? 'create'
    : req.method === 'POST' && path === '/kb/issues/comment' ? 'comment'
      : req.method === 'POST' && path === '/kb/issues/close' ? 'close'
      : req.method === 'POST' && path === '/kb/issues/update' ? 'update' : null;
  if (!op) return false;
  const audit = (outcome, resource, detail) => safeAudit(kb.getDb(), {
    userId, ip: clientIp(req), userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 200) || null,
    action: `issues.${op}`, resource, outcome, detail,
  });
  if (!verifyBusHostProof(req)) {
    audit('denied', null, { code: 'HOST_PROOF_REQUIRED' });
    return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  }
  let raw;
  try { raw = parseJSON(await readBody(req, 128 * 1024)); } catch { return fail(res, 400, 'VALIDATION_FAILED', 'Invalid JSON body'); }
  // R-021 #2: issue writes are project work; a hub requires a known project and its grant may only narrow.
  const projectId = typeof raw?.projectId === 'string' && raw.projectId ? raw.projectId : null;
  const scope = projectScopeRefusal(kb.getDb(), userId, projectId);
  if (scope) { sendJSON(res, scope.status, { error: { code: scope.code, message: scope.message } }); return true; }
  if (projectId) {
    const decision = authorizeAction(kb.getDb(), userId, 'external.write', { projectId, req });
    if (!decision.ok) { sendJSON(res, decision.status, { error: { code: decision.code, message: decision.message } }); return true; }
  }
  const w = op === 'update' ? parseIssueUpdate(raw) : parseIssueWrite(op, raw);
  if (w.error) { sendJSON(res, 400, w); return true; }
  const resource = `${w.provider}:${w.repo}${w.number ? `#${w.number}` : ''}`;
  const known = kb.findTicket(userId, { provider: w.provider, repo: w.repo, number: w.number ?? null, origin: WEB_ORIGIN[w.provider] });
  if (!known) {
    audit('denied', resource, { code: 'REPO_NOT_ALLOWED' });
    return fail(res, 403, 'REPO_NOT_ALLOWED', w.number
      ? 'This issue is not on your Issues board. Import its repository first.'
      : 'Only repositories on your Issues board can get new issues. Import this repository first.');
  }
  if (w.number && known.isPR) return fail(res, 400, 'NOT_AN_ISSUE', 'Pull requests and merge requests are not written from the Issues board.');
  const token = getSecret(kb.getDb(), userId, `${w.provider}.token`);
  if (!token) return fail(res, 400, `${w.provider.toUpperCase()}_TOKEN_MISSING`, `Add a ${NAME[w.provider]} token in Settings → Built-in keys first.`);
  const out = op === 'update' ? await updateIssue(w, token) : op === 'create' ? await onceForIdem(userId, w, () => callProvider(w, token)) : await callProvider(w, token);
  if (op === 'create') recordCreatedIssue(userId, w, out);
  if ((op === 'close' || (op === 'update' && w.state === 'closed')) && out.status === 200) kb.setTicketState(userId, { provider: w.provider, repo: w.repo, number: w.number, state: 'closed' });
  if (op === 'update' && w.state === 'open' && out.status === 200) kb.setTicketState(userId, { provider: w.provider, repo: w.repo, number: w.number, state: 'open' });
  audit(out.status === 200 ? 'success' : 'failure', resource, {
    status: out.status, code: out.body?.error?.code ?? null, ...(op === 'create' && out.status === 200 ? { deduped: out.body.deduped } : {}),
  });
  sendJSON(res, out.status, out.body);
  return true;
}

