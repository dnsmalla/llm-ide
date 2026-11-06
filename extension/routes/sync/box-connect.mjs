// Box one-time consent for the sync store (design 8.2, SP6 D1). Pending connects live in memory for 10 minutes.
import { randomBytes, createHash } from 'node:crypto';
import { AUTHORIZE_URL, API, boxRequest, postToken, buildAuthCodeForm, readJson } from '../../connectors/box.mjs';
import { maskEmail } from '../../connectors/sync-store/index.mjs';
export const BOX_CONNECT_TTL_MS = 10 * 60_000;
const pending = new Map(); const latest = new Map();
export const boxRedirectUri = (port) => `http://127.0.0.1:${port}/kb/sync/box/callback`;
export function _resetBoxConnectsForTest() { pending.clear(); latest.clear(); }
function sweep(now) { for (const [s, p] of pending) { if (now - p.createdAt <= BOX_CONNECT_TTL_MS) continue; pending.delete(s); if (latest.get(p.userId) === s) latest.delete(p.userId); } }
export function startBoxConnect(userId, { clientId, clientSecret, folder }, { port, now = Date.now() }) {
  sweep(now); const old = latest.get(userId); if (old) pending.delete(old);
  const state = randomBytes(16).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
  pending.set(state, { userId, clientId, clientSecret, folder, verifier, createdAt: now, phase: 'waiting', code: null }); latest.set(userId, state);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: boxRedirectUri(port), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return { authorizeUrl: `${AUTHORIZE_URL}?${q}` };
}
export function pollBoxConnect(userId, now = Date.now()) { sweep(now); const state = latest.get(userId); const p = state && pending.get(state); if (!p) return { phase: 'none', code: null }; if (p.phase !== 'waiting') { pending.delete(state); latest.delete(userId); } return { phase: p.phase, code: p.code }; }
export async function finishBoxConnect(query, { port, fetchImpl, commit, now = Date.now() }) {
  sweep(now); const p = pending.get(query.get('state') ?? ''); if (!p) return 'This Box sign-in link has expired. Start again from LLM-IDE Settings.';
  if (p.phase !== 'waiting') return 'This Box sign-in link was already used. Start again from LLM-IDE Settings.';
  const end = (phase, code, text) => { p.phase = phase; p.code = code; p.clientSecret = ''; p.verifier = ''; return text; };
  if (query.get('error')) return end('failed', 'cancelled', 'Box sign-in was cancelled. You can close this tab.');
  try {
    const tok = await postToken(buildAuthCodeForm({ clientId: p.clientId, clientSecret: p.clientSecret, code: query.get('code') ?? '', redirectUri: boxRedirectUri(port), codeVerifier: p.verifier }), { fetchImpl });
    if (typeof tok.refresh_token !== 'string') return end('failed', 'SYNC_AUTH_FAILED', 'Box sign-in failed. Return to LLM-IDE for details.');
    const once = { ensure: async () => tok.access_token, refresh: async () => { throw Object.assign(new Error('Box refused the new token'), { code: 'SYNC_AUTH_FAILED' }); } };
    const me = await boxRequest(once, `${API}/users/me?fields=login`, { fetchImpl });
    const login = me.ok ? String((await readJson(me)).login ?? '') : '';
    await commit(p.userId, { clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: tok.refresh_token, folder: p.folder, account: maskEmail(login) });
    return end('done', null, 'Box is connected to LLM-IDE sync. You can close this tab.');
  } catch (e) { const code = e?.boxError === 'invalid_client' ? 'SYNC_BAD_CLIENT' : String(e?.code ?? '').startsWith('SYNC_') ? e.code : e?.code === 'BOX_AUTH_FAILED' ? 'SYNC_AUTH_FAILED' : 'SYNC_UNREACHABLE'; return end('failed', code, 'Box sign-in failed. Return to LLM-IDE for details.'); }
}
