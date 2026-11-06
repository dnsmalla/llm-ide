// Timers for every user with sync on: producer every 60 s +/- 15 s, consumer every 30 s; one cycle per user at a time;
// failures back off exponentially up to 15 min and are recorded as a code only. A refused login (SYNC_AUTH_FAILED,
// SYNC_MFA_REQUIRED) or a changed server host key (SYNC_HOST_KEY_CHANGED) turns sync off instead of retrying, so a changed
// password never locks the MEGA account and a swapped server is never written to. One store (a logged-in MEGA session, one
// SSH connection, or a Box session holding the latest refresh token) per user is cached while the core runs. LLMIDE_SYNC=off starts nothing.
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState, listEnabledSyncUsers, recordPublish, setSyncEnabled } from '../../kb/sync-state.mjs';
import { createMegaStore } from '../../connectors/sync-store/mega.mjs';
import { withTimeouts } from '../../connectors/sync-store/index.mjs';
import { createSftpStore } from '../../connectors/sync-store/sftp.mjs';
import { createBoxStore } from '../../connectors/sync-store/box.mjs';
import { publishOnce } from './producer.mjs';
import { rotateKeys } from './keys.mjs';
import { drainOnce, sweepStuckRequests } from './consumer.mjs';

const PRODUCE_MS = 60_000;
const DRAIN_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const SETUP_ERRORS = new Set(['SYNC_AUTH_FAILED', 'SYNC_MFA_REQUIRED', 'SYNC_HOST_KEY_CHANGED']);
const stores = new Map(); // userId -> SyncStore
const busy = new Set(); // users with a scheduler cycle or a manual publish in flight
const rotateDue = new Set(); // users whose rotation waits for the lock

const busyError = () => Object.assign(new Error('Sync is busy'), { code: 'SYNC_BUSY' });
export async function withUserLock(userId, fn) {
  if (busy.has(userId)) throw busyError();
  busy.add(userId);
  try { return await fn(); } finally { busy.delete(userId); }
}

export async function publishNow(userId, { now = Date.now(), store = storeFor(userId) } = {}) {
  if (!store) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  return withUserLock(userId, async () => ({ publish: await publishOnce({ userId, store, now }) }));
}

export function storeFor(userId) {
  const cached = stores.get(userId);
  if (cached) return cached;
  const state = getSyncState(userId);
  const raw = state && openStore(userId, state);
  if (!raw) return null;
  const store = withTimeouts(raw);
  stores.set(userId, store);
  return store;
}

function openStore(userId, state) {
  const db = getDb();
  if (state.storeKind === 'mega') {
    const email = getSecret(db, userId, 'sync.megaEmail');
    const password = getSecret(db, userId, 'sync.megaPassword');
    return email && password ? createMegaStore(state.storeConfig, { email, password }) : null;
  }
  if (state.storeKind === 'sftp') {
    const privateKey = getSecret(db, userId, 'sync.sshKey');
    return privateKey ? createSftpStore(state.storeConfig, { privateKey }) : null;
  }
  if (state.storeKind === 'box') {
    const clientSecret = getSecret(db, userId, 'sync.boxClientSecret');
    const refreshToken = getSecret(db, userId, 'sync.boxRefreshToken');
    // Box refresh tokens are single use: the rotated one is in the vault before its access token is used.
    // shortcut: a store recreated while the old one's refresh is in flight reads the older token and fails once
    // (SYNC_AUTH_FAILED turns sync off, Settings says reconnect); serialize store creation per user if it shows up.
    if (!clientSecret || !refreshToken) return null;
    return createBoxStore(state.storeConfig, { clientSecret, refreshToken }, { onRefreshToken: (t) => setSecret(getDb(), userId, 'sync.boxRefreshToken', t) });
  }
  return null;
}

export async function dropStore(userId) {
  const s = stores.get(userId);
  stores.delete(userId);
  await s?.close?.();
}

export async function closeSyncStores() {
  const all = [...stores.values()];
  stores.clear();
  await Promise.allSettled(all.map((s) => s.close?.()));
}

export const rotationPending = (userId) => rotateDue.has(userId);

/** Rotate now under the per-user lock, or mark it pending for the next cycle when a cycle holds the lock. */
export async function rotateNow(userId, { store = storeFor(userId), now = Date.now() } = {}) {
  try {
    return await withUserLock(userId, async () => {
      rotateDue.delete(userId);
      rotateKeys(userId, now);
      if (store) await publishOnce({ userId, store, now });
      return 'done';
    });
  } catch (e) {
    if (e?.code !== 'SYNC_BUSY') throw e;
    rotateDue.add(userId);
    return 'pending';
  }
}

export async function syncCycle(userId, { now = Date.now(), produce = true, store = storeFor(userId) } = {}) {
  if (!store) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  let doPublish = produce;
  if (rotateDue.delete(userId)) { rotateKeys(userId, now); doPublish = true; }
  const publish = doPublish ? await publishOnce({ userId, store, now }) : null;
  const drain = await drainOnce({ userId, store, now });
  return { publish, drain };
}

export function recordCycleFailure(userId, e, { now, backoff }) {
  const code = String(e?.code || 'SYNC_FAILED');
  recordPublish(userId, { at: now, error: code });
  if (SETUP_ERRORS.has(code)) {
    setSyncEnabled(userId, false);
    backoff.delete(userId);
    void dropStore(userId);
    return 0;
  }
  const ms = Math.min(MAX_BACKOFF_MS, (backoff.get(userId)?.ms ?? 30_000) * 2);
  backoff.set(userId, { until: now + ms, ms });
  return ms;
}

export function startSyncScheduler({ logger, env = process.env } = {}) {
  if (env.LLMIDE_SYNC === 'off') return { async stop() {} };
  const backoff = new Map(); // userId -> { until, ms }
  let lastProduce = 0;
  const tick = async () => {
    const now = Date.now();
    const produce = now - lastProduce >= PRODUCE_MS + Math.floor(Math.random() * 15_000);
    if (produce) lastProduce = now;
    for (const userId of listEnabledSyncUsers()) {
      if (busy.has(userId) || (backoff.get(userId)?.until ?? 0) > now) continue;
      busy.add(userId);
      try {
        await syncCycle(userId, { now, produce });
        backoff.delete(userId);
      } catch (e) {
        const ms = recordCycleFailure(userId, e, { now, backoff });
        logger?.warn?.('sync_cycle_failed', { code: String(e?.code || 'SYNC_FAILED'), backoffMs: ms });
      } finally { busy.delete(userId); }
    }
  };
  void sweepStuckRequests({ storeFor }).catch((e) => logger?.warn?.('sync_sweep_failed', { code: String(e?.code || 'SYNC_FAILED') }));
  const timer = setInterval(() => { void tick(); }, DRAIN_MS);
  timer.unref?.();
  return { async stop() { clearInterval(timer); await closeSyncStores(); } };
}
