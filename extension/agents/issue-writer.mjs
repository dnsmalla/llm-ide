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

/** Read one hosted issue with its comments (GitHub issue/comments, GitLab issue/notes) for the detail window. */
export async function readIssueDetail({ provider, repo, number, token }) {
  const gl = provider === 'gitlab';
  const issues = gl ? `${API_BASE.gitlab}/projects/${encodeURIComponent(repo)}/issues` : `${API_BASE.github}/repos/${repo}/issues`;
  const headers = gl
    ? { 'User-Agent': 'llm-ide-desktop', 'PRIVATE-TOKEN': token }
    : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'llm-ide-desktop', Authorization: `Bearer ${token}` };
  const fetchPinned = makePinnedFetch();
  try {
    const meta = gl
      ? [`${API_BASE.gitlab}/projects/${encodeURIComponent(repo)}/labels?per_page=100`, `${API_BASE.gitlab}/projects/${encodeURIComponent(repo)}/milestones?per_page=100`, `${API_BASE.gitlab}/projects/${encodeURIComponent(repo)}/members/all?per_page=100`]
      : [`${API_BASE.github}/repos/${repo}/labels?per_page=100`, `${API_BASE.github}/repos/${repo}/milestones?state=all&per_page=100`, `${API_BASE.github}/repos/${repo}/assignees?per_page=100`];
    const [issueRes, commentsRes, labelsRes, milestonesRes, peopleRes] = await Promise.all([
      fetchPinned(`${issues}/${number}`, { headers, signal: AbortSignal.timeout(15_000) }),
      fetchPinned(`${issues}/${number}/${gl ? 'notes' : 'comments'}?per_page=100`, { headers, signal: AbortSignal.timeout(15_000) }),
      fetchPinned(meta[0], { headers, signal: AbortSignal.timeout(15_000) }),
      fetchPinned(meta[1], { headers, signal: AbortSignal.timeout(15_000) }),
      fetchPinned(meta[2], { headers, signal: AbortSignal.timeout(15_000) }),
    ]);
    const issue = await issueRes.json().catch(() => ({}));
    const comments = await commentsRes.json().catch(() => []);
    const labelRows = await labelsRes.json().catch(() => []);
    const milestoneRows = await milestonesRes.json().catch(() => []);
    const peopleRows = await peopleRes.json().catch(() => []);
    if (!issueRes.ok) {
      const f = mapProviderFailure(provider, issueRes.status, issue);
      return { status: f.status, body: { error: { code: f.code, message: f.message } } };
    }
    const label = (x) => (typeof x === 'string' ? x : typeof x?.name === 'string' ? x.name : '');
    const person = (x) => (typeof x?.username === 'string' ? x.username : typeof x?.login === 'string' ? x.login : typeof x?.name === 'string' ? x.name : '');
    const body = {
      ok: true,
      issue: {
        state: issue.state === 'opened' ? 'open' : typeof issue.state === 'string' ? issue.state : null,
        title: typeof issue.title === 'string' ? issue.title : '',
        body: gl ? (typeof issue.description === 'string' ? issue.description : '') : (typeof issue.body === 'string' ? issue.body : ''),
        labels: Array.isArray(issue.labels) ? issue.labels.map(label).filter(Boolean) : [],
        milestone: issue.milestone && typeof issue.milestone === 'object'
          ? { title: typeof issue.milestone.title === 'string' ? issue.milestone.title : '', dueOn: typeof issue.milestone.due_date === 'string' ? issue.milestone.due_date : null, id: Number.isSafeInteger(issue.milestone.id) ? issue.milestone.id : null }
          : null,
        milestoneId: issue.milestone && Number.isSafeInteger(issue.milestone.id) ? issue.milestone.id : null,
        assignees: Array.isArray(issue.assignees) ? issue.assignees.map(person).filter(Boolean) : [],
        assigneeIds: Array.isArray(issue.assignees) ? issue.assignees.map((a) => Number.isSafeInteger(a?.id) ? a.id : null).filter((x) => x !== null) : [],
        dueDate: typeof issue.due_date === 'string' ? issue.due_date : null,
        author: person(issue.author) || person(issue.user) || null,
        createdAt: typeof issue.created_at === 'string' ? issue.created_at : null,
        updatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : null,
        webUrl: typeof issue.web_url === 'string' ? issue.web_url : typeof issue.html_url === 'string' ? issue.html_url : null,
      },
      choices: {
        labels: (Array.isArray(labelRows) ? labelRows : []).map(label).filter(Boolean).slice(0, 100),
        milestones: (Array.isArray(milestoneRows) ? milestoneRows : []).filter((m) => Number.isSafeInteger(m?.id) && typeof m?.title === 'string').map((m) => ({ id: m.id, title: m.title })).slice(0, 100),
        assignees: (Array.isArray(peopleRows) ? peopleRows : []).filter((a) => Number.isSafeInteger(a?.id)).map((a) => ({ id: a.id, name: person(a) })).filter((a) => a.name !== '').slice(0, 100),
      },
      comments: (Array.isArray(comments) ? comments : []).filter((c) => !c?.system).slice(0, 100).map((c) => ({
        id: Number.isSafeInteger(c?.id) ? c.id : null,
        author: person(c?.author) || person(c?.user) || 'unknown',
        body: typeof c?.body === 'string' ? c.body.slice(0, 20_000) : '',
        at: typeof c?.created_at === 'string' ? c.created_at : null,
      })),
    };
    return { status: 200, body };
  } catch {
    return { status: 502, body: { error: { code: 'PROVIDER_UNREACHABLE', message: `${NAME[provider]} could not be reached. Check the connection and try again.` } } };
  }
}

/** The checked issue edit. Every field is optional, but at least one must be present. */
export function parseIssueUpdate(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const provider = b.provider;
  if (provider !== 'github' && provider !== 'gitlab') return invalid('provider', 'provider must be github or gitlab');
  const repo = typeof b.repo === 'string' ? b.repo : '';
  if (repo.length > ISSUE_LIMITS.repo || !REPO_SHAPE[provider].test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) {
    return invalid('repo', provider === 'github' ? 'repo must be owner/name' : 'repo must be a GitLab project path');
  }
  const number = b.number;
  if (!Number.isSafeInteger(number) || number <= 0) return invalid('number', 'number must be a positive integer');
  const out = { provider, repo, number };
  let changed = false;
  if (b.title !== undefined) {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title || title.length > ISSUE_LIMITS.title) return invalid('title', `title must be 1 to ${ISSUE_LIMITS.title} characters`);
    out.title = title; changed = true;
  }
  if (b.body !== undefined) {
    if (typeof b.body !== 'string' || b.body.length > ISSUE_LIMITS.body) return invalid('body', `body must be text of at most ${ISSUE_LIMITS.body} characters`);
    out.body = b.body; changed = true;
  }
  if (b.state !== undefined) {
    if (b.state !== 'open' && b.state !== 'closed') return invalid('state', 'state must be open or closed');
    out.state = b.state; changed = true;
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.length > 50 || b.labels.some((l) => typeof l !== 'string' || l.length === 0 || l.length > 100)) return invalid('labels', 'labels must be up to 50 short names');
    out.labels = b.labels; changed = true;
  }
  if (b.milestoneId !== undefined) {
    if (b.milestoneId !== null && (!Number.isSafeInteger(b.milestoneId) || b.milestoneId <= 0)) return invalid('milestoneId', 'milestoneId must be a positive integer or null');
    out.milestoneId = b.milestoneId; changed = true;
  }
  if (b.assignees !== undefined || b.assigneeIds !== undefined) {
    if (b.assignees !== undefined && (!Array.isArray(b.assignees) || b.assignees.length > 20 || b.assignees.some((n) => typeof n !== 'string' || n.length === 0 || n.length > 100))) return invalid('assignees', 'assignees must be up to 20 names');
    if (b.assigneeIds !== undefined && (!Array.isArray(b.assigneeIds) || b.assigneeIds.length > 20 || b.assigneeIds.some((n) => !Number.isSafeInteger(n) || n <= 0))) return invalid('assigneeIds', 'assigneeIds must be positive integers');
    out.assignees = b.assignees ?? []; out.assigneeIds = b.assigneeIds ?? []; changed = true;
  }
  if (b.dueDate !== undefined) {
    if (b.dueDate !== null && (typeof b.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate))) return invalid('dueDate', 'dueDate must be YYYY-MM-DD or null');
    out.dueDate = b.dueDate; changed = true;
  }
  return changed ? out : invalid('body', 'nothing to update');
}

/** Update one hosted issue. GitLab takes ids for milestone/assignees; GitHub takes names for assignees. */
export async function updateIssue(w, token) {
  const gl = w.provider === 'gitlab';
  const base = gl ? `${API_BASE.gitlab}/projects/${encodeURIComponent(w.repo)}/issues` : `${API_BASE.github}/repos/${w.repo}/issues`;
  const payload = {};
  if (w.title !== undefined) payload.title = w.title;
  if (w.body !== undefined) { if (gl) payload.description = w.body; else payload.body = w.body; }
  if (w.state !== undefined) { if (gl) payload.state_event = w.state === 'closed' ? 'close' : 'reopen'; else payload.state = w.state; }
  if (w.labels !== undefined) payload.labels = gl ? w.labels.join(',') : w.labels;
  if (w.milestoneId !== undefined) { if (gl) payload.milestone_id = w.milestoneId; else payload.milestone = w.milestoneId; }
  if (w.assignees !== undefined || w.assigneeIds !== undefined) { if (gl) payload.assignee_ids = w.assigneeIds; else payload.assignees = w.assignees; }
  if (w.dueDate !== undefined && gl) payload.due_date = w.dueDate;
  const headers = gl
    ? { 'User-Agent': 'llm-ide-desktop', 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' }
    : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'llm-ide-desktop', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const r = await makePinnedFetch()(`${base}/${w.number}`, { method: gl ? 'PUT' : 'PATCH', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const f = mapProviderFailure(w.provider, r.status, data);
      return { status: f.status, body: { error: { code: f.code, message: f.message } } };
    }
    return { status: 200, body: { ok: true, state: typeof data.state === 'string' ? data.state : null, url: typeof data.web_url === 'string' ? data.web_url : typeof data.html_url === 'string' ? data.html_url : null } };
  } catch {
    return { status: 502, body: { error: { code: 'PROVIDER_UNREACHABLE', message: `${NAME[w.provider]} could not be reached. Check the connection and try again.` } } };
  }
}
