// Reference device for the sync v1 device contract (schema/sync/v1/README.md "Enrollment"; design 4.3-4.4). SP3
// (WebCrypto) and SP4 (Swift) implement these same steps; tests drive this one against the desktop. Built on the
// independent reference (./sync-reference.mjs), never on core/sync-*.mjs, so a bug shared with the desktop cannot pass.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as S from './sync-reference.mjs';

const spkiOf = (k) => k.publicKey.export({ type: 'spki', format: 'der' });
const J = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));
const failWith = S.fail;
const newId22 = () => randomBytes(16).toString('base64url');

export function createReferenceDevice({ tier = 'ios', name = 'Test iPhone' } = {}) {
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = {
    tier, name, ecdhSpki: spkiOf(ecdh), signingSpki: spkiOf(sig), ecdhPrivate: ecdh.privateKey, signingKey: sig.privateKey,
    pair: null, keys: null, desktop: null, claimName: null, userId: null, epoch: 0, wrapKeys: null, prevReply: null, manifestSeq: 0,
  };
  d.deviceId = S.deviceIdOf(d.signingSpki);
  const base = () => `${d.pair.sid}/d/${d.pair.dir}`;
  const claim = () => ({ deviceId: d.deviceId, ecdhSpki: d.ecdhSpki, signingSpki: d.signingSpki, name: d.name });

  return Object.assign(d, {
    async scanAndClaim(store, qr, { now = Date.now() } = {}) {
      d.pair = S.parsePair(qr);
      const spki = await store.get(`${base()}/key.bin`);
      if (!spki || S.fingerprint(spki) !== d.pair.sfp) failWith('bad_desktop_key');
      d.desktop = { spki: Buffer.from(spki), verifyKey: S.verifyKeyOf(spki) };
      d.keys = S.enrollKeys(d.pair);
      d.claimName ??= newId22();
      const env = S.sealClaim({ pair: d.pair, tier, claim: claim(), keys: d.keys, signingKey: d.signingKey, issuedAt: now });
      await store.put(`${d.pair.sid}/e/${d.pair.slot}/${d.claimName}.bin`, Buffer.from(JSON.stringify(env)));
    },
    async readAck(store) {
      const bytes = await store.get(`${d.pair.sid}/e/${d.pair.slot}/ack.bin`);
      if (!bytes) return null;
      const { userId, nD } = S.openAck({ env: J(bytes), pair: d.pair, tier, claim: claim(), keys: d.keys, verifyKey: d.desktop.verifyKey });
      d.userId = userId;
      return S.sas(d.keys, d.pair, tier, claim(), nD);
    },
    async readWrap(store) {
      const bytes = await store.get(`${base()}/wrap.bin`);
      if (!bytes) return false;
      const env = J(bytes);
      if (env.tier !== tier || env.from !== d.pair.sid || env.desktopId !== d.pair.sid || env.userId !== d.userId) failWith('bad_wrap');
      if (!(env.epoch > d.epoch)) return false;
      const keys = S.unwrapSync({ env, ecdhPrivate: d.ecdhPrivate, deviceEcdhSpki: d.ecdhSpki, desktopSpki: d.desktop.spki,
        verifyKey: d.desktop.verifyKey, currentEpoch: d.epoch, deviceId: d.deviceId });
      if (d.wrapKeys) d.prevReply = { epoch: d.epoch, key: d.wrapKeys.reply };
      d.wrapKeys = keys;
      d.epoch = env.epoch;
      if (d.keys) { for (const k of Object.values(d.keys)) k.fill(0); d.keys = null; d.pair.es = ''; }
      return true;
    },
    async readSnapshot(store) {
      const raw = await store.get(`${base()}/manifest.bin`);
      if (!raw) failWith('removed');
      const env = J(raw);
      if (env.epoch > d.epoch && !(await d.readWrap(store))) failWith('bad_epoch');
      const m = JSON.parse(S.open({ env, key: d.wrapKeys.manifest, verifyKey: d.desktop.verifyKey,
        expect: { purpose: 'manifest', userId: d.userId, desktopId: d.pair.sid, from: d.pair.sid, to: d.deviceId, epoch: d.epoch } }));
      if (m.manifestSeq < d.manifestSeq) failWith('rollback');
      d.manifestSeq = m.manifestSeq;
      const kinds = {};
      for (const [kind, e] of Object.entries(m.kinds)) {
        const bytes = await store.get(`${base()}/${e.file}`);
        if (!bytes || S.sha256(bytes).toString('hex') !== e.sha256) failWith('bad_blob');
        kinds[kind] = JSON.parse(S.open({ env: J(bytes), key: d.wrapKeys.snapshot, verifyKey: d.desktop.verifyKey,
          expect: { purpose: 'snapshot', desktopId: d.pair.sid, to: d.deviceId, epoch: d.epoch } }));
      }
      return { manifest: m, kinds };
    },
    async sendRequest(store, text, { now = Date.now(), epoch = d.epoch, key = d.wrapKeys.request } = {}) {
      const requestId = newId22();
      const env = S.seal({ header: { purpose: 'request', userId: d.userId, desktopId: d.pair.sid, from: d.deviceId, to: d.pair.sid, epoch, session: '', seq: 1, issuedAt: now, tier: '' },
        key, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, class: 'chat.send', text })), signingKey: d.signingKey });
      await store.put(`${base()}/in/${String(now).padStart(13, '0')}-${requestId}.bin`, Buffer.from(JSON.stringify(env)));
      return requestId;
    },
    async readReply(store, requestId) {
      const bytes = await store.get(`${base()}/out/${requestId}.bin`);
      if (!bytes) return null;
      const env = J(bytes);
      const key = env.epoch === d.epoch ? d.wrapKeys.reply : env.epoch === d.prevReply?.epoch ? d.prevReply.key : null;
      if (!key) failWith('bad_epoch');
      return JSON.parse(S.open({ env, key, verifyKey: d.desktop.verifyKey, expect: { purpose: 'reply', desktopId: d.pair.sid, from: d.pair.sid, to: d.deviceId } }));
    },
  });
}
