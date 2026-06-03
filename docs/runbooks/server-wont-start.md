---
title: Server won't start
applies_to: server
---

# Runbook: Server won't start

## Symptom

- `node server.mjs` exits before logging `server_started`, or exits
  with non-zero immediately after.
- Mac app's BackendManager status: `.crashed(exitCode: N)`. The auto-
  restart loop exhausts its 3-attempt budget and surfaces "Click
  Start in Settings to retry" in the log.
- `curl http://127.0.0.1:3456/health` → connection refused.

## Triage

Read the LAST log line before exit. The server's startup is structured
and each failure mode produces a distinct message.

```bash
# Mac: tail the BackendManager log in Settings → Backend.
# CLI: re-run with logs visible
cd $ROOT/extension && node server.mjs 2>&1 | head -40
```

Map the message to a fix:

| Last line | Cause | Section |
|---|---|---|
| `Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'better-sqlite3'` | npm deps not installed | A |
| `MEETNOTES_JWT_SECRET and MEETNOTES_VAULT_KEY must be set in production` | missing env vars | B |
| `EADDRINUSE: ... 127.0.0.1:3456` | port already bound | C |
| `Migration <file> failed: ...` | DB migration error | D |
| `db_open_failed_at_boot` | DB file unreachable or corrupt | E |
| `uncaught_exception` then exit 1 | code-level crash | F |

## Fixes

### A. Missing dependencies

```bash
cd $ROOT/extension && npm ci
# If `better-sqlite3` fails to build, you're missing Python + a C++
# toolchain. macOS: xcode-select --install. Linux: apt install
# build-essential python3.
```

### B. Missing env vars

The server refuses to start in production without
`MEETNOTES_JWT_SECRET` and `MEETNOTES_VAULT_KEY` (each ≥32 chars).

```bash
# Generate two strong secrets
openssl rand -base64 48
openssl rand -base64 48

export MEETNOTES_JWT_SECRET="<first>"
export MEETNOTES_VAULT_KEY="<second>"
```

Store these in your supervisor's secret file (systemd
`EnvironmentFile`, launchd EnvironmentVariables). DO NOT commit them.

In **development** the server will auto-generate dev-only secrets and
write them to `kb/.dev-secrets.json` (gitignored). If you see "must be
set in production", set `NODE_ENV=development` for local work OR
explicitly provide the env vars.

### C. Port already bound

```bash
lsof -ti :3456                 # find offender
lsof -ti :3456 | xargs kill -TERM
```

If `lsof` is empty but the bind still fails, you may have hit a
TIME_WAIT pile-up after a crash — wait 60s and retry. On Linux you
can also set `SO_REUSEADDR` but our server already does.

### D. Migration failure

The migration runner is transactional, so a failed migration leaves
the DB at the prior version (not partially upgraded). The error
message names the file. Read the SQL, fix the data condition (most
common: a CHECK that a pre-existing row violates) directly via
`sqlite3 $DB`, then re-run the server.

If you can't reason about the failure: restore from a backup taken
BEFORE the offending migration (see
[restore-from-backup](restore-from-backup.md)) and roll back the code
to the matching version.

### E. DB unreachable / corrupt

```bash
sqlite3 "$DB" "PRAGMA integrity_check;"
# "ok" → DB is fine; the path is wrong. Check MEETNOTES_DB_PATH and
# file permissions.
# Anything else → see restore-from-backup.md.
```

### F. Code-level crash (uncaught exception)

This is the bad one. The stack trace will be in the log. Capture it,
restore from backup if data integrity is at risk, then file a bug.

In the meantime the server can sometimes be coaxed up with a partial
revert:

```bash
git log --oneline | head -10
# Find the last known-good commit; check it out into a working tree
git worktree add /tmp/meetnotes-rollback <commit-sha>
cd /tmp/meetnotes-rollback/extension && npm ci && node server.mjs
```

## Postmortem hooks

- Capture the last 200 lines before the exit.
- Capture `sqlite3 $DB "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;"`
- For (D) and (E), capture the integrity-check output.
