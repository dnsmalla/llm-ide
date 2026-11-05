// Timers for every user with sync on: producer every 60 s +/- 15 s, consumer every 30 s; one cycle per user at a time;
// failures back off exponentially up to 15 min and are recorded as a code only. A refused login (SYNC_AUTH_FAILED,
// SYNC_MFA_REQUIRED) turns sync off instead of retrying, so a changed password never locks the MEGA account. One MEGA
// store (one logged-in session) per user is cached while the core runs. LLMIDE_SYNC=off starts nothing.
import { getDb } from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';
import { getSyncState, listEnabledSyncUsers, recordPublish, setSyncEnabled } from '../../kb/sync-state.mjs';
import { createMegaStore } from '../../connectors/sync-store/mega.mjs';
import { publishOnce } from './producer.mjs';
import { drainOnce, sweepStuckRequests } from './consumer.mjs';

const PRODUCE_MS = 60_000;
const DRAIN_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const SETUP_ERRORS = new Set(['SYNC_AUTH_FAILED', 'SYNC_MFA_REQUIRED']);
const stores = new Map(); // userId -> SyncStore
const busy = new Set(); // users with a scheduler cycle or a manual publish in flight

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
  if (state?.storeKind !== 'mega') return null;
  const db = getDb();
  const email = getSecret(db, userId, 'sync.megaEmail');
  const password = getSecret(db, userId, 'sync.megaPassword');
  if (!email || !password) return null;
  const store = createMegaStore(state.storeConfig, { email, password });
  stores.set(userId, store);
  return store;
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

export async function syncCycle(userId, { now = Date.now(), produce = true, store = storeFor(userId) } = {}) {
  if (!store) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  const publish = produce ? await publishOnce({ userId, store, now }) : null;
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
