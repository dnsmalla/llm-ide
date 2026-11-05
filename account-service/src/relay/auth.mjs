// Relay connection auth (plan ruling R-3): the existing bearer token, sender-constrained by a signature over a
// relay challenge with the key the account service registered for it. Every failure returns the same null.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60_000;
const SEEN_WRITE_MS = 60 * 60_000; // last_seen_at granularity: one write per hour at most
export const newChallenge = () => randomBytes(32).toString('base64url');
export const authMessage = (challenge, role, tokenHash) => Buffer.from(`llmide/relay/auth/v1\n${challenge}\n${role}\n${tokenHash}`);
const hex256 = (b) => createHash('sha256').update(b).digest('hex');

function proofOk(spki, message, proof) {
  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' });
    return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
  } catch {
    return false;
  }
}

const liveDesktop = (db, userId) => db.prepare("SELECT * FROM devices WHERE user_id = ? AND kind = 'desktop' AND status = 'linked'").get(userId);
const activeUser = (db, userId) => db.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").get(userId);

export function authenticate(ctx, { token, proof, challenge }) {
  const t = ctx.now();
  const deskHash = hex256(Buffer.from(token, 'utf8'));
  const access = ctx.db.prepare("SELECT * FROM desktop_tokens WHERE id_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?").get(deskHash, t);
  if (access) {
    const desktop = activeUser(ctx.db, access.user_id) && liveDesktop(ctx.db, access.user_id);
    if (!desktop || !proofOk(desktop.signing_key, authMessage(challenge, 'desktop', deskHash), proof)) return null;
    return { role: 'desktop', kind: 'desktop', userId: access.user_id, deviceId: desktop.id, desktopId: desktop.id, tokenHash: deskHash, expiresAt: access.expires_at };
  }
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 32) return null;
  const devHash = hex256(raw);
  const dev = ctx.db.prepare("SELECT * FROM devices WHERE token_hash = ? AND status = 'linked' AND kind IN ('web', 'ios')").get(devHash);
  if (!dev || !activeUser(ctx.db, dev.user_id)) return null;
  if (t - (dev.last_seen_at ?? dev.linked_at ?? 0) > DEVICE_IDLE_MS) return null;
  const desktop = liveDesktop(ctx.db, dev.user_id);
  if (!desktop || !proofOk(dev.signing_key, authMessage(challenge, 'device', devHash), proof)) return null;
  if (t - (dev.last_seen_at ?? 0) > SEEN_WRITE_MS) ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(t, dev.id);
  return { role: 'device', kind: dev.kind, userId: dev.user_id, deviceId: dev.id, desktopId: desktop.id, tokenHash: devHash, expiresAt: null };
}
