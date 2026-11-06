// desktop/scripts/minisign.mjs
// Verifies a Tauri updater signature (minisign, Ed25519) in Node, so the publish job can refuse to write a
// latest.json whose signatures the installed apps would reject. Fails closed on any parse problem.
import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const box = (b64) => Buffer.from(String(b64).trim(), 'base64').toString('utf8').split(/\r?\n/);

function publicKey(tauriPubkey) {
  const raw = Buffer.from(box(tauriPubkey)[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign Ed25519 public key');
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw.subarray(10)]), format: 'der', type: 'spki' }) };
}

export function verifyMinisign(tauriPubkey, tauriSig, bytes) {
  try {
    const pk = publicKey(tauriPubkey);
    const lines = box(tauriSig);
    const sig = Buffer.from(lines[1] ?? '', 'base64');
    if (sig.length !== 74) return { ok: false, reason: 'malformed signature' };
    const alg = sig.subarray(0, 2).toString('latin1');
    if (!sig.subarray(2, 10).equals(pk.id)) return { ok: false, reason: 'key id mismatch (signed with another key)' };
    const msg = alg === 'ED' ? createHash('blake2b512').update(bytes).digest() : alg === 'Ed' ? bytes : null;
    if (!msg) return { ok: false, reason: `unknown algorithm ${alg}` };
    if (!verify(null, msg, pk.key, sig.subarray(10))) return { ok: false, reason: 'bad signature' };
    const trusted = (lines[2] ?? '').replace(/^trusted comment: /, '');
    const global = Buffer.from(lines[3] ?? '', 'base64');
    if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, 'utf8')]), pk.key, global)) return { ok: false, reason: 'bad trusted-comment signature' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}
