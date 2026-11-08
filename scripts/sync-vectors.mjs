// node scripts/sync-vectors.mjs          check schema/sync/v1/vectors/v1.json (exit 1 on mismatch)
// node scripts/sync-vectors.mjs --write  regenerate it
// Built on the independent reference (scripts/relay-reference.mjs), never on extension/core/sync-envelope.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, verify } from 'node:crypto';
import * as R from './relay-reference.mjs';

const RELAY = JSON.parse(readFileSync(new URL('../schema/relay/v1/vectors/v1.json', import.meta.url)));
const FILE = new URL('../schema/sync/v1/vectors/v1.json', import.meta.url);
const hex = (x) => Buffer.from(x).toString('hex');
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });
const sha = (...p) => createHash('sha256').update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();

function build() {
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
  const snapshot = R.seal({ header: hdr('snapshot', 9), key: k.snapshot, plaintext: Buffer.from(snapPlain), signingKey, nonce: Buffer.alloc(12, 0x44) });
  const manifest = R.seal({ header: hdr('manifest', 10), key: k.manifest, plaintext: Buffer.from(manPlain), signingKey, nonce: Buffer.alloc(12, 0x45) });
  const ephSpki = b(keys.ephSpki); const devSpki = b(keys.deviceEcdhSpki); const deskSpki = b(keys.desktopSigningSpki);
  const z = diffieHellman({ privateKey: priv(keys.ephPkcs8), publicKey: pub(keys.deviceEcdhSpki) });
  const wrapKey = Buffer.from(hkdfSync('sha256', z, sha(R.enc([ephSpki, devSpki])), R.enc(['llmide/syncwrap/v1', epoch, ids.deviceId, sha(devSpki), sha(deskSpki), 'web']), 32));
  const wrapHeader = { purpose: 'syncwrap', userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq: 11, issuedAt: 1762300000002, tier: 'web' };
  const syncwrap = R.seal({ header: wrapHeader, key: wrapKey, plaintext: R.enc([k.request, k.reply, k.snapshot, k.manifest]), signingKey, nonce: Buffer.alloc(12, 0x55), extra: ephSpki });
  // Device -> desktop request and desktop -> device reply (design 4.4), for the device implementations.
  const reqPlain = '{"v":1,"requestId":"RRRRRRRRRRRRRRRRRRRRRR","class":"chat.send","text":"hello"}';
  const request = R.seal({ header: { purpose: 'request', userId: ids.userId, desktopId: ids.desktopId, from: ids.deviceId, to: ids.desktopId, epoch, session: '', seq: 1, issuedAt: 1762300000300, tier: '' },
    key: k.request, plaintext: Buffer.from(reqPlain), signingKey: priv(keys.deviceSigningPkcs8), nonce: Buffer.alloc(12, 0x71) });
  const replyPlain = '{"v":1,"requestId":"RRRRRRRRRRRRRRRRRRRRRR","ok":true,"text":"hi","finishedAt":1762300000400}';
  const reply = R.seal({ header: hdr('reply', 13), key: k.reply, plaintext: Buffer.from(replyPlain), signingKey, nonce: Buffer.alloc(12, 0x72) });
  const other = 'h1-00000000-0000-4000-8000-000000000002';
  const typedNegatives = [
    { target: 'snapshot', mutate: { op: 'flip', field: 'ct' }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'flip', field: 'sig' }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'flip', field: 'nonce' }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'truncate', field: 'ct' }, error: 'bad_ciphertext' },
    { target: 'snapshot', mutate: { op: 'set', field: 'purpose', value: 'manifest' }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'set', field: 'purpose', value: 'wrap' }, error: 'bad_purpose' },
    { target: 'snapshot', mutate: { op: 'set', field: 'epoch', value: 4 }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'set', field: 'to', value: other }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'set', field: 'eph', value: 'AAAA' }, error: 'bad_signature' },
    { target: 'snapshot', mutate: { op: 'set', field: 'v', value: 2 }, error: 'bad_version' },
    { target: 'snapshot', mutate: { op: 'set', field: 'extra', value: 1 }, error: 'bad_envelope' },
    { target: 'snapshot', mutate: { op: 'key', value: 'manifest' }, error: 'bad_ciphertext' },
    { target: 'snapshot', mutate: { op: 'expect', field: 'epoch', value: 4 }, error: 'bad_epoch' },
    { target: 'snapshot', mutate: { op: 'expect', field: 'to', value: other }, error: 'bad_to' },
    { target: 'manifest', mutate: { op: 'set', field: 'seq', value: 11 }, error: 'bad_signature' },
    { target: 'manifest', mutate: { op: 'expect', field: 'purpose', value: 'snapshot' }, error: 'bad_purpose' },
    { target: 'request', mutate: { op: 'flip', field: 'sig' }, error: 'bad_signature' },
    { target: 'request', mutate: { op: 'expect', field: 'from', value: other }, error: 'bad_from' },
    { target: 'reply', mutate: { op: 'key', value: 'snapshot' }, error: 'bad_ciphertext' },
    { target: 'reply', mutate: { op: 'expect', field: 'to', value: other }, error: 'bad_to' },
    { target: 'syncwrap', mutate: { op: 'set', field: 'to', value: other }, error: 'bad_to' },
    { target: 'syncwrap', mutate: { op: 'currentEpoch', value: 3 }, error: 'stale_epoch' },
    { target: 'syncwrap', mutate: { op: 'set', field: 'tier', value: 'ios' }, error: 'bad_signature' },
    { target: 'syncwrap', mutate: { op: 'set', field: 'purpose', value: 'snapshot' }, error: 'bad_purpose' },
    { target: 'syncwrap', mutate: { op: 'flip', field: 'ct' }, error: 'bad_signature' },
  ];

  // Enrollment (README "Enrollment"), built independently of extension/core/sync-enroll.mjs.
  const ENR_SALT = sha(Buffer.from('llmide-sync-enroll-v1'));
  const es = Buffer.alloc(16, 0x77);
  const pair = { sid: ids.desktopId, sfp: sha(deskSpki).toString('base64url'), dir: 'D'.repeat(22), slot: 'E'.repeat(22), es: es.toString('base64url'), st: 'mega:llmide-sync' };
  const query = `sv=1&sid=${pair.sid}&sfp=${pair.sfp}&dir=${pair.dir}&slot=${pair.slot}&es=${pair.es}&st=${encodeURIComponent(pair.st)}`;
  const ek = (label) => Buffer.from(hkdfSync('sha256', es, ENR_SALT, R.enc([label, pair.sid, pair.slot]), 32));
  const devSig = b(keys.deviceSigningSpki);
  const deviceId = sha(devSig).subarray(0, 16).toString('base64url');
  const tier = 'ios'; const name = 'Test iPhone'; const userId = ids.userId;
  const B = [pair.sid, pair.slot, pair.dir, b(pair.sfp), tier, deviceId, devSpki, devSig, name];
  const mac = createHmac('sha256', ek('bind')).update(R.enc(B)).digest();
  const claimHash = sha(R.enc(['llmide/sync-claim/v1', deviceId, devSpki, devSig, name]));
  const nD = Buffer.alloc(16, 0x6e);
  const sasH = createHmac('sha256', ek('sas')).update(R.enc([...B, nD])).digest();
  const sas = String(sasH.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  const claimEnv = R.seal({ header: { purpose: 'enroll', userId: '', desktopId: pair.sid, from: deviceId, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, issuedAt: 1762300000100, tier: '' },
    key: ek('enroll'), plaintext: R.enc([devSpki, devSig, name, mac]), signingKey: priv(keys.deviceSigningPkcs8), nonce: Buffer.alloc(12, 0x61), extra: devSig });
  const ackEnv = R.seal({ header: { purpose: 'enrollack', userId, desktopId: pair.sid, from: pair.sid, to: deviceId, epoch: 0, session: pair.slot, seq: 12, issuedAt: 1762300000200, tier },
    key: ek('enrollack'), plaintext: R.enc([nD, claimHash]), signingKey, nonce: Buffer.alloc(12, 0x62) });
  const enroll = {
    pair, tier, name, userId, iosUrl: `llmide://pair?${query}`, webUrl: `https://llm-ide.com/#pair=${encodeURIComponent(query)}`,
    deviceSigningSpki: keys.deviceSigningSpki, deviceId,
    enrollKeyHex: hex(ek('enroll')), enrollackKeyHex: hex(ek('enrollack')), bindKeyHex: hex(ek('bind')), sasKeyHex: hex(ek('sas')),
    macHex: hex(mac), claimHashHex: hex(claimHash), nDHex: hex(nD), sas,
    claim: { name: 'F'.repeat(22), nonceHex: hex(Buffer.alloc(12, 0x61)), env: claimEnv }, ack: { nonceHex: hex(Buffer.alloc(12, 0x62)), env: ackEnv },
    negatives: [
      { target: 'claim', mutate: { op: 'flip', field: 'ct' }, error: 'bad_signature' },
      { target: 'claim', mutate: { op: 'expect', field: 'es', value: Buffer.alloc(16, 0x78).toString('base64url') }, error: 'bad_ciphertext' },
      { target: 'claim', mutate: { op: 'expect', field: 'tier', value: 'web' }, error: 'bad_mac' },
      { target: 'claim', mutate: { op: 'expect', field: 'dir', value: 'G'.repeat(22) }, error: 'bad_mac' },
      { target: 'claim', mutate: { op: 'expect', field: 'sfp', value: 'H'.repeat(43) }, error: 'bad_mac' },
      { target: 'claim', mutate: { op: 'set', field: 'session', value: 'G'.repeat(22) }, error: 'bad_session' },
      { target: 'ack', mutate: { op: 'flip', field: 'sig' }, error: 'bad_signature' },
      { target: 'ack', mutate: { op: 'verifyKey' }, error: 'bad_signature' },
      { target: 'ack', mutate: { op: 'expect', field: 'name', value: 'Attacker phone' }, error: 'ack_mismatch' },
      { target: 'ack', mutate: { op: 'expect', field: 'tier', value: 'web' }, error: 'bad_tier' },
      { target: 'ack', mutate: { op: 'set', field: 'session', value: 'G'.repeat(22) }, error: 'bad_session' },
    ],
  };

  // C5 device policy: the two clocks every implementation must agree on. The manifest cases are the existing
  // manifest's validUntil (± the 7-day grace); the token cases are 90 days from pairing. Both fail closed.
  const DAY = 86_400_000;
  const manifestValidUntil = 1762302700000;
  const devicePolicy = {
    manifest: {
      staleAfterMs: 7 * DAY,
      validUntil: manifestValidUntil,
      cases: [
        { name: 'at_validUntil', nowMs: manifestValidUntil, expect: 'fresh' },
        { name: 'just_past_validUntil', nowMs: manifestValidUntil + 1, expect: 'withheld' },
        { name: 'at_grace_boundary', nowMs: manifestValidUntil + 7 * DAY, expect: 'withheld' },
        { name: 'past_grace', nowMs: manifestValidUntil + 7 * DAY + 1, expect: 'stale_manifest' },
      ],
    },
    deviceToken: {
      maxLifetimeMs: 90 * DAY,
      pairedAt: 1762300000000,
      cases: [
        { name: 'at_pairing', nowMs: 1762300000000, expect: 'live' },
        { name: 'at_89_days', nowMs: 1762300000000 + 89 * DAY, expect: 'live' },
        { name: 'at_90_days', nowMs: 1762300000000 + 90 * DAY, expect: 'live' },
        { name: 'past_90_days', nowMs: 1762300000000 + 90 * DAY + 1, expect: 'expired' },
      ],
    },
  };
  const manifestState = (validUntil, now) => (validUntil + devicePolicy.manifest.staleAfterMs < now ? 'stale_manifest' : now > validUntil ? 'withheld' : 'fresh');
  const tokenState = (pairedAt, now) => (now - pairedAt > devicePolicy.deviceToken.maxLifetimeMs ? 'expired' : 'live');

  return {
    v: 1, ids, epoch, rootHex: hex(root),
    keys: { desktopSigningPkcs8: keys.desktopSigningPkcs8, desktopSigningSpki: keys.desktopSigningSpki, deviceEcdhPkcs8: keys.deviceEcdhPkcs8, deviceEcdhSpki: keys.deviceEcdhSpki, deviceSigningPkcs8: keys.deviceSigningPkcs8, deviceSigningSpki: keys.deviceSigningSpki, ephPkcs8: keys.ephPkcs8, ephSpki: keys.ephSpki },
    desktopSigningFingerprint: sha(deskSpki).toString('base64url'),
    requestKeyHex: hex(k.request), replyKeyHex: hex(k.reply), snapshotKeyHex: hex(k.snapshot), manifestKeyHex: hex(k.manifest),
    snapshot: { plaintext: snapPlain, env: snapshot }, manifest: { plaintext: manPlain, env: manifest }, syncwrap: { env: syncwrap }, enroll,
    request: { plaintext: reqPlain, env: request }, reply: { plaintext: replyPlain, env: reply }, typedNegatives, devicePolicy,
    negatives: ['flip:ct', 'flip:sig', 'truncate:ct', 'purpose=manifest', 'epoch=4', 'to=h1-00000000-0000-4000-8000-000000000002', 'v=2'],
  };
}

const write = process.argv.includes('--write');
let current = null;
try { current = JSON.parse(readFileSync(FILE)); } catch { /* first run */ }
const next = build();
if (write) {
  mkdirSync(new URL('.', FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  console.log('wrote', FILE.pathname);
} else {
  const strip = (v) => JSON.stringify(v, (k, x) => (k === 'sig' ? '<sig>' : x));
  const same = strip(next) === strip(current);
  const sigOk = ['snapshot', 'manifest', 'syncwrap'].every((n) => {
    const e = current[n].env;
    const extra = e.eph ? b(e.eph) : Buffer.alloc(0);
    return verify('sha256', Buffer.concat([Buffer.from(`llmide/${e.purpose}/v1\0`), R.enc([...R.headerFields(e), extra, b(e.nonce), b(e.ct)])]), { key: pub(current.keys.desktopSigningSpki), dsaEncoding: 'ieee-p1363' }, b(e.sig));
  });
  const verifyEnv = (e, spki) => verify('sha256', Buffer.concat([Buffer.from(`llmide/${e.purpose}/v1\0`), R.enc([...R.headerFields(e), e.eph ? b(e.eph) : Buffer.alloc(0), b(e.nonce), b(e.ct)])]), { key: pub(spki), dsaEncoding: 'ieee-p1363' }, b(e.sig));
  const enrollOk = !!current.enroll && verifyEnv(current.enroll.claim.env, current.enroll.deviceSigningSpki) && verifyEnv(current.enroll.ack.env, current.keys.desktopSigningSpki);
  const deviceOk = !!current.request && verifyEnv(current.request.env, current.keys.deviceSigningSpki) && verifyEnv(current.reply.env, current.keys.desktopSigningSpki);
  // Execute the policy cases here too: the shared vector is a spec, not a snapshot. Any implementation that
  // imports these numbers (Node core, Swift, WebCrypto) must get the same answer for every row.
  const policy = current.devicePolicy;
  const manifestState = (validUntil, now) => (validUntil + policy.manifest.staleAfterMs < now ? 'stale_manifest' : now > validUntil ? 'withheld' : 'fresh');
  const tokenState = (pairedAt, now) => (now - pairedAt > policy.deviceToken.maxLifetimeMs ? 'expired' : 'live');
  const policyOk = !!policy && policy.manifest.staleAfterMs === 7 * 86_400_000 && policy.deviceToken.maxLifetimeMs === 90 * 86_400_000
    && policy.manifest.cases.every((c) => manifestState(policy.manifest.validUntil, c.nowMs) === c.expect)
    && policy.deviceToken.cases.every((c) => tokenState(policy.deviceToken.pairedAt, c.nowMs) === c.expect);
  if (!same || !sigOk || !enrollOk || !deviceOk || !policyOk) { console.error('sync v1 vectors out of date: run node scripts/sync-vectors.mjs --write'); process.exit(1); }
  console.log('sync v1 vectors ok');
}
