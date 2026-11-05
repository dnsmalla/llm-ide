// /kb/sync/* for the desktop Settings card: JWT + bus host proof (desktop UI only), per user. Never returns the MEGA
// password, the full MEGA email, a private key, the root key or a folder capability; errors carry codes, never secrets.
import { send, readJson } from '../../server/route-http.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState, ensureSyncState, setSyncEnabled, listSyncDevices } from '../../kb/sync-state.mjs';
import { DEFAULT_MEGA_FOLDER, maskEmail, validateMegaConfig } from '../../connectors/sync-store/mega.mjs';
import { ensureSyncKeys } from './keys.mjs';
import { storeFor as defaultStoreFor, dropStore, syncCycle } from './scheduler.mjs';

const fail = (res, status, code, message, details) => { send(res, status, { error: { code, message, ...(details ? { details } : {}) } }); return true; };

export function isSyncRoute(url) {
  const p = String(url || '').split('?')[0];
  return p === '/kb/sync' || p.startsWith('/kb/sync/');
}

function status(userId) {
  const s = getSyncState(userId);
  if (!s) return { configured: false, enabled: false, storeKind: null, store: null, syncId: null, epoch: null, signingFingerprint: null, devices: [], lastPublishAt: null, lastError: null };
  return {
    configured: true, enabled: s.enabled, storeKind: s.storeKind,
    store: s.storeKind === 'mega' ? { folder: s.storeConfig.folder ?? DEFAULT_MEGA_FOLDER, account: maskEmail(getSecret(getDb(), userId, 'sync.megaEmail')) } : null,
    syncId: s.syncId, epoch: s.epoch, signingFingerprint: ensureSyncKeys(userId).fingerprint,
    devices: listSyncDevices(userId).map((d) => ({ deviceId: d.deviceId, name: d.name, tier: d.tier, addedAt: d.addedAt })),
    lastPublishAt: s.lastPublishAt, lastError: s.lastError,
  };
}

export async function handleSyncRoute(req, res, { deps = {}, env = process.env } = {}) {
  const storeFor = deps.storeFor ?? defaultStoreFor;
  const path = String(req.url || '').split('?')[0];
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
      setSecret(db, userId, 'sync.megaEmail', cfg.email);
      setSecret(db, userId, 'sync.megaPassword', cfg.password);
      ensureSyncState(userId, { storeKind: 'mega', storeConfig: { folder: cfg.folder } });
      await dropStore(userId);
      send(res, 200, status(userId)); return true;
    }
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
          const probe = `${state.syncId}/probe.bin`;
          await store.put(probe, Buffer.from('ok'));
          const back = await store.get(probe);
          await store.remove(probe);
          if (!back || Buffer.from(back).toString() !== 'ok') return fail(res, 502, 'SYNC_IO', 'The store did not return what was written');
          send(res, 200, { ok: true }); return true;
        }
        send(res, 200, await syncCycle(userId, { store })); return true;
      } catch (e) {
        const code = String(e?.code || '').startsWith('SYNC_') ? e.code : 'SYNC_IO';
        return fail(res, code === 'SYNC_NOT_SET_UP' ? 409 : 502, code, 'Sync store error');
      }
    }
    return fail(res, 404, 'NOT_FOUND', 'No such sync route');
  } catch (e) {
    return fail(res, e?.status === 413 ? 413 : 400, 'VALIDATION_FAILED', 'Bad request');
  }
}
