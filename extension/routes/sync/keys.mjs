// Desktop-held sync keys (design 5.1): the per-epoch root and the ECDSA P-256 signing key, in the core vault whose
// master key the desktop keeps in the OS keychain. Created on first use; never logged, never returned to a client.
import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState, setEpoch } from '../../kb/sync-state.mjs';
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

export const PREV_KEY_MS = 86_400_000;

/** Design 5.3 rotate: new K_root, epoch + 1. The previous root is kept 24 h only to answer old-epoch requests with
 *  stale_epoch. The caller holds the per-user lock and republishes (wraps are rewritten because wrapEpoch != epoch). */
export function rotateKeys(userId, now = Date.now()) {
  const db = getDb();
  const state = getSyncState(userId);
  if (!state) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  const old = getSecret(db, userId, 'sync.rootKey');
  db.transaction(() => {
    if (old) setSecret(db, userId, 'sync.prevRootKey', JSON.stringify({ epoch: state.epoch, key: old, until: now + PREV_KEY_MS }));
    setSecret(db, userId, 'sync.rootKey', randomBytes(32).toString('base64url'));
    setEpoch(userId, state.epoch + 1);
  })();
  return state.epoch + 1;
}

export function previousRoot(userId, now = Date.now()) {
  const raw = getSecret(getDb(), userId, 'sync.prevRootKey');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return Number.isSafeInteger(p.epoch) && p.until > now ? { epoch: p.epoch, root: Buffer.from(p.key, 'base64url') } : null;
  } catch { return null; }
}

/** The signing fingerprint if the key already exists; a status read must not mint keys. */
export function existingSigningFingerprint(userId) {
  const raw = getSecret(getDb(), userId, 'sync.signingKey');
  if (!raw) return null;
  const signing = createPrivateKey({ key: Buffer.from(raw, 'base64url'), format: 'der', type: 'pkcs8' });
  return spkiFingerprint(createPublicKey(signing).export({ type: 'spki', format: 'der' }));
}
