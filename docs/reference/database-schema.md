---
title: Database schema
source: extension/kb/migrations/*.sql
---

<!-- generated from extension/kb/migrations/*.sql - do not edit by hand -->

# Database schema

SQLite, WAL + FTS5. Source: `extension/kb/migrations/*.sql`.

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

## `plan_tasks`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | TEXT PRIMARY KEY |
| `plan_id` | TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE |
| `position` | INTEGER NOT NULL DEFAULT 0 |
| `milestone` | TEXT |
| `title` | TEXT NOT NULL |
| `description` | TEXT |
| `owner` | TEXT |
| `due` | TEXT |
| `estimate_days` | REAL |
| `depends_on` | TEXT NOT NULL DEFAULT '[]' |
| `status` | TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','blocked')) |
| `risk` | TEXT CHECK (risk IN ('low','med','high') OR risk IS NULL) |
| `risk_reason` | TEXT |
| `files` | TEXT NOT NULL DEFAULT '[]' |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

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

## `sources`

_From `0001_initial.sql`._

| Column | Type / constraints |
|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `kind` | TEXT NOT NULL CHECK (kind IN ('code','ticket','qa')) |
| `ref` | TEXT NOT NULL |
| `chunk_idx` | INTEGER NOT NULL DEFAULT 0 |
| `title` | TEXT NOT NULL |
| `body` | TEXT NOT NULL |
| `meta` | TEXT NOT NULL DEFAULT '{}' |
| `embedding` | BLOB |
| `indexed_at` | TEXT NOT NULL DEFAULT (datetime('now')) |
| `user_id` | TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id) |

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
