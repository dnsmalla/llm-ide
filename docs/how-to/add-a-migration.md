---
title: How to add a database migration
applies_to: server
---

# How to add a database migration

## Goal

Evolve the SQLite schema with a new migration that applies cleanly on every install.

## Steps

1. **Pick the next number.** Look in `extension/kb/migrations/`. If the last file is `0004_*.sql`, your new file is `0005_<short_name>.sql`.
2. **Write the SQL.** Use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`, or new index DDL. Never edit a shipped migration.
3. **Back-fill data in the same migration** if a new NOT NULL column needs values for existing rows. Default to `'legacy'` for the multi-tenancy `user_id` pattern.
4. **Update the FTS5 mirror** if the new column is searchable.
5. **Run the server** — `migrations.mjs` applies the new file in order on boot. Verify with `sqlite3 kb/data.db ".schema"`.

## Verification

```bash
cd extension
node -e "import('./kb/migrations.mjs').then(m => m.runMigrations())"
sqlite3 ../kb/data.db ".schema <new_table_or_column>"
```

## See also

- [ADR 0008 — append-only migrations](../decisions/0008-append-only-migrations.md)
- [Database schema reference](../reference/database-schema.md)
