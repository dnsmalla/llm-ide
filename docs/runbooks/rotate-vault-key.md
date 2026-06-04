---
title: Rotate vault key
applies_to: server
---

# Runbook: Rotate `LLMIDE_VAULT_KEY`

## When to use

- Suspected compromise of the current master key.
- Periodic rotation policy (best practice: every 90-180 days for a
  long-lived production install).
- After offboarding an operator who had access to the key.

## What this does NOT do

Vault entries are encrypted with a per-user data key derived from the
master via HKDF. You cannot "re-encrypt in place" without the OLD key
— because the old key is needed to decrypt before re-encrypting.

That means: **rotation is a re-encrypt operation, not a swap**. Doing
it requires:

1. Both old and new master keys held simultaneously
2. A loop over every `user_secrets` row that decrypts with old, then
   encrypts with new
3. Atomic swap of the env var to the new key

The current codebase does NOT implement step 2 as a built-in tool.
This runbook is the manual procedure; a `bin/rotate-vault.mjs`
helper would be a worthwhile follow-up if you rotate frequently.

## Prerequisites

- Server is healthy and reachable.
- Admin access to set env vars and restart the server.
- A SECOND `LLMIDE_VAULT_KEY` value ≥32 chars generated via
  `openssl rand -base64 48`.
- A fresh backup taken just before starting:

  ```bash
  curl -s -X POST -H "Authorization: Bearer <admin-token>" \
    http://127.0.0.1:3456/admin/backup
  ```

## Procedure

### 1. Inventory affected rows

```bash
sqlite3 "$DB" \
  "SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users
   FROM user_secrets;"
```

Note `n` (total rows to re-encrypt) and `users` (callers to notify if
the rotation requires downtime).

### 2. Stop the server

```bash
kill -TERM $(lsof -ti :3456)
```

Why a stop and not a hot rotation? Because the `vaultKey` variable in
`extension/core/config.mjs` is captured at module load. Even if you
swapped env vars at runtime, the running process wouldn't see the
change. Hot rotation would require a dedicated endpoint we don't
have today.

### 3. Run a re-encrypt script

Write this to `/tmp/rotate-vault.mjs`:

```js
import Database from 'better-sqlite3';
import crypto from 'crypto';

const DB_PATH = process.env.DB_PATH;
const OLD_KEY = process.env.OLD_VAULT_KEY;
const NEW_KEY = process.env.NEW_VAULT_KEY;
if (!DB_PATH || !OLD_KEY || !NEW_KEY) {
  console.error('DB_PATH, OLD_VAULT_KEY, NEW_VAULT_KEY all required');
  process.exit(1);
}

const KEY_VERSION = 0x01;

function derive(masterStr, userId) {
  const master = Buffer.from(masterStr);
  return crypto.hkdfSync('sha256', master, Buffer.from(String(userId)),
                          Buffer.from('llmide-vault-v1'), 32);
}
function decrypt(userId, blob, masterStr) {
  const iv  = blob.subarray(1, 13);
  const tag = blob.subarray(blob.length - 16);
  const ct  = blob.subarray(13, blob.length - 16);
  const key = Buffer.from(derive(masterStr, userId));
  const d   = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function encrypt(userId, plaintext, masterStr) {
  const key = Buffer.from(derive(masterStr, userId));
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, ct, c.getAuthTag()]);
}

const db = new Database(DB_PATH);
const rows = db.prepare('SELECT user_id, secret_key, ciphertext FROM user_secrets').all();
console.log(`re-encrypting ${rows.length} rows...`);

const tx = db.transaction(() => {
  const upd = db.prepare(
    'UPDATE user_secrets SET ciphertext = ?, updated_at = datetime(\'now\') ' +
    'WHERE user_id = ? AND secret_key = ?'
  );
  let okN = 0, badN = 0;
  for (const r of rows) {
    try {
      const pt    = decrypt(r.user_id, r.ciphertext, OLD_KEY);
      const fresh = encrypt(r.user_id, pt, NEW_KEY);
      upd.run(fresh, r.user_id, r.secret_key);
      okN += 1;
    } catch (err) {
      console.error(`FAIL ${r.user_id}/${r.secret_key}: ${err.message}`);
      badN += 1;
    }
  }
  if (badN > 0) {
    throw new Error(`${badN} rows failed — rolling back`);
  }
  console.log(`OK ${okN}/${rows.length}`);
});

tx();
db.close();
console.log('done');
```

Run:

```bash
cd $ROOT/extension
DB_PATH="$DB" \
OLD_VAULT_KEY="<current key>" \
NEW_VAULT_KEY="<new key>" \
node /tmp/rotate-vault.mjs
```

The transaction rolls back on ANY row failure — you'll see which
row failed and can investigate before retrying. If decryption fails
for a row, the OLD key isn't what you think it is; abort and recover.

### 4. Swap the env var

Update your supervisor's secret file to use `<new key>` for
`LLMIDE_VAULT_KEY`. Do NOT keep both around.

### 5. Restart the server and verify

```bash
# Start your supervisor
systemctl restart llmide        # or launchctl, or your runner

# Confirm the digest changed
curl -s http://127.0.0.1:3456/health | jq .
# Server logs at boot: "vaultKeyDigest":"<new digest>"
```

Exercise one user's stored integration to confirm decrypts work end-to-
end (e.g. trigger a `POST /kb/notify/slack` for a user with a stored
`slack.webhookUrl`).

### 6. Securely destroy the old key

`shred -u` on the file holding it; clear shell history (`history -c`);
remove from secret manager backups according to your retention policy.

## Postmortem hooks

- Capture row counts before and after; they should match.
- Audit `[auth-routes]` logs for any vault failures in the hour after
  rotation. Any failure here indicates an incomplete re-encrypt;
  restore from the backup taken in step 0 and try again.

## Risks

- **Server stays down for the duration of step 3.** For a small install
  (single-user, <100 secrets) this is sub-second. For larger installs
  scale your downtime window accordingly.
- **The rotate script holds both keys in memory simultaneously**. Run
  it from a trusted host; don't pipe keys via shell args (they show up
  in `ps` — use env vars as above).
- **A partial run cannot be resumed safely** — the script's `tx` makes
  it all-or-nothing, but if you SIGKILL it mid-transaction SQLite will
  roll back. Always test against a backup copy first.
