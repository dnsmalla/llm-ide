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
  const res = await fetch(`${API}/${method}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'invalid_response' }));
  if (!data.ok) throw new Error(friendlyError(data.error));
  return data;
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

// Resolve a set of user ids → display names, caching within this fetch so we
// call users.info at most once per distinct user. Failures degrade to null.
async function resolveUserNames(ids, token, signal) {
  const names = new Map();
  for (const id of new Set(ids)) {
    if (!id) continue;
    try {
      const r = await slackCall('users.info', token, { user: id }, signal);
      names.set(id, r.user?.profile?.display_name || r.user?.real_name || r.user?.name || null);
    } catch { names.set(id, null); }
  }
  return names;
}

// Fetch messages in `channelId` newer than `oldestTs` (forward-only). Drops
// already-seen ts's, caps the count (newest kept), resolves user names, and
// normalizes. Returns { messages, skipped: { overCap } }.
export async function fetchChannelHistory({ token, channelId, oldestTs, seenTs }) {
  const seen = seenTs instanceof Set ? seenTs : new Set(seenTs || []);
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const params = { channel: channelId, limit: String(MAX_MESSAGES + 50) };
    if (oldestTs) params.oldest = oldestTs;
    const r = await slackCall('conversations.history', token, params, ctrl.signal);
    const raw = (r.messages || [])
      .filter((m) => m.type === 'message' && !m.subtype)
      .filter((m) => !seen.has(String(m.ts)));
    const skipped = { overCap: Math.max(0, raw.length - MAX_MESSAGES) };
    const selected = raw.slice(0, MAX_MESSAGES);
    const names = await resolveUserNames(selected.map((m) => m.user), token, ctrl.signal);
    const messages = selected.map((m) => normalizeMessage(m, channelId, names.get(m.user) ?? null));
    return { messages, skipped };
  } finally { clearTimeout(killer); }
}
