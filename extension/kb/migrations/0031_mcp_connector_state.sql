-- Server-side dedup ledger for MCP-backed ingestion connectors (Miro today;
-- Google Drive/Calendar in phase 3). Twin of 0017_slack_state.sql.
--
-- There is NO high-water table here, unlike slack_state. Slack has a totally
-- ordered per-channel `ts` that makes a forward-only lower bound meaningful.
-- MCP tool results carry no such cursor — a board's items come back in
-- whatever order the server likes and can be edited in place — so the
-- seen-set IS the whole incrementality mechanism.
--
-- connector_id is part of the primary key so two connectors that happen to
-- mint the same item id (a real possibility once ids are provider-supplied)
-- cannot suppress each other's content.

CREATE TABLE IF NOT EXISTS mcp_connector_seen (
  user_id      TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, connector_id, item_id)
);
