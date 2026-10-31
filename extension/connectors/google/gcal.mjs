// Google Calendar connector, Pattern A (index into `sources` + scheduled re-fetch), Calendar REST API v3, read-only.
// Plan 2026-10-31-google-connectors-plan.md sections 3 to 6.
//
// One `sources` row group per EVENT (kind 'doc', ref gcal:<accountId>:<calendarId>:<eventId>), recurring events expanded
// into instances inside the window (singleEvents=true). Incremental by `syncToken` per calendar: a 410 clears the token
// and runs a full resync, which drops what it did not see again only AFTER the pass finished (so an interrupted resync
// never empties the index). Cancelled events delete their rows (tombstones). A run is capped; an unfinished run keeps its
// page token and reports `pending`.
//
// Attendee addresses are kept (they are the point of a meeting note); every text field is redacted with the shared
// storage redactor, the description is HTML-converted without ever loading remote content, and conference or event links
// are stored as text only: the core never fetches a URL found in an event.
import { googleCall, apiUrl } from './google-fetch.mjs';
import { htmlToMarkdown, escapeMarkdownText } from './html-to-markdown.mjs';
import { chunkLines } from '../git.mjs';
import { ingestSources, deleteSourcesByRef, deleteSourcesOlderThan } from '../../kb/sources.mjs';
import { getDb } from '../../kb/db.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';

export const CAL_API = 'https://www.googleapis.com/calendar/v3';
export const LIMITS = Object.freeze({ maxEventsPerRun: 2000, maxCalendars: 20, pageSize: 250, maxAttendees: 100, daysBackMax: 365, daysAheadMax: 730 });

const EVENT_FIELDS = 'nextPageToken,nextSyncToken,items(id,status,summary,description,location,start,end,attendees(email,displayName,responseStatus,organizer,self),'
  + 'organizer(email,displayName),htmlLink,hangoutLink,conferenceData(entryPoints(uri,entryPointType)),recurringEventId,updated,eventType)';

const CAL_ID_RE = /^[^\x00-\x1f\x7f]{1,200}$/;

/** Validate and clamp the per-account Calendar options. */
export function normalizeCalendarOptions(o = {}) {
  const ids = Array.isArray(o.calendarIds) ? [...new Set(o.calendarIds.map(String).filter((s) => CAL_ID_RE.test(s)))].slice(0, LIMITS.maxCalendars) : [];
  const back = Math.round(Number(o.daysBack)); const ahead = Math.round(Number(o.daysAhead));
  return {
    calendarIds: ids.length ? ids : ['primary'],
    daysBack: Number.isFinite(back) ? Math.min(LIMITS.daysBackMax, Math.max(0, back)) : 30,
    daysAhead: Number.isFinite(ahead) ? Math.min(LIMITS.daysAheadMax, Math.max(0, ahead)) : 90,
  };
}

const enc = (s) => encodeURIComponent(String(s));
export const eventRef = (accountId, calendarId, eventId) => `gcal:${accountId}:${enc(calendarId)}:${enc(eventId)}`;
const calPrefix = (accountId, calendarId) => `gcal:${accountId}:${enc(calendarId)}:`;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

const when = (t) => (t && typeof t === 'object' ? (t.dateTime || t.date || null) : null);
const oneLine = (s, n = 300) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function descriptionMarkdown(d) {
  const s = String(d ?? '');
  if (!s.trim()) return '';
  return /<\/?[a-zA-Z][^>]*>/.test(s) ? htmlToMarkdown(s, { maxChars: 100_000 }) : escapeMarkdownText(s.slice(0, 100_000));
}

/** Pure: one Calendar event to its `sources` rows (chunked), or null for a cancelled event. */
export function eventToRows(ev, { accountId, calendarId }) {
  if (!ev || typeof ev.id !== 'string' || ev.status === 'cancelled') return null;
  const start = when(ev.start); const end = when(ev.end);
  const summary = redactSecretsForStorage(oneLine(ev.summary, 300)) || '(no title)';
  const attendees = (Array.isArray(ev.attendees) ? ev.attendees : []).slice(0, LIMITS.maxAttendees).map((a) => ({
    name: oneLine(a.displayName, 120), email: oneLine(a.email, 200), response: oneLine(a.responseStatus, 20), organizer: a.organizer === true, self: a.self === true,
  }));
  const more = Math.max(0, (Array.isArray(ev.attendees) ? ev.attendees.length : 0) - attendees.length);
  const links = [ev.hangoutLink, ...(ev.conferenceData?.entryPoints || []).map((e) => e?.uri)].filter((u) => typeof u === 'string' && u).slice(0, 5).map((u) => oneLine(u, 500));
  const lines = [`# ${escapeMarkdownText(summary)}`, ''];
  lines.push(`When: ${escapeMarkdownText(`${start || '?'} to ${end || '?'}`)}`);
  if (ev.location) lines.push(`Where: ${escapeMarkdownText(oneLine(ev.location, 300))}`);
  if (ev.status && ev.status !== 'confirmed') lines.push(`Status: ${escapeMarkdownText(oneLine(ev.status, 30))}`);
  if (ev.organizer?.email || ev.organizer?.displayName) lines.push(`Organizer: ${escapeMarkdownText(oneLine(`${ev.organizer.displayName || ''} <${ev.organizer.email || ''}>`, 300))}`);
  if (attendees.length) {
    lines.push('', 'Attendees:');
    for (const a of attendees) lines.push(`- ${escapeMarkdownText(a.name ? `${a.name} <${a.email}>` : a.email)}${a.response ? ` (${escapeMarkdownText(a.response)})` : ''}`);
    if (more) lines.push(`- ... ${more} more`);
  }
  if (links.length) lines.push('', 'Links (text only, never opened by LLM-IDE):', ...links.map((u) => `- ${escapeMarkdownText(u)}`));
  const desc = descriptionMarkdown(ev.description);
  if (desc) lines.push('', 'Description:', '', desc);
  const text = redactSecretsForStorage(lines.join('\n'));
  const ref = eventRef(accountId, calendarId, ev.id);
  const meta = {
    source: 'gcal', untrusted: true, accountId, calendarId, eventId: ev.id, start, end, status: ev.status || 'confirmed',
    location: redactSecretsForStorage(oneLine(ev.location, 300)), attendees: attendees.map((a) => ({ ...a, name: redactSecretsForStorage(a.name) })),
    recurringEventId: ev.recurringEventId || null, updated: ev.updated || null, link: typeof ev.htmlLink === 'string' ? oneLine(ev.htmlLink, 500) : null,
  };
  return chunkLines(text).map((c, idx) => ({ kind: 'doc', ref, chunkIdx: idx, title: summary, body: c.body, meta: { ...meta, startLine: c.startLine, endLine: c.endLine } }));
}

const parseCursor = (c) => { try { const v = JSON.parse(c); return v && typeof v === 'object' && v.cals && typeof v.cals === 'object' ? v : { cals: {} }; } catch { return { cals: {} }; } };

/** The user's calendars, for the options picker (needs calendar.calendarlist.readonly). */
export async function listCalendars({ session, sleepImpl }) {
  const out = []; let pageToken;
  for (let i = 0; i < 3; i++) {
    const page = await googleCall(session, apiUrl(`${CAL_API}/users/me/calendarList`, { maxResults: 250, pageToken, minAccessRole: 'reader', fields: 'nextPageToken,items(id,summary,primary,accessRole)' }), { sleepImpl });
    for (const c of Array.isArray(page.items) ? page.items : []) if (c?.id) out.push({ id: String(c.id), summary: oneLine(c.summary, 200), primary: c.primary === true, accessRole: oneLine(c.accessRole, 20) });
    pageToken = page.nextPageToken; if (!pageToken) break;
  }
  return out;
}

async function syncOne({ session, userId, accountId, calendarId, st, options, now, budget, sleepImpl }) {
  const res = { calendarId, mode: st.syncToken ? 'incremental' : 'full', events: 0, cancelled: 0, resynced: false, pending: false };
  let state = { ...st };
  let restarts = 0;
  for (;;) {
    const incremental = !!state.syncToken;
    if (!incremental && !state.full) {
      state.full = { startedAt: sqlTime(now), timeMin: new Date(now - options.daysBack * 86_400_000).toISOString(), timeMax: new Date(now + options.daysAhead * 86_400_000).toISOString() };
    }
    res.mode = incremental ? 'incremental' : 'full';
    try {
      for (;;) {
        const page = await googleCall(session, apiUrl(`${CAL_API}/calendars/${enc(calendarId)}/events`, {
          singleEvents: true, showDeleted: true, maxResults: LIMITS.pageSize, fields: EVENT_FIELDS, pageToken: state.pageToken,
          ...(incremental ? { syncToken: state.syncToken } : { timeMin: state.full.timeMin, timeMax: state.full.timeMax }),
        }), { sleepImpl });
        const rows = []; const refs = [];
        for (const ev of Array.isArray(page.items) ? page.items : []) {
          if (!ev || typeof ev.id !== 'string') continue;
          const ref = eventRef(accountId, calendarId, ev.id);
          refs.push(ref);
          const r = eventToRows(ev, { accountId, calendarId });
          if (r) { rows.push(...r); res.events += 1; } else res.cancelled += 1;
        }
        if (refs.length) getDb().transaction(() => { for (const ref of refs) deleteSourcesByRef(userId, 'doc', ref); if (rows.length) ingestSources(userId, rows); })();
        budget.left -= refs.length;
        if (page.nextPageToken) {
          state.pageToken = page.nextPageToken;
          if (budget.left <= 0) { res.pending = true; return { res, state }; }
          continue;
        }
        if (!page.nextSyncToken) throw new Error('no nextSyncToken');
        if (state.full) deleteSourcesOlderThan(userId, 'doc', calPrefix(accountId, calendarId), state.full.startedAt);
        return { res, state: { syncToken: String(page.nextSyncToken) } };
      }
    } catch (e) {
      if (e?.status === 410 && restarts < 2) { restarts += 1; res.resynced = true; state = {}; continue; } // token or page token expired: full resync
      throw e;
    }
  }
}

/**
 * One capped Calendar run over the selected calendars.
 * @param {{ session: object, userId: string, accountId: string, cursor: string|null, options: object, now?: number, sleepImpl?: Function, limits?: object }} o
 * @returns {Promise<{ calendars: object[], nextCursor: string, pending: boolean, events: number, cancelled: number }>}
 */
export async function syncCalendars({ session, userId, accountId, cursor, options: rawOptions, now = Date.now(), sleepImpl, limits = {} }) {
  const options = normalizeCalendarOptions(rawOptions);
  const cur = parseCursor(cursor);
  const budget = { left: limits.maxEventsPerRun ?? LIMITS.maxEventsPerRun };
  const cals = {}; const calendars = [];
  let pending = false;
  for (const calendarId of options.calendarIds) {
    if (budget.left <= 0) { cals[calendarId] = cur.cals[calendarId] || {}; pending = true; continue; }
    const { res, state } = await syncOne({ session, userId, accountId, calendarId, st: cur.cals[calendarId] || {}, options, now, budget, sleepImpl });
    cals[calendarId] = state; calendars.push(res); if (res.pending) pending = true;
  }
  // a calendar the user deselected loses its cursor but keeps its rows (deselect never deletes data)
  return {
    calendars, nextCursor: JSON.stringify({ cals }), pending,
    events: calendars.reduce((a, c) => a + c.events, 0), cancelled: calendars.reduce((a, c) => a + c.cancelled, 0),
  };
}
