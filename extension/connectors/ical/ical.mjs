// iCal feed connector, Pattern A (index into `sources` + scheduled re-fetch). Spec: docs/spec/calendar-ical.md.
//
// One `sources` row group per event INSTANCE inside the window (kind 'doc', ref ical:<sourceId>:<enc uid>:<instance key>),
// the same note shape as the Google Calendar connector with `source: 'ical'` and `untrusted: true`. A sync fetches the
// whole feed (conditional GET), parses and expands it under the hard caps, writes the instances, deletes cancelled ones by
// exact ref, and only after a COMPLETE pass deletes rows the pass did not write again (so an interrupted or truncated pass
// never empties the index). Cursor and health live in connector_sync_state (connector 'ical', account = source id).
import crypto from 'node:crypto';
import { fetchIcal, IcalError, redactIcalSecrets } from './ical-fetch.mjs';
import { parseIcs, expandEvents, IcsError, ICS_LIMITS, cleanText } from './ics-parse.mjs';
import { htmlToMarkdown, escapeMarkdownText } from '../google/html-to-markdown.mjs';
import { chunkLines } from '../git.mjs';
import { ingestSources, deleteSourcesByRef, deleteSourcesByPrefix, deleteSourcesOlderThan } from '../../kb/sources.mjs';
import { getDb } from '../../kb/db.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';

export const LIMITS = Object.freeze({ maxSources: 10, daysBackMax: 365, daysAheadMax: 730, maxInstances: ICS_LIMITS.maxInstances, maxEvents: ICS_LIMITS.maxEvents, maxInstancesPerEvent: ICS_LIMITS.maxInstancesPerEvent, maxAttendees: 100 });

const enc = (s) => encodeURIComponent(String(s));
export const instanceRef = (sourceId, uid, key) => `ical:${sourceId}:${enc(uid)}:${key}`;
export const sourcePrefix = (sourceId) => `ical:${sourceId}:`;
const uidPrefix = (sourceId, uid) => `ical:${sourceId}:${enc(uid)}:`;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const oneLine = (s, n = 300) => redactIcalSecrets(cleanText(String(s ?? '')).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n));

/** Validate and clamp the per-source options. */
export function normalizeIcalOptions(o = {}) {
  const back = Math.round(Number(o?.daysBack)); const ahead = Math.round(Number(o?.daysAhead));
  return {
    daysBack: Number.isFinite(back) ? Math.min(LIMITS.daysBackMax, Math.max(0, back)) : 30,
    daysAhead: Number.isFinite(ahead) ? Math.min(LIMITS.daysAheadMax, Math.max(0, ahead)) : 90,
  };
}

function descriptionMarkdown(d) {
  const s = String(d ?? '');
  if (!s.trim()) return '';
  return /<\/?[a-zA-Z][^>]*>/.test(s) ? htmlToMarkdown(s, { maxChars: 100_000 }) : escapeMarkdownText(s.slice(0, 100_000));
}

/** Pure: one expanded instance to its `sources` rows (chunked). */
export function instanceToRows(inst, { sourceId, sourceName = '' }) {
  const summary = redactSecretsForStorage(oneLine(inst.summary, 300)) || '(no title)';
  const attendees = (inst.attendees || []).slice(0, LIMITS.maxAttendees).map((a) => ({ name: oneLine(a.name, 120), email: oneLine(a.email, 200), response: oneLine(a.response, 20) }));
  const more = Math.max(0, (inst.attendeeTotal || 0) - attendees.length);
  const lines = [`# ${escapeMarkdownText(summary)}`, ''];
  lines.push(`When: ${escapeMarkdownText(`${inst.start} to ${inst.end}`)}`);
  if (inst.location) lines.push(`Where: ${escapeMarkdownText(oneLine(inst.location, 300))}`);
  if (inst.status && inst.status !== 'CONFIRMED') lines.push(`Status: ${escapeMarkdownText(oneLine(inst.status, 30))}`);
  if (inst.organizer && (inst.organizer.email || inst.organizer.name)) lines.push(`Organizer: ${escapeMarkdownText(oneLine(`${inst.organizer.name || ''} <${inst.organizer.email || ''}>`, 300))}`);
  if (attendees.length) {
    lines.push('', 'Attendees:');
    for (const a of attendees) lines.push(`- ${escapeMarkdownText(a.name ? `${a.name} <${a.email}>` : a.email)}${a.response ? ` (${escapeMarkdownText(a.response)})` : ''}`);
    if (more) lines.push(`- ... ${more} more`);
  }
  const links = [inst.url, ...(inst.attach || [])].filter(Boolean).slice(0, 6).map((u) => oneLine(u, 500));
  if (links.length) lines.push('', 'Links (text only, never opened by LLM-IDE):', ...links.map((u) => `- ${escapeMarkdownText(u)}`));
  const desc = descriptionMarkdown(inst.description);
  if (desc) lines.push('', 'Description:', '', desc);
  const text = redactIcalSecrets(redactSecretsForStorage(lines.join('\n')));
  const ref = instanceRef(sourceId, inst.uid, inst.key);
  const meta = {
    source: 'ical', untrusted: true, sourceId, sourceName: oneLine(sourceName, 100), uid: oneLine(inst.uid, 200), instance: inst.key,
    start: inst.start, end: inst.end, allDay: inst.allDay, status: (inst.status || 'CONFIRMED').toLowerCase(),
    location: redactSecretsForStorage(oneLine(inst.location, 300)), attendees: attendees.map((a) => ({ ...a, name: redactSecretsForStorage(a.name) })),
    recurring: inst.recurring === true, override: inst.isOverride === true, flags: inst.flags || [], link: oneLine(inst.url, 500) || null,
  };
  return chunkLines(text).map((c, idx) => ({ kind: 'doc', ref, chunkIdx: idx, title: summary, body: c.body, meta: { ...meta, startLine: c.startLine, endLine: c.endLine } }));
}

const parseCursor = (c) => { try { const v = JSON.parse(c); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One sync of one feed. `getUrl()` returns the secret URL from the vault; nothing here stores or returns it.
 * @returns {Promise<{ status: 'ok'|'not_modified'|'unchanged'|'revoked', events: number, instances: number, cancelled: number,
 *   removed: number, truncated: boolean, warnings: string[], nextCursor: string|null }>}
 */
export async function syncIcalSource({ userId, sourceId, sourceName, getUrl, cursor, options: rawOptions, now = Date.now(), sleepImpl, env, limits = {} }) {
  const options = normalizeIcalOptions(rawOptions);
  const cur = parseCursor(cursor);
  const windowKey = `${dayKey(now)}|${options.daysBack}|${options.daysAhead}`;
  const sameWindow = cur.windowKey === windowKey;
  const r = await fetchIcal(getUrl(), { etag: sameWindow ? cur.etag : null, lastModified: sameWindow ? cur.lastModified : null, sleepImpl, env });
  const base = { events: 0, instances: 0, cancelled: 0, removed: 0, truncated: false, warnings: [] };
  if (r.revoked) return { ...base, status: 'revoked', nextCursor: cursor ?? null };
  if (r.notModified) return { ...base, status: 'not_modified', nextCursor: cursor ?? null };
  const hash = crypto.createHash('sha256').update(r.text).digest('hex');
  if (sameWindow && cur.hash === hash && cur.complete === true) {
    return { ...base, status: 'unchanged', nextCursor: JSON.stringify({ ...cur, etag: r.etag ?? cur.etag ?? null, lastModified: r.lastModified ?? cur.lastModified ?? null }) };
  }
  let parsed;
  try { parsed = parseIcs(r.text, limits); } catch (e) {
    if (e instanceof IcsError) throw new IcalError(e.code, e.code === 'ICAL_TOO_LARGE' ? 'The calendar feed is too large.' : 'The address did not return a calendar feed (it may have been reset).');
    throw e;
  }
  const ex = expandEvents(parsed.events, { windowStartMs: now - options.daysBack * 86_400_000, windowEndMs: now + options.daysAhead * 86_400_000, limits });
  const truncated = parsed.truncated || ex.truncated;
  // Real clock: indexed_at is datetime('now'); the injected `now` only moves the window.
  const startedAt = sqlTime(Date.now());
  const rows = [];
  const refs = [];
  for (const inst of ex.instances) { refs.push(instanceRef(sourceId, inst.uid, inst.key)); rows.push(...instanceToRows(inst, { sourceId, sourceName })); }
  let cancelled = 0;
  const db = getDb();
  db.transaction(() => {
    for (const t of ex.tombstones) {
      cancelled += 1;
      if (t.key) deleteSourcesByRef(userId, 'doc', instanceRef(sourceId, t.uid, t.key));
      else deleteSourcesByPrefix(userId, 'doc', uidPrefix(sourceId, t.uid));
    }
    for (const ref of refs) deleteSourcesByRef(userId, 'doc', ref);
    for (let i = 0; i < rows.length; i += 1000) ingestSources(userId, rows.slice(i, i + 1000));
  })();
  let removed = 0;
  // Only a complete pass may drop what it did not see again; a truncated one keeps everything.
  if (!truncated) removed = deleteSourcesOlderThan(userId, 'doc', sourcePrefix(sourceId), startedAt);
  const warnings = [...new Set([...parsed.warnings, ...ex.warnings])];
  return {
    status: 'ok', events: parsed.events.length, instances: ex.instances.length, cancelled, removed, truncated, warnings,
    nextCursor: JSON.stringify({ etag: r.etag ?? null, lastModified: r.lastModified ?? null, hash, windowKey, complete: !truncated }),
  };
}

/** Purge a source's cached rows (all of them, by prefix). */
export function purgeIcalRows(userId, sourceId) {
  return deleteSourcesByPrefix(userId, 'doc', sourcePrefix(sourceId));
}
