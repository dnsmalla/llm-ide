---
title: DB locked
applies_to: server
---

# Runbook: DB locked (`SQLITE_BUSY`)

## Symptom

- Server returns `500 Internal error` on writes; logs show
  `SqliteError: database is locked`.
- `/health` may stay `ok` (read paths don't block) but `/kb/ingest`,
  `/auth/me/secrets`, etc. fail.
- The Mac app's status bar shows the backend as `.running` but every
  user action errors.

## Triage

Pin the cause within 30 seconds:

```bash
# 1. Is anything writing the DB right now besides the server?
lsof "$DB"
# Expect: one row, the server's `node` process. Two rows means
# something else is holding the write lock.

# 2. Is the WAL file enormous? (Healthy WAL: KB to a few MB.)
ls -lh "${DB}-wal" "${DB}-shm"

# 3. Are there orphaned journal files from a crash?
ls -la "$(dirname "$DB")"/*.db-journal 2>/dev/null
```

Typical culprits:

- A second `node server.mjs` instance accidentally spawned (BackendManager
  auto-restart races on Mac before the prior PID released).
- `sqlite3 $DB` opened by the operator in another terminal that's
  sitting at a transaction prompt.
- An external backup process holding a read lock + the server trying to
  WAL-checkpoint.

## Fix

### Case A: rogue second server process

```bash
# Kill all but the youngest node process bound to :3456
pids=$(lsof -ti :3456)
echo "$pids"
# Keep one; kill the rest:
echo "$pids" | head -n -1 | xargs kill -TERM
```

### Case B: orphaned operator sqlite3

```bash
# Find the sqlite3 process holding the lock
lsof "$DB" | awk 'NR>1 && $1=="sqlite3" {print $2}'
# Kill it (or exit the terminal cleanly)
```

### Case C: WAL grew huge / checkpoint stuck

If `${DB}-wal` is >100MB, force a checkpoint. The server has the DB
open in WAL mode, so the truncate must be done with the server stopped
OR via the SQLite session held by the server (we don't expose that
endpoint). The simplest path:

```bash
# Stop the server (drains in-flight requests for up to 10s).
# Mac: Settings → Backend → Stop.  CLI:
kill -TERM $(lsof -ti :3456)

# Force-checkpoint the WAL into the main DB and truncate it.
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);"
# Output: 0|<frames>|<frames> — second and third columns should match.

# Start the server again.
cd $ROOT/extension && node server.mjs   # or use the supervisor
```

### Case D: foreign_keys deferred transaction wedged

Rare, but the cascading user-delete transaction in
`deleteUserCascade` can deadlock with a concurrent FTS trigger on a
catastrophically broken index. Diagnostic:

```bash
sqlite3 "$DB" "PRAGMA integrity_check;" | head -20
# Expect: ok
# Anything else: jump to restore-from-backup.md.
```

## Postmortem hooks

- Capture `pragma quick_check;` output for the bug report.
- Record the WAL size at the time of the incident.
- If Case A, audit `BackendManager` logs for repeated `--- Server started ---`
  lines without intervening `--- Server exited ---` — that's the
  fingerprint of the race the auto-restart fix from `cd75ed5` was meant
  to prevent. File a bug if you see it.

## Prevention

- Don't run `sqlite3 $DB` against a live server; copy via
  `POST /admin/backup` and inspect the backup file instead.
- Set `LLMIDE_DB_PATH` to a fast local SSD path. Network-mounted
  volumes (NFS, SMB) routinely produce `SQLITE_BUSY` under load.
