-- 0073: remember when the operator said they changed the storage password after revoking a sync device.
-- A revoked device keeps a working MEGA/Box session until the account password changes, so Settings shows a
-- reminder and records its dismissal here (C5).
ALTER TABLE sync_state ADD COLUMN password_changed_at INTEGER;
