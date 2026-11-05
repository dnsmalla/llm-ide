// node scripts/relay-vectors.mjs          check schema/relay/v1/vectors/v1.json (exit 1 on any mismatch)
// node scripts/relay-vectors.mjs --write  regenerate it (new keys and signatures; ECDSA is randomized)
// Deterministic parts (encoding, subkeys, padding, AES-GCM with the fixed nonce, ECDH, wrap key) are recomputed;
// signatures are verify-only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import * as R from './relay-reference.mjs';

const FILE = new URL('../schema/relay/v1/vectors/v1.json', import.meta.url);
const hex = (x) => Buffer.from(x).toString('hex');
const pk8 = (k) => k.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
const spki = (k) => k.export({ type: 'spki', format: 'der' }).toString('base64url');
const priv = (s) => createPrivateKey({ key: Buffer.from(s, 'base64url'), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: Buffer.from(s, 'base64url'), format: 'der', type: 'spki' });

function build(keys) {
  const ids = { userId: 'user-AAAAAAAAAAAAAAAAAAAAAA', desktopId: 'desk-BBBBBBBBBBBBBBBBBBBBBB', deviceId: 'dev-CCCCCCCCCCCCCCCCCCCCCC' };
  const root = Buffer.alloc(32, 0x11);
  const sub = R.deviceKeys(root, ids, 7);
  const header = { purpose: 'request', userId: ids.userId, desktopId: ids.desktopId, from: ids.deviceId, to: ids.desktopId, epoch: 7, session: 'AAECAwQFBgcICQoLDA0ODw', seq: 3, issuedAt: 1762300000000, tier: '' };
  const frame = '{"apiVersion":1,"id":"r1","type":"request","command":"host.ping","payload":{},"ts":1}';
  const nonce = Buffer.alloc(12, 0x22);
  const env = keys.env ?? R.seal({ header, key: sub.request, plaintext: Buffer.from(frame), signingKey: priv(keys.deviceSigning), nonce });
  const wrapEnv = keys.wrap ?? R.makeWrap({ ids, epoch: 7, tier: 'web', deviceEcdhSpki: Buffer.from(keys.deviceEcdhPub, 'base64url'),
    desktopSigningSpki: Buffer.from(keys.desktopSigningPub, 'base64url'), keys: sub, hostApiToken: 'host-api-token-0123456789abcdef0123456789abc',
    signingKey: priv(keys.desktopSigning), eph: { privateKey: priv(keys.ephPriv), publicKey: pub(keys.ephPub) }, nonce: Buffer.alloc(12, 0x33), seq: 9, issuedAt: 1762300000001 });
  const authMsg = R.authMessage('Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtMDA', 'device', hex(createHash('sha256').update(Buffer.alloc(32, 0x44)).digest()));
  return {
    v: 1,
    keys: { deviceSigningPkcs8: keys.deviceSigning, deviceSigningSpki: keys.deviceSigningPub, deviceEcdhPkcs8: keys.deviceEcdh, deviceEcdhSpki: keys.deviceEcdhPub,
      desktopSigningPkcs8: keys.desktopSigning, desktopSigningSpki: keys.desktopSigningPub, ephPkcs8: keys.ephPriv, ephSpki: keys.ephPub },
    canonical: { fields: [1, 'ab', ''], hex: hex(R.enc([1, 'ab', ''])) },
    subkeys: { rootHex: hex(root), ids, epoch: 7, requestHex: hex(sub.request), replyHex: hex(sub.reply) },
    padding: { frameLen: frame.length, bucket: R.pad(Buffer.from(frame)).length },
    envelope: { header, frame, keyHex: hex(sub.request), nonceHex: hex(nonce), aadHex: hex(R.enc([...R.headerFields(header), Buffer.alloc(0)])), env },
    wrap: { env: wrapEnv, hostApiToken: 'host-api-token-0123456789abcdef0123456789abc', currentEpoch: 6 },
    keyconfirm: { plaintextHex: hex(R.keyConfirmPlaintext(Buffer.from(wrapEnv.sig, 'base64url'))) },
    auth: { messageUtf8: authMsg.toString('utf8'), proof: keys.authProof ?? sign('sha256', authMsg, { key: priv(keys.deviceSigning), dsaEncoding: 'ieee-p1363' }).toString('base64url'), deviceTokenHex: hex(Buffer.alloc(32, 0x44)) },
    negatives: ['flip:ct', 'flip:nonce', 'flip:sig', 'truncate:ct', 'set:to=other', 'set:purpose=reply', 'set:v=2', 'set:epoch=8', 'set:seq=4', 'set:session=BBBBBBBBBBBBBBBBBBBBBB', 'set:issuedAt=1'],
  };
}

function freshKeys() {
  const g = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const [ds, de, ks, ep] = [g(), g(), g(), g()];
  return { deviceSigning: pk8(ds.privateKey), deviceSigningPub: spki(ds.publicKey), deviceEcdh: pk8(de.privateKey), deviceEcdhPub: spki(de.publicKey),
    desktopSigning: pk8(ks.privateKey), desktopSigningPub: spki(ks.publicKey), ephPriv: pk8(ep.privateKey), ephPub: spki(ep.publicKey) };
}

if (process.argv.includes('--write')) {
  mkdirSync(new URL('.', FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(build(freshKeys()), null, 2)}\n`);
  console.log('relay vectors: written');
} else {
  const v = JSON.parse(readFileSync(FILE, 'utf8'));
  const k = v.keys;
  const keys = { deviceSigning: k.deviceSigningPkcs8, deviceSigningPub: k.deviceSigningSpki, deviceEcdh: k.deviceEcdhPkcs8, deviceEcdhPub: k.deviceEcdhSpki,
    desktopSigning: k.desktopSigningPkcs8, desktopSigningPub: k.desktopSigningSpki, ephPriv: k.ephPkcs8, ephPub: k.ephSpki, env: v.envelope.env, wrap: v.wrap.env, authProof: v.auth.proof };
  const again = build(keys);
  const strip = (x) => JSON.stringify({ ...x, envelope: { ...x.envelope, env: undefined }, wrap: { ...x.wrap, env: undefined } });
  if (strip(again) !== strip(v)) { console.error('relay vectors: deterministic values differ'); process.exit(1); }
  const reSealed = R.seal({ header: v.envelope.header, key: Buffer.from(v.envelope.keyHex, 'hex'), plaintext: Buffer.from(v.envelope.frame), signingKey: priv(k.deviceSigningPkcs8), nonce: Buffer.from(v.envelope.nonceHex, 'hex') });
  if (reSealed.ct !== v.envelope.env.ct) { console.error('relay vectors: ciphertext differs'); process.exit(1); }
  R.open({ env: v.envelope.env, key: Buffer.from(v.envelope.keyHex, 'hex'), verifyKey: pub(k.deviceSigningSpki), expect: {} });
  R.unwrap({ env: v.wrap.env, ecdhPrivate: priv(k.deviceEcdhPkcs8), deviceEcdhSpki: Buffer.from(k.deviceEcdhSpki, 'base64url'), desktopSigningSpki: Buffer.from(k.desktopSigningSpki, 'base64url'), verifyKey: pub(k.desktopSigningSpki), currentEpoch: v.wrap.currentEpoch, deviceId: v.subkeys.ids.deviceId });
  if (!verify('sha256', Buffer.from(v.auth.messageUtf8), { key: pub(k.deviceSigningSpki), dsaEncoding: 'ieee-p1363' }, Buffer.from(v.auth.proof, 'base64url'))) { console.error('relay vectors: auth proof'); process.exit(1); }
  console.log('relay vectors: ok');
}
