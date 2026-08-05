// Slack OAuth v2 (user-token flow, hosted app). LLM-IDE owns a single Slack
// App registration — client_id/client_secret live in server env vars
// (config.slackClientId/slackClientSecret), never per-user, never on the
// wire to the Mac. Requests `user_scope` only (no bot `scope`), so no bot
// user gets installed — the resulting authed_user.access_token (xoxp-...)
// reads channels/groups the individual user already belongs to.

const AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize';
const TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access';
const USER_SCOPE = 'channels:history,groups:history,channels:read,groups:read,users:read';
const STATE_TTL_MS = 10 * 60 * 1000;

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTHORIZE_ENDPOINT);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    user_scope: USER_SCOPE,
    state,
  }).toString();
  return u.toString();
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId, client_secret: clientSecret,
      code, redirect_uri: redirectUri,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Slack token exchange failed: ${data.error || res.status}`);
  }
  if (!data.authed_user?.access_token) {
    throw new Error('Slack token exchange returned no user token — is the Slack app requesting user_scope (not bot scope)?');
  }
  return { accessToken: data.authed_user.access_token, teamName: data.team?.name || '' };
}

// In-memory OAuth state store (single-node; TTL-swept). Mirrors
// agents/google-oauth.mjs's store; kept as its own module (not shared) so
// each provider's state shape stays isolated — this one carries no PKCE
// verifier and completes with teamName instead of email. `channels` is
// passed through generically (takeStatus below) but the callback in
// auth-routes.mjs no longer populates it — channel discovery moved to a
// standalone GET /kb/slack/conversations call so the OAuth callback never
// blocks on a Slack rate limit.
const _states = new Map();
function sweep() {
  const now = Date.now();
  for (const [k, v] of _states) if (now - v.createdAt > STATE_TTL_MS) _states.delete(k);
}
export function putState(state, data) { sweep(); _states.set(state, { ...data, status: 'pending', createdAt: Date.now() }); }
export function getState(state) { const v = _states.get(state); if (!v) return undefined; if (Date.now() - v.createdAt > STATE_TTL_MS) { _states.delete(state); return undefined; } return v; }
export function completeState(state, patch) { const v = _states.get(state); if (v) _states.set(state, { ...v, ...patch }); }
// Read the terminal status once and remove it (single-use).
export function takeStatus(state) {
  const v = _states.get(state);
  if (!v) return { status: 'unknown' };
  if (v.status !== 'pending') _states.delete(state);
  const out = { status: v.status };
  if (v.teamName !== undefined) out.teamName = v.teamName;
  if (v.channels !== undefined) out.channels = v.channels;
  if (v.message !== undefined) out.message = v.message;
  return out;
}
