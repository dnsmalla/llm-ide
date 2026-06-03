---
title: Recover corrupt vault
applies_to: server
---

# Runbook: Recover corrupt vault

## Symptom

- A specific user reports "Slack notifications stopped working" or
  similar — when an integration that depends on a stored secret (GitHub
  token, Slack webhook, Linear API key, etc.) silently fails.
- Server logs show `vault decrypt failed: Unsupported authentication tag`
  or similar.
- The client sees `error.message: 'Vault operation failed'` (generic by
  design — the real cause is logged server-side via `[auth-routes]
  vault set_secret failed: ...`).

## What this means

Vault entries are encrypted with AES-256-GCM using a key derived from
the server's `MEETNOTES_VAULT_KEY` master key and the user's id:

```
data_key = HKDF-SHA256(master, salt=user_id, info='meetnotes-vault-v1', length=32)
ciphertext = version(1) || iv(12) || AES-256-GCM(data_key, plaintext) || tag(16)
```

Decryption fails when ANY of:

1. The master key changed (someone rotated `MEETNOTES_VAULT_KEY` without
   following the [rotate-vault-key](rotate-vault-key.md) procedure).
2. The user id changed (this should be impossible; user ids are
   permanent in the schema, but if you restored from a backup that
   was migrated through a bug, this is the symptom).
3. The ciphertext blob was corrupted on disk (filesystem damage).
4. A bug wrote a non-v1 record but the version byte is still 0x01.

## Triage

```bash
# 1. Confirm the master key hasn't moved unexpectedly. We log a digest
#    at boot — compare across logs.
grep vaultKeyDigest /path/to/server-logs/*.log | tail -5
# Every line should show the same vaultKeyDigest.

# 2. Identify the affected user.
sqlite3 "$DB" \
  "SELECT user_id, secret_key, updated_at, length(ciphertext)
   FROM user_secrets ORDER BY updated_at DESC LIMIT 20;"
# Anomaly: a blob shorter than 1+12+16 = 29 bytes is malformed.

# 3. For a specific user, find which keys decrypt vs fail.
# Test by hitting /auth/me/secrets — list endpoint doesn't decrypt;
# it returns metadata only. So you can't tell from the API. Instead,
# try a no-op operation that DOES decrypt (e.g. fetch a Slack
# webhook URL via the slack agent).
```

## Fix

### Case 1: Master key was changed without rotation

Restore the original `MEETNOTES_VAULT_KEY` from your secret store and
restart the server. If the original is unrecoverable, the encrypted
secrets are unrecoverable — proceed to Case 3.

### Case 2: Restored from a backup, user ids differ

This shouldn't happen with our `VACUUM INTO` backups (they preserve
ids). If it does, see [restore-from-backup.md](restore-from-backup.md)
for the row-level migration pattern, and pay specific attention to
keeping `users.id` stable.

### Case 3: Ciphertext is genuinely lost

The only recovery is to drop the dead rows and have the user re-enter
their secrets:

```bash
# Delete all secrets for the affected user. This is a destructive
# operation — make a backup first.
curl -s -X POST -H "Authorization: Bearer <admin-token>" \
  http://127.0.0.1:3456/admin/backup

sqlite3 "$DB" \
  "DELETE FROM user_secrets WHERE user_id = 'USER_ID';"
```

Notify the user: "Your stored integrations (GitHub token, Slack
webhook, etc.) were reset due to a server-side recovery operation.
Please re-enter them in Settings → Account → Integrations."

### Case 4: A single secret corrupt, others fine

Same as Case 3 but scoped to one key:

```bash
sqlite3 "$DB" \
  "DELETE FROM user_secrets WHERE user_id = 'USER_ID' AND secret_key = 'github.token';"
```

## Postmortem hooks

- Capture the `vaultKeyDigest` from logs at the time of the incident
  vs the current one. A mismatch confirms key rotation as the cause.
- Capture `length(ciphertext)` and the rotated-at timestamps of all
  affected rows.
- File a bug if multiple users were affected — that's a server-side
  issue, not user error.

## Prevention

- Treat `MEETNOTES_VAULT_KEY` like a production secret: store it in a
  secret manager, NEVER inline in shell history or scripts.
- Use the [rotate-vault-key](rotate-vault-key.md) procedure if you
  need to change it — never swap directly.
- Take a backup BEFORE any production secret rotation.
