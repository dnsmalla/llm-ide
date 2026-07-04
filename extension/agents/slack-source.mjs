// Slack input source — a thin Slack Web API fetcher (twin of email-source.mjs).
// The server connects to Slack with the user's bot token, pulls recent channel
// messages, and hands back normalized JSON. The Mac client turns those rows
// into notes; zero note-domain logic lives here.
//
// Split: stripMrkdwn/normalizeMessage are PURE (unit-tested); testConnection/
// fetchChannelHistory own the network. The bot token flows in as an argument
// (resolved from the vault by the caller) and is NEVER logged.
//
// Host is fixed (https://slack.com/api/*), so unlike the IMAP connector there
// is no DNS resolution / SSRF surface.

const API = 'https://slack.com/api';

const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 20000;
const FETCH_DEADLINE_MS = 90_000;

// Rate-limit handling. Slack returns HTTP 429 (with a Retry-After header) — and
// occasionally HTTP 200 with { ok:false, error:'ratelimited' } — when a per-
// method limit is hit. We honor Retry-After with a bounded retry/backoff before
// surfacing an error, so a burst of calls on a busy channel degrades to waiting
// rather than a hard SLACK_FETCH_FAILED.
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;

// Workspace user roster cache — keyed by team, refreshed periodically. Resolving
// author display names from a single (cached) users.list collapses what used to
// be N users.info calls per fetch (one per distinct author) down to ~0 within
// the TTL window, which is what kept blowing past users.info's rate limit on
// busy channels.
const USER_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_USER_LIST_PAGES = 50;      // bound users.list pagination on big workspaces
const MAX_USER_INFO_FALLBACK = 25;   // bound per-fetch users.info fallback bursts
const userCacheByTeam = new Map();   // teamId → { at: epochMs, names: Map<id, name|null> }

// Real backoff sleep, resolving after `ms` or rejecting if `signal` aborts.
// Overridable in tests (via _setSleepForTest) so the retry loop runs instantly.
const realSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('aborted')); return; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});
let sleepImpl = realSleep;

// PURE. Backoff delay (ms) for a rate-limited attempt: honor a valid Retry-After
// header (seconds) when present, else exponential (1s, 2s, 4s…). Both capped at
// MAX_BACKOFF_MS. Exported for unit testing.
export function backoffDelayMs(attempt, retryAfterHeader) {
  // Guard the empty/null header explicitly — Number(null) is 0, not NaN, which
  // would otherwise masquerade as a valid "retry immediately".
  if (retryAfterHeader != null && retryAfterHeader !== '') {
    const ra = Number(retryAfterHeader);
    if (Number.isFinite(ra) && ra >= 0) return Math.min(MAX_BACKOFF_MS, Math.round(ra * 1000));
  }
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
}

// Test-only hooks. Not part of the public API.
export function _setSleepForTest(fn) { sleepImpl = fn || realSleep; }
export function _resetUserCache() { userCacheByTeam.clear(); }

// PURE. Slack mrkdwn → plain text: unwrap <url|label> and <url>, strip the
// leftover angle brackets on <@U…>/<#C…> mentions, decode the three entities
// Slack escapes (& < >). Dependency-free; exported for unit testing.
export function stripMrkdwn(text) {
  if (!text) return '';
  return String(text)
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>|]+)>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// PURE. Normalize a raw Slack message + a resolved display name into the stable
// shape the client expects. `userName` is the resolved name or null (→ fall
// back to the raw user id). Missing thread_ts → null.
export function normalizeMessage(raw, channelId, userName) {
  let text = stripMrkdwn(raw.text || '');
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[...truncated]';
  return {
    ts: String(raw.ts),
    channelId,
    user: userName || raw.user || 'unknown',
    text,
    threadTs: raw.thread_ts ? String(raw.thread_ts) : null,
  };
}

// Call a Slack Web API method with the bot token. Slack returns HTTP 200 with
// `{ ok: false, error }` on logical failures, so we check `ok` and throw a
// clean Error. `signal` bounds the call.
async function slackCall(method, token, params, signal) {
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${method}?${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    // HTTP 429: rate limited. Honor Retry-After (header, seconds) with a bounded
    // backoff; the body is often not JSON, so don't parse it — just retry.
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error(friendlyError('ratelimited'));
      await sleepImpl(backoffDelayMs(attempt, res.headers.get('retry-after')), signal);
      continue;
    }
    const data = await res.json().catch(() => ({ ok: false, error: 'invalid_response' }));
    // Slack sometimes signals rate limiting with HTTP 200 + { ok:false,
    // error:'ratelimited' }; treat it the same as a 429.
    if (!data.ok && data.error === 'ratelimited' && attempt < MAX_RETRIES) {
      await sleepImpl(backoffDelayMs(attempt, res.headers.get('retry-after')), signal);
      continue;
    }
    if (!data.ok) throw new Error(friendlyError(data.error));
    return data;
  }
}

function friendlyError(code) {
  switch (code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':     return 'Slack auth failed — check the bot token';
    case 'not_in_channel':
    case 'channel_not_found': return 'The bot is not in that channel (invite it, or check the channel id)';
    case 'ratelimited':       return 'Slack rate limit hit — try again shortly';
    default:                  return `Slack API error: ${code || 'unknown'}`;
  }
}

// Verify the token. Used by the client's "Test connection" button.
export async function testConnection({ token }) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const r = await slackCall('auth.test', token, {}, ctrl.signal);
    return { ok: true, team: r.team || '', user: r.user || '' };
  } finally { clearTimeout(killer); }
}

// Fetch replies for a single thread (ts === thread_ts). The first element
// returned by conversations.replies is the root message (already in history),
// so we drop it and return only the child replies.
async function fetchReplies(token, channelId, threadTs, signal) {
  const r = await slackCall('conversations.replies',
    token, { channel: channelId, ts: threadTs, limit: String(MAX_MESSAGES) }, signal);
  // The first element is the root (ts === thread_ts); drop it (already in history).
  return (r.messages || []).filter((m) => String(m.ts) !== String(threadTs)
    && m.type === 'message' && !m.subtype);
}

// PURE. Pick the best display label off a Slack user object.
function pickUserName(u) {
  return u?.profile?.display_name || u?.real_name || u?.name || null;
}

// Fetch (or reuse) the team's user roster: id → display name. Cached per team
// for USER_CACHE_TTL_MS and shared across fetches, so name resolution costs ~1
// users.list per window instead of one users.info per author. Pagination is
// bounded; a failure returns whatever was gathered (possibly empty) so name
// resolution degrades to the users.info fallback rather than throwing.
async function getTeamRoster(token, team, signal) {
  const key = team || 'default';
  const hit = userCacheByTeam.get(key);
  if (hit && (Date.now() - hit.at) < USER_CACHE_TTL_MS) return hit.names;

  const names = new Map();
  try {
    let cursor = '';
    for (let page = 0; page < MAX_USER_LIST_PAGES; page++) {
      const params = { limit: '200' };
      if (cursor) params.cursor = cursor;
      const r = await slackCall('users.list', token, params, signal);
      for (const u of r.members || []) {
        if (u?.id) names.set(u.id, pickUserName(u));
      }
      cursor = r.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
  } catch {
    // Degrade. If we got nothing, don't cache the empty roster — let the next
    // fetch retry the list; misses fall through to users.info below.
    if (names.size === 0) return names;
  }
  userCacheByTeam.set(key, { at: Date.now(), names });
  return names;
}

// Resolve a set of user ids → display names. Reads from the team roster cache
// first (one users.list, shared across fetches); ids missing from the roster
// (new members, bots) fall back to a bounded number of per-user users.info
// calls, memoized into the cache. All failures degrade to null (→ raw id).
async function resolveUserNames(ids, token, team, signal) {
  const roster = await getTeamRoster(token, team, signal);
  const names = new Map();
  const misses = [];
  for (const id of new Set(ids)) {
    if (!id) continue;
    if (roster.has(id)) names.set(id, roster.get(id));
    else misses.push(id);
  }
  for (const id of misses.slice(0, MAX_USER_INFO_FALLBACK)) {
    try {
      const r = await slackCall('users.info', token, { user: id }, signal);
      const name = pickUserName(r.user);
      names.set(id, name);
      roster.set(id, name); // memoize into the team cache for the TTL window
    } catch { names.set(id, null); }
  }
  return names;
}

// PURE. Resolve the `oldest` lower bound for conversations.history. The
// forward-only per-channel high-water (`oldestTs`, a Slack ts) wins; on the
// first fetch (no high-water) fall back to `lookbackDays` (clamped 1..60,
// default 7) converted to a Slack ts (epoch seconds). Mirrors the email
// connector's resolveSince. Exported for unit testing.
export function resolveOldestTs({ oldestTs, lookbackDays }) {
  if (oldestTs) return String(oldestTs);
  const raw = Number(lookbackDays);
  const days = Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.round(raw))) : 7;
  return ((Date.now() - days * 86400000) / 1000).toFixed(6);
}

// Fetch messages in `channelId` newer than the resolved `oldest` bound
// (high-water if present, else lookbackDays). Drops already-seen ts's, caps
// the count (newest kept), resolves user names, and normalizes. Returns
// { messages, skipped: { overCap } }.
export async function fetchChannelHistory({ token, channelId, oldestTs, lookbackDays, seenTs }) {
  const seen = seenTs instanceof Set ? seenTs : new Set(seenTs || []);
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    // Resolve the team id up front (also validates the token). It keys the
    // shared user-name cache; if it fails we fall back to the 'default' bucket
    // rather than aborting the fetch — the history call below reports real auth
    // errors.
    let team = '';
    try { team = (await slackCall('auth.test', token, {}, ctrl.signal)).team_id || ''; } catch { team = ''; }

    const params = { channel: channelId, limit: String(MAX_MESSAGES + 50) };
    params.oldest = resolveOldestTs({ oldestTs, lookbackDays });
    const r = await slackCall('conversations.history', token, params, ctrl.signal);
    const raw = (r.messages || [])
      .filter((m) => m.type === 'message' && !m.subtype)
      .filter((m) => !seen.has(String(m.ts)));
    const selected = raw.slice(0, MAX_MESSAGES);

    // Identify thread parents among `selected` and fetch their replies.
    const threadParents = selected.filter(
      (m) => m.thread_ts && String(m.thread_ts) === String(m.ts) && m.reply_count > 0,
    );
    const replyLists = await Promise.all(threadParents.map(async (parent) => {
      try {
        return await fetchReplies(token, channelId, parent.ts, ctrl.signal);
      } catch { return []; }
    }));
    const allReplies = replyLists.flat();

    // Combine top-level selected + replies, drop already-seen ts's, sort
    // newest-first, then cap at MAX_MESSAGES.
    const combined = [...selected, ...allReplies]
      .filter((m) => !seen.has(String(m.ts)))
      .sort((a, b) => Number(b.ts) - Number(a.ts));
    const skipped = { overCap: Math.max(0, combined.length - MAX_MESSAGES) };
    const finalSelected = combined.slice(0, MAX_MESSAGES);

    const names = await resolveUserNames(finalSelected.map((m) => m.user), token, team, ctrl.signal);
    const messages = finalSelected.map((m) => normalizeMessage(m, channelId, names.get(m.user) ?? null));
    return { messages, skipped };
  } finally { clearTimeout(killer); }
}
