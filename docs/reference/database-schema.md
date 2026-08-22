---
title: Database schema
source: extension/kb/migrations/*.sql
---

<!-- generated from extension/kb/migrations/*.sql - do not edit by hand -->

# Database schema

SQLite, WAL + FTS5. Source: `extension/kb/migrations/*.sql`.

## `activity`

_From `0018_activity.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `kind` | TEXT NOT NULL |
| `title` | TEXT NOT NULL |
| `detail` | TEXT |
| `link` | TEXT |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `activity_seen`

_From `0018_activity.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE |
| `last_seen_id` | INTEGER NOT NULL DEFAULT 0 |

## `agent_ask_messages`

_From `0007_agent_ask_history.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `seq` | INTEGER NOT NULL |
| `role` | TEXT NOT NULL CHECK (role IN ('user', 'assistant')) |
| `content` | TEXT NOT NULL |
| `created_at` | REAL NOT NULL |

## `agent_feedback`

_From `0004_agent_feedback.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `session_id` | TEXT NOT NULL |
| `caption_seq` | INTEGER NOT NULL |
| `verdict` | TEXT NOT NULL CHECK (verdict IN ('useful','noise','later')) |
| `plan_task_id` | TEXT |
| `score` | REAL |
| `recorded_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `agent_sessions`

_From `0029_agent_sessions.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `user_id` | TEXT NOT NULL |
| `chat_scope` | TEXT NOT NULL DEFAULT 'explorer' |
| `mac_chat_session_id` | TEXT NOT NULL |
| `sdk_session_id` | TEXT |
| `model` | TEXT |
| `created_at` | TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) |
| `last_used_at` | TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) |
| `last_mode` | TEXT |
| `status` | TEXT NOT NULL DEFAULT 'active' |

## `audit_log`

_From `0002_multitenancy.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `user_id` | TEXT REFERENCES users(id) ON DELETE SET NULL |
| `request_id` | TEXT |
| `ip` | TEXT |
| `user_agent` | TEXT |
| `action` | TEXT NOT NULL |
| `resource` | TEXT |
| `outcome` | TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure','denied')) |
| `detail` | TEXT |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `chat_messages`

_From `0023_unified_chat_sessions.sql`._

| Column | Type / constraints |
|---|---|
| `session_id` | TEXT NOT NULL |
| `user_id` | TEXT NOT NULL |
| `seq` | INTEGER NOT NULL |
| `role` | TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')) |
| `content` | TEXT NOT NULL |
| `meta_json` | TEXT |
| `created_at` | REAL NOT NULL |

## `chat_sessions`

_From `0023_unified_chat_sessions.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT NOT NULL |
| `user_id` | TEXT NOT NULL |
| `title` | TEXT NOT NULL DEFAULT 'New chat' |
| `surface` | TEXT NOT NULL DEFAULT 'any' CHECK (surface IN ('mac', 'extension', 'any')) |
| `mode` | TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'agent', 'transcript')) |
| `project_id` | TEXT |
| `created_at` | REAL NOT NULL |
| `updated_at` | REAL NOT NULL |

## `code_graph_edges`

_From `0025_scip_code_graph.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `repo_id` | TEXT NOT NULL |
| `from_id` | TEXT NOT NULL |
| `to_id` | TEXT NOT NULL |
| `kind` | TEXT NOT NULL |
| `confidence` | TEXT NOT NULL DEFAULT 'EXTRACTED' |
| `source` | TEXT NOT NULL DEFAULT 'scip' |

## `code_graph_nodes`

_From `0025_scip_code_graph.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `repo_id` | TEXT NOT NULL |
| `symbol_id` | TEXT NOT NULL |
| `title` | TEXT NOT NULL |
| `kind` | TEXT NOT NULL |
| `source_file` | TEXT NOT NULL |
| `line` | INTEGER NOT NULL |
| `language` | TEXT |
| `doc` | TEXT |
| `source` | TEXT NOT NULL DEFAULT 'scip' |

## `email_seen`

_From `0013_email_state.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `message_id` | TEXT NOT NULL |
| `seen_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `email_state`

_From `0013_email_state.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT PRIMARY KEY |
| `last_fetched_at` | TEXT |

## `entities`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `meeting_id` | TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE |
| `kind` | TEXT NOT NULL CHECK (kind IN ('action','decision','blocker')) |
| `text` | TEXT NOT NULL |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `quote` | TEXT |
| `embedding` | BLOB |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

## `issue_schedule`

_From `0020_issue_schedule.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `provider` | TEXT NOT NULL |
| `repo` | TEXT NOT NULL |
| `issue_number` | INTEGER NOT NULL |
| `start_date` | TEXT |
| `due_date` | TEXT |
| `estimate_days` | REAL |
| `depends_on` | TEXT NOT NULL DEFAULT '[]' |
| `updated_at` | TEXT NOT NULL DEFAULT (datetime('now','localtime')) |

## `mcp_connector_seen`

_From `0031_mcp_connector_state.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `connector_id` | TEXT NOT NULL |
| `item_id` | TEXT NOT NULL |
| `seen_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `meetings`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `title` | TEXT NOT NULL |
| `date` | TEXT NOT NULL |
| `duration_sec` | INTEGER NOT NULL DEFAULT 0 |
| `language` | TEXT |
| `participants` | TEXT |
| `transcript` | TEXT |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |
| `meta` | TEXT NOT NULL DEFAULT '{}' |

## `model_limits`

_From `0019_usage_limits.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `provider` | TEXT NOT NULL |
| `model` | TEXT NOT NULL |
| `priority` | INTEGER NOT NULL DEFAULT 0 |
| `enabled` | INTEGER NOT NULL DEFAULT 1 |
| `limit_value` | INTEGER NOT NULL DEFAULT 0 |
| `unit` | TEXT NOT NULL DEFAULT 'runs' |
| `window_kind` | TEXT NOT NULL DEFAULT 'daily' |
| `threshold_pct` | INTEGER NOT NULL DEFAULT 90 |
| `updated_at` | TEXT NOT NULL DEFAULT (datetime('now','localtime')) |

## `outcomes`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `task_id` | TEXT NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE |
| `provider` | TEXT NOT NULL |
| `ref` | TEXT NOT NULL |
| `state` | TEXT NOT NULL |
| `is_terminal` | INTEGER NOT NULL DEFAULT 0 |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `observed_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

## `password_reset_tokens`

_From `0008_password_reset.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `token_hash` | TEXT NOT NULL UNIQUE |
| `expires_at` | TEXT NOT NULL |
| `used_at` | TEXT DEFAULT NULL |

## `plan_tasks`

_From `0011_plan_tasks_indexes.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `plan_id` | TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE |
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `position` | INTEGER NOT NULL DEFAULT 0 |
| `milestone` | TEXT |
| `title` | TEXT NOT NULL |
| `description` | TEXT |
| `owner` | TEXT |
| `due` | TEXT |
| `estimate_days` | REAL |
| `depends_on` | TEXT NOT NULL DEFAULT '[]' |
| `status` | TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','blocked','cancelled')) |
| `risk` | TEXT CHECK (risk IN ('low','med','high') OR risk IS NULL) |
| `risk_reason` | TEXT |
| `files` | TEXT NOT NULL DEFAULT '[]' |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `symbols` | TEXT NOT NULL DEFAULT '[]' |

## `plans`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `meeting_id` | TEXT |
| `title` | TEXT NOT NULL |
| `goal` | TEXT |
| `language` | TEXT |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `updated_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

## `quota_state`

_From `0019_usage_limits.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `provider` | TEXT NOT NULL |
| `model` | TEXT NOT NULL |
| `window_start` | TEXT NOT NULL |
| `exhausted` | INTEGER NOT NULL DEFAULT 1 |
| `hit_at` | TEXT NOT NULL DEFAULT (datetime('now','localtime')) |

## `rate_limit_buckets`

_From `0009_rate_limit_state.sql`._

| Column | Type / constraints |
|---|---|
| `key` | TEXT PRIMARY KEY |
| `tokens` | REAL NOT NULL |
| `capacity` | REAL NOT NULL |
| `refill_rate` | REAL NOT NULL |
| `last_refill` | INTEGER NOT NULL |
| `saved_at` | INTEGER NOT NULL |

## `refresh_tokens`

_From `0002_multitenancy.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `token_hash` | TEXT NOT NULL UNIQUE |
| `expires_at` | TEXT NOT NULL |
| `revoked_at` | TEXT |
| `user_agent` | TEXT |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `review_items`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `kind` | TEXT NOT NULL CHECK (kind IN ('dispatch','codegen-apply')) |
| `plan_id` | TEXT |
| `task_id` | TEXT |
| `title` | TEXT NOT NULL |
| `payload` | TEXT NOT NULL |
| `guardrails` | TEXT NOT NULL DEFAULT '{}' |
| `status` | TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed','expired')) |
| `reviewer_note` | TEXT |
| `result` | TEXT |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `decided_at` | TEXT |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

## `revoked_jti`

_From `0003_user_repos.sql`._

| Column | Type / constraints |
|---|---|
| `jti` | TEXT PRIMARY KEY |
| `user_id` | TEXT REFERENCES users(id) ON DELETE CASCADE |
| `expires_at` | TEXT NOT NULL |

## `session_memory`

_From `0028_session_memory.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `user_id` | TEXT NOT NULL |
| `session_id` | TEXT NOT NULL |
| `fact` | TEXT NOT NULL |
| `created_at` | REAL NOT NULL |

## `slack_seen`

_From `0017_slack_state.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `message_ts` | TEXT NOT NULL |
| `seen_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `slack_state`

_From `0017_slack_state.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `channel_id` | TEXT NOT NULL |
| `last_ts` | TEXT |

## `sources`

_From `0022_sources_user_unique.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `kind` | TEXT NOT NULL CHECK (kind IN ('code','ticket','qa','doc')) |
| `ref` | TEXT NOT NULL |
| `chunk_idx` | INTEGER NOT NULL DEFAULT 0 |
| `title` | TEXT NOT NULL |
| `body` | TEXT NOT NULL |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `embedding` | BLOB |
| `indexed_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

## `tool_approvals`

_From `0030_tool_approvals.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL |
| `tool_name` | TEXT NOT NULL |
| `created_at` | TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) |

## `usage_ledger`

_From `0019_usage_limits.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `ts` | TEXT NOT NULL DEFAULT (datetime('now','localtime')) |
| `provider` | TEXT NOT NULL |
| `model` | TEXT NOT NULL |
| `source` | TEXT NOT NULL DEFAULT 'api' |
| `endpoint` | TEXT |
| `input_tokens` | INTEGER |
| `output_tokens` | INTEGER |
| `runs` | INTEGER NOT NULL DEFAULT 1 |
| `request_id` | TEXT |

## `user_flags`

_From `0003_user_repos.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `flag` | TEXT NOT NULL |
| `value` | TEXT NOT NULL DEFAULT '1' |
| `set_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `user_repos`

_From `0003_user_repos.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `path` | TEXT NOT NULL |
| `label` | TEXT |
| `added_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `user_secrets`

_From `0002_multitenancy.sql`._

| Column | Type / constraints |
|---|---|
| `user_id` | TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE |
| `secret_key` | TEXT NOT NULL |
| `ciphertext` | BLOB NOT NULL |
| `updated_at` | TEXT NOT NULL DEFAULT (datetime('now')) |

## `users`

_From `0002_multitenancy.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `email` | TEXT NOT NULL UNIQUE COLLATE NOCASE |
| `display_name` | TEXT NOT NULL |
| `password_hash` | TEXT NOT NULL |
| `role` | TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')) |
| `status` | TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')) |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `last_login_at` | TEXT |
| `tokens_valid_after` | INTEGER NOT NULL DEFAULT 0 |

## Full-text search

FTS5 virtual tables power keyword search. They are maintained by triggers (see below) and are not directly writable by application code.

### `search` (USING fts5)

_From `0001_initial.sql`._

```sql
CREATE VIRTUAL TABLE search USING fts5(meeting_id UNINDEXED, entity_id UNINDEXED, kind UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
```

## Indexes

| Index | Table | Columns | WHERE clause | Source |
|---|---|---|---|---|
| `idx_activity_user_time` | `activity` | `user_id, created_at DESC, id DESC` |  | `0018_activity.sql` |
| `agent_ask_messages_user_seq` | `agent_ask_messages` | `user_id, seq DESC` |  | `0007_agent_ask_history.sql` |
| `idx_agent_feedback_task` | `agent_feedback` | `user_id, plan_task_id` |  | `0004_agent_feedback.sql` |
| `idx_agent_feedback_user_time` | `agent_feedback` | `user_id, recorded_at` |  | `0004_agent_feedback.sql` |
| `idx_agent_sessions_user_chat` | `agent_sessions` | `user_id, mac_chat_session_id` |  | `0029_agent_sessions.sql` |
| `idx_audit_action` | `audit_log` | `action, created_at DESC` |  | `0002_multitenancy.sql` |
| `idx_audit_user_time` | `audit_log` | `user_id, created_at DESC` |  | `0002_multitenancy.sql` |
| `chat_messages_session_seq` | `chat_messages` | `session_id, seq ASC` |  | `0023_unified_chat_sessions.sql` |
| `chat_sessions_user_updated` | `chat_sessions` | `user_id, updated_at DESC` |  | `0023_unified_chat_sessions.sql` |
| `idx_cge_user_from` | `code_graph_edges` | `user_id, from_id` |  | `0025_scip_code_graph.sql` |
| `idx_cge_user_repo_source` | `code_graph_edges` | `user_id, repo_id, source` |  | `0027_code_graph_source.sql` |
| `idx_cge_user_to` | `code_graph_edges` | `user_id, to_id` |  | `0025_scip_code_graph.sql` |
| `idx_cgn_user_repo_source` | `code_graph_nodes` | `user_id, repo_id, source` |  | `0027_code_graph_source.sql` |
| `idx_cgn_user_sym` | `code_graph_nodes` | `user_id, symbol_id` |  | `0025_scip_code_graph.sql` |
| `idx_cgn_user_title` | `code_graph_nodes` | `user_id, title` |  | `0025_scip_code_graph.sql` |
| `idx_entities_kind` | `entities` | `kind` |  | `0001_initial.sql` |
| `idx_entities_meeting` | `entities` | `meeting_id` |  | `0001_initial.sql` |
| `idx_entities_user` | `entities` | `user_id` |  | `0002_multitenancy.sql` |
| `idx_issue_schedule_user_repo` | `issue_schedule` | `user_id, provider, repo` |  | `0020_issue_schedule.sql` |
| `idx_meetings_project` | `meetings` | `user_id` | WHERE json_extract(meta, '$.projectId') IS NOT NULL | `0011_plan_tasks_indexes.sql` |
| `idx_meetings_project_value` | `meetings` | `user_id, json_extract(meta, '$.projectId')` | WHERE json_extract(meta, '$.projectId') IS NOT NULL | `0012_project_value_indexes.sql` |
| `idx_meetings_user` | `meetings` | `user_id, date DESC` |  | `0002_multitenancy.sql` |
| `idx_outcomes_state` | `outcomes` | `state` |  | `0001_initial.sql` |
| `idx_outcomes_task` | `outcomes` | `task_id, observed_at DESC` |  | `0001_initial.sql` |
| `idx_outcomes_user` | `outcomes` | `user_id, observed_at DESC` |  | `0002_multitenancy.sql` |
| `idx_prt_expiry` | `password_reset_tokens` | `expires_at` |  | `0008_password_reset.sql` |
| `idx_prt_token` | `password_reset_tokens` | `token_hash` |  | `0008_password_reset.sql` |
| `idx_prt_user` | `password_reset_tokens` | `user_id` |  | `0008_password_reset.sql` |
| `idx_plan_tasks_dispatch_retry` | `plan_tasks` | `user_id` | WHERE json_extract(meta, '$.dispatchRetry.nextRetryAt') IS NOT NULL | `0011_plan_tasks_indexes.sql` |
| `idx_plan_tasks_dispatched` | `plan_tasks` | `user_id` | WHERE json_extract(meta, '$.dispatched.url') IS NOT NULL | `0011_plan_tasks_indexes.sql` |
| `idx_plan_tasks_plan` | `plan_tasks` | `plan_id` |  | `0011_plan_tasks_indexes.sql` |
| `idx_plan_tasks_status` | `plan_tasks` | `status` |  | `0011_plan_tasks_indexes.sql` |
| `idx_plan_tasks_user` | `plan_tasks` | `user_id` |  | `0002_multitenancy.sql` |
| `idx_plans_project` | `plans` | `user_id` | WHERE json_extract(meta, '$.projectId') IS NOT NULL | `0011_plan_tasks_indexes.sql` |
| `idx_plans_project_value` | `plans` | `user_id, json_extract(meta, '$.projectId')` | WHERE json_extract(meta, '$.projectId') IS NOT NULL | `0012_project_value_indexes.sql` |
| `idx_plans_user` | `plans` | `user_id, updated_at DESC` |  | `0002_multitenancy.sql` |
| `idx_rlb_saved` | `rate_limit_buckets` | `saved_at` |  | `0009_rate_limit_state.sql` |
| `idx_refresh_tokens_hash` | `refresh_tokens` | `token_hash` |  | `0002_multitenancy.sql` |
| `idx_refresh_tokens_user` | `refresh_tokens` | `user_id` |  | `0002_multitenancy.sql` |
| `idx_review_items_user` | `review_items` | `user_id, status, created_at DESC` |  | `0002_multitenancy.sql` |
| `idx_review_status` | `review_items` | `status, created_at DESC` |  | `0001_initial.sql` |
| `idx_review_task` | `review_items` | `task_id` |  | `0001_initial.sql` |
| `idx_revoked_jti_expires` | `revoked_jti` | `expires_at` |  | `0003_user_repos.sql` |
| `session_memory_user_session` | `session_memory` | `user_id, session_id` |  | `0028_session_memory.sql` |
| `idx_sources_kind` | `sources` | `kind` |  | `0022_sources_user_unique.sql` |
| `idx_sources_ref` | `sources` | `kind, ref` |  | `0022_sources_user_unique.sql` |
| `idx_sources_user` | `sources` | `user_id, kind` |  | `0022_sources_user_unique.sql` |
| `idx_usage_user_prov_model_ts` | `usage_ledger` | `user_id, provider, model, ts` |  | `0019_usage_limits.sql` |
| `idx_user_repos_user` | `user_repos` | `user_id` |  | `0003_user_repos.sql` |
| `idx_users_email` | `users` | `email` |  | `0002_multitenancy.sql` |

## Triggers

All triggers keep the `search` FTS5 table in sync with their owning tables.

| Trigger | Timing | Event | Table | Source |
|---|---|---|---|---|
| `trg_entities_ad` | AFTER | DELETE | `entities` | `0001_initial.sql` |
| `trg_entities_ai` | AFTER | INSERT | `entities` | `0001_initial.sql` |
| `trg_meetings_ad` | AFTER | DELETE | `meetings` | `0001_initial.sql` |
| `trg_meetings_ai` | AFTER | INSERT | `meetings` | `0001_initial.sql` |
| `trg_meetings_au` | AFTER | UPDATE | `meetings` | `0014_fts_update_triggers.sql` |
| `trg_outcomes_ad` | AFTER | DELETE | `outcomes` | `0001_initial.sql` |
| `trg_outcomes_ai` | AFTER | INSERT | `outcomes` | `0015_outcomes_fts_body.sql` |
| `trg_outcomes_au` | AFTER | UPDATE | `outcomes` | `0015_outcomes_fts_body.sql` |
| `trg_plan_tasks_ad` | AFTER | DELETE | `plan_tasks` | `0011_plan_tasks_indexes.sql` |
| `trg_plan_tasks_ai` | AFTER | INSERT | `plan_tasks` | `0011_plan_tasks_indexes.sql` |
| `trg_plan_tasks_au` | AFTER | UPDATE | `plan_tasks` | `0011_plan_tasks_indexes.sql` |
| `trg_plans_ad` | AFTER | DELETE | `plans` | `0001_initial.sql` |
| `trg_plans_ai` | AFTER | INSERT | `plans` | `0001_initial.sql` |
| `trg_plans_au` | AFTER | UPDATE | `plans` | `0014_fts_update_triggers.sql` |
| `trg_sources_ad` | AFTER | DELETE | `sources` | `0022_sources_user_unique.sql` |
| `trg_sources_ai` | AFTER | INSERT | `sources` | `0022_sources_user_unique.sql` |
| `trg_sources_au` | AFTER | UPDATE | `sources` | `0022_sources_user_unique.sql` |
