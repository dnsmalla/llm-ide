// connectors/ical/ical-fetch.mjs: URL validation, host allowlist, redirects, caps, conditional GET, backoff. Fixture
// transport only; a tripwire turns any direct attempt to reach a Google host into a failure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const f = await import('../connectors/ical/ical-fetch.mjs');
const { makeTransport, textResponse, installTripwire } = await import('./helpers/google-fixture.mjs');

const TOKEN = 'private-0123456789abcdef0123456789abcdef';
const URL_OK = `https://calendar.google.com/calendar/ical/me%40example.com/${TOKEN}/basic.ics`;
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
let tripwire;
before(() => { tripwire = installTripwire(); f._setIcalSleepForTests(async () => {}); });
after(() => { f._setIcalFetchForTests(null); f._setIcalSleepForTests(null); tripwire.restore(); assert.deepEqual(tripwire.hits, []); });

const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const asyncCode = async (p) => { try { await p; } catch (e) { return e; } return null; };

test('validateIcalUrl accepts the Google secret address and webcal, and returns a short non-secret id prefix', () => {
  const r = f.validateIcalUrl(URL_OK);
  assert.equal(r.host, 'calendar.google.com');
  assert.equal(r.idPrefix, 'me@examp');
  assert.ok(!r.idPrefix.includes('private'));
  assert.equal(f.validateIcalUrl(URL_OK.replace('https://', 'webcal://')).url, r.url);
  assert.equal(f.validateIcalUrl(`https://CALENDAR.GOOGLE.COM:443/calendar/ical/x/public/basic.ics`).host, 'calendar.google.com');
});

test('validateIcalUrl refuses everything else with a stable code', () => {
  const bad = {
    ICAL_URL_INVALID: [
      '', '   ', 'not a url', 12, null, `http://calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics`, `ftp://calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics`,
      `https://user:pw@calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics`, `https://calendar.google.com:8443/calendar/ical/x/${TOKEN}/basic.ics`,
      `https://calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics#frag`, 'https://calendar.google.com/calendar/ical/x/y/basic.ics', 'https://calendar.google.com/',
      `https://calendar.google.com/calendar/ical/x/${TOKEN}/../basic.ics`, `https://calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics\nHost: evil`,
      `https://calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics${'a'.repeat(3000)}`,
    ],
    ICAL_HOST_NOT_ALLOWED: [
      `https://calendar.google.com.evil.com/calendar/ical/x/${TOKEN}/basic.ics`, `https://evilcalendar.google.com/calendar/ical/x/${TOKEN}/basic.ics`,
      `https://a.calendar.google.com/calendar/ical/x/${TOKEN}/basic.ics`, `https://google.com/calendar/ical/x/${TOKEN}/basic.ics`,
      `https://127.0.0.1/calendar/ical/x/${TOKEN}/basic.ics`, `https://[::1]/calendar/ical/x/${TOKEN}/basic.ics`, `https://169.254.169.254/latest/meta-data`,
      `https://2130706433/x.ics`, `https://localhost/x.ics`, `https://calendar.google.com@evil.example/x.ics`.replace('@', '.'),
    ],
  };
  for (const [code, list] of Object.entries(bad)) for (const u of list) assert.equal(codeOf(() => f.validateIcalUrl(u)), code, String(u).slice(0, 80));
  // userinfo trick: the host is evil.example, the userinfo says calendar.google.com
  assert.equal(codeOf(() => f.validateIcalUrl('https://calendar.google.com@evil.example/calendar/ical/x/public/basic.ics')), 'ICAL_URL_INVALID');
  // the error text never carries the URL or the token
  try { f.validateIcalUrl(`https://evil.example/calendar/ical/x/${TOKEN}/basic.ics`); } catch (e) { assert.ok(!e.message.includes(TOKEN) && !e.message.includes('evil.example')); }
});

test('LLMIDE_ICAL_HOSTS adds exact hosts only', () => {
  const env = { LLMIDE_ICAL_HOSTS: 'cal.example.org, *.wild.example, 10.0.0.1, bad host, CAL2.example.org' };
  assert.deepEqual(f.allowedIcalHosts(env), ['calendar.google.com', 'cal.example.org', 'cal2.example.org']);
  assert.equal(f.validateIcalUrl('https://cal.example.org/feeds/me.ics', env).host, 'cal.example.org');
  assert.equal(codeOf(() => f.validateIcalUrl('https://x.cal.example.org/feeds/me.ics', env)), 'ICAL_HOST_NOT_ALLOWED');
  assert.equal(codeOf(() => f.validateIcalUrl('https://x.wild.example/feeds/me.ics', env)), 'ICAL_HOST_NOT_ALLOWED');
  assert.equal(codeOf(() => f.validateIcalUrl('https://10.0.0.1/feeds/me.ics', env)), 'ICAL_HOST_NOT_ALLOWED');
  assert.equal(codeOf(() => f.validateIcalUrl('https://cal.example.org/feeds/me.ics', {})), 'ICAL_HOST_NOT_ALLOWED');
});

test('redactIcalSecrets removes URLs and private tokens', () => {
  const s = f.redactIcalSecrets(`fetching ${URL_OK} then webcal://calendar.google.com/calendar/ical/a/${TOKEN}/basic.ics and ${TOKEN}`);
  assert.ok(!s.includes(TOKEN));
  assert.ok(!s.includes('calendar.google.com'));
});

test('fetch: 200 returns text and validators; the conditional headers are sent and 304 is notModified', async () => {
  const t = makeTransport().on(() => true, (u, i) => (i.headers['If-None-Match'] === '"v1"' ? new Response(null, { status: 304 }) : textResponse(200, ICS, { etag: '"v1"', 'last-modified': 'Mon, 03 Nov 2025 00:00:00 GMT' })));
  f._setIcalFetchForTests(t);
  const a = await f.fetchIcal(URL_OK);
  assert.deepEqual([a.text, a.etag, a.lastModified], [ICS, '"v1"', 'Mon, 03 Nov 2025 00:00:00 GMT']);
  assert.equal(t.calls[0].headers['if-none-match'], undefined);
  const b = await f.fetchIcal(URL_OK, { etag: '"v1"', lastModified: a.lastModified });
  assert.deepEqual(b, { notModified: true });
  assert.equal(t.calls[1].headers['if-none-match'], '"v1"');
  assert.equal(t.calls[1].headers['if-modified-since'], a.lastModified);
  assert.equal(t.calls[1].headers.authorization, undefined, 'no bearer, no cookies');
  // a hostile validator (control characters) is not sent
  await f.fetchIcal(URL_OK, { etag: '"v1"\r\nX-Evil: 1' });
  assert.equal(t.calls[2].headers['if-none-match'], undefined);
  assert.deepEqual(t.unmatched, []);
});

test('fetch: 404 and 410 mean revoked, other 4xx fail, 429 and 5xx back off then fail', async () => {
  for (const status of [404, 410]) {
    f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(status, 'gone')));
    assert.deepEqual(await f.fetchIcal(URL_OK), { revoked: true, status });
  }
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(403, 'no')));
  let e = await asyncCode(f.fetchIcal(URL_OK));
  assert.equal(e.code, 'ICAL_FETCH_FAILED'); assert.equal(e.status, 403);
  let n = 0; const sleeps = [];
  f._setIcalFetchForTests(makeTransport().on(() => true, () => (++n < 3 ? textResponse(429, 'slow', { 'retry-after': '2' }) : textResponse(200, ICS))));
  assert.equal((await f.fetchIcal(URL_OK, { sleepImpl: async (ms) => { sleeps.push(ms); } })).text, ICS);
  assert.equal(n, 3); assert.equal(sleeps.length, 2); assert.ok(sleeps.every((ms) => ms >= 2000 && ms < 2300));
  n = 0;
  f._setIcalFetchForTests(makeTransport().on(() => true, () => { n++; return textResponse(429, 'slow'); }));
  e = await asyncCode(f.fetchIcal(URL_OK));
  assert.equal(e.code, 'ICAL_RATE_LIMITED'); assert.equal(n, 4);
  n = 0;
  f._setIcalFetchForTests(makeTransport().on(() => true, () => { n++; return textResponse(503, 'down'); }));
  e = await asyncCode(f.fetchIcal(URL_OK));
  assert.equal(e.code, 'ICAL_FETCH_FAILED'); assert.equal(n, 4);
  assert.ok(!e.message.includes(TOKEN));
});

test('redirects: same host for at most 2 hops; another host, http, userinfo, port are refused before any request', async () => {
  const same = (hops) => {
    const t = makeTransport();
    t.on(() => true, (u) => {
      const k = Number(u.searchParams.get('hop') || 0);
      return k < hops ? new Response(null, { status: 302, headers: { location: `/calendar/ical/x/${TOKEN}/basic.ics?hop=${k + 1}` } }) : textResponse(200, ICS);
    });
    return t;
  };
  f._setIcalFetchForTests(same(2));
  assert.equal((await f.fetchIcal(URL_OK)).text, ICS);
  const t3 = same(3); f._setIcalFetchForTests(t3);
  let e = await asyncCode(f.fetchIcal(URL_OK));
  assert.equal(e.code, 'ICAL_FETCH_FAILED'); assert.equal(t3.calls.length, 3);
  for (const loc of ['https://evil.example/x.ics', 'http://calendar.google.com/calendar/ical/x/public/basic.ics', 'https://u:p@calendar.google.com/calendar/ical/x/public/basic.ics',
    'https://calendar.google.com:444/calendar/ical/x/public/basic.ics', 'https://calendar.google.com.evil.com/x', 'https://127.0.0.1/x', 'https://www.google.com/x']) {
    const t = makeTransport().on(() => true, () => new Response(null, { status: 302, headers: { location: loc } }));
    f._setIcalFetchForTests(t);
    e = await asyncCode(f.fetchIcal(URL_OK));
    assert.equal(e.code, 'ICAL_HOST_NOT_ALLOWED', loc);
    assert.equal(t.calls.length, 1, `no request to ${loc}`);
    assert.ok(!e.message.includes(TOKEN));
  }
  // redirect without a location
  f._setIcalFetchForTests(makeTransport().on(() => true, () => new Response(null, { status: 302 })));
  assert.equal((await asyncCode(f.fetchIcal(URL_OK))).code, 'ICAL_FETCH_FAILED');
});

test('size cap: content-length and streamed bodies over 5 MiB are ICAL_TOO_LARGE', async () => {
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(200, 'x', { 'content-length': String(6 * 1024 * 1024) })));
  assert.equal((await asyncCode(f.fetchIcal(URL_OK))).code, 'ICAL_TOO_LARGE');
  // no content-length, chunked: the stream is cancelled once the cap is crossed
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024 * 1024)); if (pulled > 50) c.close(); } });
  f._setIcalFetchForTests(makeTransport().on(() => true, () => new Response(stream, { status: 200 })));
  assert.equal((await asyncCode(f.fetchIcal(URL_OK))).code, 'ICAL_TOO_LARGE');
  assert.ok(pulled <= 8, `stopped reading early (${pulled} chunks)`);
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(200, 'A'.repeat(5 * 1024 * 1024))));
  assert.equal((await f.fetchIcal(URL_OK)).text.length, 5 * 1024 * 1024);
});

test('network errors and SSRF refusals map to codes without leaking the URL', async () => {
  f._setIcalFetchForTests(async () => { throw new TypeError(`fetch failed ${URL_OK}`); });
  let e = await asyncCode(f.fetchIcal(URL_OK));
  assert.equal(e.code, 'ICAL_FETCH_FAILED'); assert.ok(!e.message.includes(TOKEN));
  f._setIcalFetchForTests(async () => { throw Object.assign(new Error('blocked'), { code: 'SSRF_BLOCKED' }); });
  assert.equal((await asyncCode(f.fetchIcal(URL_OK))).code, 'ICAL_HOST_NOT_ALLOWED');
  f._setIcalFetchForTests(null);
  assert.equal((await asyncCode(f.fetchIcal(URL_OK))).code, 'ICAL_TEST_TRIPWIRE', 'with no fixture transport a test cannot reach the network');
});
