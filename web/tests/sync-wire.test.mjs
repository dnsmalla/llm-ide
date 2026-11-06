// The sync wire primitives (web/src/sync/wire.ts) against the relay v1 vectors that sync v1 builds on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enc, decodeEnc, pad, unpad, b64u, unb64u, MAX_FRAME } from '../src/sync/wire.ts';
const V = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url), 'utf8'));
const hex = (u) => Buffer.from(u).toString('hex');
test('canonical encoding and padding match the relay v1 vectors', () => {
  assert.equal(hex(enc(V.canonical.fields)), V.canonical.hex);
  const frame = new TextEncoder().encode(V.envelope.frame);
  const padded = pad(frame);
  assert.equal(padded.length, V.padding.bucket);
  assert.deepEqual(unpad(padded), frame);
});
test('decodeEnc inverts enc and refuses a wrong count or a truncated buffer', () => {
  const b = enc(['a', 7, new Uint8Array([1, 2])]);
  assert.equal(decodeEnc(b, 3).length, 3);
  assert.throws(() => decodeEnc(b, 2), /bad_encoding/);
  assert.throws(() => decodeEnc(b.subarray(0, b.length - 1), 3), /bad_encoding/);
});
test('padding refuses an oversized frame, a non-bucket length and non-zero filler', () => {
  assert.throws(() => pad(new Uint8Array(MAX_FRAME + 1)), /frame_too_large/);
  assert.throws(() => unpad(new Uint8Array(1000)), /bad_padding/);
  const p = pad(new Uint8Array([1])); p[p.length - 1] = 9; assert.throws(() => unpad(p), /bad_padding/);
});
test('base64url round-trips and refuses the standard alphabet', () => {
  const b = new Uint8Array([0, 251, 255, 62, 63]);
  assert.deepEqual(unb64u(b64u(b)), b); assert.doesNotMatch(b64u(b), /[+/=]/); assert.throws(() => unb64u('a+b/'), /bad_base64/);
});
