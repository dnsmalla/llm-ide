// /kb/google/* — the Google connectors (Gmail, Calendar, Drive). Plan 2026-10-31-google-connectors-plan.md, spec docs/spec/google-connectors.md.
//
// Google sign-in here is a CONNECTOR credential only (never an app login, never a model provider). The core owns the OAuth
// client, the loopback listener and every token; a client only ever sees the authorization URL, a status, and notes.
//
//   POST /kb/google/start         { clientId?, clientSecret?, products[], driveContent?, accountId? } -> { authUrl, state, ... }
//   GET  /kb/google/status?state= the flow's status (terminal result is read once)
//   GET  /kb/google/accounts      connected accounts, per-connector status and options (no secrets)
//   POST /kb/google/disconnect    { accountId } revoke + delete credentials, cursors, cached index rows
//   POST /kb/google/options       { accountId, product, options } validated and clamped
//   GET  /kb/google/calendars?accountId=        the user's calendars (picker)
//   GET  /kb/google/drive/folders?accountId=&parent=  folders under a parent (picker)
//   POST /kb/google/gmail/fetch   { accountId } -> notes to write into the Library folder (Pattern B, forward-only)
//   POST /kb/google/gmail/seen    { accountId, batchId } commit the cursor AFTER the client wrote the notes
//   POST /kb/google/sync          { accountId, product: gcal|gdrive } Pattern A index run
//
// Tiers (command bus spec): connect, disconnect and options are desktop-only decisions; a phone-originated "sync now" is
// a T1 enqueue handled by the bus (G7), not here. No route returns a token, a client secret or a raw Google response body.
import crypto from 'node:crypto';
import { logger } from '../core/logger.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { redactSecrets } from '../core/redact-secrets.mjs';
import { getDb } from '../kb/db.mjs';
import { recordActivity } from '../kb/activity.mjs';
import { getGoogleAccount, listGoogleAccounts, getSyncState, patchSyncState, listSyncStates } from '../kb/google-store.mjs';
import { safeAudit } from '../server/route-http.mjs';
import { GoogleApiError } from '../connectors/google/google-fetch.mjs';
import {
  startAuthFlow, flowStatus, disconnectAccount, googleSession, legacyMailTokenPresent,
} from '../connectors/google/google-auth.mjs';
import { fetchGmail, normalizeGmailOptions } from '../connectors/google/gmail.mjs';
import { syncCalendars, normalizeCalendarOptions, listCalendars } from '../connectors/google/gcal.mjs';
import { syncDrive, normalizeDriveOptions, listFolders } from '../connectors/google/gdrive.mjs';
import { driveContentGranted } from '../connectors/google/google-scopes.mjs';

const ACCOUNT_ID_RE = /^[a-f0-9]{12}$/;
const PRODUCTS = new Set(['gmail', 'gcal', 'gdrive']);
const BODY_LIMIT = 64 * 1024;

const STATUS_FOR_CODE = {
  GOOGLE_BAD_REQUEST: 400, GOOGLE_NOT_FOUND: 404, GOOGLE_RECONNECT_NEEDED: 409, GOOGLE_BUSY: 429, GOOGLE_RATE_LIMITED: 429,
  GOOGLE_PRODUCT_NOT_GRANTED: 409, GOOGLE_SYNC_RUNNING: 409, GOOGLE_BATCH_UNKNOWN: 409,
};

function fail(res, status, code, message) {
  sendJSON(res, status, { error: { code, message } });
  return true;
}

function googleFail(res, e, where) {
  if (e instanceof GoogleApiError) {
    const status = STATUS_FOR_CODE[e.code] || 502;
    if (status >= 500) logger.warn('google_connector_failed', { where, code: e.code, status: e.status });
    return fail(res, status, e.code, redactSecrets(e.message));
  }
  logger.error('google_connector_error', { where, name: e?.name, message: redactSecrets(String(e?.message || '')).slice(0, 200) });
  return fail(res, 500, 'INTERNAL', 'Google connector request failed');
}

async function body(req, res) {
  let raw;
  try { raw = await readBody(req, BODY_LIMIT); } catch { fail(res, 413, 'VALIDATION_FAILED', 'Request body too large'); return null; }
  const b = raw ? parseJSON(raw) : {};
  if (b === null || typeof b !== 'object' || Array.isArray(b)) { fail(res, 400, 'VALIDATION_FAILED', 'Body must be a JSON object'); return null; }
  return b;
}

const running = new Set();
const key = (userId, product, accountId) => `${userId}\u0000${product}\u0000${accountId}`;

function account(res, userId, accountId, product) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)) { fail(res, 400, 'VALIDATION_FAILED', 'accountId is required'); return null; }
  const acct = getGoogleAccount(userId, accountId);
  if (!acct) { fail(res, 404, 'GOOGLE_NOT_FOUND', 'Unknown Google account'); return null; }
  if (product && !acct.products.includes(product)) { fail(res, 409, 'GOOGLE_PRODUCT_NOT_GRANTED', 'This product was not granted for the account. Connect it again with that product ticked.'); return null; }
  return acct;
}

function publicAccount(acct, userId) {
  const states = Object.fromEntries(listSyncStates(userId, acct.accountId).map((s) => [s.connectorId, s]));
  const connectors = {};
  for (const p of acct.products) {
    const s = states[p] || { status: 'idle', options: {}, lastError: null, lastRunAt: null };
    const normalize = p === 'gmail' ? normalizeGmailOptions : p === 'gcal' ? normalizeCalendarOptions : normalizeDriveOptions;
    connectors[p] = { status: acct.status === 'reconnect_needed' ? 'reconnect_needed' : s.status, lastRunAt: s.lastRunAt, lastError: s.lastError, options: normalize(s.options) };
  }
  return { accountId: acct.accountId, email: acct.email, status: acct.status, products: acct.products, driveContent: acct.driveContent, scopes: acct.scopes, connectors };
}

const nowIso = () => new Date().toISOString();

async function guarded(res, userId, product, accountId, fn) {
  const k = key(userId, product, accountId);
  if (running.has(k)) return fail(res, 409, 'GOOGLE_SYNC_RUNNING', 'A sync for this account is already running');
  running.add(k);
  try { return await fn(); } finally { running.delete(k); }
}

function settle(userId, product, accountId, e) {
  const reconnect = e?.code === 'GOOGLE_RECONNECT_NEEDED';
  try { patchSyncState(userId, product, accountId, { status: reconnect ? 'reconnect_needed' : 'error', lastError: reconnect ? 'Reconnect needed' : String(e?.code || 'error'), lastRunAt: nowIso() }); } catch { /* best effort */ }
}

export async function handleGoogleRoutes(req, res, { userId, url }) {
  const path = url.split('?')[0];
  if (!path.startsWith('/kb/google/')) return false;
  const q = new URL(url, 'http://127.0.0.1').searchParams;
  const db = getDb();

  if (req.method === 'POST' && path === '/kb/google/start') {
    const b = await body(req, res); if (!b) return true;
    for (const k of ['clientId', 'clientSecret', 'accountId']) if (b[k] != null && typeof b[k] !== 'string') return fail(res, 400, 'VALIDATION_FAILED', `${k} must be a string`);
    if (!Array.isArray(b.products)) return fail(res, 400, 'VALIDATION_FAILED', 'products must be a list');
    if (b.accountId != null && !ACCOUNT_ID_RE.test(b.accountId)) return fail(res, 400, 'VALIDATION_FAILED', 'accountId is invalid');
    try {
      const out = await startAuthFlow({ db, userId, clientId: b.clientId, clientSecret: b.clientSecret, products: b.products, driveContent: b.driveContent === true, existingAccountId: b.accountId || undefined });
      safeAudit(db, { userId, action: 'connector.google.start', resource: 'google', detail: { products: b.products, legacyMailTokenRevoked: out.legacyMailTokenRevoked } });
      sendJSON(res, 200, out);
    } catch (e) { return googleFail(res, e, 'start'); }
    return true;
  }

  if (req.method === 'GET' && path === '/kb/google/status') {
    const s = flowStatus(q.get('state') || '', userId);
    if (s.forbidden) return fail(res, 403, 'FORBIDDEN', 'not your sign-in');
    sendJSON(res, 200, s);
    return true;
  }

  if (req.method === 'GET' && path === '/kb/google/accounts') {
    sendJSON(res, 200, { accounts: listGoogleAccounts(userId).map((a) => publicAccount(a, userId)), legacyMailToken: legacyMailTokenPresent(db, userId) });
    return true;
  }

  if (req.method === 'POST' && path === '/kb/google/disconnect') {
    const b = await body(req, res); if (!b) return true;
    if (!account(res, userId, b.accountId)) return true;
    try {
      const out = await disconnectAccount(db, userId, b.accountId);
      safeAudit(db, { userId, action: 'connector.revoke', resource: `google.acct.${b.accountId}`, detail: { revoked: out.revoked, purgedSources: out.purgedSources } });
      sendJSON(res, 200, { ok: true, revoked: out.revoked, purgedSources: out.purgedSources });
    } catch (e) { return googleFail(res, e, 'disconnect'); }
    return true;
  }

  if (req.method === 'POST' && path === '/kb/google/options') {
    const b = await body(req, res); if (!b) return true;
    if (typeof b.product !== 'string' || !PRODUCTS.has(b.product)) return fail(res, 400, 'VALIDATION_FAILED', 'product must be gmail, gcal or gdrive');
    if (b.options == null || typeof b.options !== 'object' || Array.isArray(b.options)) return fail(res, 400, 'VALIDATION_FAILED', 'options must be an object');
    const acct = account(res, userId, b.accountId, b.product); if (!acct) return true;
    const norm = b.product === 'gmail' ? normalizeGmailOptions(b.options) : b.product === 'gcal' ? normalizeCalendarOptions(b.options) : normalizeDriveOptions(b.options);
    const cur = getSyncState(userId, b.product, b.accountId);
    // A changed selection restarts that connector's cursor: a new label set or calendar list is a new query.
    const changed = JSON.stringify(norm) !== JSON.stringify(b.product === 'gmail' ? normalizeGmailOptions(cur.options) : b.product === 'gcal' ? normalizeCalendarOptions(cur.options) : normalizeDriveOptions(cur.options));
    patchSyncState(userId, b.product, b.accountId, { options: norm, ...(changed && b.product === 'gmail' ? { cursor: null, pendingCursor: null } : {}) });
    sendJSON(res, 200, { ok: true, options: norm, ...(b.product === 'gdrive' ? { contentGranted: driveContentGranted(acct.scopes) } : {}) });
    return true;
  }

  if (req.method === 'GET' && path === '/kb/google/calendars') {
    const acct = account(res, userId, q.get('accountId'), 'gcal'); if (!acct) return true;
    try { sendJSON(res, 200, { calendars: await listCalendars({ session: googleSession(db, userId, acct.accountId) }) }); } catch (e) { return googleFail(res, e, 'calendars'); }
    return true;
  }

  if (req.method === 'GET' && path === '/kb/google/drive/folders') {
    const acct = account(res, userId, q.get('accountId'), 'gdrive'); if (!acct) return true;
    try { sendJSON(res, 200, { folders: await listFolders({ session: googleSession(db, userId, acct.accountId), parentId: q.get('parent') || '' }) }); } catch (e) { return googleFail(res, e, 'folders'); }
    return true;
  }

  if (req.method === 'POST' && path === '/kb/google/gmail/fetch') {
    const b = await body(req, res); if (!b) return true;
    const acct = account(res, userId, b.accountId, 'gmail'); if (!acct) return true;
    return guarded(res, userId, 'gmail', acct.accountId, async () => {
      const state = getSyncState(userId, 'gmail', acct.accountId);
      try {
        const r = await fetchGmail({ session: googleSession(db, userId, acct.accountId), accountId: acct.accountId, accountEmail: acct.email, cursor: state.cursor, options: state.options });
        const batchId = crypto.randomBytes(12).toString('hex');
        patchSyncState(userId, 'gmail', acct.accountId, { pendingCursor: JSON.stringify({ batchId, cursor: r.nextCursor, pending: r.pending }), status: r.pending ? 'pending' : 'idle', lastError: null, lastRunAt: nowIso() });
        safeAudit(db, { userId, action: 'connector.sync', resource: `gmail:${acct.accountId}`, detail: { threads: r.stats.threads, messages: r.stats.messages, mode: r.mode, pending: r.pending } });
        if (r.notes.length > 0) {
          try { recordActivity({ userId, kind: 'email_fetched', title: `Fetched ${r.notes.length} Gmail thread${r.notes.length === 1 ? '' : 's'}`, detail: { count: r.notes.length, connector: 'gmail' } }); } catch { /* feed is best effort */ }
        }
        sendJSON(res, 200, {
          accountId: acct.accountId, batchId, mode: r.mode, pending: r.pending, stats: r.stats, tombstones: r.tombstones,
          notes: r.notes.map((n) => ({ threadId: n.threadId, noteFile: n.noteFile, title: n.title, markdown: n.markdown, messageCount: n.messageCount, lastAt: n.lastAt })),
        });
      } catch (e) { settle(userId, 'gmail', acct.accountId, e); return googleFail(res, e, 'gmail.fetch'); }
      return true;
    });
  }

  if (req.method === 'POST' && path === '/kb/google/gmail/seen') {
    const b = await body(req, res); if (!b) return true;
    const acct = account(res, userId, b.accountId, 'gmail'); if (!acct) return true;
    const state = getSyncState(userId, 'gmail', acct.accountId);
    let pend = null;
    try { pend = state.pendingCursor ? JSON.parse(state.pendingCursor) : null; } catch { pend = null; }
    if (!pend || typeof b.batchId !== 'string' || pend.batchId !== b.batchId) return fail(res, 409, 'GOOGLE_BATCH_UNKNOWN', 'Unknown or already confirmed batch');
    patchSyncState(userId, 'gmail', acct.accountId, { cursor: pend.cursor, pendingCursor: null, status: pend.pending ? 'pending' : 'idle' });
    sendJSON(res, 200, { ok: true, pending: pend.pending === true });
    return true;
  }

  if (req.method === 'POST' && path === '/kb/google/sync') {
    const b = await body(req, res); if (!b) return true;
    if (b.product !== 'gcal' && b.product !== 'gdrive') return fail(res, 400, 'VALIDATION_FAILED', 'product must be gcal or gdrive');
    const acct = account(res, userId, b.accountId, b.product); if (!acct) return true;
    return guarded(res, userId, b.product, acct.accountId, async () => {
      const state = getSyncState(userId, b.product, acct.accountId);
      const session = googleSession(db, userId, acct.accountId);
      try {
        if (b.product === 'gcal') {
          const r = await syncCalendars({ session, userId, accountId: acct.accountId, cursor: state.cursor, options: state.options });
          patchSyncState(userId, 'gcal', acct.accountId, { cursor: r.nextCursor, status: r.pending ? 'pending' : 'idle', lastError: null, lastRunAt: nowIso() });
          safeAudit(db, { userId, action: 'connector.sync', resource: `gcal:${acct.accountId}`, detail: { events: r.events, cancelled: r.cancelled, pending: r.pending } });
          if (r.events > 0) { try { recordActivity({ userId, kind: 'knowledge_updated', title: `Google Calendar: ${r.events} event${r.events === 1 ? '' : 's'} updated`, detail: { connector: 'gcal', count: r.events } }); } catch { /* best effort */ } }
          sendJSON(res, 200, { accountId: acct.accountId, product: 'gcal', pending: r.pending, events: r.events, cancelled: r.cancelled, calendars: r.calendars });
        } else {
          const r = await syncDrive({ session, userId, accountId: acct.accountId, cursor: state.cursor, options: state.options, contentGranted: driveContentGranted(acct.scopes) });
          patchSyncState(userId, 'gdrive', acct.accountId, { cursor: r.nextCursor, status: r.pending ? 'pending' : 'idle', lastError: null, lastRunAt: nowIso() });
          safeAudit(db, { userId, action: 'connector.sync', resource: `gdrive:${acct.accountId}`, detail: { files: r.stats.files, removed: r.stats.removed, withContent: r.stats.withContent, pending: r.pending } });
          if (r.stats.files > 0) { try { recordActivity({ userId, kind: 'knowledge_updated', title: `Google Drive: ${r.stats.files} file${r.stats.files === 1 ? '' : 's'} updated`, detail: { connector: 'gdrive', count: r.stats.files } }); } catch { /* best effort */ } }
          sendJSON(res, 200, { accountId: acct.accountId, product: 'gdrive', pending: r.pending, mode: r.mode, stats: r.stats });
        }
      } catch (e) { settle(userId, b.product, acct.accountId, e); return googleFail(res, e, `${b.product}.sync`); }
      return true;
    });
  }

  return false;
}
