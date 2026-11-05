// Desktop-held sync keys (design 5.1): the per-epoch root and the ECDSA P-256 signing key, in the core vault whose
// master key the desktop keeps in the OS keychain. Created on first use; never logged, never returned to a client.
import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState } from '../../kb/sync-state.mjs';
import { newSigningKey, spkiFingerprint } from '../../core/sync-envelope.mjs';

export function ensureSyncKeys(userId) {
  const db = getDb();
  const state = getSyncState(userId);
  if (!state) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  let root = getSecret(db, userId, 'sync.rootKey');
  if (!root) { root = randomBytes(32).toString('base64url'); setSecret(db, userId, 'sync.rootKey', root); }
  let pkcs8 = getSecret(db, userId, 'sync.signingKey');
  if (!pkcs8) { pkcs8 = newSigningKey().pkcs8.toString('base64url'); setSecret(db, userId, 'sync.signingKey', pkcs8); }
  const signingKey = createPrivateKey({ key: Buffer.from(pkcs8, 'base64url'), format: 'der', type: 'pkcs8' });
  const signingSpki = createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
  return { root: Buffer.from(root, 'base64url'), epoch: state.epoch, signingKey, signingSpki, fingerprint: spkiFingerprint(signingSpki) };
}

export const syncIdsFor = (userId, state) => ({ userId, desktopId: state.syncId });
