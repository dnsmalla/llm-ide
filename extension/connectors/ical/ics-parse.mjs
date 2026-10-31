// A safe, dependency-free iCalendar (RFC 5545) reader for untrusted feeds. Spec: docs/spec/calendar-ical.md.
//
// Everything here is bounded: input size, line count, logical line length, property parameters, components, events,
// per-event and total instances, and CPU (a shared iteration budget plus a wall-clock deadline). A hostile feed can make
// the result smaller (flagged `truncated` / a warning code) but never hangs the process or allocates without limit.
//
// Nothing in the content is ever fetched: URL and ATTACH values are returned as text. Recurrence rules are expanded only
// inside the sync window. FREQ below DAILY, BYWEEKNO/BYYEARDAY/BYHOUR/BYMINUTE/BYSECOND and unparsable rules are NOT
// expanded: the event keeps its first instance and carries a warning code, so a `FREQ=SECONDLY;COUNT=999999999` costs one
// parse and nothing else.
//
// Time zones: UTC, floating, IANA TZIDs (through Intl.DateTimeFormat) and a small map of Windows zone names. An unknown
// TZID is treated as floating (read as UTC) and flagged `tz_unknown`.

export class IcsError extends Error {
  /** @param {string} code ICAL_PARSE_FAILED | ICAL_TOO_LARGE */
  constructor(code, message) { super(message); this.name = 'IcsError'; this.code = code; }
}

export const ICS_LIMITS = Object.freeze({
  maxInputChars: 6_000_000, maxLines: 400_000, maxLineChars: 16_384, maxParams: 16, maxParamChars: 256, maxDepth: 6,
  maxEvents: 5_000, maxInstancesPerEvent: 500, maxInstances: 5_000, maxAttendees: 100, maxExdates: 1_000, maxRdates: 500,
  maxBySetPos: 10, maxByDay: 20, maxIterations: 1_000_000, maxPeriods: 100_000, deadlineMs: 8_000,
  summaryChars: 300, descriptionChars: 100_000, locationChars: 300,
});

const DAY = 86_400_000;

// ---------------------------------------------------------------- civil date arithmetic (proleptic Gregorian)
export function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}
export function civilFromDays(z0) {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const dowOfDay = (day) => (((day + 4) % 7) + 7) % 7; // 0 = Sunday
const mod = (a, n) => ((a % n) + n) % n;

// ---------------------------------------------------------------- time zones
const WINDOWS_ZONES = {
  'utc': 'UTC', 'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver', 'pacific standard time': 'America/Los_Angeles', 'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu', 'atlantic standard time': 'America/Halifax', 'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris', 'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw', 'russian standard time': 'Europe/Moscow', 'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul', 'china standard time': 'Asia/Shanghai', 'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata', 'aus eastern standard time': 'Australia/Sydney', 'e. australia standard time': 'Australia/Brisbane',
};
const zoneCache = new Map();
const fmtCache = new Map();

function intlOk(name) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true; } catch { return false; }
}

/** TZID text to an IANA zone name ('UTC' included), or null when unknown. Bounded cache. */
export function resolveZone(tzid) {
  const raw = String(tzid ?? '').trim().slice(0, 100);
  if (!raw) return null;
  if (zoneCache.has(raw)) return zoneCache.get(raw);
  let out = null;
  const lower = raw.toLowerCase();
  if (lower === 'utc' || lower === 'gmt' || lower === 'z') out = 'UTC';
  else if (/^[A-Za-z0-9_+\-/]{1,60}$/.test(raw) && intlOk(raw)) out = raw;
  else if (WINDOWS_ZONES[lower]) out = WINDOWS_ZONES[lower];
  else if (raw.includes('/')) {
    // "/mozilla.org/20050126_1/Europe/Paris" style prefixes: try the last two, then the last three segments.
    const segs = raw.split('/').filter(Boolean);
    for (const n of [2, 3]) {
      const cand = segs.slice(-n).join('/');
      if (segs.length >= n && /^[A-Za-z0-9_+\-/]{1,60}$/.test(cand) && intlOk(cand)) { out = cand; break; }
    }
  }
  if (zoneCache.size > 200) zoneCache.clear();
  zoneCache.set(raw, out);
  return out;
}

function formatter(zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    if (fmtCache.size > 50) fmtCache.clear();
    fmtCache.set(zone, f);
  }
  return f;
}

/** Offset (zone minus UTC) in ms at the instant `utcMs`. */
export function zoneOffsetMs(zone, utcMs) {
  if (!zone || zone === 'UTC') return 0;
  const p = {};
  for (const part of formatter(zone).formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock reading (milliseconds as if UTC) in `zone` to a real UTC instant. */
export function wallToUtc(wall, zone) {
  if (!zone || zone === 'UTC') return wall;
  const first = wall - zoneOffsetMs(zone, wall);
  return wall - zoneOffsetMs(zone, first);
}
const utcToWall = (utc, zone) => utc + zoneOffsetMs(zone, utc);

// ---------------------------------------------------------------- text helpers
const CTRL_LINE_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Strips control, format (bidi, zero width) and line/paragraph separator characters, keeping \n and \t. */
export function cleanText(s) {
  return String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''));
}

/** RFC 5545 TEXT unescape (\n \N \, \; \\). Anything else after a backslash is kept as the character. */
export function unescapeText(v) {
  return String(v).replace(/\\([\s\S])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// ---------------------------------------------------------------- content lines
function* logicalLines(text, limits, warn) {
  const re = /\r\n|\n|\r/g;
  let pos = 0; let cur = null; let over = false; let lines = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(text);
    const end = m ? m.index : text.length;
    const phys = text.slice(pos, end);
    lines += 1;
    if (lines > limits.maxLines) throw new IcsError('ICAL_PARSE_FAILED', 'too many lines');
    if (phys.length && (phys[0] === ' ' || phys[0] === '\t') && cur !== null) {
      if (!over) {
        if (cur.length + phys.length - 1 > limits.maxLineChars) { over = true; warn('oversized_property'); } else cur += phys.slice(1);
      }
    } else {
      if (cur !== null && !over) yield cur;
      cur = phys; over = false;
      if (cur.length > limits.maxLineChars) { over = true; warn('oversized_property'); }
    }
    if (!m) break;
    pos = m.index + m[0].length;
  }
  if (cur !== null && !over) yield cur;
}

/** One unfolded content line to { name, params, value }, or null when malformed. */
export function parseContentLine(line0, limits = ICS_LIMITS) {
  const line = line0.replace(CTRL_LINE_RE, '');
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ';' && line[i] !== ':') i += 1;
  const name = line.slice(0, i).toUpperCase();
  if (!/^[A-Z0-9-]{1,40}$/.test(name)) return null;
  const params = {};
  let count = 0;
  while (i < n && line[i] === ';') {
    i += 1;
    const ps = i;
    while (i < n && line[i] !== '=' && line[i] !== ';' && line[i] !== ':') i += 1;
    if (line[i] !== '=') return null;
    const pname = line.slice(ps, i).toUpperCase();
    i += 1;
    let v = ''; let inQ = false;
    while (i < n && (inQ || (line[i] !== ';' && line[i] !== ':'))) {
      if (line[i] === '"') inQ = !inQ; else v += line[i];
      i += 1;
    }
    count += 1;
    if (count > limits.maxParams) return null;
    if (/^[A-Z0-9-]{1,40}$/.test(pname) && !(pname in params)) params[pname] = v.slice(0, limits.maxParamChars);
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

// ---------------------------------------------------------------- date values
const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i;

/**
 * An iCalendar DATE or DATE-TIME property to { wall, allDay, zone, floating, tzUnknown }, or null when invalid.
 * `wall` is milliseconds as if the reading were UTC; for a real instant use wallToUtc(wall, zone).
 */
export function parseDateValue(prop) {
  if (!prop) return null;
  const m = DT_RE.exec(String(prop.value).trim());
  if (!m) return null;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const dateOnly = m[4] === undefined || String(prop.params?.VALUE || '').toUpperCase() === 'DATE';
  if (dateOnly) return { wall: daysFromCivil(y, mo, d) * DAY, allDay: true, zone: null, floating: false, tzUnknown: false };
  const hh = +m[4]; const mi = +m[5]; const ss = Math.min(+m[6], 59);
  if (hh > 23 || mi > 59) return null;
  const wall = daysFromCivil(y, mo, d) * DAY + ((hh * 60 + mi) * 60 + ss) * 1000;
  if (m[7]) return { wall, allDay: false, zone: 'UTC', floating: false, tzUnknown: false };
  const tzid = prop.params?.TZID;
  if (!tzid) return { wall, allDay: false, zone: null, floating: true, tzUnknown: false };
  const zone = resolveZone(tzid);
  if (!zone) return { wall, allDay: false, zone: null, floating: true, tzUnknown: true };
  return { wall, allDay: false, zone, floating: false, tzUnknown: false };
}

/** DURATION value (P1W, P1DT2H30M, PT45M) to milliseconds, or null. */
export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d{1,4})W)?(?:(\d{1,5})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/i.exec(String(v).trim());
  if (!m || /^[+-]?P$/i.test(String(v).trim())) return null;
  const ms = ((+(m[2] || 0)) * 7 + (+(m[3] || 0))) * DAY + ((+(m[4] || 0)) * 3600 + (+(m[5] || 0)) * 60 + (+(m[6] || 0))) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---------------------------------------------------------------- event extraction
const emailOf = (v) => {
  const e = String(v ?? '').replace(/^mailto:/i, '').trim();
  return /^[^\s@<>"]{1,100}@[^\s@<>"]{1,150}$/.test(e) ? e : '';
};
const person = (p) => ({ name: cleanText(p.params?.CN || '').slice(0, 120), email: emailOf(p.value), response: cleanText(p.params?.PARTSTAT || '').toUpperCase().slice(0, 20) });

function newDraft() {
  return { props: {}, attendees: [], attendeeTotal: 0, exdates: [], rdates: [], attach: [], warnings: new Set() };
}

function finalizeEvent(d, limits, warn) {
  const get = (k) => d.props[k];
  const start = parseDateValue(get('DTSTART'));
  if (!start) { warn('event_without_valid_dtstart'); return null; }
  const flags = [];
  if (start.floating) flags.push('floating');
  if (start.tzUnknown) flags.push('tz_unknown');
  let end = parseDateValue(get('DTEND'));
  if (get('DTEND') && !end) flags.push('bad_dtend');
  let durationMs = null;
  if (!end && get('DURATION')) durationMs = parseDuration(get('DURATION').value);
  if (end && end.tzUnknown) flags.push('tz_unknown');
  if (end && (end.allDay !== start.allDay)) end = null; // mixed value types: ignore DTEND
  let recurrenceId = null;
  if (get('RECURRENCE-ID')) {
    recurrenceId = parseDateValue(get('RECURRENCE-ID'));
    if (!recurrenceId) flags.push('bad_recurrence_id');
    else if (String(get('RECURRENCE-ID').params?.RANGE || '').toUpperCase() === 'THISANDFUTURE') flags.push('recurrence_range_ignored');
  }
  let uid = cleanText(get('UID')?.value || '').trim().slice(0, 200);
  if (!uid) uid = `noid-${Math.abs(hash32(`${get('DTSTART')?.value}|${get('SUMMARY')?.value || ''}`)).toString(16)}`;
  const status = cleanText(get('STATUS')?.value || '').trim().toUpperCase().slice(0, 20);
  const text = (k, max) => cleanText(unescapeText(get(k)?.value ?? '')).slice(0, max);
  const rr = get('RRULE')?.value ? String(get('RRULE').value).slice(0, 500) : null;
  return {
    uid, recurrenceId, start, end, durationMs, status: status || 'CONFIRMED',
    summary: text('SUMMARY', limits.summaryChars), description: cleanText(unescapeText(get('DESCRIPTION')?.value ?? '')).slice(0, limits.descriptionChars),
    location: text('LOCATION', limits.locationChars),
    organizer: get('ORGANIZER') ? person(get('ORGANIZER')) : null,
    attendees: d.attendees, attendeeTotal: d.attendeeTotal,
    rrule: rr, exdates: d.exdates, rdates: d.rdates,
    url: text('URL', 500), attach: d.attach, sequence: Number.parseInt(get('SEQUENCE')?.value, 10) || 0,
    flags,
  };
}

function hash32(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }

/**
 * Parse a feed into raw events. Throws IcsError (ICAL_PARSE_FAILED when it is not an iCalendar document, ICAL_TOO_LARGE
 * over the input cap).
 * @returns {{ events: object[], truncated: boolean, warnings: string[] }}
 */
export function parseIcs(input, limitsIn = {}) {
  const limits = { ...ICS_LIMITS, ...limitsIn };
  const text0 = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  if (text0.length > limits.maxInputChars) throw new IcsError('ICAL_TOO_LARGE', 'feed is too large');
  const text = text0.replace(/^\uFEFF/, '');
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096).replace(/\u0000/g, ''))) throw new IcsError('ICAL_PARSE_FAILED', 'not an iCalendar document');
  const warnings = new Set();
  const warn = (c) => warnings.add(c);
  const events = [];
  let truncated = false;
  const stack = [];
  let draft = null;
  let sawEvent = false;
  for (const line of logicalLines(text, limits, warn)) {
    const p = parseContentLine(line, limits);
    if (!p) { if (line.trim()) warn('malformed_line'); continue; }
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      if (!/^[A-Z0-9-]{1,40}$/.test(comp)) { warn('malformed_line'); continue; }
      if (comp === 'VCALENDAR' && stack.includes('VCALENDAR')) warn('nested_vcalendar');
      if (stack.length >= limits.maxDepth) { warn('too_deep'); stack.push('?'); continue; }
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') {
        sawEvent = true;
        if (events.length >= limits.maxEvents) { truncated = true; draft = null; } else draft = newDraft();
      }
      continue;
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      const idx = stack.lastIndexOf(comp);
      if (idx === -1) continue;
      const wasEvent = comp === 'VEVENT' && idx === 1 && stack[0] === 'VCALENDAR';
      stack.length = idx;
      if (wasEvent && draft) { const ev = finalizeEvent(draft, limits, warn); if (ev) events.push(ev); draft = null; }
      continue;
    }
    if (!draft || stack.length !== 2 || stack[1] !== 'VEVENT') continue;
    const d = draft;
    switch (p.name) {
      case 'ATTENDEE':
        d.attendeeTotal += 1;
        if (d.attendees.length < limits.maxAttendees) d.attendees.push(person(p));
        break;
      case 'EXDATE':
        for (const v of p.value.split(',')) { if (d.exdates.length >= limits.maxExdates) { warn('exdate_cap'); break; } const x = parseDateValue({ params: p.params, value: v }); if (x) d.exdates.push(x); }
        break;
      case 'RDATE':
        if (String(p.params.VALUE || '').toUpperCase() === 'PERIOD') { warn('rdate_period_ignored'); break; }
        for (const v of p.value.split(',')) { if (d.rdates.length >= limits.maxRdates) { warn('rdate_cap'); break; } const x = parseDateValue({ params: p.params, value: v }); if (x) d.rdates.push(x); }
        break;
      case 'ATTACH':
        if (d.attach.length < 5) d.attach.push(cleanText(p.value).slice(0, 300)); // text only, never fetched
        break;
      case 'DTSTART': case 'DTEND': case 'DURATION': case 'RRULE': case 'UID': case 'RECURRENCE-ID': case 'SUMMARY': case 'DESCRIPTION':
      case 'LOCATION': case 'STATUS': case 'ORGANIZER': case 'URL': case 'SEQUENCE':
        if (!(p.name in d.props)) d.props[p.name] = p;
        break;
      default:
    }
  }
  if (!sawEvent && !/BEGIN:VCALENDAR/i.test(text)) throw new IcsError('ICAL_PARSE_FAILED', 'no calendar found');
  return { events, truncated, warnings: [...warnings] };
}

// ---------------------------------------------------------------- RRULE
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const UNSUPPORTED_PARTS = new Set(['BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']);

const intList = (s, lo, hi, max) => {
  const out = [];
  for (const t of String(s).split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(t)) return null;
    const v = Number(t);
    if (v < lo || v > hi || v === 0) return null;
    out.push(v);
    if (out.length > max) return null;
  }
  return out.length ? [...new Set(out)] : null;
};

/** RRULE text to a normalised rule, or { unsupported: code } / { invalid: true }. */
export function parseRrule(text, limits = ICS_LIMITS) {
  const parts = {};
  for (const seg of String(text).split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 1) return { invalid: true };
    const k = seg.slice(0, eq).trim().toUpperCase();
    if (k in parts) return { invalid: true };
    parts[k] = seg.slice(eq + 1).trim().toUpperCase();
  }
  if (Object.keys(parts).some((k) => UNSUPPORTED_PARTS.has(k))) return { unsupported: 'rrule_unsupported' };
  const freq = parts.FREQ;
  if (!freq) return { invalid: true };
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return { unsupported: freq === 'SECONDLY' || freq === 'MINUTELY' || freq === 'HOURLY' ? 'rrule_subdaily' : 'rrule_invalid' };
  const rule = { freq, interval: 1, count: null, until: null, byDay: null, byMonthDay: null, byMonth: null, bySetPos: null, wkst: 1 };
  if (parts.INTERVAL !== undefined) { if (!/^\d{1,4}$/.test(parts.INTERVAL) || +parts.INTERVAL < 1) return { invalid: true }; rule.interval = +parts.INTERVAL; }
  if (parts.COUNT !== undefined) { if (!/^\d{1,10}$/.test(parts.COUNT) || +parts.COUNT < 1) return { invalid: true }; rule.count = +parts.COUNT; }
  if (parts.UNTIL !== undefined) { const u = parseDateValue({ params: {}, value: parts.UNTIL }); if (!u) return { invalid: true }; rule.until = u; }
  if (rule.count !== null && rule.until) return { invalid: true };
  if (parts.BYDAY !== undefined) {
    const out = [];
    for (const t of parts.BYDAY.split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(t);
      if (!m) return { invalid: true };
      const ord = m[1] ? Number(m[1]) : 0;
      if (m[1] && (ord === 0 || Math.abs(ord) > 53)) return { invalid: true };
      out.push({ ord, dow: DOW[m[2]] });
      if (out.length > limits.maxByDay) return { invalid: true };
    }
    rule.byDay = out;
  }
  if (parts.BYMONTHDAY !== undefined) { rule.byMonthDay = intList(parts.BYMONTHDAY, -31, 31, 31); if (!rule.byMonthDay) return { invalid: true }; }
  if (parts.BYMONTH !== undefined) { rule.byMonth = intList(parts.BYMONTH, 1, 12, 12); if (!rule.byMonth || rule.byMonth.some((v) => v < 1)) return { invalid: true }; }
  if (parts.BYSETPOS !== undefined) { rule.bySetPos = intList(parts.BYSETPOS, -366, 366, limits.maxBySetPos); if (!rule.bySetPos) return { invalid: true }; }
  if (parts.WKST !== undefined) { if (!(parts.WKST in DOW)) return { invalid: true }; rule.wkst = DOW[parts.WKST]; }
  return { rule };
}

class Budget {
  constructor(limits) { this.left = limits.maxIterations; this.deadline = Date.now() + limits.deadlineMs; this.exhausted = false; this.ticks = 0; }
  tick() {
    if (this.exhausted) return false;
    this.left -= 1; this.ticks += 1;
    if (this.left <= 0 || ((this.ticks & 1023) === 0 && Date.now() > this.deadline)) { this.exhausted = true; return false; }
    return true;
  }
}

function nthMatching(first, last, dow, ord) {
  const days = [];
  let d = first + mod(dow - dowOfDay(first), 7);
  for (; d <= last; d += 7) days.push(d);
  if (!ord) return days;
  const pick = ord > 0 ? days[ord - 1] : days[days.length + ord];
  return pick === undefined ? [] : [pick];
}

/**
 * Wall-clock occurrences (ms as UTC) of `rule` from `startWall`, restricted to [loWall, hiWall] (inclusive, both with the
 * caller's slack), at most `maxOut` of them. COUNT is honoured from DTSTART. Stops at the budget.
 * @returns {{ walls: number[], truncated: boolean }}
 */
export function expandRule(rule, startWall, untilWall, loWall, hiWall, maxOut, budget) {
  const startDay = Math.floor(startWall / DAY);
  const msOfDay = startWall - startDay * DAY;
  const start = civilFromDays(startDay);
  const limitDay = Math.floor(Math.min(untilWall ?? Infinity, hiWall) / DAY);
  const walls = [];
  let truncated = false;
  let emitted = 0; // rule occurrences counted for COUNT
  const { freq, interval } = rule;
  const monthOk = (m) => !rule.byMonth || rule.byMonth.includes(m);
  const mdOk = (y, m, d) => !rule.byMonthDay || rule.byMonthDay.includes(d) || rule.byMonthDay.includes(d - daysInMonth(y, m) - 1);
  const bdPlain = rule.byDay ? new Set(rule.byDay.map((e) => e.dow)) : null;

  const monthDays = (y, m) => {
    const dim = daysInMonth(y, m);
    const first = daysFromCivil(y, m, 1); const last = first + dim - 1;
    let set = null;
    if (rule.byMonthDay) set = new Set(rule.byMonthDay.map((v) => (v > 0 ? v : dim + 1 + v)).filter((v) => v >= 1 && v <= dim).map((v) => first + v - 1));
    if (rule.byDay) {
      const bd = new Set();
      for (const e of rule.byDay) for (const day of nthMatching(first, last, e.dow, e.ord)) bd.add(day);
      set = set ? new Set([...set].filter((x) => bd.has(x))) : bd;
    }
    if (!set) return start.d <= dim ? [first + start.d - 1] : [];
    return [...set];
  };

  let p0 = 0;
  if (rule.count === null) {
    const loDay = Math.floor(loWall / DAY);
    if (freq === 'DAILY') p0 = Math.floor((loDay - startDay) / interval) - 1;
    else if (freq === 'WEEKLY') p0 = Math.floor((loDay - startDay) / (7 * interval)) - 1;
    else {
      const lo = civilFromDays(Math.max(loDay, startDay));
      const monthDiff = (lo.y - start.y) * 12 + (lo.m - start.m);
      p0 = freq === 'MONTHLY' ? Math.floor(monthDiff / interval) - 1 : Math.floor((lo.y - start.y) / interval) - 1;
    }
    p0 = Math.max(0, p0);
  }

  for (let p = p0; p < p0 + ICS_LIMITS.maxPeriods; p++) {
    if (!budget.tick()) { truncated = true; break; }
    let cands = [];
    let periodFirstDay;
    if (freq === 'DAILY') {
      const day = startDay + p * interval;
      periodFirstDay = day;
      const c = civilFromDays(day);
      if (monthOk(c.m) && mdOk(c.y, c.m, c.d) && (!bdPlain || bdPlain.has(dowOfDay(day)))) cands = [day];
    } else if (freq === 'WEEKLY') {
      const ws0 = startDay - mod(dowOfDay(startDay) - rule.wkst, 7);
      const ws = ws0 + p * 7 * interval;
      periodFirstDay = ws;
      const dows = bdPlain ? [...bdPlain] : [dowOfDay(startDay)];
      for (const dw of dows) {
        const day = ws + mod(dw - rule.wkst, 7);
        const c = civilFromDays(day);
        if (monthOk(c.m) && mdOk(c.y, c.m, c.d)) cands.push(day);
      }
    } else if (freq === 'MONTHLY') {
      const idx = start.y * 12 + (start.m - 1) + p * interval;
      const y = Math.floor(idx / 12); const m = (idx % 12) + 1;
      periodFirstDay = daysFromCivil(y, m, 1);
      if (y > 2300) break;
      if (monthOk(m)) cands = monthDays(y, m);
    } else {
      const y = start.y + p * interval;
      periodFirstDay = daysFromCivil(y, 1, 1);
      if (y > 2300) break;
      if (rule.byDay && !rule.byMonth && !rule.byMonthDay) {
        const first = daysFromCivil(y, 1, 1); const last = daysFromCivil(y, 12, 31);
        const set = new Set();
        for (const e of rule.byDay) for (const day of nthMatching(first, last, e.dow, e.ord)) set.add(day);
        cands = [...set];
      } else {
        const months = rule.byMonth || (rule.byMonthDay || rule.byDay ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.m]);
        for (const m of months) { if (!budget.tick()) { truncated = true; break; } cands.push(...monthDays(y, m)); }
        if (truncated) break;
      }
    }
    if (periodFirstDay > limitDay + 366) break;
    cands = [...new Set(cands)].sort((a, b) => a - b);
    if (rule.bySetPos) {
      const picked = new Set();
      for (const sp of rule.bySetPos) { const v = sp > 0 ? cands[sp - 1] : cands[cands.length + sp]; if (v !== undefined) picked.add(v); }
      cands = [...picked].sort((a, b) => a - b);
    }
    for (const day of cands) {
      const wall = day * DAY + msOfDay;
      if (wall < startWall) continue;
      if (untilWall !== null && untilWall !== undefined && wall > untilWall) return { walls, truncated };
      if (rule.count !== null) { emitted += 1; if (emitted > rule.count) return { walls, truncated }; }
      if (wall > hiWall) return { walls, truncated };
      if (wall >= loWall) { walls.push(wall); if (walls.length >= maxOut) return { walls, truncated: true }; }
    }
    if (periodFirstDay > limitDay) break;
  }
  return { walls, truncated };
}

// ---------------------------------------------------------------- expansion to instances
const pad = (n, w = 2) => String(n).padStart(w, '0');
function isoDate(day) { const c = civilFromDays(day); return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`; }
function isoUtc(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
const compactUtc = (ms) => isoUtc(ms).replace(/[-:]/g, '');

/** A date value to its identity key: the date for all-day, else the UTC instant, compact. */
export function dateKey(v) {
  if (!v) return null;
  if (v.allDay) return isoDate(Math.floor(v.wall / DAY));
  return compactUtc(wallToUtc(v.wall, v.zone));
}

/**
 * Raw events to instances inside the window, plus tombstones.
 * @param {object[]} events parseIcs().events
 * @param {{ windowStartMs: number, windowEndMs: number, limits?: object, budget?: Budget }} o
 * @returns {{ instances: object[], tombstones: Array<{uid: string, key: string|null}>, truncated: boolean, warnings: string[] }}
 */
export function expandEvents(events, { windowStartMs, windowEndMs, limits: limIn = {}, budget: b } = {}) {
  const limits = { ...ICS_LIMITS, ...limIn };
  const budget = b || new Budget(limits);
  const warnings = new Set();
  const tombstones = [];
  const instances = new Map(); // `${uid}\0${key}` -> instance (later wins)
  let truncated = false;

  const overrides = new Map(); // uid -> Map(key -> event)
  const masters = [];
  for (const ev of events) {
    if (ev.recurrenceId) {
      const k = dateKey(ev.recurrenceId);
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Map());
      overrides.get(ev.uid).set(k, ev);
    } else masters.push(ev);
  }

  const overlaps = (startMs, endMs) => (endMs > startMs ? endMs > windowStartMs && startMs < windowEndMs : startMs >= windowStartMs && startMs < windowEndMs);

  const place = (ev, key, startV, endMs, durMs) => {
    // startV: { allDay, wall, zone } ; computes real times, applies the window, records an instance.
    let startMs; let endMsOut;
    if (startV.allDay) { startMs = startV.wall; endMsOut = endMs; } else { startMs = wallToUtc(startV.wall, startV.zone); endMsOut = startMs + durMs; }
    if (startV.allDay) endMsOut = startMs + durMs;
    if (!overlaps(startMs, endMsOut)) return false;
    const all = startV.allDay;
    const inst = {
      uid: ev.uid, key, allDay: all,
      start: all ? isoDate(Math.floor(startMs / DAY)) : isoUtc(startMs), end: all ? isoDate(Math.floor(endMsOut / DAY)) : isoUtc(endMsOut),
      startMs, endMs: endMsOut,
      summary: ev.summary, description: ev.description, location: ev.location, status: ev.status, organizer: ev.organizer,
      attendees: ev.attendees, attendeeTotal: ev.attendeeTotal, url: ev.url, attach: ev.attach, sequence: ev.sequence,
      isOverride: !!ev.recurrenceId, recurring: !!ev.rrule || !!ev.recurrenceId, flags: ev.flags,
    };
    instances.set(`${ev.uid}\u0000${key}`, inst);
    return true;
  };

  const durationOf = (ev) => {
    if (ev.start.allDay) {
      const days = ev.end ? Math.max(1, Math.round((ev.end.wall - ev.start.wall) / DAY)) : (ev.durationMs ? Math.max(1, Math.round(ev.durationMs / DAY)) : 1);
      return days * DAY;
    }
    if (ev.end) return Math.max(0, wallToUtc(ev.end.wall, ev.end.zone) - wallToUtc(ev.start.wall, ev.start.zone));
    return Math.max(0, ev.durationMs ?? 0);
  };

  for (const ev of masters) {
    if (instances.size >= limits.maxInstances) { truncated = true; break; }
    for (const f of ev.flags) warnings.add(f);
    if (ev.status === 'CANCELLED') { tombstones.push({ uid: ev.uid, key: ev.rrule ? null : dateKey(ev.start) }); continue; }
    const dur = durationOf(ev);
    const ovr = overrides.get(ev.uid);
    const exKeys = new Set(ev.exdates.map(dateKey));
    const exDates = new Set(ev.exdates.filter((x) => x.allDay).map((x) => isoDate(Math.floor(x.wall / DAY))));
    const excluded = (key, startV) => exKeys.has(key) || (!startV.allDay && exDates.has(isoDate(Math.floor(startV.wall / DAY))));
    const walls = [];
    let rule = null;
    if (ev.rrule) {
      const pr = parseRrule(ev.rrule, limits);
      if (pr.rule) rule = pr.rule;
      else { warnings.add(pr.unsupported || 'rrule_invalid'); }
    }
    const slack = 2 * DAY + dur;
    if (rule) {
      let untilWall = null;
      if (rule.until) untilWall = rule.until.allDay ? rule.until.wall + DAY - 1 : (ev.start.allDay ? rule.until.wall + DAY - 1 : utcToWall(wallToUtc(rule.until.wall, rule.until.zone), ev.start.zone));
      const lo = windowStartMs - slack; const hi = windowEndMs + 2 * DAY;
      const r = expandRule(rule, ev.start.wall, untilWall, lo, hi, limits.maxInstancesPerEvent, budget);
      if (r.truncated) { truncated = true; warnings.add(budget.exhausted ? 'budget_exhausted' : 'instance_cap'); }
      walls.push(...r.walls);
    } else walls.push(ev.start.wall);
    for (const rd of ev.rdates) if (walls.length < limits.maxInstancesPerEvent * 2) walls.push(rd.wall);
    let n = 0;
    for (const wall of new Set(walls)) {
      const startV = { allDay: ev.start.allDay, wall, zone: ev.start.zone };
      const key = dateKey(startV);
      if (excluded(key, startV)) continue;
      if (ovr?.has(key)) continue; // an override replaces this occurrence
      if (place(ev, key, startV, 0, dur)) { n += 1; if (n >= limits.maxInstancesPerEvent) { truncated = true; warnings.add('instance_cap'); break; } }
      if (instances.size >= limits.maxInstances) { truncated = true; warnings.add('instance_cap'); break; }
    }
  }

  for (const [uid, byKey] of overrides) {
    for (const [key, ev] of byKey) {
      for (const f of ev.flags) warnings.add(f);
      if (ev.status === 'CANCELLED') { tombstones.push({ uid, key }); continue; }
      const dur = durationOf(ev);
      if (instances.size >= limits.maxInstances) { truncated = true; break; }
      place(ev, key, { allDay: ev.start.allDay, wall: ev.start.wall, zone: ev.start.zone }, 0, dur);
    }
  }
  const list = [...instances.values()].sort((a, b) => a.startMs - b.startMs || (a.uid < b.uid ? -1 : 1));
  return { instances: list, tombstones, truncated, warnings: [...warnings] };
}

/** Convenience: parse and expand in one call (used by the connector and the tests). */
export function readFeed(text, { windowStartMs, windowEndMs, limits } = {}) {
  const parsed = parseIcs(text, limits);
  const ex = expandEvents(parsed.events, { windowStartMs, windowEndMs, limits });
  return {
    instances: ex.instances, tombstones: ex.tombstones, eventCount: parsed.events.length,
    truncated: parsed.truncated || ex.truncated, warnings: [...new Set([...parsed.warnings, ...ex.warnings])],
  };
}
