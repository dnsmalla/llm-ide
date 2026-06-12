---
title: How to rotate the JWT secret
applies_to: server
---

# How to rotate `LLMIDE_JWT_SECRET`

JWT rotation is simpler than [vault-key rotation](../runbooks/rotate-vault-key.md)
because JWTs are short-lived (15 min access, 30 day refresh by default).
You don't need to re-sign existing tokens — you just need to handle the
window where some tokens were signed with the old secret and some with
the new.

## When to rotate

- Suspected secret compromise (mandatory; do this immediately).
- Periodic rotation policy (recommended: every 90 days).
- Offboarding an operator who had access to the secret.

## Strategy

Two viable paths. Pick one before starting; don't mix.

### Path A — Hard cutover (recommended for single-user / dev installs)

1. Take a backup. Generate a new secret.
2. Stop the server.
3. Update the env var.
4. Start the server.

**Effect:** all existing access tokens become invalid immediately
(signature verification fails → 401). Every Mac/extension client
re-runs the refresh flow — which ALSO fails because refresh tokens
are signed with the same secret and verified on every refresh.
Every user is forced to re-login.

**When acceptable:** single-user laptop installs (one re-login is a
trivial cost). Most users of this codebase fit this profile.

### Path B — Dual-secret window (for multi-user production)

The current codebase does NOT support dual-secret verification — the
JWT module reads exactly one `LLMIDE_JWT_SECRET`. To do a graceful
rotation you would:

1. Add a `LLMIDE_JWT_SECRET_PREVIOUS` env var (code change required:
   modify `server/jwt.mjs` to try verifying with both secrets, mint
   only with the new one).
2. Deploy the code change with both env vars set.
3. Run for `accessTokenTTLSec` + `refreshTokenTTLSec` (default: 15min
   - 30d = 30 days, 15min). During this window every minted token is
   signed with the new secret; tokens minted before are still
   verifiable.
4. Remove the `_PREVIOUS` env var and redeploy.

**When required:** any deployment where forcing re-login is a real
operational cost (multi-user, SSO-fronted, etc.).

This path is **not implemented today**. If you need it, treat the
above as a feature request and file a ticket. The runbook here covers
Path A only.

## Procedure (Path A — hard cutover)

### 1. Generate a new secret

```bash
openssl rand -base64 48
```

Save this to your secret manager. The secret must be ≥32 chars (the
server refuses to start otherwise).

### 2. Backup

```bash
curl -s -X POST -H "Authorization: Bearer <admin-token>" \
  http://127.0.0.1:3456/admin/backup
# → {"ok":true,"path":"...","bytes":...}
```

The JWT secret isn't in the DB, but the refresh-token rows ARE — and
those become unverifiable. The backup lets you roll back if something
else breaks in step 3.

### 3. Invalidate refresh tokens (optional but recommended)

Refresh tokens signed with the old secret will fail to verify after
the swap. To keep the database clean, drop them explicitly:

```bash
sqlite3 "$DB" "DELETE FROM refresh_tokens;"
```

This is idempotent — the next login by each user will mint a fresh
refresh token.

### 4. Swap the env var

Update your supervisor's secret file to use the new
`LLMIDE_JWT_SECRET`. Do NOT keep the old one around.

### 5. Restart the server

```bash
systemctl restart llmide        # or launchctl, or your runner
```

Watch the boot log:

```text
{"level":"info","msg":"server_started", ..., "jwtSecretDigest":"<digest>"}
```

The `jwtSecretDigest` field should now show the new digest (first 8
hex chars of SHA-256). Compare against the previous boot's log to
confirm the rotation took effect.

### 6. Verify

```bash
# A fresh login mints a token signed with the new secret.
curl -s -X POST http://127.0.0.1:3456/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<user>","password":"<pass>"}'
# → {"accessToken":"...","refreshToken":"..."}

# An old token (from before rotation) should now fail with 401.
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <old-token>" http://127.0.0.1:3456/auth/me
# → 401
```

### 7. Notify users

Every signed-in user will see their next API call fail with 401 and
the Mac app / extension will surface "session expired — please
re-login". This is the expected hard-cutover behavior.

## Postmortem hooks

- Capture `jwtSecretDigest` before and after — must differ.
- Verify `SELECT COUNT(*) FROM refresh_tokens;` is 0 right after
  rotation (if you ran step 3) and starts growing again as users
  re-authenticate.
- Audit `auth.login_failure` events in the audit log for the hour
  after rotation; a spike means clients aren't recovering gracefully.

## Risks

- **All in-flight uploads with bearer auth fail mid-stream.** Schedule
  rotation during a low-traffic window.
- **Mac app's auto-restart loop may show several `--- Server started
  ---` lines in quick succession** as it adopts the new server. Not a
  bug; that's the [BackendManager auto-restart](https://github.com/dnsmalla/llm-ide/blob/main/mac/Sources/LlmIdeMac/Services/BackendManager.swift)
  doing its job.
