import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { simpleParser } from 'mailparser';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { normalizeParsed } = await import('../connectors/email-source.mjs');

// NOTE: both encoders are transitive dependencies of mailparser (not declared
// in package.json). They are used only to PRODUCE fixture bytes; every fixture
// is cross-checked with Node's built-in TextDecoder (an independent oracle), so
// a bad fixture can never be mistaken for a mailparser decoding regression.
const require = createRequire(import.meta.url);
const Encoding = require('encoding-japanese');
const iconv = require('iconv-lite');

function toJis(str) {
  return Buffer.from(Encoding.convert(Encoding.stringToCode(str), { to: 'JIS', from: 'UNICODE' }));
}
function toSjis(str) {
  return iconv.encode(str, 'Shift_JIS');
}
function assertFixture(label, bytes, expected) {
  assert.equal(new TextDecoder(label).decode(bytes), expected, `fixture for ${label} must round-trip`);
}
const b64 = (buf) => buf.toString('base64');
const wrap76 = (s) => s.match(/.{1,76}/g).join('\r\n');

const SUBJECT_JA = '会議の議事録について';
const FROM_NAME_JA = '山田 太郎';
const BODY_JA = 'お世話になっております。\r\n明日の定例会議の議事録を共有します。';
const BODY_LF = BODY_JA.replace(/\r\n/g, '\n');
const DATE_HDR = 'Tue, 03 Nov 2026 09:15:00 +0900';

async function parse(raw, uid = 7) {
  const parsed = await simpleParser(Buffer.from(raw));
  return { parsed, note: normalizeParsed(parsed, uid) };
}

test('ISO-2022-JP subject, From display name and 7bit body decode to Japanese', async () => {
  const subject = toJis(SUBJECT_JA);
  const name = toJis(FROM_NAME_JA);
  const body = toJis(BODY_JA);
  assertFixture('iso-2022-jp', subject, SUBJECT_JA);
  assertFixture('iso-2022-jp', name, FROM_NAME_JA);
  assertFixture('iso-2022-jp', body, BODY_JA);
  const raw = Buffer.concat([
    Buffer.from(
      `From: =?ISO-2022-JP?B?${b64(name)}?= <taro@example.jp>\r\n` +
      `To: me@example.com\r\nSubject: =?ISO-2022-JP?B?${b64(subject)}?=\r\n` +
      `Date: ${DATE_HDR}\r\nMessage-ID: <jis-1@example.jp>\r\nMIME-Version: 1.0\r\n` +
      'Content-Type: text/plain; charset=ISO-2022-JP\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'),
    body,
  ]);
  const { note } = await parse(raw);
  assert.equal(note.subject, SUBJECT_JA);
  // mailparser re-renders the decoded display name quoted, and normalises CRLF to LF in text parts.
  assert.equal(note.from, `"${FROM_NAME_JA}" <taro@example.jp>`);
  assert.equal(note.text, BODY_LF);
});

test('Shift_JIS subject (B) and base64 body decode to Japanese', async () => {
  const subject = toSjis(SUBJECT_JA);
  const body = toSjis(BODY_JA);
  assertFixture('shift_jis', subject, SUBJECT_JA);
  assertFixture('shift_jis', body, BODY_JA);
  const raw =
    `From: sjis@example.jp\r\nSubject: =?Shift_JIS?B?${b64(subject)}?=\r\n` +
    `Date: ${DATE_HDR}\r\nMessage-ID: <sjis-1@example.jp>\r\nMIME-Version: 1.0\r\n` +
    'Content-Type: text/plain; charset=Shift_JIS\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    wrap76(b64(body)) + '\r\n';
  const { note } = await parse(raw);
  assert.equal(note.subject, SUBJECT_JA);
  assert.equal(note.text, BODY_LF);
});

test('UTF-8 Q-encoded subject and quoted-printable body decode to Japanese', async () => {
  const qp = (str) => [...Buffer.from(str, 'utf8')]
    .map((byte) => (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d && byte !== 0x3f && byte !== 0x5f
      ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
  const bodyQp = qp(BODY_JA.split('\r\n')[0]) + '\r\n' + qp(BODY_JA.split('\r\n')[1]);
  const raw =
    `From: utf8@example.jp\r\nSubject: =?UTF-8?Q?${qp(SUBJECT_JA)}?=\r\n` +
    `Date: ${DATE_HDR}\r\nMessage-ID: <utf8-1@example.jp>\r\nMIME-Version: 1.0\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
    bodyQp + '\r\n';
  const { note } = await parse(raw);
  assert.equal(note.subject, SUBJECT_JA);
  assert.equal(note.text, BODY_LF);
});

test('multipart/alternative yields both the text and the html part', async () => {
  const html = '<html><body><p>議事録を<b>共有</b>します。</p></body></html>';
  const plain = '議事録を共有します。';
  const raw =
    `From: alt@example.jp\r\nSubject: alt\r\nDate: ${DATE_HDR}\r\nMessage-ID: <alt-1@example.jp>\r\n` +
    'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="BND"\r\n\r\n' +
    '--BND\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' +
    plain + '\r\n' +
    '--BND\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    wrap76(b64(Buffer.from(html, 'utf8'))) + '\r\n--BND--\r\n';
  const { parsed, note } = await parse(raw);
  assert.equal(parsed.text.trim(), plain);
  assert.equal(parsed.html.trim(), html);
  assert.equal(note.text, plain);
});

test('date parses to the expected instant and messageId is preserved', async () => {
  const raw =
    `From: d@example.jp\r\nSubject: d\r\nDate: ${DATE_HDR}\r\nMessage-ID: <keep-me-42@example.jp>\r\n` +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody\r\n';
  const { note } = await parse(raw, 42);
  assert.equal(note.date, '2026-11-03T00:15:00.000Z');
  assert.equal(note.messageId, '<keep-me-42@example.jp>');
  assert.equal(note.uid, 42);
});
