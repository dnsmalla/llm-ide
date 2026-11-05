# Account service review, 2026-11-05

Independent review of commits `32b0d72b..1f86e3d8` (account-service sub-project 1 plus the desktop OAuth backend), against the [spec](../specs/2026-11-05-accounts-and-device-linking-design.md), the [plan](../plans/2026-11-05-account-service-identity.md) and [ADR 0019](../../decisions/0019-public-accounts-desktop-data.md). C1 was re-checked by hand at `4b206922`: `GET /v1/account` only accepts the session cookie (`account-service/src/sessions.mjs` `require`), while `desktop/src-tauri/src/account_oauth.rs:183-184` sends a Bearer token. **Fix C1 and I1 to I3 before anything else in sub-project 2.**


Read-only. Committed code at 1f86e3d8 (`git show 1f86e3d8:<path>`); line numbers are at that commit.
Diff: `acct-review.diff` in this folder.

**Tests:** `cd account-service && npm test` -> 65 tests, 65 pass, 0 fail (first run in the sandbox: listen EPERM, 45 failed; rerun with the sandbox off: all green). `npm run check:boundary` -> ok.
Note: run against the working tree, whose `account-service/` = HEAD (1ad1f41b), which adds 7 files over 1f86e3d8 (device list/revoke, oauth revoke). No uncommitted changes in `account-service/`.

Counts: Critical 1, Important 4, Minor 14.

What holds up (checked, no finding): WebAuthn via `@simplewebauthn/server` 14.0.3 with exact origin + RP ID, `requireUserVerification: true`, resident key required, attestation none, empty `allowCredentials`; challenges single-use (DELETE ... RETURNING), 5 min, registration ceremony bound to the session's user; counter updated from `newCounter`. Sessions: 256-bit, SHA-256 at rest, `__Host-` + HttpOnly + SameSite=Strict + Secure, 1 h idle / 12 h absolute, rotated on sign-in, all revoked on recovery passkey add. Exact-Origin check on every non-GET cookie route. Email tokens: 256-bit, hashed, purpose-bound, 15 min, single-use, kills older tokens. Sign-up closed by default and checked first. Sign-up/recovery always 202 with the same body; the per-address cap is applied before the existence branch. OAuth: S256 only, exact redirect-URI string match, canonical loopback port, 60 s single-use hashed code, replay revokes the tokens it granted, refresh rotation with family revoke on reuse, opaque hashed tokens. All SQL is parameterised. Migrations are append-only (0001, 0002, each added once). Boundary script pins exactly the 3 deps; no `extension/` import. systemd unit runs as `llmide-accounts` with ProtectSystem=strict, NoNewPrivileges, an empty CapabilityBoundingSet, UMask 0077. nginx access log has no IP or query string; HSTS, CSP, no-referrer are set.

---

## Critical

### C1. Desktop sign-in can never complete: the profile fetch uses a Bearer token on a cookie-only route
- `desktop/src-tauri/src/account_oauth.rs:178-189` (`fetch_email`) calls `GET /v1/account` with `Authorization: Bearer <access>`; `sign_in_blocking` (`:195`) requires it to succeed before it stores anything (`:196-198`).
- `account-service/src/routes/account.mjs:9-12`: `GET /v1/account` uses `ctx.sessions.require(req)`, which only reads the session cookie (`sessions.mjs:32-41`). `oauth.requireAccess` (`oauth.mjs:125-135`) is used only by `POST /v1/desktop`.
- Failure: every desktop sign-in gets 401 `{"error":"unauthenticated"}`, then "the account service returned no email", and is reported as failed. The code was already spent and a live 30-day refresh family was minted; the client throws it away and never revokes it (an orphaned credential stays valid on the server).
- No test covers it: Rust tests do not exercise the network, and `tests/oauth.test.mjs` never calls `/v1/account` with a Bearer token. Still present at HEAD (`account_oauth.rs:182`).
- Fix: add a Bearer-authenticated profile route (e.g. `GET /v1/desktop/account` using `ctx.oauth.requireAccess`, or let `GET /v1/account` accept either credential), and add an end-to-end test (authorize -> token -> profile). Make the desktop revoke the refresh token if a later step fails.

## Important

### I1. Recovery does not sign out the desktop (OAuth tokens survive "every other session is signed out")
- `account-service/src/routes/passkeys.mjs:76-79`: the recovery path calls `ctx.sessions.revokeOthers` (web `sessions` table only). `desktop_tokens` (`migrations/0002_oauth_devices.sql:16-27`) and unexpired `oauth_codes` are untouched. The recovery mail (`mail-templates.mjs:43`, `:55`) and spec 4.3 step 3 / P2 promise that every other session is signed out.
- Failure: someone who stole a desktop refresh token (or a desktop the user lost) keeps rotating it for up to 30 days of idle after the user recovers. The user has been told it was signed out. With `POST /v1/desktop` (`routes/desktop.mjs:7-19`), that token can still register keys.
- Fix: in the same transaction, `UPDATE desktop_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL` and delete the user's `oauth_codes`. Test it in `tests/recovery.test.mjs:21`. Decide whether passkey removal and `revoke-others` should also cover desktop tokens.

### I2. OAuth authorize has no consent step; a fresh session alone silently mints desktop tokens
- `account-service/src/routes/oauth.mjs:30-61` issues a code straight from a GET when a full session is under 5 minutes old. The comment at `:32-33` admits the spec's "Sign in LLM-IDE on this computer?" confirmation (spec 4.4 step 2) is missing.
- Failure: within 5 minutes of a web sign-in, any local program can open the system browser at `/v1/oauth/authorize?...redirect_uri=http://127.0.0.1:<its port>/auth/callback` with its own PKCE pair. An externally opened navigation counts as same-site, so the Strict cookie is sent. That program then receives a code, and from it 30-day desktop tokens, with no user interaction. Separately, when the session is not fresh, the real desktop flow just gets a JSON 401 page: there is no sign-in or re-auth redirect, so the shipped desktop button only works if the user signed in on the web in the last 5 minutes.
- Fix: before issuing a code, render or require an explicit consent POST (Origin-checked; show client and "this computer"). Redirect unauthenticated or stale sessions to sign-in with a return URL. Until then, document that the flow is not usable end to end.

### I3. One-desktop rule with no replace or release path: a registration can never be undone
- `account-service/src/devices.mjs:21-33` together with the unique index `migrations/0002_oauth_devices.sql:49-51` (`WHERE kind='desktop'`, every status). Spec 4.7 (replace, fresh passkey, 72 h hold after recovery, Q4) is not built. At HEAD, `revokeDevice` only sets `status='revoked'`; the row stays and still holds the unique slot.
- Keys are only bounded as text (`validate.mjs:53-58`). There is no check that they are P-256 SPKI (spec 4.4 step 5) and no proof of possession.
- Failure: a desktop reinstall or lost keys, or a garbage key sent with any access token (including one that survived recovery, I1), leaves the account at `409 desktop_exists` permanently. The only escape is deleting the account. The 72 h post-recovery hold (Q4) is unimplemented: `recovered_at` is written but never read.
- Fix: ship replace (4.7) with fresh-passkey + `recovered_at + 72h` check before allowing real registrations, or gate `POST /v1/desktop` off until then. Parse keys as P-256 SPKI with `node:crypto.createPublicKey` and check the curve. Consider a signature over a server nonce as proof of possession.

### I4. Desktop sign-out (at this commit) leaves the server-side refresh family live
- `desktop/src-tauri/src/account_oauth.rs:220-230` only deletes the keyring entries; there is no revoke call, and the server had no revoke endpoint at 1f86e3d8.
- Failure: a refresh token copied from the keyring before sign-out stays valid for 30 days of idle. The user believes the computer is signed out.
- Status: fixed later by c466d439 (`POST /v1/oauth/revoke` + desktop call), which is outside this range. Verify that commit revokes before it deletes local state and handles offline failure.

## Minor

1. `routes/oauth.mjs:30` plus spec 6.2 "GET routes change nothing": authorize is a state-changing GET (issues a code, writes audit), and `GET /v1/account/export` writes audit (`routes/account.mjs:67`). This is acceptable for OAuth, but the spec line should say so.
2. Plan Global Constraint "every non-GET needs Content-Type: application/json" (plan:23) is relaxed for `/v1/oauth/token` (form, `routes/oauth.mjs:6-21`). That is correct per RFC 6749, but there is no written plan for sub-project 2 at all (only the identity plan exists). OAuth and devices were built plan-less, which goes against the plan-first workflow.
3. Recovery sends a link to, and can activate, `pending_passkey` accounts (`routes/recovery.mjs:14-15`, `passkeys.mjs:75`), even while sign-up is closed. Restrict recovery to `status='active'`.
4. Enumeration by timing: the existing-account branch of recovery (`recovery.mjs:15`) and the new-or-pending branch of sign-up (`signup.mjs:24`) do a synchronous SQLite insert (WAL commit) that the other branch skips. The mail caps limit how many samples an attacker gets, but P8 claims timing does not depend on the branch. Issue a dummy token on both branches or move the insert off the path.
5. Rate limiter `rate-limit.mjs:12`: when 100k live keys exist it calls `windows.clear()`, which resets every counter, including the per-address mail caps. An IPv6 attacker can force that and lift the 3/h and 10/day inbox cap. Evict per key instead, or reject new keys when full.
6. Sign-in does not refresh `backed_up` / `device_type` from `authenticationInfo` (`routes/signin.mjs:57-58`), so the account page shows stale backup state.
7. Export (`routes/account.mjs:57-71`) omits `devices` and desktop token metadata (sub-project 2 data). Spec section 8 gate 2 and the audit-visibility rule want all stored data.
8. nginx error log retention: `llmide-accounts.logrotate:2-3` (`daily`, `rotate 3`, `delaycompress`) keeps about 4 days of IP-bearing lines (limit_req and proxy errors log the client address). That exceeds the 72 h rule. Use `rotate 2`, or `maxage 3` with hourly rotation.
9. systemd hardening could add `ProtectClock`, `ProtectKernelLogs`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictSUIDSGID`, `RestrictRealtime`, `SystemCallFilter=@system-service`, and `IPAddressDeny=any` + `IPAddressAllow=localhost` (SMTP egress then needs an allow) (`llmide-accounts.service:14-28`).
10. Desktop loopback listener (`account_oauth.rs:121-153`) accepts the first connection from any local process and never checks that the path is `/auth/callback`. A local process that connects first aborts the sign-in (DoS only, because state is checked). Loop until a request whose path and state match, within the deadline.
11. Desktop stores tokens but has no refresh logic: the access token dies after 15 min and status still shows "signed in" (`account_oauth.rs:94-98`).
12. Tests use a fake WebAuthn adapter (`tests/helpers.mjs:28-60`). The real library's argument shape (`registrationInfo.credential`, `newCounter`) was checked by hand against the 14.0.3 `.d.ts` and matches, but no test runs the real verifier. Add one fixture-based test with a recorded attestation and assertion.
13. `checkOriginIfPresent` (`guard.mjs:19-21`) plus a trusted `X-Real-IP` from any loopback peer (`guard.mjs:6-10`): another VPS process can spoof client IPs in rate limits and audit. This is accepted by the spec, but worth noting for the external review.
14. CI actions are tag-pinned, not commit-pinned (`account-service-ci.yml:32,34`). The spec defers this to sub-project 5.
