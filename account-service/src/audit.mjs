// detail must never contain tokens, cookies, email addresses or request bodies.
export function createAudit(db, now) {
  const insert = db.prepare('INSERT INTO audit_events (at, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?)');
  return (event, { userId = null, ip = null, detail = {} } = {}) => {
    insert.run(now(), userId, event, ip, JSON.stringify(detail));
  };
}
