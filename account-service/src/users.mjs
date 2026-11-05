export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null;
}

// What a signed-in user may see about their own account: never counters or public keys.
export function publicAccount(db, user) {
  const passkeys = db
    .prepare('SELECT id, name, device_type, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .all(user.id);
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    language: user.language,
    timeZone: user.time_zone,
    status: user.status,
    createdAt: user.created_at,
    passkeys: passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      deviceType: p.device_type,
      backedUp: p.backed_up === 1,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
    })),
  };
}
