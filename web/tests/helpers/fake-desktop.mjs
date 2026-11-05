// A desktop built from the shipped Node core (extension/core/sync-envelope.mjs + sync-enroll.mjs), the same functions the
// SP1/SP2 desktop calls, with the producer's exact headers and the consumer's reply format. No database.
import { createPublicKey, randomBytes } from 'node:crypto';
import * as S from '../../../extension/core/sync-envelope.mjs';
import * as E from '../../../extension/core/sync-enroll.mjs';

const bytesOf = (env) => Buffer.from(JSON.stringify(env));

export function createFakeDesktop({ store, userId = 'user-AAAAAAAAAAAAAAAAAAAAAA', tier = 'web', webOrigin = 'https://llm-ide.com', st = 'memory:' } = {}) {
  const signing = S.newSigningKey();
  const d = { store, userId, sid: E.newId22(), epoch: 1, root: randomBytes(32), seq: 1000, signing, prevRoot: null, devices: new Map(), lastSas: null };
  const next = () => ++d.seq;
  const ids = (deviceId) => ({ userId, desktopId: d.sid, deviceId });
  const keysOf = (deviceId, root = d.root, epoch = d.epoch) => S.deviceKeys(root, ids(deviceId), epoch);
  let pending = null;
  return Object.assign(d, {
    async open(now = Date.now()) {
      const es = randomBytes(16);
      const pair = { sid: d.sid, sfp: S.spkiFingerprint(signing.spki), dir: E.newId22(), slot: E.newId22(), es: es.toString('base64url'), st };
      pending = { pair, keys: E.enrollKeys(es, pair.sid, pair.slot), claim: null };
      d.lastSas = null;
      await store.put(`${d.sid}/d/${pair.dir}/key.bin`, signing.spki);
      return E.pairUrl(pair, tier, webOrigin);
    },
    async take(now = Date.now()) {
      const dir = `${d.sid}/e/${pending.pair.slot}`;
      const files = (await store.list(dir)).filter((f) => f.name !== 'ack.bin');
      if (files.length !== 1) return null;
      const claim = E.openClaim({ env: JSON.parse(Buffer.from(await store.get(`${dir}/${files[0].name}`)).toString()), pair: pending.pair, tier, keys: pending.keys });
      const nD = randomBytes(16);
      await store.put(`${dir}/ack.bin`, bytesOf(E.sealAck({ userId, pair: pending.pair, tier, claim, nD, keys: pending.keys, signingKey: signing.privateKey, seq: next(), issuedAt: now })));
      pending.claim = claim;
      d.lastSas = E.sasCode(pending.keys.sas, { ...pending.pair, tier, ...claim, nD });
      return d.lastSas;
    },
    async confirm(now = Date.now()) {
      const dev = { ...pending.claim, dir: pending.pair.dir, tier };
      d.devices.set(dev.deviceId, dev);
      await d.writeWrap(dev, now);
      await store.removeTree(`${d.sid}/e/${pending.pair.slot}`);
      pending = null;
      return dev;
    },
    async writeWrap(dev, now = Date.now(), wrapTier = dev.tier) {
      const w = S.makeSyncWrap({ ids: ids(dev.deviceId), epoch: d.epoch, tier: wrapTier, deviceEcdhSpki: dev.ecdhSpki, desktopSigningSpki: signing.spki,
        keys: keysOf(dev.deviceId), signingKey: signing.privateKey, seq: next(), issuedAt: now });
      await store.put(`${d.sid}/d/${dev.dir}/wrap.bin`, bytesOf(w));
    },
    async publish(dev, kinds, now = Date.now(), { validFor = 45 * 60_000 } = {}) {
      const base = `${d.sid}/d/${dev.dir}`;
      const dk = keysOf(dev.deviceId);
      const header = (purpose, seq) => ({ purpose, userId, desktopId: d.sid, from: d.sid, to: dev.deviceId, epoch: d.epoch, session: '', seq, issuedAt: now, tier: '' });
      const entries = {};
      for (const [kind, body] of Object.entries(kinds)) {
        const seq = next();
        const frame = Buffer.from(JSON.stringify({ v: 1, kind, generatedAt: now, truncated: false, ...body }));
        const bytes = bytesOf(S.seal({ header: header('snapshot', seq), key: dk.snapshot, plaintext: frame, signingKey: signing.privateKey }));
        const file = `s/${randomBytes(16).toString('hex')}.bin`;
        await store.put(`${base}/${file}`, bytes);
        entries[kind] = { file, seq, sha256: S.sha256(bytes).toString('hex') };
      }
      const manifestSeq = next();
      const m = { v: 1, manifestSeq, epoch: d.epoch, generatedAt: now, validUntil: now + validFor, kinds: entries };
      await store.put(`${base}/manifest.bin`, bytesOf(S.seal({ header: header('manifest', manifestSeq), key: dk.manifest, plaintext: Buffer.from(JSON.stringify(m)), signingKey: signing.privateKey })));
      return m;
    },
    async rotate(now = Date.now()) {
      d.prevRoot = { root: d.root, epoch: d.epoch };
      d.root = randomBytes(32); d.epoch += 1;
      for (const dev of d.devices.values()) await d.writeWrap(dev, now);
    },
    async drain(dev, answer = (req) => ({ ok: true, text: `echo: ${req.text}` }), now = Date.now()) {
      const base = `${d.sid}/d/${dev.dir}`;
      const verifyKey = createPublicKey({ key: Buffer.from(dev.signingSpki), format: 'der', type: 'spki' });
      const out = [];
      for (const f of await store.list(`${base}/in`)) {
        const env = JSON.parse(Buffer.from(await store.get(`${base}/in/${f.name}`)).toString());
        const old = env.epoch !== d.epoch && d.prevRoot && env.epoch === d.prevRoot.epoch;
        const root = old ? d.prevRoot.root : d.root; const epoch = old ? d.prevRoot.epoch : d.epoch;
        const req = JSON.parse(S.open({ env, key: keysOf(dev.deviceId, root, epoch).request, verifyKey,
          expect: { purpose: 'request', userId, desktopId: d.sid, from: dev.deviceId, to: d.sid, epoch } }).toString());
        const body = old ? { ok: false, code: 'stale_epoch' } : answer(req);
        const plain = { v: 1, requestId: req.requestId, ...(body.ok ? { ok: true, text: body.text, finishedAt: now } : body) };
        await store.put(`${base}/out/${req.requestId}.bin`, bytesOf(S.seal({ header: { purpose: 'reply', userId, desktopId: d.sid, from: d.sid, to: dev.deviceId,
          epoch, session: '', seq: next(), issuedAt: now, tier: '' }, key: keysOf(dev.deviceId, root, epoch).reply, plaintext: Buffer.from(JSON.stringify(plain)), signingKey: signing.privateKey })));
        await store.remove(`${base}/in/${f.name}`);
        out.push({ name: f.name, header: env, ...req });
      }
      return out;
    },
  });
}
