// /kb/calendar-ical/* — the iCal feed connector (Google Calendar "Secret address in iCal format"; read-only, no OAuth).
// Spec docs/spec/calendar-ical.md, contract schema/http/calendar-ical.schema.json.
//
//   POST   /kb/calendar-ical/sources      { name, url } add a feed; the URL goes to the vault and is NEVER returned
//   GET    /kb/calendar-ical/sources      the user's feeds (id, name, calendar id prefix, status; never the URL)
//   DELETE /kb/calendar-ical/sources/:id  vault delete + purge cached rows
//   POST   /kb/calendar-ical/sync         { sourceId } one capped sync
//   POST   /kb/calendar-ical/options      { sourceId, options: { daysBack, daysAhead } }
//
// The URL is a bearer secret: write-only here, redacted in every log, audit row, error and response. Tiers (command bus
// spec): add, delete and options are desktop-only decisions; a phone-originated "sync now" is a T1 enqueue handled by the
// bus (`sources.update`), not here.
import crypto from 'node:crypto';
import { logger } from '../core/logger.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';
import { redactSecrets } from '../core/redact-secrets.mjs';
import { getDb } from '../kb/db.mjs';
import { recordActivity } from '../kb/activity.mjs';
import { getSyncState, patchSyncState, listSyncStates } from '../kb/google-store.mjs';
import { addIcalSource, getIcalSource, listIcalSources, countIcalSources, deleteIcalSource, MAX_ICAL_SOURCES, SOURCE_ID_RE } from '../kb/ical-store.mjs';
import { safeAudit } from '../server/route-http.mjs';
import { setSecret, getSecret } from '../server/vault.mjs';
import { IcalError, validateIcalUrl, redactIcalSecrets } from '../connectors/ical/ical-fetch.mjs';
import { syncIcalSource, normalizeIcalOptions, purgeIcalRows } from '../connectors/ical/ical.mjs';
import { cleanText } from '../connectors/ical/ics-parse.mjs';

const BODY_LIMIT = 16 * 1024;
const vaultKey = (sourceId) => `ical.src.${sourceId}.url`;

const STATUS_FOR_CODE = {
  ICAL_URL_INVALID: 400, ICAL_HOST_NOT_ALLOWED: 400, ICAL_NOT_FOUND: 404, ICAL_DUPLICATE: 409, ICAL_TOO_MANY_SOURCES: 409,
  ICAL_SYNC_RUNNING: 409, ICAL_FEED_REVOKED: 409, ICAL_RATE_LIMITED: 429, ICAL_FETCH_FAILED: 502, ICAL_TOO_LARGE: 502, ICAL_PARSE_FAILED: 502,
};

function fail(res, status, code, message) {
  sendJSON(res, status, { error: { code, message: redactIcalSecrets(redactSecrets(message)) } });
  return true;
}

function icalFail(res, e, where) {
  if (e instanceof IcalError) {
    const status = STATUS_FOR_CODE[e.code] || 502;
    if (status >= 500) logger.warn('ical_connector_failed', { where, code: e.code, status: e.status });
    return fail(res, status, e.code, e.message);
  }
  logger.error('ical_connector_error', { where, name: e?.name, message: redactIcalSecrets(redactSecrets(String(e?.message || ''))).slice(0, 200) });
  return fail(res, 500, 'INTERNAL', 'Calendar feed request failed');
}

async function body(req, res) {
  let raw;
  try { raw = await readBody(req, BODY_LIMIT); } catch { fail(res, 413, 'VALIDATION_FAILED', 'Request body too large'); return null; }
  const b = raw ? parseJSON(raw) : {};
  if (b === null || typeof b !== 'object' || Array.isArray(b)) { fail(res, 400, 'VALIDATION_FAILED', 'Body must be a JSON object'); return null; }
  return b;
}

const running = new Set();
let clock = () => Date.now();
/** Test seam (NODE_ENV=test only): the clock the sync window is computed from. Pass null to restore. */
export function _setIcalClockForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setIcalClockForTests is test-only');
  clock = fn || (() => Date.now());
}
const nowIso = () => new Date().toISOString();

function source(res, userId, sourceId) {
  if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) { fail(res, 400, 'VALIDATION_FAILED', 'sourceId is required'); return null; }
  const s = getIcalSource(userId, sourceId);
  if (!s) { fail(res, 404, 'ICAL_NOT_FOUND', 'Unknown calendar feed'); return null; }
  return s;
}

function publicSource(s, userId) {
  const st = listSyncStates(userId, s.sourceId).find((x) => x.connectorId === 'ical') || { status: 'idle', options: {}, lastError: null, lastRunAt: null };
  return { sourceId: s.sourceId, name: s.name, calendarIdPrefix: s.idPrefix, host: s.host, status: st.status, lastRunAt: st.lastRunAt, lastError: st.lastError, options: normalizeIcalOptions(st.options) };
}

export async function handleCalendarIcalRoutes(req, res, { userId, url }) {
  const path = url.split('?')[0];
  if (!path.startsWith('/kb/calendar-ical/')) return false;
  const db = getDb();

  if (path === '/kb/calendar-ical/sources') {
    if (req.method === 'GET') {
      sendJSON(res, 200, { sources: listIcalSources(userId).map((s) => publicSource(s, userId)) });
      return true;
    }
    if (req.method !== 'POST') return false;
    const b = await body(req, res); if (!b) return true;
    if (typeof b.name !== 'string' || typeof b.url !== 'string') return fail(res, 400, 'VALIDATION_FAILED', 'name and url must be strings');
    const name = cleanText(b.name).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!name) return fail(res, 400, 'VALIDATION_FAILED', 'name is required');
    let checked;
    try { checked = validateIcalUrl(b.url); } catch (e) { return icalFail(res, e, 'sources.add'); }
    if (countIcalSources(userId) >= MAX_ICAL_SOURCES) return fail(res, 409, 'ICAL_TOO_MANY_SOURCES', `At most ${MAX_ICAL_SOURCES} calendar feeds per user`);
    for (const s of listIcalSources(userId)) {
      let stored = null;
      try { stored = getSecret(db, userId, vaultKey(s.sourceId)); } catch { stored = null; }
      if (stored && stored === checked.url) return fail(res, 409, 'ICAL_DUPLICATE', 'This calendar feed is already added');
    }
    const sourceId = crypto.randomBytes(6).toString('hex');
    db.transaction(() => {
      setSecret(db, userId, vaultKey(sourceId), checked.url);
      addIcalSource(userId, { sourceId, name, idPrefix: checked.idPrefix, host: checked.host });
    })();
    safeAudit(db, { userId, action: 'connector.ical.add', resource: `ical:${sourceId}`, detail: { host: checked.host } });
    sendJSON(res, 200, { sourceId, name, nameOnly: true, calendarIdPrefix: checked.idPrefix, host: checked.host });
    return true;
  }

  const del = /^\/kb\/calendar-ical\/sources\/([^/]+)$/.exec(path);
  if (del && req.method === 'DELETE') {
    const s = source(res, userId, del[1]); if (!s) return true;
    try {
      db.transaction(() => { setSecret(db, userId, vaultKey(s.sourceId), ''); deleteIcalSource(userId, s.sourceId); })();
      const purged = purgeIcalRows(userId, s.sourceId);
      safeAudit(db, { userId, action: 'connector.ical.delete', resource: `ical:${s.sourceId}`, detail: { purgedSources: purged } });
      sendJSON(res, 200, { ok: true, purgedSources: purged });
    } catch (e) { return icalFail(res, e, 'sources.delete'); }
    return true;
  }

  if (req.method === 'POST' && path === '/kb/calendar-ical/options') {
    const b = await body(req, res); if (!b) return true;
    if (b.options == null || typeof b.options !== 'object' || Array.isArray(b.options)) return fail(res, 400, 'VALIDATION_FAILED', 'options must be an object');
    const s = source(res, userId, b.sourceId); if (!s) return true;
    const norm = normalizeIcalOptions(b.options);
    const cur = getSyncState(userId, 'ical', s.sourceId);
    const changed = JSON.stringify(norm) !== JSON.stringify(normalizeIcalOptions(cur.options));
    patchSyncState(userId, 'ical', s.sourceId, { options: norm, ...(changed ? { cursor: null } : {}) });
    sendJSON(res, 200, { ok: true, options: norm });
    return true;
  }

  if (req.method === 'POST' && path === '/kb/calendar-ical/sync') {
    const b = await body(req, res); if (!b) return true;
    const s = source(res, userId, b.sourceId); if (!s) return true;
    const k = `${userId}\u0000${s.sourceId}`;
    if (running.has(k)) return fail(res, 409, 'ICAL_SYNC_RUNNING', 'A sync for this calendar feed is already running');
    running.add(k);
    try {
      const state = getSyncState(userId, 'ical', s.sourceId);
      try {
        const r = await syncIcalSource({
          userId, sourceId: s.sourceId, sourceName: s.name, now: clock(), cursor: state.cursor, options: state.options,
          getUrl: () => { const u = getSecret(db, userId, vaultKey(s.sourceId)); if (!u) throw new IcalError('ICAL_URL_INVALID', 'The stored calendar address is missing. Remove the feed and add it again.'); return u; },
        });
        if (r.status === 'revoked') {
          patchSyncState(userId, 'ical', s.sourceId, { status: 'revoked', lastError: 'ICAL_FEED_REVOKED', lastRunAt: nowIso() });
          safeAudit(db, { userId, action: 'connector.sync', resource: `ical:${s.sourceId}`, detail: { status: 'revoked' } });
          return fail(res, 409, 'ICAL_FEED_REVOKED', 'The calendar address no longer works (the secret address was reset or the calendar was removed). Add the new address.');
        }
        patchSyncState(userId, 'ical', s.sourceId, { cursor: r.nextCursor, status: 'idle', lastError: null, lastRunAt: nowIso() });
        safeAudit(db, { userId, action: 'connector.sync', resource: `ical:${s.sourceId}`, detail: { status: r.status, events: r.events, instances: r.instances, cancelled: r.cancelled, removed: r.removed, truncated: r.truncated } });
        if (r.instances > 0) { try { recordActivity({ userId, kind: 'knowledge_updated', title: `Calendar feed: ${r.instances} event${r.instances === 1 ? '' : 's'} updated`, detail: { connector: 'ical', count: r.instances } }); } catch { /* best effort */ } }
        sendJSON(res, 200, { sourceId: s.sourceId, status: r.status, events: r.events, instances: r.instances, cancelled: r.cancelled, removed: r.removed, truncated: r.truncated, warnings: r.warnings });
      } catch (e) {
        try { patchSyncState(userId, 'ical', s.sourceId, { status: 'error', lastError: String(e?.code || 'error'), lastRunAt: nowIso() }); } catch { /* best effort */ }
        return icalFail(res, e, 'sync');
      }
      return true;
    } finally { running.delete(k); }
  }

  return false;
}
