---
title: "0008. Database migrations are append-only and applied on server start"
status: accepted
date: 2026-05-18
---

# 0008. Append-only migrations

## Context

The schema evolves as features land. Inline `ALTER TABLE` calls at server start, or hand-edited migrations, both produce a state where two installs at the same version have different schemas.

## Decision

Migrations live under `extension/kb/migrations/NNNN_<name>.sql`, applied in lexical order by `migrations.mjs` on server start. A shipped migration is never edited; the only legal change is a new file with the next number. Schema version is tracked in a `schema_migrations` table.

## Consequences

- **Positive:** every install at version X has exactly the same schema.
- **Positive:** downgrades are explicit (and rare); upgrades are automatic.
- **Negative:** fixing a bug in a shipped migration requires a follow-up migration, not an edit.
- **Locked in:** see [how-to/add-a-migration](../how-to/add-a-migration.md).
