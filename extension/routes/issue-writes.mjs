// Hosted issue writes for the desktop Issues board and the Gantt row detail (feature gantt_issues, reached through
// issue-schedule.mjs): POST /kb/issues/create, /kb/issues/comment and /kb/issues/close. Nothing else is written: no
// edit, reopen, labels or arbitrary API path. Desktop only (bus host proof). The token comes from the vault
// (github.token / gitlab.token) and is never returned, logged or audited. Hosts are fixed (api.github.com, gitlab.com).
// A write reaches only an issue or repo already on the caller's board: an imported ticket row whose stored URL is on
// that provider's web host (kb.findTicket). Audit rows carry the action, repo/number and outcome, never the text.
import { createHash } from 'node:crypto';

export const ISSUE_LIMITS = Object.freeze({ title: 255, body: 20_000, repo: 200 });
export const IDEM_TTL_MS = 10 * 60_000;
const IDEM_MAX = 500;
const API_BASE = Object.freeze({ github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' });
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
  const said = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : '';
  const message = (said || `${NAME[provider]} answered ${status}.`).slice(0, 300);
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
