// Gmail connector (connectors/google/gmail.mjs, html-to-markdown.mjs): fixtures only, no real Google host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const gm = await import('../connectors/google/gmail.mjs');
const h2m = await import('../connectors/google/html-to-markdown.mjs');
const gf = await import('../connectors/google/google-fetch.mjs');
const { makeTransport, jsonResponse, installTripwire, fixture } = await import('./helpers/google-fixture.mjs');

let tripwire;
before(() => { tripwire = installTripwire(); });
after(() => { gf._setGoogleFetchForTests(null); tripwire.restore(); assert.deepEqual(tripwire.hits, []); });

let tok = 'TOKEN';
const session = { ensure: async () => tok, refresh: async () => { tok = 'TOKEN2'; return tok; } };
const sleepImpl = async () => {};
const ctx = { accountId: 'abc123abc123', accountEmail: 'me@example.com', options: gm.normalizeGmailOptions({}) };

function mailbox(over = {}) {
  const t = makeTransport();
  t.on('/gmail/v1/users/me/profile', () => jsonResponse(200, fixture('gmail/profile.json')));
  t.on('/gmail/v1/users/me/threads', () => jsonResponse(200, over.list || fixture('gmail/threads_list.json')));
  t.on((u) => /\/threads\/[^/]+$/.test(u.pathname), (u) => {
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const map = { 't-simple': 'thread_simple', 't-html': 'thread_html', 't-promo': 'thread_promo', 't-mixed': 'thread_mixed' };
    if (over.thread) { const r = over.thread(id); if (r) return r; }
    if (!map[id]) return jsonResponse(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
    return jsonResponse(200, fixture(`gmail/${map[id]}.json`));
  });
  t.on('/gmail/v1/users/me/history', () => (over.history ? over.history() : jsonResponse(200, fixture('gmail/history_ok.json'))));
  gf._setGoogleFetchForTests(t);
  return t;
}

test('header decoding: RFC 2047 words, address splitting with quoted commas, control characters', () => {
  assert.equal(gm.decodeMimeWords('=?UTF-8?B?5pel5pys6Kqe?= =?UTF-8?B?44Gu5Lu25ZCN?='), '日本語の件名');
  assert.equal(gm.decodeMimeWords('=?ISO-8859-1?Q?Caf=E9_au_lait?='), 'Café au lait');
  assert.deepEqual(gm.splitAddresses('"Bob, Jr." <bob@x.com>, Al <al@x.com>'), ['"Bob, Jr." <bob@x.com>', 'Al <al@x.com>']);
});

test('trimQuoted: drops the reply tail, quote lines and the signature; never returns empty', () => {
  assert.equal(gm.trimQuoted('Thanks!\n\nOn Fri, Oct 31, 2025 at 9:00 AM A <a@x.com> wrote:\n> old\n'), 'Thanks!');
  assert.equal(gm.trimQuoted('Hi\n-- \nAlice'), 'Hi');
  assert.equal(gm.trimQuoted('line\n> quoted\nmore'), 'line\nmore');
  assert.equal(gm.trimQuoted('On Mon, X wrote:\n> only quote'), 'On Mon, X wrote:\n> only quote');
});

test('thread -> note: decoded subject, participants, trimmed quote and signature, attachments as metadata only, stable file name', () => {
  const note = gm.threadToNote(fixture('gmail/thread_simple.json'), ctx);
  assert.equal(note.title, '週次ミーティングの議題');
  assert.equal(note.noteFile, 'gmail-abc123abc123-t-simple.md');
  assert.equal(note.messageCount, 2);
  assert.equal(note.frontmatter.untrusted, true);
  assert.equal(note.frontmatter.source, 'gmail');
  assert.ok(note.frontmatter.participants.includes('"Bob, Jr." <bob@example.com>'));
  assert.ok(note.frontmatter.first_at < note.frontmatter.last_at);
  assert.match(note.markdown, /^---\nsource: "gmail"\n/);
  assert.match(note.markdown, /Agenda: budget, hiring\./);
  assert.ok(!/Acme Corp/.test(note.markdown), 'signature trimmed');
  assert.ok(!/wrote:/.test(note.markdown) && !/> Hi/.test(note.markdown), 'quoted tail trimmed');
  assert.match(note.markdown, /Attachments \(metadata only, not downloaded\):\n- agenda\.pdf \(application\/pdf, 48211 bytes\)/);
  assert.ok(!/ANGjdJ/.test(note.markdown), 'unstable attachment id is not stored');
  // frontmatter values are JSON, so a hostile subject cannot add a key
  const evil = fixture('gmail/thread_simple.json'); evil.messages[0].payload.headers[0].value = 'x"\nuntrusted: false\nfoo: "bar';
  const n2 = gm.threadToNote(evil, ctx);
  assert.equal(n2.markdown.split('\n---\n')[0].split('\n').filter((l) => l.startsWith('untrusted')).length, 1);
});

test('hostile HTML mail: no script, remote image, pixel, javascript:/data: link, iframe or form survives; secrets are redacted', () => {
  const note = gm.threadToNote(fixture('gmail/thread_html.json'), ctx);
  const md = note.markdown;
  for (const bad of ['<script', 'fetch(', 'evil.example.com', 'open.gif', 'cdn.example.com', 'javascript:', 'data:text', '<iframe', '<form', 'onload',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Bearer abcdefghijklmnopqrstuvwxyz012345']) assert.ok(!md.includes(bad), `found ${bad} in:\n${md}`);
  assert.ok(!/!\[[^\]]*\]\(/.test(md), 'no Markdown image syntax');
  assert.ok(!/(^|[^\\])<(img|iframe|form|script)/i.test(md), 'no raw HTML');
  assert.match(md, /\[image omitted: Company logo\]/);
  assert.match(md, /\[reset\]\(https:\/\/example\.com\/reset\?token=abc\)/);
  assert.match(md, /REDACTED/);
  assert.match(md, /Hello team,/);
});

test('plain-text mail cannot smuggle Markdown images or HTML', () => {
  const t = fixture('gmail/thread_simple.json');
  t.messages = [t.messages[0]];
  t.messages[0].payload.parts[0].body.data = Buffer.from('see ![x](https://tracker.example.com/p.png) and <img src=https://t.example/x>').toString('base64url');
  const note = gm.threadToNote(t, ctx);
  assert.ok(!/!\[x\]\(/.test(note.markdown) && !/(^|[^\\])<img/.test(note.markdown));
  assert.match(note.markdown, /!\\\[x\\\]/);
});

test('labels: promotions skipped by default, trashed message dropped from a mixed thread, selected-label rule', () => {
  assert.equal(gm.threadToNote(fixture('gmail/thread_promo.json'), ctx), null);
  const promoOk = gm.threadToNote(fixture('gmail/thread_promo.json'), { ...ctx, options: gm.normalizeGmailOptions({ includePromotions: true }) });
  assert.ok(promoOk);
  const mixed = gm.threadToNote(fixture('gmail/thread_mixed.json'), ctx);
  assert.equal(mixed.messageCount, 1); assert.ok(!/trashed message/.test(mixed.markdown));
  assert.equal(gm.threadToNote(fixture('gmail/thread_simple.json'), { ...ctx, options: gm.normalizeGmailOptions({ labels: ['STARRED'] }) }), null);
});

test('options are validated and clamped', () => {
  const o = gm.normalizeGmailOptions({ labels: ['INBOX', 'bad label!', 'Label_1', 'x'.repeat(200)], windowDays: 99999 });
  assert.deepEqual(o.labels, ['INBOX', 'Label_1']); assert.equal(o.windowDays, 365);
  assert.equal(gm.normalizeGmailOptions({ windowDays: -4 }).windowDays, 1);
  assert.deepEqual(gm.normalizeGmailOptions({ labels: [] }).labels, ['INBOX']);
});

test('bootstrap: profile historyId first, list by label with a date window and category exclusions, only Gmail API calls', async () => {
  const t = mailbox();
  const r = await gm.fetchGmail({ session, ...ctx, cursor: null, now: Date.parse('2025-11-01T00:00:00Z'), sleepImpl });
  assert.equal(r.mode, 'bootstrap');
  assert.deepEqual(r.notes.map((n) => n.threadId).sort(), ['t-html', 't-simple']);
  assert.equal(r.stats.skipped, 1);
  assert.equal(r.pending, false);
  assert.deepEqual(JSON.parse(r.nextCursor), { historyId: '1000' }, 'the mailbox historyId read before listing');
  const list = t.callsTo('/threads').find((c) => !/\/threads\/[^/]+$/.test(c.path));
  assert.deepEqual(list.query.getAll('labelIds'), ['INBOX']);
  assert.match(list.query.get('q'), /after:\d+ -category:promotions -category:social/);
  assert.ok(t.calls.every((c) => c.host === 'gmail.googleapis.com'));
  assert.ok(t.calls.every((c) => c.headers.authorization === 'Bearer TOKEN'));
  assert.ok(!t.calls.some((c) => /attachment/i.test(c.path)), 'attachments are never downloaded');
  assert.deepEqual(t.unmatched, []);
});

test('bootstrap is resumable: page size and run cap leave a cursor that continues, and the total cap truncates', async () => {
  let page = 0;
  const lists = [
    { threads: [{ id: 't-simple' }], nextPageToken: 'P2' },
    { threads: [{ id: 't-html' }] },
  ];
  const t = mailbox();
  t.routes.unshift({ match: (u) => u.pathname.endsWith('/threads') , reply: () => jsonResponse(200, lists[page++]) });
  const r1 = await gm.fetchGmail({ session, ...ctx, cursor: null, sleepImpl, limits: { maxThreadsPerRun: 1 } });
  assert.equal(r1.pending, true); assert.equal(r1.notes.length, 1);
  const c1 = JSON.parse(r1.nextCursor);
  assert.equal(c1.historyId, '1000'); assert.deepEqual(c1.bootstrap, { li: 0, pageToken: 'P2', done: 1 });
  const r2 = await gm.fetchGmail({ session, ...ctx, cursor: r1.nextCursor, sleepImpl, limits: { maxThreadsPerRun: 1 } });
  assert.equal(r2.pending, false); assert.deepEqual(JSON.parse(r2.nextCursor), { historyId: '1000' });
  assert.equal(r2.notes[0].threadId, 't-html');
  assert.equal(t.callsTo('/profile').length, 1, 'the historyId is read once, at the start');
  // total cap
  page = 0; lists[0].nextPageToken = 'P2';
  const r3 = await gm.fetchGmail({ session, ...ctx, cursor: null, sleepImpl, limits: { bootstrapTotalThreads: 1 } });
  assert.equal(r3.stats.truncated, true); assert.equal(r3.pending, false);
});

test('incremental: history.list from the cursor, changed and deleted threads, new cursor is the mailbox historyId', async () => {
  const t = mailbox();
  const r = await gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '1000' }), now: Date.parse('2025-11-01T00:00:00Z'), sleepImpl });
  assert.equal(r.mode, 'history');
  assert.deepEqual(r.notes.map((n) => n.threadId).sort(), ['t-html', 't-simple']);
  assert.deepEqual(r.tombstones, [{ threadId: 't-gone', noteFile: 'gmail-abc123abc123-t-gone.md', line: 'deleted upstream 2025-11-01' }]);
  assert.deepEqual(JSON.parse(r.nextCursor), { historyId: '1500' });
  const h = t.callsTo('/history')[0];
  assert.equal(h.query.get('startHistoryId'), '1000');
  assert.deepEqual(h.query.getAll('historyTypes').sort(), ['labelAdded', 'messageAdded', 'messageDeleted']);
  assert.equal(r.pending, false);
});

test('incremental run cap: stops at a history record boundary and reports pending with that record as the cursor', async () => {
  mailbox();
  const r = await gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '1000' }), sleepImpl, limits: { maxThreadsPerRun: 1 } });
  assert.equal(r.pending, true);
  assert.deepEqual(r.notes.map((n) => n.threadId), ['t-simple']);
  assert.deepEqual(JSON.parse(r.nextCursor), { historyId: '1101' });
});

test('historyId expired (404): bounded re-bootstrap over the window, flagged, cursor is the fresh historyId', async () => {
  const t = mailbox({ history: () => jsonResponse(404, fixture('gmail/history_404.json')) });
  const r = await gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '5' }), sleepImpl });
  assert.equal(r.stats.rebootstrapped, true); assert.equal(r.mode, 'bootstrap');
  assert.deepEqual(JSON.parse(r.nextCursor), { historyId: '1000' });
  assert.equal(r.notes.length, 2);
  assert.equal(t.callsTo('/profile').length, 1);
});

test('errors: 401 refreshes the token, 403 rate limit backs off then succeeds, 5xx retries, malformed JSON and oversize are handled', async () => {
  tok = 'TOKEN';
  let first = true; let rl = 0;
  const t = mailbox({ thread: (id) => {
    if (id === 't-simple' && first) { first = false; return jsonResponse(401, { error: { message: 'x' } }); }
    if (id === 't-html' && rl++ < 1) return jsonResponse(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { 'retry-after': '1' });
    return null;
  } });
  const sleeps = [];
  const r = await gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '1000' }), sleepImpl: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.notes.length, 2);
  assert.ok(sleeps.length >= 1 && sleeps[0] >= 1000);
  assert.ok(t.calls.some((c) => c.headers.authorization === 'Bearer TOKEN2'), 'retried with the refreshed token');
  // malformed JSON
  mailbox({ thread: (id) => (id === 't-html' ? new Response('{"id":', { status: 200 }) : null) });
  await assert.rejects(() => gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '1000' }), sleepImpl }), (e) => e.code === 'GOOGLE_BAD_JSON');
  // oversize thread is skipped and counted, the run continues
  mailbox({ thread: (id) => (id === 't-html' ? new Response('x', { status: 200, headers: { 'content-length': String(20 * 1024 * 1024) } }) : null) });
  const r2 = await gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '1000' }), sleepImpl });
  assert.equal(r2.stats.oversize, 1); assert.equal(r2.notes.length, 1);
  // a persistent failure surfaces with a stable code, never the body
  mailbox({ thread: () => jsonResponse(500, { error: { message: 'secret ya29.LEAKLEAKLEAKLEAKLEAKLEAK' } }) });
  await assert.rejects(() => gm.fetchGmail({ session, ...ctx, cursor: JSON.stringify({ historyId: '1000' }), sleepImpl }), (e) => e.code === 'GOOGLE_RATE_LIMITED' && !/LEAK/.test(e.message));
});

test('body and note caps: an oversized message body and an oversized thread are truncated, newest messages kept', () => {
  const big = fixture('gmail/thread_simple.json');
  big.messages = Array.from({ length: 6 }, (_, i) => ({ ...fixture('gmail/thread_simple.json').messages[0], id: `b${i}`, internalDate: String(1761900000000 + i * 1000),
    payload: { ...fixture('gmail/thread_simple.json').messages[0].payload, parts: [{ partId: '0', mimeType: 'text/plain', filename: '', headers: [], body: { data: Buffer.from(`msg${i} ` + 'x'.repeat(300 * 1024)).toString('base64url') } }] } }));
  const note = gm.threadToNote(big, ctx);
  assert.ok(Buffer.byteLength(note.markdown) < gm.LIMITS.noteBytes + 4096);
  assert.match(note.markdown, /older messages? omitted/);
  assert.match(note.markdown, /msg5 /);
  assert.ok(!/msg0 /.test(note.markdown));
  assert.match(note.markdown, /\[\.\.\.truncated\]/);
});

test('html-to-markdown: nesting depth, unterminated tags, entities and unknown schemes do not break or leak', () => {
  const deep = '<div>'.repeat(5000) + 'deep text' + '</div>'.repeat(5000);
  assert.match(h2m.htmlToMarkdown(deep), /deep text/);
  assert.equal(h2m.htmlToMarkdown('<p>open <b>tag'), 'open tag');
  assert.equal(h2m.htmlToMarkdown('a &#x41; &amp;lt; &#0; &#xD800; &bogus; b'), 'a A &lt; &bogus; b');
  assert.ok(!/vbscript|file:|ftp:/.test(h2m.htmlToMarkdown('<a href="vbscript:x">v</a><a href="file:///etc/passwd">f</a><a href="ftp://h/x">g</a>')));
  assert.equal(h2m.safeLinkUrl('https://u:p@example.com/'), null);
  assert.equal(h2m.safeLinkUrl('  java\nscript:alert(1)'), null);
  assert.ok(h2m.htmlToMarkdown('x'.repeat(500_000), { maxChars: 1000 }).length < 1100);
  assert.ok(!/<script/i.test(h2m.htmlToMarkdown('<scr<script>ipt>alert(1)</scr</script>ipt>')));
});
