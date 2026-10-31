// The in-repo ICS parser and bounded RRULE expansion (connectors/ical/ics-parse.mjs). Pure; no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcs, readFeed, parseRrule, parseContentLine, parseDuration, resolveZone, wallToUtc, IcsError, cleanText } from '../connectors/ical/ics-parse.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ical');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const NOW = Date.parse('2025-11-10T00:00:00Z');
const win = { windowStartMs: NOW - 30 * 86_400_000, windowEndMs: NOW + 90 * 86_400_000 };
const feed = (t, extra = {}) => readFeed(t, { ...win, ...extra });
const wrap = (...ev) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev.join('\r\n')}\r\nEND:VCALENDAR\r\n`;

test('Google-style feed: recurrence, EXDATE, override, cancelled override, all-day, cancelled single, attendees', () => {
  const r = feed(fx('google-style.ics'));
  const by = (uid) => r.instances.filter((i) => i.uid === uid);
  const standup = by('standup-001@google.com').map((i) => i.start);
  // Mondays 10:00 JST = 01:00Z. Oct 13 .. Feb 2 inside the window; Nov 17 is EXDATE'd, Nov 24 is moved, Dec 1 is cancelled.
  assert.ok(standup.includes('2025-11-03T01:00:00Z'));
  assert.ok(!standup.includes('2025-11-17T01:00:00Z'), 'EXDATE removed');
  assert.ok(!standup.includes('2025-11-24T01:00:00Z'), 'overridden occurrence replaced');
  assert.ok(standup.includes('2025-11-24T06:00:00Z'), 'override at its new time (15:00 JST)');
  assert.ok(!standup.includes('2025-12-01T01:00:00Z'), 'cancelled override removed');
  assert.ok(standup.includes('2025-12-08T01:00:00Z'));
  assert.equal(new Set(standup).size, standup.length, 'no duplicates');
  const moved = by('standup-001@google.com').find((i) => i.start === '2025-11-24T06:00:00Z');
  assert.equal(moved.isOverride, true);
  assert.equal(moved.key, '20251124T010000Z', 'the override keeps the ORIGINAL occurrence as its identity');
  assert.deepEqual(r.tombstones.filter((t) => t.uid === 'standup-001@google.com'), [{ uid: 'standup-001@google.com', key: '20251201T010000Z' }]);
  const first = by('standup-001@google.com')[0];
  assert.equal(first.location, 'Room 4, Floor 2');
  assert.equal(first.attendees.length, 2);
  assert.equal(first.attendees[1].email, 'bob@example.com');
  assert.equal(first.organizer.name, 'Alice Example');
  assert.match(first.description, /Agenda:\n- status/);
  const allDay = by('offsite-002@google.com');
  assert.equal(allDay.length, 1);
  assert.deepEqual([allDay[0].allDay, allDay[0].start, allDay[0].end], [true, '2025-11-20', '2025-11-22']);
  assert.equal(by('cancelled-003@google.com').length, 0);
  assert.ok(r.tombstones.some((t) => t.uid === 'cancelled-003@google.com' && t.key === '20251112T013000Z'));
  assert.equal(by('old-005@google.com').length, 0, 'outside the window');
  assert.equal(by('one-off-004@google.com')[0].attendees[0].name, 'Carol, Example');
});

test('Outlook-style feed: Windows zone names, BYSETPOS, unknown zone is floating and flagged, DURATION', () => {
  const r = feed(fx('outlook-style.ics'));
  const allHands = r.instances.filter((i) => i.summary === 'All hands').map((i) => i.start);
  // Second Wednesday of each month at 14:00 US Eastern: Nov 12 (EST, 19:00Z), Dec 10 (EST), Jan 14 (EST).
  assert.deepEqual(allHands, ['2025-11-12T19:00:00Z', '2025-12-10T19:00:00Z', '2026-01-14T19:00:00Z']);
  const unknown = r.instances.find((i) => i.uid === 'unknown-tz-1');
  assert.equal(unknown.start, '2025-11-13T10:00:00Z');
  assert.ok(unknown.flags.includes('tz_unknown') && unknown.flags.includes('floating'));
  assert.ok(r.warnings.includes('tz_unknown'));
  const floating = r.instances.find((i) => i.uid === 'floating-1');
  assert.deepEqual([floating.start, floating.end], ['2025-11-15T10:00:00Z', '2025-11-15T11:30:00Z']);
  assert.ok(floating.flags.includes('floating'));
});

test('DST: a weekly 09:00 New York event stays at 09:00 local across the November change', () => {
  const r = feed(wrap('BEGIN:VEVENT', 'UID:dst', 'DTSTART;TZID=America/New_York:20251027T090000', 'DTEND;TZID=America/New_York:20251027T100000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:x', 'END:VEVENT'), { windowStartMs: Date.parse('2025-10-01Z') });
  assert.deepEqual(r.instances.map((i) => i.start), ['2025-10-27T13:00:00Z', '2025-11-03T14:00:00Z', '2025-11-10T14:00:00Z']);
});

test('RRULE: UNTIL, INTERVAL, COUNT counted from DTSTART, monthly negative day, yearly leap day, last weekday', () => {
  const ev = (rule, start = '20250101T120000Z') => wrap('BEGIN:VEVENT', 'UID:r', `DTSTART:${start}`, `RRULE:${rule}`, 'SUMMARY:r', 'END:VEVENT');
  const w = { windowStartMs: Date.parse('2025-01-01Z'), windowEndMs: Date.parse('2027-01-01Z') };
  const days = (rule, start) => feed(ev(rule, start), w).instances.map((i) => i.start.slice(0, 10));
  assert.deepEqual(days('FREQ=DAILY;INTERVAL=2;UNTIL=20250107T120000Z'), ['2025-01-01', '2025-01-03', '2025-01-05', '2025-01-07']);
  assert.deepEqual(days('FREQ=DAILY;UNTIL=20250103'), ['2025-01-01', '2025-01-02', '2025-01-03']);
  assert.deepEqual(days('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3'), ['2025-01-31', '2025-02-28', '2025-03-31']);
  assert.deepEqual(days('FREQ=MONTHLY;COUNT=3', '20250131T120000Z'), ['2025-01-31', '2025-03-31', '2025-05-31'], 'months without the 31st are skipped');
  assert.deepEqual(feed(ev('FREQ=YEARLY', '20240229T120000Z'), { windowStartMs: Date.parse('2024-01-01Z'), windowEndMs: Date.parse('2033-01-01Z') }).instances.map((i) => i.start.slice(0, 10)), ['2024-02-29', '2028-02-29', '2032-02-29'], 'leap day only in leap years');
  assert.deepEqual(days('FREQ=MONTHLY;BYDAY=-1FR;COUNT=2'), ['2025-01-31', '2025-02-28']);
  assert.deepEqual(days('FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'), ['2025-03-09', '2026-03-08']);
  assert.deepEqual(days('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2'), ['2025-01-31', '2025-02-28']);
  // COUNT counts occurrences before the window: 5 daily from 2024-12-30, only 3 of them in the window.
  const early = feed(ev('FREQ=DAILY;COUNT=5', '20241230T120000Z'), w).instances.map((i) => i.start.slice(0, 10));
  assert.deepEqual(early, ['2025-01-01', '2025-01-02', '2025-01-03']);
});

test('RRULE: skip-ahead for a long-running rule without COUNT stays inside the window', () => {
  const r = readFeed(wrap('BEGIN:VEVENT', 'UID:old', 'DTSTART:19950101T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,FR', 'SUMMARY:old', 'END:VEVENT'), { windowStartMs: Date.parse('2025-11-01Z'), windowEndMs: Date.parse('2025-11-15Z') });
  assert.deepEqual(r.instances.map((i) => i.start.slice(0, 10)), ['2025-11-03', '2025-11-07', '2025-11-10', '2025-11-14']);
});

test('hostile RRULEs: bounded time, no hang, flagged', () => {
  const t0 = Date.now();
  const r = feed(fx('hostile-rrule.ics'));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.ok(r.warnings.includes('rrule_subdaily'));
  assert.ok(r.warnings.includes('rrule_invalid'));
  assert.ok(r.instances.length <= 5000);
  const per = new Map();
  for (const i of r.instances) per.set(i.uid, (per.get(i.uid) || 0) + 1);
  for (const n of per.values()) assert.ok(n <= 500);
  assert.equal(per.get('h1'), undefined, 'sub-daily rule: only the first instance is kept, and it starts outside the window');
  const inWin = feed(wrap('BEGIN:VEVENT', 'UID:s', 'DTSTART:20251112T010000Z', 'RRULE:FREQ=SECONDLY;COUNT=999999999', 'SUMMARY:s', 'END:VEVENT'));
  assert.equal(inWin.instances.length, 1);
  // the iteration budget is the backstop: a tiny budget stops expansion and says so
  const small = readFeed(fx('hostile-rrule.ics'), { ...win, limits: { maxIterations: 50 } });
  assert.equal(small.truncated, true);
  assert.ok(small.warnings.includes('budget_exhausted'));
});

test('parseRrule: rejects malformed and unsupported parts without throwing', () => {
  assert.ok(parseRrule('FREQ=DAILY').rule);
  assert.deepEqual(parseRrule('FREQ=HOURLY'), { unsupported: 'rrule_subdaily' });
  assert.deepEqual(parseRrule('FREQ=DAILY;BYHOUR=3'), { unsupported: 'rrule_unsupported' });
  for (const bad of ['', 'FREQ', 'INTERVAL=2', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=2;UNTIL=20250101', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;BYDAY=XX', 'FREQ=DAILY;BYMONTH=13', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=DAILY;INTERVAL=99999', 'FREQ=DAILY;BYSETPOS=1,2,3,4,5,6,7,8,9,10,11']) {
    assert.deepEqual(parseRrule(bad), { invalid: true }, bad);
  }
});

test('line unfolding, parameters with quoted colons, TEXT escapes', () => {
  const r = feed(wrap('BEGIN:VEVENT', 'UID:fold', 'DTSTART:20251112T010000Z', 'SUMMARY:A very long su', ' mmary that was fol', '\tded twice', 'DESCRIPTION:a\\nb\\, c\\; d\\\\ e', 'ATTENDEE;CN="Doe: John; Jr.";PARTSTAT=ACCEPTED:mailto:j@example.com', 'END:VEVENT'));
  const i = r.instances[0];
  assert.equal(i.summary, 'A very long summary that was folded twice');
  assert.equal(i.description, 'a\nb, c; d\\ e');
  assert.equal(i.attendees[0].name, 'Doe: John; Jr.');
  assert.deepEqual(parseContentLine('X-FOO;A="1;2":v'), { name: 'X-FOO', params: { A: '1;2' }, value: 'v' });
  assert.equal(parseContentLine('no colon here'), null);
  assert.equal(parseContentLine('BAD NAME:x'), null);
});

test('deeply folded line: oversized property is dropped, the rest survives', () => {
  const folded = ['SUMMARY:start'].concat(Array.from({ length: 5000 }, () => ' ' + 'x'.repeat(100))).join('\r\n');
  const r = feed(wrap('BEGIN:VEVENT', 'UID:fold2', 'DTSTART:20251112T010000Z', folded, 'LOCATION:kept', 'END:VEVENT'));
  assert.ok(r.warnings.includes('oversized_property'));
  assert.equal(r.instances[0].summary, '');
  assert.equal(r.instances[0].location, 'kept');
});

test('nested VCALENDAR and nested VEVENT are ignored', () => {
  const r = feed(fx('nested.ics'));
  assert.deepEqual(r.instances.map((i) => i.uid), ['outer-1']);
  assert.ok(r.warnings.includes('nested_vcalendar'));
});

test('not a calendar: binary, empty and HTML inputs are ICAL_PARSE_FAILED; oversized input is ICAL_TOO_LARGE', () => {
  const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 167 + 13) % 256));
  for (const bad of [binary, '', '<html><body>sign in</body></html>', Buffer.alloc(2000)]) {
    assert.throws(() => parseIcs(bad), (e) => e instanceof IcsError && e.code === 'ICAL_PARSE_FAILED');
  }
  assert.throws(() => parseIcs('BEGIN:VCALENDAR\r\n' + 'X'.repeat(6_100_000)), (e) => e.code === 'ICAL_TOO_LARGE');
});

test('NUL bytes and control characters are stripped, not fatal', () => {
  const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:nul-1\r\nDTSTART:2025111\u00002T010000Z\r\nSUMMARY:Has\u0000NUL\u0007bytes\r\nEND:VEVENT\u0000\r\nEND:VCALENDAR\r\n';
  const r = feed(text);
  assert.equal(r.instances[0].summary, 'HasNULbytes');
  assert.equal(r.instances[0].start, '2025-11-12T01:00:00Z');
});

test('bidi and format characters are removed from text values', () => {
  const rlo = String.fromCodePoint(0x202e); const pdf = String.fromCodePoint(0x202c); const zw = String.fromCodePoint(0x200b); const iso = String.fromCodePoint(0x2066);
  const r = feed(wrap('BEGIN:VEVENT', 'UID:bidi', 'DTSTART:20251112T010000Z', `SUMMARY:Invoice ${rlo}gnp.exe${pdf} review${zw}`, `LOCATION:Room ${iso}1`, 'END:VEVENT'));
  assert.equal(r.instances[0].summary, 'Invoice gnp.exe review');
  assert.equal(r.instances[0].location, 'Room 1');
  assert.equal(cleanText(`a${rlo}b\nc\td`), 'ab\nc\td');
});

test('caps: events, attendees, instances per event and in total', () => {
  const many = Array.from({ length: 30 }, (_, i) => wrap('BEGIN:VEVENT', `UID:e${i}`, 'DTSTART:20251112T010000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:e', 'END:VEVENT').replace(/BEGIN:VCALENDAR[\s\S]*?(?=BEGIN:VEVENT)/, '').replace(/END:VCALENDAR\r\n$/, ''));
  const text = `BEGIN:VCALENDAR\r\n${many.join('')}END:VCALENDAR\r\n`;
  const r = feed(text, { limits: { maxInstancesPerEvent: 10, maxInstances: 100, maxEvents: 20 } });
  assert.ok(r.instances.length <= 100);
  assert.equal(r.truncated, true);
  assert.equal(r.eventCount, 20);
  const att = Array.from({ length: 300 }, (_, i) => `ATTENDEE:mailto:p${i}@example.com`);
  const a = feed(wrap('BEGIN:VEVENT', 'UID:att', 'DTSTART:20251112T010000Z', ...att, 'END:VEVENT')).instances[0];
  assert.equal(a.attendees.length, 100);
  assert.equal(a.attendeeTotal, 300);
});

test('invalid dates and missing DTSTART skip the event only', () => {
  const r = feed(wrap('BEGIN:VEVENT', 'UID:a', 'DTSTART:20251332T010000Z', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:no start', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:c', 'DTSTART:20251112T010000Z', 'SUMMARY:ok', 'END:VEVENT'));
  assert.deepEqual(r.instances.map((i) => i.uid), ['c']);
  assert.ok(r.warnings.includes('event_without_valid_dtstart'));
});

test('zones and durations', () => {
  assert.equal(resolveZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(resolveZone('Tokyo Standard Time'), 'Asia/Tokyo');
  assert.equal(resolveZone('/mozilla.org/20050126_1/Europe/Paris'), 'Europe/Paris');
  assert.equal(resolveZone('Nowhere/Land'), null);
  assert.equal(resolveZone('x'.repeat(500)), null);
  assert.equal(wallToUtc(Date.parse('2025-07-01T12:00:00Z'), 'Asia/Tokyo'), Date.parse('2025-07-01T03:00:00Z'));
  assert.equal(parseDuration('P1DT2H30M'), (86400 + 9000) * 1000);
  assert.equal(parseDuration('PT45M'), 2_700_000);
  assert.equal(parseDuration('P1W'), 604_800_000);
  assert.equal(parseDuration('garbage'), null);
  assert.equal(parseDuration('P'), null);
});

test('ATTACH and URL stay text', () => {
  const r = feed(wrap('BEGIN:VEVENT', 'UID:u', 'DTSTART:20251112T010000Z', 'ATTACH;FMTTYPE=application/pdf:https://evil.example/a.pdf', 'URL:https://evil.example/u', 'END:VEVENT'));
  assert.deepEqual(r.instances[0].attach, ['https://evil.example/a.pdf']);
  assert.equal(r.instances[0].url, 'https://evil.example/u');
});
