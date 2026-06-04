---
title: Out of disk
applies_to: server
---

# Runbook: Out of disk (`ENOSPC`)

## Symptom

- Writes fail with `SqliteError: disk I/O error` or `ENOSPC` in logs.
- `/admin/backup` returns 500 even though the live DB is healthy.
- Meeting recording stops mid-session; Mac app surfaces "Backend log:
  ENOSPC" through the BackendManager status bar.

## Triage

```bash
df -h "$DB"
du -sh "$(dirname "$DB")"

# What's growing?
du -sh "$(dirname "$DB")"/* | sort -h
```

Three usual suspects, in descending likelihood:

1. **Backups** under `$BACKUPS/` — the on-demand `/admin/backup`
   endpoint never deletes old snapshots.
2. **`${DB}-wal`** — checkpoint pressure (see [db-locked](db-locked.md)).
3. **Log files** if the operator is writing logs to disk via their
   supervisor (the server itself only writes to stdout/stderr).

## Fix

### Free space fast (do NOT delete `${DB}` itself)

```bash
# Prune backups older than 14 days
find "$BACKUPS" -name 'data-*.db' -mtime +14 -delete

# Force-checkpoint to shrink the WAL (server must be stopped)
kill -TERM $(lsof -ti :3456)
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);"

# If the operator's supervisor writes app logs, truncate the oldest
journalctl --vacuum-size=200M    # systemd
log show --predicate '...' --last 1d   # macOS — not destructive
```

### Permanent fix: backup retention

The `/admin/backup` endpoint is intentionally minimal — it does NOT
prune old snapshots, since we don't know which the operator wants to
keep. Install a cron / launchd timer:

```bash
# Keep last 14 days of backups
find "$BACKUPS" -name 'data-*.db' -mtime +14 -delete
```

Add to `crontab -e`:

```
0 3 * * * find /path/to/kb/backups -name 'data-*.db' -mtime +14 -delete
```

### Move the DB to a larger volume

`LLMIDE_DB_PATH` controls the location. To migrate:

```bash
kill -TERM $(lsof -ti :3456)            # stop the server cleanly
mv "$DB" /new/volume/data.db
mv "${DB}-wal" /new/volume/ 2>/dev/null   # optional; safe to discard
mv "${DB}-shm" /new/volume/ 2>/dev/null   # optional; safe to discard
export LLMIDE_DB_PATH=/new/volume/data.db
# Restart the server (your supervisor will re-read the env var).
```

## Postmortem hooks

- Capture `du -sh "$(dirname "$DB")"/*` snapshot for the bug report.
- If backups consumed the space, log how many were retained and the
  size distribution — informs the retention policy default.

## Prevention

- Always set `LLMIDE_DB_PATH` to a volume with at least 5× the
  current DB size of headroom. Backups are full copies, not deltas.
- Wire the backup-retention cron above into the install procedure.
- Monitor disk usage via the supervisor or `/health` (Phase 2: we plan
  to expose `df` numbers there).
