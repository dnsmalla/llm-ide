-- Account deletes whose agent.db history purge did not run (agent.db was down
-- at the time). Written inside the user-delete transaction, so it commits with
-- the delete. openAgentStoreAtBoot replays it and removes the row on success.
--
-- The column is deleted_user_id, not user_id, on purpose: the user-delete
-- cascade enumerates user_id tables and must not treat this row as the
-- deleted user's data (the row exists precisely to outlive that user).
CREATE TABLE IF NOT EXISTS pending_agent_purges (
  deleted_user_id TEXT PRIMARY KEY,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
