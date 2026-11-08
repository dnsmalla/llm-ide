// Hosted issue writes for the desktop Issues board and the Gantt row detail (feature gantt_issues, reached through
// issue-schedule.mjs): POST /kb/issues/create, /kb/issues/comment and /kb/issues/close. Nothing else is written: no
// edit, reopen, labels or arbitrary API path. Desktop only (bus host proof). The token comes from the vault
// (github.token / gitlab.token) and is never returned, logged or audited. Hosts are fixed (api.github.com, gitlab.com).
// A write reaches only an issue or repo already on the caller's board: an imported ticket row whose stored URL is on
// that provider's web host (kb.findTicket). Audit rows carry the action, repo/number and outcome, never the text.
import { createHash } from 'node:crypto';
import * as kb from '../kb/db.mjs';
import { authorizeAction, projectScopeRefusal } from '../server/route-authority.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { getSecret } from '../server/vault.mjs';
import { makePinnedFetch } from '../server/pinned-fetch.mjs';
import { safeAudit, clientIp } from '../server/route-http.mjs';

export const ISSUE_LIMITS = Object.freeze({ title: 255, body: 20_000, repo: 200 });
export const IDEM_TTL_MS = 10 * 60_000;
const IDEM_MAX = 500;
const API_BASE = Object.freeze({ github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' });
const WEB_ORIGIN = Object.freeze({ github: 'https://github.com', gitlab: 'https://gitlab.com' });
const NAME = Object.freeze({ github: 'GitHub', gitlab: 'GitLab' });
const REPO_SHAPE = Object.freeze({
  github: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  gitlab: /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19}$/,
});
const IDEM_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

const invalid = (field, message) => ({ error: { code: 'VALIDATION_FAILED', message, details: { field } } });

/** The checked write for `op`, or a 400 envelope naming the field. Pure; a value over a limit is refused, not cut. */
export function parseIssueWrite(op, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const provider = b.provider;
  if (provider !== 'github' && provider !== 'gitlab') return invalid('provider', 'provider must be github or gitlab');
  const repo = typeof b.repo === 'string' ? b.repo : '';
  if (repo.length > ISSUE_LIMITS.repo || !REPO_SHAPE[provider].test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) {
    return invalid('repo', provider === 'github' ? 'repo must be owner/name' : 'repo must be a GitLab project path');
  }
  if (op === 'create') {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) return invalid('title', 'title is required');
    if (title.length > ISSUE_LIMITS.title) return invalid('title', `title is longer than ${ISSUE_LIMITS.title} characters`);
    const text = b.body === undefined ? '' : b.body;
    if (typeof text !== 'string' || text.length > ISSUE_LIMITS.body) return invalid('body', `body must be text of at most ${ISSUE_LIMITS.body} characters`);
    if (typeof b.idem !== 'string' || !IDEM_SHAPE.test(b.idem)) return invalid('idem', 'idem must be 16 to 64 letters, digits, _ or -');
    return { op, provider, repo, title, body: text, idem: b.idem };
  }
  const number = b.number;
  if (!Number.isSafeInteger(number) || number <= 0) return invalid('number', 'number must be a positive integer');
  if (op === 'comment') {
    const text = typeof b.body === 'string' ? b.body : '';
    if (!text.trim()) return invalid('body', 'body is required');
    if (text.length > ISSUE_LIMITS.body) return invalid('body', `body must be text of at most ${ISSUE_LIMITS.body} characters`);
    return { op, provider, repo, number, body: text };
  }
  return { op, provider, repo, number };
}

/** The one provider call for a checked write. Pure; the host never comes from the request. */
export function providerCall(w) {
  const gl = w.provider === 'gitlab';
  const issues = gl ? `${API_BASE.gitlab}/projects/${encodeURIComponent(w.repo)}/issues` : `${API_BASE.github}/repos/${w.repo}/issues`;
  if (w.op === 'create') return { url: issues, method: 'POST', payload: gl ? { title: w.title, description: w.body } : { title: w.title, body: w.body } };
  if (w.op === 'comment') return { url: `${issues}/${w.number}/${gl ? 'notes' : 'comments'}`, method: 'POST', payload: { body: w.body } };
  return { url: `${issues}/${w.number}`, method: gl ? 'PUT' : 'PATCH', payload: gl ? { state_event: 'close' } : { state: 'closed' } };
}

/** A provider refusal as the client sees it. Never 401: the desktop treats any 401 as its own expired session. */
export function mapProviderFailure(provider, status, data) {
  // Fixed text only: the provider's own wording never reaches the client (data is not read here).
  void data;
  const message = `${NAME[provider]} answered ${status}.`;
  if (status === 401) return { status: 403, code: 'TOKEN_UNAUTHORIZED', message };
  if (status === 403 || status === 404) return { status: 403, code: 'TOKEN_FORBIDDEN', message };
  if (status === 400 || status === 422) return { status: 400, code: 'PROVIDER_REJECTED', message };
  return { status: 502, code: 'PROVIDER_ERROR', message };
}

const creates = new Map(); // `${userId}\0${idem}` -> { at, fp, result: Promise<{ status, body }> }

/** Runs `run` once per (user, idem) for IDEM_TTL_MS: the same content waits for and replays the first answer
 *  (deduped: true), other content is 409 IDEM_CONFLICT, and a failed attempt frees the key. `run` must not reject. */
export async function onceForIdem(userId, w, run, now = Date.now()) {
  for (const [k, v] of creates) if (now - v.at > IDEM_TTL_MS) creates.delete(k);
  const key = `${userId}\0${w.idem}`;
  const fp = createHash('sha256').update(JSON.stringify([w.provider, w.repo, w.title, w.body])).digest('hex');
  const prev = creates.get(key);
  if (prev) {
    if (prev.fp !== fp) return { status: 409, body: { error: { code: 'IDEM_CONFLICT', message: 'This request key was already used for a different issue.' } } };
    const r = await prev.result;
    return r.status === 200 ? { status: 200, body: { ...r.body, deduped: true } } : r;
  }
  // shortcut: in memory and capped at IDEM_MAX, so a core restart or a flood forgets keys (one duplicate at worst); persist if that matters.
  if (creates.size >= IDEM_MAX) creates.delete(creates.keys().next().value);
  const result = run();
  creates.set(key, { at: now, fp, result });
  const r = await result;
  if (r.status !== 200) {
    if (creates.get(key)?.result === result) creates.delete(key);
    return r;
  }
  return { status: 200, body: { ...r.body, deduped: false } };
}

/** Test seam. */
export function _resetIssueWriteIdemForTests() { creates.clear(); }

const fail = (res, status, code, message) => { sendJSON(res, status, { error: { code, message } }); return true; };

async function callProvider(w, token) {
  const call = providerCall(w);
  const headers = w.provider === 'gitlab'
    ? { 'User-Agent': 'llm-ide-desktop', 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' }
    : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'llm-ide-desktop', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const r = await makePinnedFetch()(call.url, { method: call.method, headers, body: JSON.stringify(call.payload), signal: AbortSignal.timeout(15_000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const f = mapProviderFailure(w.provider, r.status, data);
      return { status: f.status, body: { error: { code: f.code, message: f.message } } };
    }
    const url = typeof data?.web_url === 'string' ? data.web_url : typeof data?.html_url === 'string' ? data.html_url : null;
    return { status: 200, body: { ok: true, id: Number.isSafeInteger(data?.id) ? data.id : null, url, state: typeof data?.state === 'string' ? data.state : null } };
  } catch {
    return { status: 502, body: { error: { code: 'PROVIDER_UNREACHABLE', message: `${NAME[w.provider]} could not be reached. Check the connection and try again.` } } };
  }
}

/** POST /kb/issues/{create,comment,close}. false for anything else (the caller keeps dispatching). */
export async function handleIssueWriteRoutes(req, res, { userId, url }) {
  const path = String(url || '').split('?')[0];
  const op = req.method === 'POST' && path === '/kb/issues/create' ? 'create'
    : req.method === 'POST' && path === '/kb/issues/comment' ? 'comment'
      : req.method === 'POST' && path === '/kb/issues/close' ? 'close' : null;
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
  const w = parseIssueWrite(op, raw);
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
  const out = op === 'create' ? await onceForIdem(userId, w, () => callProvider(w, token)) : await callProvider(w, token);
  if (op === 'close' && out.status === 200) kb.setTicketState(userId, { provider: w.provider, repo: w.repo, number: w.number, state: 'closed' });
  audit(out.status === 200 ? 'success' : 'failure', resource, {
    status: out.status, code: out.body?.error?.code ?? null, ...(op === 'create' && out.status === 200 ? { deduped: out.body.deduped } : {}),
  });
  sendJSON(res, out.status, out.body);
  return true;
}
