// /kb/sync/* for the desktop Settings card: JWT + bus host proof (desktop UI only), per user. Never returns the MEGA
// password, the full MEGA email, the SSH private key, the root key or a folder capability; errors carry codes, never secrets.
import { send, readJson, oauthCallbackHtml } from '../../server/route-http.mjs';
import { config } from '../../core/config.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState, ensureSyncState, setSyncEnabled, listSyncDevices, resetSyncPublish, deleteSyncDevice, forgetSyncDevices } from '../../kb/sync-state.mjs';
import { DEFAULT_SFTP_ROOT, DEFAULT_SFTP_USER, DEFAULT_WEB_HOST, generateSyncSshKey, parseHostFingerprint, validateSftpConfig } from '../../connectors/sync-store/sftp.mjs';
import { DEFAULT_MEGA_FOLDER, maskEmail, validateMegaConfig } from '../../connectors/sync-store/mega.mjs';
import { DEFAULT_BOX_FOLDER, validateBoxConfig } from '../../connectors/sync-store/box.mjs';
import { existingSigningFingerprint, rotateKeys } from './keys.mjs';
import { storeFor as defaultStoreFor, dropStore, publishNow, rotateNow, rotationPending, withUserLock } from './scheduler.mjs';
import { randomBytes } from 'node:crypto';
import { startEnrollment, pollEnrollment, confirmEnrollment, cancelEnrollment } from './enroll.mjs';
import { revokeDevice } from './registry.mjs';
import { startBoxConnect, pollBoxConnect, finishBoxConnect } from './box-connect.mjs';

const sftpView = (c) => ({ host: c.host, port: c.port, username: c.username, hostFingerprint: c.hostFingerprint, webHost: c.webHost, publicKey: c.publicKey });
/** Another storage kind is a place linked devices cannot follow (their pairing named the old one): drop a pending
 *  enrollment, unlink every device (they pair again), forget the old storage's login, and reset the publish records
 *  (the SP1 store-change reset). The old storage's files stay; Settings tells the user to delete them. Caller holds the
 *  user lock. */
async function leaveStoreKind(userId) {
  const db = getDb();
  void cancelEnrollment(userId).catch(() => {});
  await dropStore(userId);
  for (const d of listSyncDevices(userId)) deleteSyncDevice(userId, d.deviceId);
  for (const k of ['sync.megaEmail', 'sync.megaPassword', 'sync.sshKey']) setSecret(db, userId, k, '');
  resetSyncPublish(userId);
}
const DEVICE_RE = /^\/kb\/sync\/devices\/([A-Za-z0-9_-]{22})$/;
const fail = (res, status, code, message, details) => { send(res, status, { error: { code, message, ...(details ? { details } : {}) } }); return true; };

export function isSyncRoute(url) {
  const p = String(url || '').split('?')[0];
  return p === '/kb/sync' || p.startsWith('/kb/sync/');
}

function status(userId) {
  const s = getSyncState(userId);
  if (!s) return { configured: false, enabled: false, storeKind: null, store: null, syncId: null, epoch: null, signingFingerprint: null, devices: [], rotationPending: false, lastPublishAt: null, lastError: null };
  return {
    configured: true, enabled: s.enabled, storeKind: s.storeKind,
    store: s.storeKind === 'mega' ? { folder: s.storeConfig.folder ?? DEFAULT_MEGA_FOLDER, account: maskEmail(getSecret(getDb(), userId, 'sync.megaEmail')) } : s.storeKind === 'sftp' ? sftpView(s.storeConfig) : s.storeKind === 'box' ? { folder: s.storeConfig.folder ?? DEFAULT_BOX_FOLDER, account: s.storeConfig.account ?? '' } : null,
    syncId: s.syncId, epoch: s.epoch, signingFingerprint: existingSigningFingerprint(userId),
    devices: listSyncDevices(userId).map((d) => ({ deviceId: d.deviceId, name: d.name, tier: d.tier, addedAt: d.addedAt, folderHint: d.dir.slice(0, 6) })),
    rotationPending: rotationPending(userId), lastPublishAt: s.lastPublishAt, lastError: s.lastError,
  };
}

async function commitBox(userId, c, { storeFor }) {
  const db = getDb();
  const before = getSyncState(userId);
  if (before && before.storeKind !== 'box') {
    const old = storeFor(userId);
    if (old) await withUserLock(userId, () => old.removeTree(before.syncId)).catch(() => {});
  }
  await cancelEnrollment(userId).catch(() => {});
  await dropStore(userId);
  setSecret(db, userId, 'sync.boxClientSecret', c.clientSecret);
  setSecret(db, userId, 'sync.boxRefreshToken', c.refreshToken);
  ensureSyncState(userId, { storeKind: 'box', storeConfig: { clientId: c.clientId, folder: c.folder, account: c.account } });
  if (before && before.storeKind !== 'box') { resetSyncPublish(userId); if (forgetSyncDevices(userId) > 0) rotateKeys(userId); }
}

export async function handleSyncRoute(req, res, { deps = {}, env = process.env } = {}) {
  const storeFor = deps.storeFor ?? defaultStoreFor;
  const path = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && path === '/kb/sync/box/callback') {
    const text = await finishBoxConnect(new URL(req.url, 'http://127.0.0.1').searchParams, { port: config.port, fetchImpl: deps.fetchImpl, commit: (uid, c) => commitBox(uid, c, { storeFor }) });
    oauthCallbackHtml(res, text); return true;
  }
  if (!verifyBusHostProof(req, env)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const userId = req.user?.id;
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');
  try {
    if (req.method === 'GET' && path === '/kb/sync/status') { send(res, 200, status(userId)); return true; }
    if (req.method === 'POST' && path === '/kb/sync/mega') {
      const b = await readJson(req, 4096);
      const cfg = { email: String(b.email ?? '').trim(), password: typeof b.password === 'string' ? b.password : '', folder: String(b.folder ?? DEFAULT_MEGA_FOLDER).trim() || DEFAULT_MEGA_FOLDER };
      const field = validateMegaConfig(cfg);
      if (field) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${field}`, { field });
      const db = getDb();
      const before = getSyncState(userId);
      const oldEmail = getSecret(db, userId, 'sync.megaEmail');
      const changed = !!before && (before.storeKind !== 'mega' || before.storeConfig.folder !== cfg.folder || oldEmail !== cfg.email);
      await withUserLock(userId, async () => {
        if (before && before.storeKind !== 'mega') await leaveStoreKind(userId);
        setSecret(db, userId, 'sync.megaEmail', cfg.email);
        setSecret(db, userId, 'sync.megaPassword', cfg.password);
        ensureSyncState(userId, { storeKind: 'mega', storeConfig: { folder: cfg.folder } });
        if (changed) resetSyncPublish(userId);
        await dropStore(userId);
      });
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && path === '/kb/sync/sftp') {
      const b = await readJson(req, 4096);
      const cfg = { host: String(b.host ?? '').trim(), port: b.port ?? 22, username: String(b.username ?? '').trim() || DEFAULT_SFTP_USER, hostFingerprint: parseHostFingerprint(b.hostFingerprint) ?? '', webHost: String(b.webHost ?? '').trim().toLowerCase() || DEFAULT_WEB_HOST, root: DEFAULT_SFTP_ROOT };
      const field = validateSftpConfig(cfg);
      if (field) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${field}`, { field });
      const db = getDb();
      await withUserLock(userId, async () => {
        const before = getSyncState(userId);
        if (before && before.storeKind !== 'sftp') await leaveStoreKind(userId);
        const keep = before?.storeKind === 'sftp' && before.storeConfig.publicKey && getSecret(db, userId, 'sync.sshKey') ? before.storeConfig.publicKey : null;
        const moved = before?.storeKind === 'sftp' && ['host','port','username','root'].some((k) => before.storeConfig[k] !== cfg[k]);
        const state = ensureSyncState(userId, { storeKind: 'sftp', storeConfig: { ...cfg, publicKey: keep } });
        if (!keep) {
          const key = await generateSyncSshKey(`llmide-sync-${state.syncId}`);
          setSecret(db, userId, 'sync.sshKey', key.privateKey);
          ensureSyncState(userId, { storeKind: 'sftp', storeConfig: { ...cfg, publicKey: key.publicKey } });
        }
        if (moved) resetSyncPublish(userId);
        await dropStore(userId);
      });
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && path === '/kb/sync/box/start') {
      const b = await readJson(req, 4096);
      const cfg = { clientId: String(b.clientId ?? '').trim(), clientSecret: typeof b.clientSecret === 'string' ? b.clientSecret.trim() : '', folder: String(b.folder ?? DEFAULT_BOX_FOLDER).trim() || DEFAULT_BOX_FOLDER };
      const field = validateBoxConfig(cfg);
      if (field) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${field}`, { field });
      send(res, 200, startBoxConnect(userId, cfg, { port: config.port })); return true;
    }
    if (req.method === 'POST' && path === '/kb/sync/box/poll') { send(res, 200, pollBoxConnect(userId)); return true; }
    if (req.method === 'POST' && path === '/kb/sync/enabled') {
      const b = await readJson(req, 1024);
      if (typeof b.enabled !== 'boolean') return fail(res, 400, 'VALIDATION_FAILED', 'enabled must be a boolean', { field: 'enabled' });
      if (!getSyncState(userId)) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      setSyncEnabled(userId, b.enabled);
      if (!b.enabled) await dropStore(userId);
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && (path === '/kb/sync/test' || path === '/kb/sync/publish')) {
      const state = getSyncState(userId);
      const store = state && storeFor(userId);
      if (!store) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      try {
        if (path === '/kb/sync/test') {
          const probe = `${state.syncId}/probe-${randomBytes(8).toString('hex')}.bin`;
          await store.put(probe, Buffer.from('ok'));
          const back = await store.get(probe);
          await store.remove(probe);
          if (!back || Buffer.from(back).toString() !== 'ok') return fail(res, 502, 'SYNC_IO', 'The store did not return what was written');
          send(res, 200, { ok: true }); return true;
        }
        send(res, 200, await publishNow(userId, { store })); return true;
      } catch (e) {
        const code = String(e?.code || '').startsWith('SYNC_') ? e.code : 'SYNC_IO';
        return fail(res, code === 'SYNC_NOT_SET_UP' || code === 'SYNC_BUSY' ? 409 : 502, code, 'Sync store error');
      }
    }
    if (path.startsWith('/kb/sync/devices') || path === '/kb/sync/rotate') {
      const body = req.method === 'POST' ? await readJson(req, 1024) : {};
      if (req.method === 'POST' && path === '/kb/sync/devices/enroll' && body.tier !== 'web' && body.tier !== 'ios') {
        return fail(res, 400, 'VALIDATION_FAILED', 'tier must be web or ios', { field: 'tier' });
      }
      const store = getSyncState(userId) ? storeFor(userId) : null;
      if (!store) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      const m = DEVICE_RE.exec(path);
      try {
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll') { send(res, 200, await startEnrollment(userId, { store, tier: body.tier, env })); return true; }
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll/poll') { send(res, 200, await pollEnrollment(userId)); return true; }
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll/confirm') {
          await confirmEnrollment(userId);
          await publishNow(userId, { store }).catch(() => {});
          send(res, 200, status(userId)); return true;
        }
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll/cancel') { await cancelEnrollment(userId); send(res, 200, { ok: true }); return true; }
        if (req.method === 'DELETE' && m) {
          // Under the per-user lock (review I1): a publish in flight would write the deleted folder back.
          if (!(await withUserLock(userId, () => revokeDevice(userId, m[1], { store })))) return fail(res, 404, 'NOT_FOUND', 'No such device');
          await rotateNow(userId, { store });
          send(res, 200, status(userId)); return true;
        }
        if (req.method === 'POST' && path === '/kb/sync/rotate') { await rotateNow(userId, { store }); send(res, 200, status(userId)); return true; }
      } catch (e) {
        const code = String(e?.code || '');
        if (code === 'SYNC_OFF' || code.startsWith('ENROLL_')) return fail(res, 409, code, 'Enrollment is not possible now');
        if (code === 'SYNC_BUSY') return fail(res, 409, code, 'Sync is busy, try again');
        return fail(res, 502, code.startsWith('SYNC_') ? code : 'SYNC_IO', 'Sync store error');
      }
    }
    return fail(res, 404, 'NOT_FOUND', 'No such sync route');
  } catch (e) {
    if (e?.code === 'SYNC_BUSY') return fail(res, 409, 'SYNC_BUSY', 'Sync is busy, try again');
    return fail(res, e?.status === 413 ? 413 : 400, 'VALIDATION_FAILED', 'Bad request');
  }
}
