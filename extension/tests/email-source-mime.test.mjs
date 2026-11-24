import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { normalizeParsed } = await import('../connectors/email-source.mjs');

// NOTE: the ISO-2022-JP and Shift_JIS fixtures are fixed bytes, not produced by
// an encoder library: the encoders were only transitive dependencies (hoisted
// from imapflow, not declared in package.json), so a lockfile change could
// break the test with MODULE_NOT_FOUND. Only these JIS/Shift_JIS fixtures are
// cross-checked, by assertFixture against Node's built-in TextDecoder (an
// independent oracle), so a wrong constant can never be mistaken for a
// mailparser decoding regression. The UTF-8 fixtures are built inline.
const hex = (str) => Buffer.from(str, 'hex');
const JIS_SUBJECT = hex('1b244232713544244e35443b764f3f244b2444242424461b2842');
const JIS_NAME = hex('1b24423b3345441b2842201b244242404f3a1b2842');
const JIS_BODY = hex(
  '1b2442242a40244f43244b244a24432446242a246a245e243921231b28420d0a' +
  '1b24424c40467c244e446a4e6332713544244e35443b764f3f247236264d2d2437245e243921231b2842');
const SJIS_SUBJECT = hex('89ef8b6382cc8b638e96985e82c982c282a282c4');
const SJIS_BODY = hex(
  '82a890a2986282c982c882c182c482a882e882dc82b781420d0a96be93fa82cc92e897e1' +
  '89ef8b6382cc8b638e96985e82f08ba4974c82b582dc82b78142');

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
  const subject = JIS_SUBJECT;
  const name = JIS_NAME;
  const body = JIS_BODY;
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
  const subject = SJIS_SUBJECT;
  const body = SJIS_BODY;
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
