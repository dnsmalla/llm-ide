// Factory PR/MR status for the Factory board: PR/MR state, CI and new comments, read on demand
// from GitHub (api.github.com) and gitlab.com. Not part of outcome-watcher: factory PRs/MRs are not
// rows in the outcomes table, and the board polls only while it is visible.
//
// Hosts are fixed. The PR/MR URL only supplies owner/repo/number (or project/iid), and both parsers
// are anchored to the web origin. Redirects are refused (makeTrackerFetch default). A failure rejects
// with a ShipStatusError whose `code` is the only thing the route returns, so no provider text and no
// token reaches the client. Comment bodies and check names are untrusted data: callers fence them.
import { makeTrackerFetch } from '../server/tracker-fetch.mjs';
import { parseGithubUrl } from './outcome-providers.mjs';

export const MAX_SHIP_STATUS_REQUESTS = 20;
export const MAX_COMMENTS = 20;
export const MAX_COMMENT_CHARS = 4_000;
const MAX_SUMMARY_NAMES = 10;
const MAX_SUMMARY_CHARS = 500;
const TIMEOUT_MS = 15_000;
const GITHUB_API = 'https://api.github.com';
const GITLAB_API = 'https://gitlab.com/api/v4';
const SHA_RE = /^[0-9a-f]{40}$/;
// Same project-path shape as routes/issue-writes.mjs REPO_SHAPE.gitlab (2 to 20 segments).
const GITLAB_MR_RE = /^https?:\/\/gitlab\.com\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19})\/-\/merge_requests\/(\d+)(?:[/?#]|$)/;
const GH_FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
const GL_PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual']);
const GL_FAILED = new Set(['failed', 'canceled']);

/** A status failure. `code` is one of provider_error | unauthorized | unsupported_url. */
export class ShipStatusError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ShipStatusError';
    this.code = code;
  }
}

const isDotSegment = (s) => s === '.' || s === '..';

/**
 * The gitlab.com project path and MR iid of a merge request URL, or null.
 * Only https?://gitlab.com/<2-20 segments>/-/merge_requests/<iid> is accepted.
 */
export function parseGitlabMrUrl(url) {
  const m = GITLAB_MR_RE.exec(String(url ?? ''));
  if (!m) return null;
  if (m[1].split('/').some(isDotSegment)) return null;
  const iid = Number(m[2]);
  return Number.isSafeInteger(iid) && iid > 0 ? { project: m[1], iid } : null;
}

async function getJson(fetchFn, url, headers) {
  let r;
  try {
    r = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ShipStatusError('provider_error');
  }
  if (r.status === 401 || r.status === 403) throw new ShipStatusError('unauthorized');
  if (!r.ok) throw new ShipStatusError('provider_error');
  try {
    return await r.json();
  } catch {
    throw new ShipStatusError('provider_error');
  }
}

/** Comments created after `since` (all when since is null), oldest first, the newest MAX_COMMENTS, bodies capped. */
function newComments(rows, since) {
  const parsed = Date.parse(since ?? '');
  const after = Number.isFinite(parsed) ? parsed : -Infinity;
  return rows
    .filter((c) => typeof c.body === 'string' && Date.parse(c.at) > after)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_COMMENTS)
    .map((c) => ({ author: c.author, body: c.body.slice(0, MAX_COMMENT_CHARS), at: c.at }));
}

const summary = (prefix, names) => `${prefix}: ${names.slice(0, MAX_SUMMARY_NAMES).join(', ') || 'unnamed'}`.slice(0, MAX_SUMMARY_CHARS);
const asArray = (v) => (Array.isArray(v) ? v : []);

function githubCi(checks, status) {
  const runs = asArray(checks?.check_runs);
  const statuses = asArray(status?.statuses);
  const failedRuns = runs.filter((c) => c?.status === 'completed' && GH_FAILED.has(c.conclusion));
  const failedStatuses = statuses.filter((s) => s?.state === 'failure' || s?.state === 'error');
  if (failedRuns.length + failedStatuses.length > 0) {
    const names = [...failedRuns.map((c) => c.name), ...failedStatuses.map((s) => s.context)]
      .filter((n) => typeof n === 'string' && n);
    return { ci: 'failed', ciSummary: summary('Failed checks', names) };
  }
  if (runs.some((c) => c?.status !== 'completed') || statuses.some((s) => s?.state === 'pending')) {
    return { ci: 'pending', ciSummary: null };
  }
  if (runs.length + statuses.length > 0) return { ci: 'success', ciSummary: null };
  return { ci: 'none', ciSummary: null };
}

async function pollGithubPr(pr, since, token) {
  const fetchFn = makeTrackerFetch({ secret: token });
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'llm-ide-extension' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}`;
  const data = await getJson(fetchFn, `${base}/pulls/${pr.number}`, headers);
  const state = data?.merged === true ? 'merged' : data?.state === 'closed' ? 'closed' : 'open';
  // The sha goes into a URL path: only a plain 40-hex sha is used.
  const sha = typeof data?.head?.sha === 'string' && SHA_RE.test(data.head.sha) ? data.head.sha : null;
  const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : '';
  const [checks, status, issueComments, reviewComments] = await Promise.all([
    sha ? getJson(fetchFn, `${base}/commits/${sha}/check-runs?per_page=100`, headers) : null,
    sha ? getJson(fetchFn, `${base}/commits/${sha}/status`, headers) : null,
    getJson(fetchFn, `${base}/issues/${pr.number}/comments?per_page=100${sinceQuery}`, headers),
    getJson(fetchFn, `${base}/pulls/${pr.number}/comments?per_page=100${sinceQuery}`, headers),
  ]);
  const rows = [...asArray(issueComments), ...asArray(reviewComments)].map((c) => ({
    author: typeof c?.user?.login === 'string' ? c.user.login : '',
    body: c?.body,
    at: c?.created_at,
  }));
  return { state, ...githubCi(checks, status), comments: newComments(rows, since) };
}

async function pollGitlabMr(mr, since, token) {
  const fetchFn = makeTrackerFetch({ secret: token });
  const headers = { 'User-Agent': 'llm-ide-extension' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const base = `${GITLAB_API}/projects/${encodeURIComponent(mr.project)}`;
  const [data, notes] = await Promise.all([
    getJson(fetchFn, `${base}/merge_requests/${mr.iid}`, headers),
    getJson(fetchFn, `${base}/merge_requests/${mr.iid}/notes?sort=desc&order_by=created_at&per_page=100`, headers),
  ]);
  const state = data?.state === 'merged' ? 'merged' : data?.state === 'closed' ? 'closed' : 'open';
  const pipeline = data?.head_pipeline;
  const pipelineStatus = typeof pipeline?.status === 'string' ? pipeline.status : null;
  let ci = 'none';
  let ciSummary = null;
  if (pipelineStatus === 'success') ci = 'success';
  else if (GL_PENDING.has(pipelineStatus)) ci = 'pending';
  else if (GL_FAILED.has(pipelineStatus)) {
    ci = 'failed';
    const jobs = Number.isSafeInteger(pipeline.id)
      ? await getJson(fetchFn, `${base}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=100`, headers)
      : [];
    const names = asArray(jobs).map((j) => j?.name).filter((n) => typeof n === 'string' && n);
    ciSummary = names.length ? summary('Failed jobs', names) : `Pipeline ${pipelineStatus}`;
  }
  const rows = asArray(notes)
    .filter((n) => n?.system === false)
    .map((n) => ({ author: typeof n?.author?.username === 'string' ? n.author.username : '', body: n?.body, at: n?.created_at }));
  return { state, ci, ciSummary, comments: newComments(rows, since) };
}

/**
 * Status of one factory PR (github.com) or MR (gitlab.com).
 * @param {string} url the PR/MR web URL
 * @param {{ since?: string|null, creds?: { github?: { token?: string }, gitlab?: { token?: string } } }} [opts]
 * @returns {Promise<{ url: string, state: 'open'|'merged'|'closed', ci: 'none'|'pending'|'success'|'failed',
 *   ciSummary: string|null, comments: { author: string, body: string, at: string }[] }>}
 * @throws {ShipStatusError} code provider_error | unauthorized | unsupported_url
 */
export async function pollRequest(url, { since = null, creds = {} } = {}) {
  const gh = parseGithubUrl(url);
  // A '..' owner or repo would be normalised away by URL parsing and hit another API path.
  if (gh && gh.kind === 'pr' && !isDotSegment(gh.owner) && !isDotSegment(gh.repo)) {
    return { url, ...(await pollGithubPr(gh, since, creds.github?.token)) };
  }
  const gl = parseGitlabMrUrl(url);
  if (gl) return { url, ...(await pollGitlabMr(gl, since, creds.gitlab?.token)) };
  throw new ShipStatusError('unsupported_url');
}
