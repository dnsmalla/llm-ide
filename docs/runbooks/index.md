---
title: Runbooks
---

# Runbooks

Incident-response and recovery procedures for the Meet Notes server. Each
runbook follows the same shape:

1. **Symptom** — what the operator sees
2. **Triage** — fast commands to confirm the diagnosis
3. **Fix** — minimal-impact recovery
4. **Postmortem hooks** — what to capture for the audit log / follow-up

These are operator docs, not user docs. They assume shell access to the
machine running `node server.mjs` and read access to `kb/data.db`.

## Index

| Symptom | Runbook |
|---|---|
| `SQLITE_BUSY` / app appears frozen, writes hang | [DB locked](db-locked.md) |
| `ENOSPC` / writes fail / app shows red banner | [Out of disk](out-of-disk.md) |
| `node server.mjs` exits before listen, or `/health` 5xx at boot | [Server won't start](server-wont-start.md) |
| Need to recover a deleted user / corrupted DB | [Restore from backup](restore-from-backup.md) |
| `Vault decrypt failed` errors for a user | [Recover corrupt vault](recover-corrupt-vault.md) |
| Need to rotate `MEETNOTES_VAULT_KEY` | [Rotate vault key](rotate-vault-key.md) |
| Need to rotate `MEETNOTES_JWT_SECRET` | [Rotate JWT secret](../how-to/rotate-jwt-secret.md) |

## Conventions

- `$ROOT` = the directory containing `extension/server.mjs`
- `$DB` = `$MEETNOTES_DB_PATH` (default: `$ROOT/kb/data.db`)
- `$BACKUPS` = `$(dirname $DB)/backups/` (default location for
  `POST /admin/backup`)
- Commands assume macOS/Linux. Substitute equivalents on other platforms.

## What is NOT covered here

- **Application-level bug reports** — those go through the in-app
  Report a bug flow (`CodeAssistantPanel` → ReportBugSheet).
- **Per-user "I forgot my password"** — there is no email-based reset
  today. The admin can clear `users.password_hash` and instruct the
  user to re-register, or use `verifyPassword` + manual hash set.
- **Chrome extension issues** — see [docs/how-to/debug-captions-not-appearing.md](../how-to/debug-captions-not-appearing.md).
