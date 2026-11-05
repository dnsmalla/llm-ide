import { createHash } from 'node:crypto';

// The exact bytes both clients pin in tests: raw SPKI DER and the 32-byte nonce, concatenated after a
// domain-separation prefix. Keeping this here (not in a route) lets the desktop's Rust port and the
// browser's WebCrypto code use the same documented vector.
const COMMIT_PREFIX = Buffer.from('llmide/link/commit/v1');
const SAS_PREFIX = Buffer.from('llmide/link/sas/v1');

const raw = (value) => Buffer.from(value, 'base64url');
const digest = (parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

export function linkCommitment(signingKey, ecdhKey, deviceNonce) {
  return digest([COMMIT_PREFIX, raw(signingKey), raw(ecdhKey), raw(deviceNonce)]).toString('base64url');
}

export function linkSas(signingKey, ecdhKey, desktopSigningKey, deviceNonce, desktopNonce) {
  const h = digest([SAS_PREFIX, raw(signingKey), raw(ecdhKey), raw(desktopSigningKey), raw(deviceNonce), raw(desktopNonce)]);
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
