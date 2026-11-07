// Test-only: set a member's grant directly. registerUser already wrote the default row (plan H1.2
// Task 1), so ensureMember (insert-or-ignore) would be a no-op; this upserts.
export function grant(db, userId, { teamRole = 'member', maxMode = 'execute', usdCapMonth = 0 } = {}) {
  db.prepare(`
    INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      team_role = excluded.team_role, max_mode = excluded.max_mode, usd_cap_month = excluded.usd_cap_month
  `).run(String(userId), teamRole, maxMode, Number(usdCapMonth));
}
