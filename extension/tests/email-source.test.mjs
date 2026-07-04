import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Pure helpers only — we never open a real IMAP connection here.
const { normalizeParsed, stripHtml, resolveSince, isPrivateAddress, friendlyError } = await import('../agents/email-source.mjs');

// imapflow throws `new Error('Command failed')` for every failed IMAP command
// and puts the real reason in err.responseText / responseStatus. friendlyError
// must read those, not just err.message (which is always 'Command failed').
test('friendlyError classifies a Gmail auth failure hidden behind "Command failed"', () => {
  const err = new Error('Command failed');
  err.responseStatus = 'NO';
  err.responseText = '[AUTHENTICATIONFAILED] Invalid credentials (Failure)';
  const msg = friendlyError(err);
  assert.match(msg, /app password/i, `expected an app-password hint, got: ${msg}`);
  assert.doesNotMatch(msg, /^Command failed$/, 'must not surface the raw generic message');
});

test('friendlyError handles the imapflow authenticationFailed flag', () => {
  const err = new Error('Command failed');
  err.authenticationFailed = true;
  assert.match(friendlyError(err), /login failed/i);
});

test('friendlyError surfaces the server response text instead of generic "Command failed"', () => {
  const err = new Error('Command failed');
  err.responseText = 'Mailbox does not exist';
  const msg = friendlyError(err);
  assert.match(msg, /Mailbox does not exist/);
  assert.notEqual(msg, 'Command failed');
});

test('normalizeParsed maps a complete message', () => {
  const parsed = {
    messageId: '<a@b>',
    subject: 'Hi',
    from: { text: 'A <a@b>' },
    date: new Date('2026-01-02T03:04:05Z'),
    text: 'body',
  };
  const out = normalizeParsed(parsed, 7);
  assert.equal(out.uid, 7);
  assert.equal(out.messageId, '<a@b>');
  assert.equal(out.subject, 'Hi');
  assert.equal(out.from, 'A <a@b>');
  assert.equal(out.date, '2026-01-02T03:04:05.000Z');
  assert.equal(out.text, 'body');
});

test('normalizeParsed fills defaults for missing fields', () => {
  const out = normalizeParsed({}, 9);
  assert.equal(out.messageId, 'email-uid-9');
  assert.equal(out.subject, '(no subject)');
  assert.equal(out.from, '');
  assert.equal(out.text, '');
  // date falls back to "now" — assert it's a valid ISO string.
  assert.ok(!Number.isNaN(Date.parse(out.date)));
});

test('normalizeParsed falls back to stripped HTML when text is missing', () => {
  const out = normalizeParsed({ html: '<p>Hello<br>World</p><script>x</script>' }, 1);
  assert.match(out.text, /Hello/);
  assert.match(out.text, /World/);
  assert.ok(!out.text.includes('<'), 'no angle brackets should survive');
  assert.ok(!out.text.includes('script'), 'script content should be removed');
});

test('stripHtml decodes common entities', () => {
  assert.equal(stripHtml('a &amp; b &lt;c&gt;'), 'a & b <c>');
});

test('resolveSince prefers a valid sinceISO', () => {
  const d = resolveSince({ sinceISO: '2026-01-02T03:04:05Z', lookbackDays: 7 });
  assert.equal(d.toISOString(), '2026-01-02T03:04:05.000Z');
});

test('resolveSince falls back to lookbackDays on missing/invalid sinceISO', () => {
  const before = Date.now() - 7 * 86400000;
  const d1 = resolveSince({ lookbackDays: 7 });
  const d2 = resolveSince({ sinceISO: 'not-a-date', lookbackDays: 7 });
  // Within a few seconds of "now - 7d" for both the absent and invalid cases.
  assert.ok(Math.abs(d1.getTime() - before) < 5000);
  assert.ok(Math.abs(d2.getTime() - before) < 5000);
});

test('resolveSince clamps lookbackDays to 1..60 server-side', () => {
  const tooBig = resolveSince({ lookbackDays: 100000 });
  const cap = Date.now() - 60 * 86400000;
  assert.ok(Math.abs(tooBig.getTime() - cap) < 5000, 'clamped to 60 days');
  const tooSmall = resolveSince({ lookbackDays: 0 });
  const oneDay = Date.now() - 1 * 86400000; // 0 clamps up to the 1-day floor
  assert.ok(Math.abs(tooSmall.getTime() - oneDay) < 5000);
});

test('isPrivateAddress flags loopback/private/link-local/ULA, allows public', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1',
                    '169.254.169.254', '100.64.0.1', '0.0.0.0',
                    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::3',
                    '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '142.250.80.1', '1.1.1.1', '2607:f8b0::1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});
