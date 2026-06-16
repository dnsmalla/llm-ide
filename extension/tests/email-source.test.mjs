import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Pure helpers only — we never open a real IMAP connection here.
const { normalizeParsed, stripHtml } = await import('../agents/email-source.mjs');

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
