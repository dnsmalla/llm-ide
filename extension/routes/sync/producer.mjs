// Snapshot producer (design 4.2 to 4.3, 7): per device, write key.bin and wrap.bin when its wrap epoch is behind, the
// changed kinds as fresh random blob names, then the manifest, then remove blobs the manifest does not name (this also
// cleans up after a crash mid-publish). Unchanged kinds are not rewritten; the manifest is refreshed on the heartbeat.
import { randomBytes } from 'node:crypto';
import { deviceKeys, seal, makeSyncWrap, sha256 } from '../../core/sync-envelope.mjs';
import { getSyncState, listSyncDevices, getPublished, setPublishedMany, nextSeq, recordPublish, setDeviceWrapEpoch } from '../../kb/sync-state.mjs';
import { ensureSyncKeys, syncIdsFor, rotateKeys } from './keys.mjs';
import { pruneMissingDevices } from './registry.mjs';
import { loadKinds as defaultLoadKinds, KINDS } from './kinds.mjs';

export const HEARTBEAT_MS = 15 * 60_000;
export const VALID_FOR_MS = 45 * 60_000;
const hex = (b) => Buffer.from(b).toString('hex');
const envBytes = (env) => Buffer.from(JSON.stringify(env));

/** key.bin + a signed syncwrap for one device at the current epoch (design 5.2 step 4; used by enrollment and publish). */
export async function writeDeviceWrap({ userId, store, state, keys, dev, now }) {
  const base = `${state.syncId}/d/${dev.dir}`;
  const ids = syncIdsFor(userId, state);
  await store.put(`${base}/key.bin`, keys.signingSpki);
  const dk = deviceKeys(keys.root, { ...ids, deviceId: dev.deviceId }, keys.epoch);
  const wrap = makeSyncWrap({ ids: { ...ids, deviceId: dev.deviceId }, epoch: keys.epoch, tier: dev.tier, deviceEcdhSpki: dev.ecdhSpki,
    desktopSigningSpki: keys.signingSpki, keys: dk, signingKey: keys.signingKey, seq: nextSeq(userId, now), issuedAt: now });
  await store.put(`${base}/wrap.bin`, envBytes(wrap));
  setDeviceWrapEpoch(userId, dev.deviceId, keys.epoch);
}

export async function publishOnce({ userId, store, now = Date.now(), loadKinds = defaultLoadKinds }) {
  const out = { devices: 0, blobs: 0, manifests: 0 };
  const state = getSyncState(userId);
  if (!state?.enabled) return out;
  if ((await pruneMissingDevices(userId, { store })).dropped.length) rotateKeys(userId, now);
  const devices = listSyncDevices(userId);
  if (!devices.length) return out;
  const keys = ensureSyncKeys(userId);
  const ids = syncIdsFor(userId, state);
  const frames = loadKinds(userId, now);
  const heartbeatDue = !state.lastPublishAt || now - state.lastPublishAt >= HEARTBEAT_MS;
  let wroteManifest = false;
  for (const dev of devices) {
    out.devices += 1;
    const base = `${state.syncId}/d/${dev.dir}`;
    const dk = deviceKeys(keys.root, { ...ids, deviceId: dev.deviceId }, keys.epoch);
    const header = (purpose, seq) => ({ purpose, userId, desktopId: state.syncId, from: state.syncId, to: dev.deviceId, epoch: keys.epoch, session: '', seq, issuedAt: now, tier: '' });
    if (dev.wrapEpoch !== keys.epoch) await writeDeviceWrap({ userId, store, state, keys, dev, now });
    const published = getPublished(userId, dev.deviceId);
    const changed = KINDS.filter((k) => published[k]?.plainSha256 !== hex(sha256(frames[k])) || published[k]?.epoch !== keys.epoch);
    if (!changed.length && !heartbeatDue) continue;
    const entries = Object.fromEntries(KINDS.filter((k) => published[k]).map((k) => [k, published[k]]));
    for (const kind of changed) {
      const seq = nextSeq(userId, now);
      const bytes = envBytes(seal({ header: header('snapshot', seq), key: dk.snapshot, plaintext: frames[kind], signingKey: keys.signingKey }));
      const file = `s/${randomBytes(16).toString('hex')}.bin`;
      await store.put(`${base}/${file}`, bytes);
      entries[kind] = { file, seq, fileSha256: hex(sha256(bytes)), plainSha256: hex(sha256(frames[kind])), epoch: keys.epoch };
      out.blobs += 1;
    }
    const manifestSeq = nextSeq(userId, now);
    const manifest = { v: 1, manifestSeq, epoch: keys.epoch, generatedAt: now, validUntil: now + VALID_FOR_MS,
      kinds: Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, { file: e.file, seq: e.seq, sha256: e.fileSha256 }])) };
    await store.put(`${base}/manifest.bin`, envBytes(seal({ header: header('manifest', manifestSeq), key: dk.manifest, plaintext: Buffer.from(JSON.stringify(manifest)), signingKey: keys.signingKey })));
    out.manifests += 1;
    wroteManifest = true;
    setPublishedMany(userId, dev.deviceId, Object.fromEntries(changed.map((kind) => [kind, entries[kind]])));
    const keep = new Set(Object.values(entries).map((e) => e.file.slice(2)));
    for (const f of await store.list(`${base}/s`)) if (!keep.has(f.name)) await store.remove(`${base}/s/${f.name}`);
  }
  if (wroteManifest) recordPublish(userId, { at: now });
  return out;
}
