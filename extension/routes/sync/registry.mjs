// The desktop's local device registry is the only registry (design 5.2 step 4). Revoke = delete the device folder, then
// the row (the caller rotates). A registered device whose wrap was written at this location (wrapEpoch > 0) and whose
// folder has no key.bin was deleted on the storage with the desktop off (spec Q10): drop it, say so, never recreate it.
import { getSyncState, listSyncDevices, deleteSyncDevice } from '../../kb/sync-state.mjs';
import { recordActivity } from '../../kb/activity.mjs';

export const folderPresent = async (store, base) => (await store.list(base)).some((f) => f.name === 'key.bin');

export async function revokeDevice(userId, deviceId, { store }) {
  const state = getSyncState(userId);
  const dev = state && listSyncDevices(userId).find((d) => d.deviceId === deviceId);
  if (!dev) return false;
  if (store) await store.removeTree(`${state.syncId}/d/${dev.dir}`);
  return deleteSyncDevice(userId, deviceId);
}

export async function pruneMissingDevices(userId, { store }) {
  const state = getSyncState(userId);
  const dropped = [];
  if (!state) return { dropped };
  for (const dev of listSyncDevices(userId)) {
    if (dev.wrapEpoch === 0 || await folderPresent(store, `${state.syncId}/d/${dev.dir}`)) continue;
    if (deleteSyncDevice(userId, dev.deviceId)) {
      dropped.push(dev.name);
      recordActivity({ userId, kind: 'sync_device_removed', title: `Sync: removed "${dev.name}" because its folder was deleted`, detail: { deviceId: dev.deviceId } });
    }
  }
  return { dropped };
}
