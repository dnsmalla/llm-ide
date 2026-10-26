// errorText turns server error bodies into messages. An object body must
// read its message, never stringify to "[object Object]".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../src/lib/server-error.ts';

test('reads the message of the { error: { code, message } } envelope', () => {
  const body = { error: { code: 'VALIDATION_FAILED', message: 'Missing transcript' } };
  assert.equal(errorText(body, 400), 'Missing transcript');
});

test('keeps the legacy { error: "text" } shape', () => {
  assert.equal(errorText({ error: 'Rate limited' }, 429), 'Rate limited');
});

test('falls back to the status when the body has no usable message', () => {
  assert.equal(errorText({}, 502), 'Server error: 502');
  assert.equal(errorText({ error: {} }, 500), 'Server error: 500');
  assert.equal(errorText({ error: { code: 'X' } }, 500), 'Server error: 500');
  assert.equal(errorText(null, 503), 'Server error: 503');
  assert.equal(errorText('<html>', 504), 'Server error: 504');
});

test('uses the caller fallback when given, and never prints [object Object]', () => {
  assert.equal(errorText({}, 500, 'Failed to generate DOCX'), 'Failed to generate DOCX');
  assert.equal(errorText({ error: { code: 'X' } }, undefined, 'Server streaming error'), 'Server streaming error');
  assert.equal(errorText({ error: {} }), 'Server error');
  for (const body of [{ error: { message: 'm' } }, { error: {} }, {}]) {
    assert.ok(!errorText(body, 500).includes('[object Object]'));
  }
});
