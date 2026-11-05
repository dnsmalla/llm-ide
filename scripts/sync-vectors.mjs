// node scripts/sync-vectors.mjs          check schema/sync/v1/vectors/v1.json (exit 1 on mismatch)
// node scripts/sync-vectors.mjs --write  regenerate it
// Built on the independent reference (scripts/relay-reference.mjs), never on extension/core/sync-envelope.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, verify } from 'node:crypto';
import * as R from './relay-reference.mjs';

const RELAY = JSON.parse(readFileSync(new URL('../schema/relay/v1/vectors/v1.json', import.meta.url)));
const FILE = new URL('../schema/sync/v1/vectors/v1.json', import.meta.url);
const hex = (x) => Buffer.from(x).toString('hex');
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });
const sha = (...p) => createHash('sha256').update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();

function build(previous) {
  const keys = RELAY.keys;
  const ids = { userId: 'user-AAAAAAAAAAAAAAAAAAAAAA', desktopId: 'BBBBBBBBBBBBBBBBBBBBBB', deviceId: 'h1-00000000-0000-4000-8000-000000000001' };
  const epoch = 3;
  const root = Buffer.alloc(32, 0x66);
  const sk = (purpose, sender, recipient) => R.subkey(root, { userId: ids.userId, desktopId: ids.desktopId, purpose, epoch, sender, recipient });
  const k = { request: sk('request', ids.deviceId, ids.desktopId), reply: sk('reply', ids.desktopId, ids.deviceId),
    snapshot: sk('snapshot', ids.desktopId, ids.deviceId), manifest: sk('manifest', ids.desktopId, ids.deviceId) };
  const hdr = (purpose, seq, tier = '') => ({ purpose, userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq, issuedAt: 1762300000000 + seq, tier });
  const snapPlain = '{"v":1,"kind":"chats","generatedAt":1762300000000,"truncated":false,"items":[]}';
  const manPlain = '{"v":1,"manifestSeq":10,"epoch":3,"generatedAt":1762300000000,"validUntil":1762302700000,"kinds":{}}';
  const signingKey = priv(keys.desktopSigningPkcs8);
  const snapshot = previous?.snapshot.env ?? R.seal({ header: hdr('snapshot', 9), key: k.snapshot, plaintext: Buffer.from(snapPlain), signingKey, nonce: Buffer.alloc(12, 0x44) });
  const manifest = previous?.manifest.env ?? R.seal({ header: hdr('manifest', 10), key: k.manifest, plaintext: Buffer.from(manPlain), signingKey, nonce: Buffer.alloc(12, 0x45) });
  const ephSpki = b(keys.ephSpki); const devSpki = b(keys.deviceEcdhSpki); const deskSpki = b(keys.desktopSigningSpki);
  const z = diffieHellman({ privateKey: priv(keys.ephPkcs8), publicKey: pub(keys.deviceEcdhSpki) });
  const wrapKey = Buffer.from(hkdfSync('sha256', z, sha(R.enc([ephSpki, devSpki])), R.enc(['llmide/syncwrap/v1', epoch, ids.deviceId, sha(devSpki), sha(deskSpki), 'web']), 32));
  const wrapHeader = { purpose: 'syncwrap', userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq: 11, issuedAt: 1762300000002, tier: 'web' };
  const syncwrap = previous?.syncwrap.env ?? R.seal({ header: wrapHeader, key: wrapKey, plaintext: R.enc([k.request, k.reply, k.snapshot, k.manifest]), signingKey, nonce: Buffer.alloc(12, 0x55), extra: ephSpki });
  return {
    v: 1, ids, epoch, rootHex: hex(root),
    keys: { desktopSigningPkcs8: keys.desktopSigningPkcs8, desktopSigningSpki: keys.desktopSigningSpki, deviceEcdhPkcs8: keys.deviceEcdhPkcs8, deviceEcdhSpki: keys.deviceEcdhSpki, ephPkcs8: keys.ephPkcs8, ephSpki: keys.ephSpki },
    desktopSigningFingerprint: sha(deskSpki).toString('base64url'),
    requestKeyHex: hex(k.request), replyKeyHex: hex(k.reply), snapshotKeyHex: hex(k.snapshot), manifestKeyHex: hex(k.manifest),
    snapshot: { plaintext: snapPlain, env: snapshot }, manifest: { plaintext: manPlain, env: manifest }, syncwrap: { env: syncwrap },
  };
}

const write = process.argv.includes('--write');
let current = null;
try { current = JSON.parse(readFileSync(FILE)); } catch { /* first run */ }
const next = build(write ? null : current);
if (write) {
  mkdirSync(new URL('.', FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  console.log('wrote', FILE.pathname);
} else {
  const same = JSON.stringify(next) === JSON.stringify(current);
  const sigOk = ['snapshot', 'manifest', 'syncwrap'].every((n) => {
    const e = current[n].env;
    const extra = e.eph ? b(e.eph) : Buffer.alloc(0);
    return verify('sha256', Buffer.concat([Buffer.from(`llmide/${e.purpose}/v1\0`), R.enc([...R.headerFields(e), extra, b(e.nonce), b(e.ct)])]), { key: pub(current.keys.desktopSigningSpki), dsaEncoding: 'ieee-p1363' }, b(e.sig));
  });
  if (!same || !sigOk) { console.error('sync v1 vectors out of date: run node scripts/sync-vectors.mjs --write'); process.exit(1); }
  console.log('sync v1 vectors ok');
}
