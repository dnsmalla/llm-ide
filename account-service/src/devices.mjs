import { createPublicKey, verify } from 'node:crypto';
import { newId } from './db.mjs';
import { HttpError } from './http.mjs';
import { FRESH_MS } from './sessions.mjs';

// Sub-project 2 registers only the account's desktop (design 4.4 step 5). The relay connection and
// link requests are later sub-projects; no device token is minted here yet.
export const DESKTOP_TIER = 'desktop';
export const DESKTOP_CHANGE_HOLD_MS = 72 * 60 * 60_000;

export function publicDevice(row) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    status: row.status,
    tier: row.tier,
    createdAt: row.created_at,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
  };
}

// Proof of possession: the desktop signs its two public keys bound to SHA-256(access token), so a key
// cannot be registered by anyone who does not hold its private half, and a proof made for one sign-in
// cannot be replayed with another account's token. ECDSA P-256 / SHA-256, raw r||s (64 bytes), base64url.
// account_oauth.rs builds the same message; tests/fixtures/desktop-proof-vector.json pins both sides.
export const desktopProofMessage = (tokenHash, signingKey, ecdhKey) =>
  `llmide/desktop/register/v1\n${tokenHash}\n${signingKey}\n${ecdhKey}`;

export function verifyDesktopProof({ tokenHash, signingKey, ecdhKey, proof }) {
  let ok = false;
  if (typeof proof === 'string' && /^[A-Za-z0-9_-]{86}$/.test(proof)) {
    try {
      const key = createPublicKey({ key: Buffer.from(signingKey, 'base64url'), format: 'der', type: 'spki' });
      ok = verify('sha256', Buffer.from(desktopProofMessage(tokenHash, signingKey, ecdhKey)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new HttpError(400, 'invalid_proof');
}

// Design 4.3 step 4 / Q4: for 72 h after an email recovery the account's desktop cannot be swapped.
function changeHeld(db, userId, t) {
  const recoveredAt = db.prepare('SELECT recovered_at FROM users WHERE id = ?').pluck().get(userId);
  if (recoveredAt != null && t - recoveredAt < DESKTOP_CHANGE_HOLD_MS) throw new HttpError(403, 'desktop_change_held');
}

const liveDesktop = (db, userId) =>
  db.prepare("SELECT * FROM devices WHERE user_id = ? AND kind = 'desktop' AND status <> 'revoked'").get(userId);

function insertDesktop(db, t, { userId, label, signingKey, ecdhKey }) {
  const id = newId();
  db.prepare(
    `INSERT INTO devices (id, user_id, kind, label, status, signing_key, ecdh_key, tier, created_at, updated_at, linked_at)
     VALUES (?, ?, 'desktop', ?, 'linked', ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, label, signingKey, ecdhKey, DESKTOP_TIER, t, t, t);
  return id;
}

export function registerDesktop(db, now, desktop) {
  const t = now();
  const id = db.transaction(() => {
    if (liveDesktop(db, desktop.userId)) throw new HttpError(409, 'desktop_exists');
    // Re-registering after a web revoke is a replace in two steps, so it gets the same hold.
    const hadOne = db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND kind = 'desktop'").get(desktop.userId);
    if (hadOne) changeHeld(db, desktop.userId, t);
    return insertDesktop(db, t, desktop);
  })();
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

// Design 4.7: only from a sign-in whose passkey proof is under 5 minutes old (token.auth_at, carried
// from the web session through the OAuth code). Revokes the old desktop and every other desktop token
// family, and unlinks every other device. Relay data does not exist yet (sub-project 3).
export function replaceDesktop(db, now, { token, ...desktop }) {
  const t = now();
  if (token.auth_at == null || t - token.auth_at > FRESH_MS) throw new HttpError(401, 'reauth_required');
  const result = db.transaction(() => {
    changeHeld(db, desktop.userId, t);
    const old = liveDesktop(db, desktop.userId);
    if (old) {
      db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?").run(t, t, old.id);
    }
    const unlinked = db.prepare(
      "UPDATE devices SET status = 'unlinked', updated_at = ? WHERE user_id = ? AND kind <> 'desktop' AND status IN ('pending', 'linked')",
    ).run(t, desktop.userId).changes;
    db.prepare('UPDATE desktop_tokens SET revoked_at = ? WHERE user_id = ? AND family <> ? AND revoked_at IS NULL')
      .run(t, desktop.userId, token.family);
    return { id: insertDesktop(db, t, desktop), replacedId: old?.id ?? null, unlinked };
  })();
  return { ...result, device: db.prepare('SELECT * FROM devices WHERE id = ?').get(result.id) };
}

export function listDevices(db, userId) {
  return db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId).map(publicDevice);
}

export function revokeDevice(db, now, { userId, id }) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  if (row.status === 'revoked') return true;
  db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(now(), now(), id, userId);
  return true;
}
