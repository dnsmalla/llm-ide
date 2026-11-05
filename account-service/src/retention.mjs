// Retention policy from the account design: IPs 72 h, unfinished accounts 24 h, revoked sessions 1 day,
// audit rows 400 days. Runs at boot and every ten minutes; one transaction.
export const IP_RETENTION_MS = 72 * 60 * 60_000;
export const PENDING_ACCOUNT_MS = 24 * 60 * 60_000;
export const REVOKED_SESSION_MS = 24 * 60 * 60_000;
export const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60_000;

export function purge(db, now) {
  const t = now();
  db.transaction(() => {
    db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').run(t, t - REVOKED_SESSION_MS);
    // Used refresh tokens stay until they expire, so a replay can still be recognised as reuse.
    db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM desktop_tokens WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').run(t, t - REVOKED_SESSION_MS);
    db.prepare("DELETE FROM users WHERE status = 'pending_passkey' AND created_at <= ?").run(t - PENDING_ACCOUNT_MS);
    db.prepare('UPDATE sessions SET ip = NULL WHERE ip IS NOT NULL AND created_at <= ?').run(t - IP_RETENTION_MS);
    db.prepare('UPDATE audit_events SET ip = NULL WHERE ip IS NOT NULL AND at <= ?').run(t - IP_RETENTION_MS);
    db.prepare('DELETE FROM audit_events WHERE at <= ?').run(t - AUDIT_RETENTION_MS);
    db.prepare("DELETE FROM relay_wraps WHERE device_id IN (SELECT id FROM devices WHERE status <> 'linked')").run();
  })();
}
