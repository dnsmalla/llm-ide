---
title: Restore from backup
applies_to: server
---

# Runbook: Restore from backup

## When to use this

- `PRAGMA integrity_check` reports anything other than `ok`.
- A failed migration corrupted the DB and there's no clean revert.
- Accidental deletion via `/auth/me/delete` of an account you wanted
  to keep (the cascade is irreversible without a backup).
- Filesystem-level damage (truncated file, bad sector).

## Prerequisites

You need a backup. Take one regularly via:

```bash
cd extension
npm run backup
# → backup=/abs/path/to/data.db.bak-<iso>.db
#   bytes=<N>
#   sha256=<hex>

# Or choose an explicit destination:
npm run backup -- --out /path/to/backups/meetnotes.db

# For a live admin-triggered copy over HTTP:
curl -s -X POST -H "Authorization: Bearer <admin-token>" \
  http://127.0.0.1:3456/admin/backup
# → {"ok":true,"path":"$BACKUPS/data-<unix>.db","bytes":<N>}
```

`npm run backup` uses `better-sqlite3`'s SQLite backup API, which is
WAL-aware and safe for hot copies. `/admin/backup` uses SQLite's
`VACUUM INTO`, which is also safe to run while the server is up and
serving traffic.

For unattended backups, cron the equivalent. See
[out-of-disk.md](out-of-disk.md) for the retention pattern.

## Restore procedure (full-DB rollback)

1. **Stop the server cleanly.** This drains in-flight requests for up
   to 10 seconds; do not SIGKILL unless the drain hangs.

   ```bash
   kill -TERM $(lsof -ti :3456)
   # OR Mac: Settings → Backend → Stop
   ```

2. **Move the broken DB aside.** Don't delete — you may need to
   extract specific rows later.

   ```bash
   mv "$DB"      "${DB}.broken.$(date +%s)"
   mv "${DB}-wal" "${DB}-wal.broken.$(date +%s)" 2>/dev/null
   mv "${DB}-shm" "${DB}-shm.broken.$(date +%s)" 2>/dev/null
   ```

3. **Copy the chosen backup into place.**

   ```bash
   cp "$BACKUPS/data-<unix>.db" "$DB"
   chmod 600 "$DB"   # match the original permission posture
   ```

4. **Sanity check before bringing the server back up.**

   ```bash
   sqlite3 "$DB" "PRAGMA integrity_check;"
   sqlite3 "$DB" "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;"
   ```

   - `integrity_check` must be `ok`.
   - The latest migration must be ≤ the version the current code
     applies. If the backup is OLDER than what the code expects, the
     server will re-apply intermediate migrations on startup
     (idempotent). If the backup is NEWER, you must check out the
     matching code revision first or the server will refuse to start.

5. **Start the server.** Watch the boot log for `migration_applied`
   lines if your backup predated current schema; that's normal.

6. **Verify with a smoke request.**

   ```bash
   curl -s http://127.0.0.1:3456/health | jq '.checks'
   # {"db": true, "claude": true}
   ```

## Partial restore — extracting a single user's data

If only one user's data was lost (e.g. accidental
`POST /auth/me/delete`), you can avoid a full rollback:

```bash
# 1. Find the user_id you want back from the backup
sqlite3 "$BACKUPS/data-<unix>.db" \
  "SELECT id, email FROM users WHERE email = 'user@example.com';"

# 2. ATTACH the backup to the live DB and copy rows. Run with the
#    server stopped so no writes interleave.
kill -TERM $(lsof -ti :3456)

sqlite3 "$DB" <<'SQL'
ATTACH DATABASE 'BACKUP_PATH' AS bak;
BEGIN;

INSERT OR IGNORE INTO users
  SELECT * FROM bak.users WHERE id = 'USER_ID';
INSERT INTO meetings    SELECT * FROM bak.meetings    WHERE user_id = 'USER_ID';
INSERT INTO entities    SELECT * FROM bak.entities    WHERE user_id = 'USER_ID';
INSERT INTO sources     SELECT * FROM bak.sources     WHERE user_id = 'USER_ID';
INSERT INTO plans       SELECT * FROM bak.plans       WHERE user_id = 'USER_ID';
INSERT INTO plan_tasks  SELECT * FROM bak.plan_tasks  WHERE user_id = 'USER_ID';
INSERT INTO outcomes    SELECT * FROM bak.outcomes    WHERE user_id = 'USER_ID';
INSERT INTO review_items SELECT * FROM bak.review_items WHERE user_id = 'USER_ID';
INSERT INTO user_repos  SELECT * FROM bak.user_repos  WHERE user_id = 'USER_ID';
-- Skip user_secrets / refresh_tokens — those should be regenerated
-- via re-login + re-entering secrets in Settings, not restored.

COMMIT;
DETACH DATABASE bak;
SQL
```

(Substitute `BACKUP_PATH` and `USER_ID` first; SQLite's `<<'SQL'`
heredoc doesn't expand shell variables.)

The FTS5 `search` index will lag — re-trigger a search to detect any
gaps. If FTS rows are missing, run:

```sql
INSERT INTO search (meeting_id, entity_id, kind, title, body)
SELECT id, NULL, 'meeting', title, COALESCE(transcript, '')
FROM meetings WHERE user_id = 'USER_ID'
  AND id NOT IN (SELECT meeting_id FROM search WHERE meeting_id IS NOT NULL);
```

## Postmortem hooks

- Note WHEN the corruption was first observed vs the timestamp of the
  backup you restored from — that's your data-loss window.
- File a bug if the corruption was triggered by a migration or
  cascading delete, not by hardware. The runbook is for hardware /
  operator error; software bugs need a real fix.
