// Google OAuth2 (PKCE) for Gmail IMAP via XOAUTH2. Bring-your-own Desktop
// client. Network is global fetch to fixed Google hosts (no SSRF surface).
import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'https://mail.google.com/';
const STATE_TTL_MS = 10 * 60 * 1000;

export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars, URL-safe
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const u = new URL(AUTH_ENDPOINT);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

async function tokenPost(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function exchangeCode({ clientId, clientSecret, code, verifier, redirectUri }) {
  const d = await tokenPost({
    grant_type: 'authorization_code',
    client_id: clientId, client_secret: clientSecret,
    code, code_verifier: verifier, redirect_uri: redirectUri,
  });
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in };
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const d = await tokenPost({
    grant_type: 'refresh_token',
    client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken,
  });
  return { accessToken: d.access_token, expiresIn: d.expires_in };
}

export async function fetchEmailAddress(accessToken) {
  const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json().catch(() => ({}));
  return d.email || '';
}

// In-memory OAuth state store (single-node; TTL-swept). Never holds the
// client secret — the callback reads that from the vault by userId.
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
  if (v.email !== undefined) out.email = v.email;
  if (v.message !== undefined) out.message = v.message;
  return out;
}
