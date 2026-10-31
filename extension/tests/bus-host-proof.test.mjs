// H1: the command-bus host proof is a SEPARATE secret derived from LLMIDE_HOST_APPROVAL_KEY. The /health identity nonce
// (LLMIDE_CORE_NONCE, served unauthenticated) must never raise a client class.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const KEY_HEX = 'a1'.repeat(32);
const NONCE = 'ab'.repeat(24);
const proofOf = (keyHex) => crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update('bus-host-proof/v1').digest('hex');
const SAVED = { ...process.env };
const { resolveClient } = await import('../routes/bus/client.mjs');
const H = await import('../core/host-approval.mjs');

const as = (cls, extra = {}) => resolveClient({ headers: { 'x-llmide-client': cls, ...extra } });
beforeEach(() => {
  for (const k of ['LLMIDE_BUS_TRUST_CLIENT_HEADER', 'LLMIDE_CORE_NONCE', 'LLMIDE_HOST_APPROVAL_KEY', 'LLMIDE_HOST', 'LLMIDE_ALLOW_REMOTE']) delete process.env[k];
  process.env.NODE_ENV = 'test';
});
after(() => { for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]; Object.assign(process.env, SAVED); });

test('the /health nonce is not a credential: it does not raise the class, with or without the approval key', () => {
  process.env.LLMIDE_CORE_NONCE = NONCE;
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': NONCE }).client, 'extension');
  process.env.LLMIDE_HOST_APPROVAL_KEY = KEY_HEX;
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': NONCE }).client, 'extension');
  assert.equal(as('ios-native', { 'x-llmide-host-nonce': NONCE }).client, 'extension');
});

test('the derived proof raises the class; wrong, missing, truncated and repeated proofs are capped at extension', () => {
  process.env.LLMIDE_HOST_APPROVAL_KEY = KEY_HEX;
  process.env.LLMIDE_CORE_NONCE = NONCE;
  const proof = proofOf(KEY_HEX);
  assert.equal(H.busHostProof(process.env), proof);
  assert.notEqual(proof, NONCE);
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': proof }).client, 'desktop-ui');
  assert.equal(as('ios-native', { 'x-llmide-host-nonce': proof }).client, 'ios-native');
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': proofOf('b2'.repeat(32)) }).client, 'extension', 'proof of another key');
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': proof.slice(1) }).client, 'extension', 'short');
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': proof.toUpperCase() }).client, 'extension', 'shape is lower-case hex');
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': [proof, proof] }).client, 'extension', 'repeated header');
  assert.equal(as('desktop-ui').client, 'extension', 'missing');
});

test('a malformed approval key proves nothing (fails closed)', () => {
  process.env.LLMIDE_HOST_APPROVAL_KEY = 'zz';
  assert.equal(H.busHostProof(process.env), null);
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': proofOf(KEY_HEX) }).client, 'extension');
});

test('no approval key (standalone core): nobody can prove host, the nonce included', () => {
  process.env.LLMIDE_CORE_NONCE = NONCE;
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': NONCE }).client, 'extension');
  assert.equal(as('desktop-ui', { 'x-llmide-host-nonce': proofOf(KEY_HEX) }).client, 'extension');
});

test('LLMIDE_BUS_TRUST_CLIENT_HEADER=1 works on loopback in dev, and is REFUSED when bound non-loopback or in production', () => {
  process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER = '1';
  assert.equal(as('desktop-ui').client, 'desktop-ui');
  process.env.NODE_ENV = 'production';
  assert.equal(as('desktop-ui').client, 'extension', 'production');
  process.env.NODE_ENV = 'test';
  process.env.LLMIDE_HOST = '0.0.0.0'; process.env.LLMIDE_ALLOW_REMOTE = '1';
  assert.equal(as('desktop-ui').client, 'extension', 'non-loopback bind');
  process.env.LLMIDE_HOST = '127.0.0.1';
  assert.equal(as('desktop-ui').client, 'desktop-ui');
});

test('the proof header and the approval key never survive object redaction', async () => {
  const { redact } = await import('../core/redact-object.mjs');
  const proof = proofOf(KEY_HEX);
  const out = JSON.stringify(redact({ headers: { 'x-llmide-host-nonce': proof, 'user-agent': 'x' }, LLMIDE_HOST_APPROVAL_KEY: KEY_HEX }));
  assert.ok(!out.includes(proof));
  assert.ok(!out.includes(KEY_HEX));
});
