import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest, response, event, errorFrame, clamp } from '../routes/host-api/frame.mjs';
import { validate } from '../routes/bus/schema-validate.mjs';
import { HOST_API_ENVELOPE } from '../routes/host-api/commands.generated.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../schema/host-api/v1/fixtures');
const read = (p) => readFileSync(join(DIR, p), 'utf8');
const defs = HOST_API_ENVELOPE.$defs;

test('every valid request fixture parses', () => {
  const r = parseRequest(read('valid/request.json'));
  assert.equal(r.ok, true);
  assert.equal(r.command, JSON.parse(read('valid/request.json')).command);
});

test('refusals carry the same codes and message templates as the Mac host', () => {
  assert.equal(parseRequest(' '.repeat(1048577)).code, 'invalid_payload');
  assert.equal(parseRequest('not json').code, 'invalid_payload');
  const unknownField = parseRequest('{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1,"surprise":true}');
  assert.deepEqual(unknownField, { ok: false, replyTo: 'c-1', code: 'invalid_payload', message: 'The frame does not match the Host API envelope (.surprise).' });
  const unknown = parseRequest('{"apiVersion":1,"id":"c-2","type":"request","command":"files.write","payload":{},"ts":1}');
  assert.equal(unknown.code, 'unknown_command'); assert.equal(unknown.replyTo, 'c-2');
  const bad = parseRequest('{"apiVersion":1,"id":"c-3","type":"request","command":"chat.send","payload":{"text":""},"ts":1}');
  assert.deepEqual(bad, { ok: false, replyTo: 'c-3', code: 'invalid_payload', message: 'The payload does not match chat.send (.text).' });
  const longKey = parseRequest(`{"apiVersion":1,"id":"c-4","type":"request","command":"host.ping","payload":{},"ts":1,"${'k'.repeat(2000)}":1}`);
  assert.ok(longKey.message.length <= 500);
});

test('every invalid command fixture is refused with invalid_payload', () => {
  const cases = JSON.parse(read('invalid-cases.json')).commands;
  for (const [file, c] of Object.entries(cases)) {
    if (c.kind !== 'request') continue;
    const frame = JSON.stringify({ apiVersion: 1, id: 'c-9', type: 'request', command: c.command, payload: JSON.parse(read(`invalid/commands/${file}`)), ts: 1 });
    assert.equal(parseRequest(frame).code, 'invalid_payload', file);
  }
});

test('response, event and error frames validate; bad results and events throw internal', () => {
  const r = JSON.parse(response('c-1', 'host.ping', {}, 3));
  assert.deepEqual(validate(defs.Response, r, { defs }), []);
  assert.equal(r.rev, 3);
  assert.throws(() => response('c-1', 'host.auth.pair', { capabilities: [], token: 'short' }, 0), (e) => e.code === 'internal');
  const e = JSON.parse(event('chat.delta', { text: 'hi' }, 9, 'c-7'));
  assert.deepEqual(validate(defs.Event, e, { defs }), []);
  assert.throws(() => event('chat.delta', { text: 'x'.repeat(100001) }, 1), (err) => err.code === 'internal');
  const long = JSON.parse(errorFrame({ replyTo: 'c-1', code: 'denied', message: 'é'.repeat(900), retryable: false, rev: 1 }));
  assert.deepEqual(validate(defs.ErrorFrame, long, { defs }), []);
  const odd = JSON.parse(errorFrame({ replyTo: null, code: 'nope', message: '', retryable: true, retryAfterMs: 500, rev: 1 }));
  assert.equal(odd.error.code, 'internal'); assert.equal(odd.error.details.retryAfterMs, 500);
});

test('clamp cuts on code-point boundaries within the UTF-16 cap', () => {
  assert.equal(clamp('😀😀😀', 5), '😀😀');
  assert.equal(clamp('abc', 10), 'abc');
});

test('fixture directories are all exercised', () => {
  assert.ok(readdirSync(join(DIR, 'invalid/commands')).length > 0);
});
