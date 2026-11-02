// Ticket-system connector.  Phase 3 ships GitHub Issues + a generic JSON
// importer (paste-array-of-tickets) so users on Backlog / Jira / Linear
// can pipe their own dump in without us bundling auth code per provider.
//
// Tokens flow client → 127.0.0.1 server only on the indexing call; they
// are never persisted server-side and never leave localhost.

import { makeTrackerFetch } from '../server/tracker-fetch.mjs';
import { ingestSources, deleteSourcesByPrefix } from '../kb/db.mjs';

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
// The Mac app pages up to 20 pages of 100 per repo (GitHubClient+RepoBackend);
// the importer matches that and stops at 2 000 rows per run.
export const MAX_PAGES = 20;
export const MAX_ROWS = PER_PAGE * MAX_PAGES;
// Wall-clock ceiling for one import run, checked before each page after the
// first. A run that hits it keeps what it fetched and reports truncated.
export const IMPORT_BUDGET_MS = 60_000;

function authHeaders(token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'llm-ide-extension',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function fetchPage(repo, state, page, token) {
  const url = `${GITHUB_API}/repos/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${PER_PAGE}&page=${page}`;
  // 15s ceiling: a stalled GitHub call would otherwise hold the
  // request socket up to the server's 5min requestTimeout and burn
  // rate-limit slots. Per-page timeout is bounded; the outer
  // pagination loop covers the multi-page case.
  const r = await makeTrackerFetch({ secret: token, followSameHost: true })(url, { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) });
  if (r.status === 403) {
    // GitHub returns 403 for both auth failures AND rate-limit exceeded.
    // Distinguish them so the caller gets an actionable message instead
    // of "check your token" when the actual problem is rate-limit.
    if (r.headers.get('x-ratelimit-remaining') === '0') {
      const resetEpoch = Number(r.headers.get('x-ratelimit-reset'));
      const resetAt = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : 'unknown';
      throw new Error(`GitHub API rate-limit exceeded. Quota resets at ${resetAt}.`);
    }
    throw new Error('GitHub auth failed (403) — check token and scope (needs `repo` for private repos).');
  }
  if (r.status === 401) {
    throw new Error('GitHub auth failed (401) — check token and scope (needs `repo` for private repos).');
  }
  if (r.status === 404) {
    throw new Error(`Repo not found or no access: ${repo}`);
  }
  if (!r.ok) {
    // Do not expose raw response body — it may contain internal detail.
    throw new Error(`GitHub API request failed with status ${r.status}`);
  }
  return r.json();
}

function repoSlug(repo) {
  // "owner/name" or "https://github.com/owner/name" → "owner/name"
  const m = String(repo || '').match(/(?:github\.com\/)?([^/]+\/[^/?#]+)/);
  if (!m) throw new Error('Repo must be "owner/name"');
  return m[1].replace(/\.git$/, '');
}

const MAX_REPO_LEN  = 200;   // "owner/name" will never legitimately exceed this
const MAX_TOKEN_LEN = 500;   // GitHub PATs are ~40 chars; hard cap prevents abuse

// Control characters out, length capped. Applied to the fields this importer
// adds (milestone, assignees) and to labels; title and body keep their existing caps.
function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

function toTicketItem(issue, slug) {
  // The /issues endpoint returns PRs too; mark them so the planner
  // can distinguish later, but still index them — PR descriptions
  // are often where decisions get re-litigated.
  const isPR = Boolean(issue.pull_request);
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l) => cleanText(typeof l === 'string' ? l : l?.name, 100)).filter(Boolean).slice(0, 100)
    : [];
  // GitHub's issue object has no due date of its own; the only one it
  // carries is the milestone's due_on, returned as milestone.dueOn.
  const ms = issue.milestone && typeof issue.milestone === 'object' ? issue.milestone : null;
  const milestone = ms && (ms.title || ms.due_on)
    ? { title: cleanText(ms.title, 200), dueOn: typeof ms.due_on === 'string' && !Number.isNaN(Date.parse(ms.due_on)) ? cleanText(ms.due_on, 64) : null }
    : null;
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((a) => cleanText(a?.login, 100)).filter(Boolean).slice(0, 50)
    : [];
  return {
    kind: 'ticket',
    ref: issue.html_url,
    chunkIdx: 0,
    title: String(issue.title || '').slice(0, 500),
    body: String(issue.body || '').slice(0, 50_000),
    meta: {
      provider: 'github',
      repo: slug,
      number: issue.number,
      state: issue.state,
      isPR,
      labels,
      author: issue.user?.login,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      milestone,
      assignees,
    },
  };
}

/**
 * Import one GitHub repo's issues into the KB index. Pages until a short or
 * empty page (exhausted), or stops early at MAX_PAGES pages, MAX_ROWS rows or
 * the time budget (truncated: true). Re-running replaces the repo's rows, so
 * the same issue is never stored twice (the ref is the issue's html_url, which
 * is unique per provider, repo and number).
 * @param {string} userId
 * @param {{ repo: string, token?: string, state?: string, budgetMs?: number }} opts
 */
export async function indexGithubIssues(userId, { repo, token, state = 'all', budgetMs = IMPORT_BUDGET_MS }) {
  // Length validation — guard against oversized inputs being forwarded
  // to the GitHub API or embedded in error messages.
  if (typeof repo === 'string' && repo.length > MAX_REPO_LEN) {
    throw new Error(`repo parameter exceeds maximum allowed length (${MAX_REPO_LEN} chars)`);
  }
  if (typeof token === 'string' && token.length > MAX_TOKEN_LEN) {
    throw new Error(`token parameter exceeds maximum allowed length (${MAX_TOKEN_LEN} chars)`);
  }
  const slug = repoSlug(repo);
  const allowedState = ['open', 'closed', 'all'].includes(state) ? state : 'all';

  const items = [];
  const deadline = Date.now() + budgetMs;
  let exhausted = false;
  let pages = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (page > 1 && Date.now() > deadline) break;
    const batch = await fetchPage(slug, allowedState, page, token);
    pages = page;
    if (!Array.isArray(batch) || batch.length === 0) { exhausted = true; break; }
    for (const issue of batch) items.push(toTicketItem(issue, slug));
    if (batch.length < PER_PAGE) { exhausted = true; break; }  // last page
    if (items.length >= MAX_ROWS) break;
  }

  // Replace existing rows for this repo so closed tickets that vanish
  // from the API (rare, but possible on transfer/delete) don't linger.
  deleteSourcesByPrefix(userId, 'ticket', `https://github.com/${slug}/`);
  const written = ingestSources(userId, items);
  return { repo: slug, count: items.length, chunks: written, pages, truncated: !exhausted };
}

// Generic importer — accepts an array of { id, title, body, url?, meta? }
// objects.  Lets users paste a Backlog / Jira / Linear export without us
// shipping per-provider auth code.
export function indexTicketsJson(userId, { tickets, provider = 'manual' }) {
  if (!Array.isArray(tickets)) throw new Error('tickets must be an array');
  const items = tickets.map((t, i) => ({
    kind: 'ticket',
    ref: String(t.url || t.id || `manual-${Date.now()}-${i}`),
    chunkIdx: 0,
    title: String(t.title || t.id || `Ticket ${i + 1}`).slice(0, 500),
    body: String(t.body || '').slice(0, 50_000),
    meta: { provider, ...(t.meta || {}) },
  }));
  const written = ingestSources(userId, items);
  return { count: items.length, chunks: written };
}
