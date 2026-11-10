// The hosted issue writer (Issues board creates, comments and closes), shared by the desktop route
// (routes/issue-writes.mjs) and the Sources -> Issue task (agents/tasks/issues-from-notes.mjs). The provider is called
// only through `callProvider`; the host comes from the fixed table below, never from a request. The idempotency
// map is the only module state (per process).
import { createHash } from "node:crypto";
import * as kb from "../kb/db.mjs";
import { makePinnedFetch } from "../server/pinned-fetch.mjs";


export const ISSUE_LIMITS = Object.freeze({ title: 255, body: 20_000, repo: 200 });
export const IDEM_TTL_MS = 10 * 60_000;
const IDEM_MAX = 500;
const API_BASE = Object.freeze({ github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' });
export const WEB_ORIGIN = Object.freeze({ github: 'https://github.com', gitlab: 'https://gitlab.com' });
export const NAME = Object.freeze({ github: 'GitHub', gitlab: 'GitLab' });
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
    return r.status === 200 ? { ...r, body: { ...r.body, deduped: true } } : r;
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
  return { ...r, body: { ...r.body, deduped: false } };
}

/** Test seam. */
export function _resetIssueWriteIdemForTests() { creates.clear(); }



export async function callProvider(w, token) {
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
    // `number` is the project-level issue number (GitHub number, GitLab iid): the link record needs it, the wire body never does.
    const number = Number.isSafeInteger(data?.number) ? data.number : Number.isSafeInteger(data?.iid) ? data.iid : null;
    return { status: 200, number, body: { ok: true, id: Number.isSafeInteger(data?.id) ? data.id : null, url, state: typeof data?.state === 'string' ? data.state : null } };
  } catch {
    return { status: 502, body: { error: { code: 'PROVIDER_UNREACHABLE', message: `${NAME[w.provider]} could not be reached. Check the connection and try again.` } } };
  }
}

/** A checked create with the provider token, through the same once-per-key path the route uses. */
export async function createIssue({ userId, provider, repo, title, body: text, idem, token }) {
  const w = parseIssueWrite("create", { provider, repo, title, body: text, idem });
  if (w.error) return { status: 400, body: w };
  return onceForIdem(userId, w, () => callProvider(w, token));
}

/** True when the repository is already on this user's Issues board (the only repositories a write may reach). */
export function repoOnBoard(userId, provider, repo) {
  return !!kb.findTicket(userId, { provider, repo, number: null, origin: WEB_ORIGIN[provider] });
}
