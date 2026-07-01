// Phase 8 — per-provider outcome pollers.  Each function takes the
// dispatched-record we stored at dispatch time + the credentials the
// client passed for THIS poll, and returns a normalized
//
//   { state: 'open' | 'closed' | 'merged' | 'cancelled' | 'unknown',
//     meta:  { ... provider-specific extras } }
//
// We never throw on individual poll failure — that would abort the
// whole batch.  Instead, errors come back as state='unknown' with the
// reason in meta.error so the user sees what went wrong per task.

import { redactSecrets } from '../core/redact-secrets.mjs';

// Redact secrets before returning a poll error. Runs the shared token-shape
// redactor (the single source of truth — catches ghp_/glpat-/Bearer/etc. even
// when echoed in an error body without a query string) AND strips URL query
// strings (Backlog's personal key rides in a query param).
function redactUrlsFromError(msg) {
  return redactSecrets(String(msg || ''))
    .replace(/\?[^\s"')]+/g, '?[REDACTED]')  // query strings (apiKey=… etc.)
    .slice(0, 300);
}

const safe = async (fn) => {
  try { return await fn(); }
  catch (err) { return { state: 'unknown', meta: { error: redactUrlsFromError(err.message || err) } }; }
};

// --- GitHub ---------------------------------------------------------------

export function parseGithubUrl(url) {
  // Anchored to the github.com origin so a crafted stored URL like
  // "https://evil.com/?x=github.com/o/r/issues/1" can't smuggle attacker-chosen
  // owner/repo path segments onto api.github.com. owner/repo restricted to the
  // GitHub-legal charset.
  const m = String(url).match(
    /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)/
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2], kind: m[3] === 'pull' ? 'pr' : 'issue', number: Number(m[4]) };
}

async function pollGithub(dispatched, { token } = {}) {
  return safe(async () => {
    const u = parseGithubUrl(dispatched?.url);
    if (!u) return { state: 'unknown', meta: { error: 'Bad URL' } };
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'llm-ide-extension',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const path = u.kind === 'pr'
      ? `/repos/${u.owner}/${u.repo}/pulls/${u.number}`
      : `/repos/${u.owner}/${u.repo}/issues/${u.number}`;
    const r = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      return { state: 'unknown', meta: { error: `GitHub ${r.status}` } };
    }
    const data = await r.json();
    let state;
    if (u.kind === 'pr') {
      // PRs report state='closed' both when merged and when closed-without-merge;
      // disambiguate via the `merged` boolean.
      if (data.merged) state = 'merged';
      else if (data.state === 'closed') state = 'cancelled';
      else state = 'open';
    } else {
      state = data.state === 'closed' ? 'closed' : 'open';
    }
    return {
      state,
      meta: {
        kind: u.kind,
        labels: Array.isArray(data.labels) ? data.labels.map((l) => l.name).filter(Boolean) : [],
        assignee: data.assignee?.login || null,
        closedAt: data.closed_at,
        mergedAt: data.merged_at,
        draft: data.draft,
        updatedAt: data.updated_at,
      },
    };
  });
}

// --- Backlog --------------------------------------------------------------

// Mirrors BACKLOG_TLD_RE in agents/dispatcher.mjs:40.  Validates that the
// `space` hostname parsed from a stored task URL is a legitimate Backlog
// subdomain before we send a credentialed GET to it.  This prevents a
// tampered stored-task URL (e.g. "evil.com") from redirecting our request
// — including the apiKey in the query string — to an arbitrary host.
const BACKLOG_TLD_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.backlog\.(?:com|jp|tool)$/;

export function parseBacklogUrl(url) {
  // https://<space>/view/<KEY>
  const m = String(url).match(/^https?:\/\/([^/]+)\/view\/([A-Z0-9_-]+)/);
  if (!m) return null;
  return { space: m[1], issueKey: m[2] };
}

async function pollBacklog(dispatched, { apiKey } = {}) {
  return safe(async () => {
    const u = parseBacklogUrl(dispatched?.url);
    if (!u) return { state: 'unknown', meta: { error: 'Bad URL' } };
    // Reject any host that isn't a recognised Backlog subdomain BEFORE
    // the fetch — a tampered stored URL could otherwise redirect our
    // credentialed GET (with the apiKey in the query string) to an
    // arbitrary host outside Backlog's infrastructure.
    if (!BACKLOG_TLD_RE.test(u.space)) {
      return { state: 'unknown', meta: { error: 'Backlog URL host is not a valid Backlog domain' } };
    }
    if (!apiKey) return { state: 'unknown', meta: { error: 'No Backlog apiKey supplied' } };
    // Backlog v2 personal-API-key auth unfortunately requires the key in
    // the query string for GET requests — there is no header equivalent
    // for personal keys (OAuth bearer tokens work but require a redirect
    // flow).  We accept this limitation and ensure:
    //   1. The URL is never written to application logs (errors only
    //      surface the HTTP status code, not the full URL).
    //   2. The key is URL-encoded so it can't break the URL structure.
    const url = `https://${u.space}/api/v2/issues/${encodeURIComponent(u.issueKey)}?apiKey=${encodeURIComponent(apiKey)}`;
    // redirect:'error' — the apiKey rides in the query string, so a 3xx from the
    // (validated) Backlog host to anywhere else must NOT be followed, or the
    // credential would be re-sent off-Backlog. Fail closed instead.
    const r = await fetch(url, { headers: { 'User-Agent': 'llm-ide-extension' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    // Intentionally omit the URL from the error — it contains the apiKey.
    if (!r.ok) return { state: 'unknown', meta: { error: `Backlog HTTP ${r.status}` } };
    const data = await r.json();
    // Backlog status names are localized; we look at id (1=Open, 2=In Progress, 3=Resolved, 4=Closed)
    // but fall back to the localized name for the meta record.
    const id = data?.status?.id;
    let state;
    if (id === 4) state = 'closed';
    else if (id === 3) state = 'closed'; // resolved → closed for our purposes
    else state = 'open';
    return {
      state,
      meta: {
        statusId: id,
        statusName: data?.status?.name,
        assignee: data?.assignee?.name || null,
        updatedAt: data?.updated,
        closedAt: id === 4 ? data?.updated : null,
      },
    };
  });
}

// --- Linear ---------------------------------------------------------------

async function pollLinear(dispatched, { apiKey } = {}) {
  return safe(async () => {
    const id = dispatched?.number;
    if (!id) return { state: 'unknown', meta: { error: 'No Linear identifier' } };
    if (!apiKey) return { state: 'unknown', meta: { error: 'No Linear apiKey supplied' } };
    const query = `
      query($id: String!) {
        issue(id: $id) { id identifier url state { name type } completedAt cancelledAt }
      }
    `;
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'llm-ide-extension',
      },
      body: JSON.stringify({ query, variables: { id: String(id) } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { state: 'unknown', meta: { error: `Linear ${r.status}` } };
    const data = await r.json();
    if (data?.errors?.length) {
      return { state: 'unknown', meta: { error: data.errors.map((e) => e.message).join('; ').slice(0, 200) } };
    }
    const issue = data?.data?.issue;
    if (!issue) return { state: 'unknown', meta: { error: 'Issue not found' } };
    // type: backlog / unstarted / started / completed / cancelled
    const type = issue.state?.type;
    let state;
    if (type === 'completed') state = 'closed';
    else if (type === 'cancelled') state = 'cancelled';
    else state = 'open';
    return {
      state,
      meta: {
        statusName: issue.state?.name,
        type,
        completedAt: issue.completedAt,
        cancelledAt: issue.cancelledAt,
      },
    };
  });
}

// --- Dispatcher -----------------------------------------------------------

export async function pollOne(task, creds = {}) {
  const provider = task.dispatched?.provider;
  if (provider === 'github')  return pollGithub(task.dispatched,  { token: creds.github?.token });
  if (provider === 'backlog') return pollBacklog(task.dispatched, { apiKey: creds.backlog?.apiKey });
  if (provider === 'linear')  return pollLinear(task.dispatched,  { apiKey: creds.linear?.apiKey });
  return { state: 'unknown', meta: { error: `No poller for provider: ${provider}` } };
}
