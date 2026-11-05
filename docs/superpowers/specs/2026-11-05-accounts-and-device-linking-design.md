# Public accounts and device linking: design

Status: **design approved by the user in brainstorming (2026-11-05); sub-project 1 (identity API) implemented 2026-11-05; sign-up closed; sub-projects 2 to 5 not built.** Date: 2026-11-05, at `main`. Decision record: [ADR 0019](../../decisions/0019-public-accounts-desktop-data.md) (proposed). Builds on: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md), the [relay design](../plans/2026-10-31-relay-design.md) and its [security review](../plans/2026-10-31-relay-security-review.md), [sync-kit](../../kits/sync-kit.md) S1 to S6, [USER-NEEDS](../USER-NEEDS.md) section C (UN-060 to UN-062), [MASTER-PLAN](../MASTER-PLAN.md) "Web app: the user's answers", [Host API v1](../../../schema/host-api/v1/README.md), [VPS deployment](../../../deploy/vps/README.md). First implementation plan: [account service identity](../plans/2026-11-05-account-service-identity.md) (sub-project 1).

Nothing here was run or measured. Numbers are proposed starting values. Library versions were read from the npm registry on 2026-11-05 (`@simplewebauthn/server` 14.0.3, `nodemailer` 10.3.1, both `engines.node >= 20`); the repo already pins `better-sqlite3` 13.0.3 in `extension/package-lock.json`.

## 1. Goals and non-goals

**Goals**

1. Anyone can create an LLM-IDE account at llm-ide.com, sign in with a passkey, and link a phone or browser to **their own desktop**.
2. The user's meetings, code, chats and project list **stay on the desktop**. AI runs there with the user's own Claude login or API key (ADR 0015 vault). The cloud runs no AI and has no AI bill.
3. The cloud holds only what an account needs: email, display name, language, time zone, the device list, sign-in settings, and the E2E-encrypted relay traffic of the [relay design](../plans/2026-10-31-relay-design.md).
4. A new device gets access only after the **desktop** approves it; the account service alone can never grant access to data.
5. Replace the SSH tunnel and the public `/api/` path ([VPS README](../../../deploy/vps/README.md)) with one outbound relay connection from the desktop.

**Non-goals**

- No user data, no AI, no agent, plugin, MCP or connector code in the cloud. The account service never imports `extension/`.
- No hosted web client with its own data (MASTER-PLAN Q-WEB-1 option C stays rejected; section 2.1).
- No passwords. No SMS. No social login in v1.
- No team or shared accounts (relay D8: per-user keys; a team is a later cryptographic design).
- No more than one desktop per account in v1.
- No recovery key for E2E data (relay D3): losing the desktop means re-linking devices; the data itself was always on the desktop.
- No change to the local core's own local login (`extension/server/users.mjs`, `extension/server/jwt.mjs`). It stays loopback-only (ADR 0004) and is never reused on the public service.

## 2. Decisions (user, 2026-11-05)

| # | Decision |
|---|---|
| A1 | **Public sign-up:** anyone can create an account at llm-ide.com (VPS). Sign-up stays **closed** until sub-project 5 opens it after the external review. |
| A2 | **Data home is the user's desktop.** Cloud: account, profile, device list, E2E relay. AI runs on the desktop with the user's own Claude login or API key. |
| A3 | **Sign-in:** email (verified by a one-time, 15-minute, single-use link; only a token hash stored) plus **passkey** (WebAuthn). After setup, sign-in is passkey only. The email link is the **lost-passkey fallback**; adding a passkey through it signs out every other session and emails the user. |
| A4 | **New device:** passkey sign-in, the device creates its own keys, the service marks it pending and tells the desktop through the relay, the desktop shows "Allow <device>?" with a **6-digit code** that must match the device's, approval wraps a **tier-limited key** for the device (relay D1, D2) which the relay forwards as ciphertext. Deny or a 10-minute timeout leaves it unlinked. |
| A5 | **Revoke** from the desktop or the web: the device token is blocked at once and the desktop rotates epoch keys (relay 4.9). |
| A6 | **One desktop per account in v1.** A second desktop is refused. "Replace this account's desktop" needs a fresh passkey check; replacing unlinks every phone (each re-approves). No recovery key (relay D3). |
| A7 | **The server knows:** email, display name, language, time zone, device list (label, kind, status, times), sign-in settings. The **project list travels E2E-encrypted** through the relay; the server never sees project names. |
| A8 | **Approach A:** a new top-level `account-service/`: its own deployable Node service, own SQLite, own unprivileged system user; units identity, profile, devices, relay. |
| A9 | **Desktop sign-in:** system browser, OAuth 2.0 Authorization Code with PKCE (RFC 7636, native-app rules of RFC 8252), returning to a random loopback callback (`http://127.0.0.1:<ephemeral>/auth/callback`); `llmide://` is a fallback only. The desktop registers its device public keys and keeps one outbound relay connection. |
| A10 | **iPhone and web:** passkey sign-in at the `accounts.llm-ide.com` origin, wait for desktop approval, then talk to the desktop through the relay. The PWA never performs WebAuthn itself: it delegates sign-in to the account pages and uses a BFF on `app.llm-ide.com` for code exchange and refresh. |
| A11 | **Removed:** the SSH tunnel and `/api/` exposure (the `/api/` proxy was closed on 2026-11-05, commit `35d43f2b`). PIN pairing is removed later at relay R9 (sync-kit S5). |
| A12 | **Unchanged:** the local core's local login; Host API v1 commands (`schema/host-api/v1/`, `extension/routes/host-api/`), which now travel inside relay envelopes instead of a direct socket. |

### 2.1 Why this is not Q-WEB-1 option C

MASTER-PLAN rejected option C, "a server-side app with its own login and data", because it breaks the one-copy rule, the loopback-only core and "no data access" in the cloud. This design has a login in the cloud, but **no data**: the account service stores identity rows and ciphertext only, the relay cannot read what it forwards (relay design 4.10), and every read or action is answered by the desktop. Q-WEB-1 option A (a relay-served PWA, tiered per D1) is what the web client still is; ADR 0019 adds a public **account** in front of it, which answers relay open question X1.

## 3. Architecture and units

```text
 Browser (PWA, app origin)      Native iOS app             Desktop (Tauri / Mac)
   passkey sign-in                passkey sign-in            system browser: OAuth code + PKCE
   device keys (WebCrypto)        device keys (Keychain)     -> llmide://auth/callback
        |  HTTPS                       |  HTTPS              registers device keys
        |                              |                     ONE outbound connection (HTTPS/SSE)
        v                              v                              |
 +--------------------------- account-service (VPS) -------------------v-----------+
 |  identity   email links, passkeys, sessions, OAuth code+PKCE, audit log        |
 |  profile    display name, language, time zone                                  |
 |  devices    registry copy, pending links, revoke, one-desktop rule             |
 |  relay      E2E envelopes only: link messages, wraps, manifest, snapshots,     |
 |             inbox, outbox (relay design sections 2 to 7)                       |
 |  own SQLite, own system user, no AI, no agents, never imports extension/       |
 +-------------------------------------------------------------------------------+
                                                                       |
                                     Desktop Node core (loopback only, ADR 0004)
                                     holds data, root keys, signing key,
                                     authoritative device registry (relay 4.6),
                                     runs AI with the user's own Claude login/key
```

| Unit | Owns | Talks to |
|---|---|---|
| identity | users, email tokens, passkeys, web sessions, OAuth codes and desktop tokens, audit log | browsers, desktop (OAuth) |
| profile | display name, language, time zone; export and delete | browsers |
| devices | the device registry copy, pending link requests, revoke, the one-desktop rule | identity, relay |
| relay | encrypted envelopes, per-device queues, the desktop's outbound connection | desktop, devices |

**Origins:** `https://accounts.llm-ide.com` serves the account pages and `/v1/` API and is the WebAuthn RP ID; the relay endpoints live on the same service under `/relay/v1/`; the PWA is on a **separate origin and hosting account** (`https://app.llm-ide.com`, relay D1). `llm-ide.com` itself serves no API.

The PWA does **not** perform WebAuthn on `app.llm-ide.com`: a passkey registered for the `accounts.llm-ide.com` RP ID cannot be used from another origin. The PWA opens the account sign-in page, the passkey ceremony runs on the accounts origin, and the authorization code returns to an `app.llm-ide.com` callback served by a small BFF. The BFF exchanges the code and keeps the refresh token server-side in an `HttpOnly; Secure; SameSite=Lax` cookie on the app origin; the browser holds only the short-lived access token in memory. The accounts API therefore sends no CORS headers and the PWA makes no cross-origin `/v1/` calls. This is required by the PWA's separate origin, not optional.

The PWA's relay WebSocket connects to `wss://accounts.llm-ide.com/relay/v1` with `Origin: https://app.llm-ide.com`; the relay checks an explicit `ACCOUNTS_ALLOWED_WEB_ORIGINS` allowlist (never `*`).

The Node core still binds to `127.0.0.1`; only the desktop opens outbound connections (relay design non-goal list). The account service binds to `127.0.0.1` behind nginx.

## 4. Flows

All state-changing requests are JSON `POST`/`PATCH` from the exact service origin. "Email" below is text-only mail.

### 4.1 Sign-up

1. Browser: `POST /v1/signup {email, displayName, language, timeZone}`.
2. Service: if sign-up is closed, `403 signup_closed`. Otherwise it **always** answers `202 {"status":"check_email"}`:
   - no account, or an account still `pending_passkey`: store `SHA-256(token)` (256-bit random token, purpose `signup`, 15 minutes) and email the link `https://accounts.llm-ide.com/account/verify#purpose=signup&token=<token>`;
   - an active account: email "you already have an account; sign in, or use Lost your passkey".
3. The link's page reads the token from the **fragment** (never sent to the server or written to logs; a mail scanner's GET consumes nothing) and `POST /v1/signup/verify {token}`.
4. Service: consume the token (single use, unexpired, purpose match; older tokens for the same address and purpose die with it), create the user as `pending_passkey`, and issue a **setup session** (15 minutes, may only register a passkey).
5. Browser: `POST /v1/passkeys/options` then `POST /v1/passkeys/verify` (resident key and user verification **required**). The account becomes `active`; the setup session is replaced by a full session.
6. A `pending_passkey` account older than 24 hours is deleted.

### 4.2 Sign-in

1. `POST /v1/signin/options {}` returns WebAuthn options with an **empty `allowCredentials`** (discoverable credentials), so the request names no account and cannot enumerate one.
2. `POST /v1/signin/verify {ceremonyId, response}`: look up the credential by id, verify (challenge single use, 5 minutes; origin and RP ID exact; user verification required; signature counter checked by the library), then rotate to a new full session. Every failure is the same `400 signin_failed`.

### 4.3 Lost passkey

1. `POST /v1/recovery {email}` always answers `202 {"status":"check_email"}`. Only an existing account receives a link (purpose `recovery`, 15 minutes, single use).
2. `POST /v1/recovery/verify {token}` issues a setup session marked `via = recovery`.
3. Registering a passkey through it: **revokes every other session**, records `recovered_at`, and emails "a passkey was added through an email link; every other session was signed out; if this was not you, …".
4. Sub-project 2 adds: within 72 hours after `recovered_at`, "replace desktop" is held (proposed, Q4), so an email takeover cannot swap the desktop silently.

### 4.4 Desktop sign-in (sub-project 2)

1. The desktop creates a PKCE verifier (43 to 128 chars) and `S256` challenge and a `state`, binds a random loopback port, and opens the system browser at `/v1/oauth/authorize?client_id=llmide-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback&code_challenge=…&code_challenge_method=S256&state=…`. The `llmide://auth/callback` custom scheme remains a fallback only if loopback is impossible; PKCE still protects the code.
2. The user signs in with a passkey (4.2) and confirms "Sign in LLM-IDE on this computer?".
3. The service redirects to the exact loopback redirect URI with `?code=…&state=…` (code: 256-bit, single use, 60 seconds, hash stored, bound to the challenge and redirect URI). The desktop closes the loopback listener after one request; a foreign scheme handler cannot read the loopback callback.
4. The desktop checks `state`, then `POST /v1/oauth/token` with the verifier, and receives an access token (opaque, 15 minutes) and a rotating refresh token (30-day idle; reuse of an old refresh token revokes the family).
5. The desktop registers its device public keys (ECDSA P-256 signing, ECDH P-256 wrap; relay 4.2) as the account's **desktop**. If the account already has one, `409 desktop_exists` and the desktop offers "Replace this account's desktop" (4.7).
6. The desktop opens its one outbound connection to the relay. Every admin operation on it is signed by the desktop signing key (relay 4.8), so the bearer token alone is not a takeover.

A custom scheme can be claimed by another local app; PKCE makes an intercepted code useless without the verifier (RFC 8252 section 8.1), but the loopback redirect is the default because it cannot be claimed by another app.

### 4.5 Device linking (sub-projects 2 and 4)

Replaces the QR enrollment of relay 4.5 for phones and browsers; keeps its goals (desktop-enforced single use, SAS on both screens, contested-claim alert, desktop-authoritative registry).

1. The device signs in with a passkey (iOS: platform passkey with associated domains; PWA: Authorization Code + PKCE against the accounts origin).
2. The device generates two non-extractable key pairs (relay 4.2) and a 256-bit nonce `nD`, and sends `POST /v1/devices {kind, label, commitment}` where `commitment = SHA-256("llmide/link/commit/v1" || deviceSigningSPKI || deviceEcdhSPKI || nD)`. The service creates a `pending` device (10-minute expiry) and forwards a link request to the desktop through the relay.
3. The desktop shows "Allow <label> (<kind>)?" and replies, signed, with its own fresh 256-bit nonce `nK`. The service forwards it.
4. The device reveals its public keys and `nD`. The desktop checks them against the commitment.
5. Both compute `SAS = 6 decimal digits of SHA-256("llmide/link/sas/v1" || deviceSigningSPKI || deviceEcdhSPKI || desktopSigningSPKI || nD || nK)` and show it. Because the device committed before `nK` existed, a malicious service cannot search for a key pair whose code collides (one try per link, 1 in 10^6).
6. The user approves on the desktop only when the codes match. The desktop adds the device to its **local signed registry** (relay 4.6), wraps the subkeys of the device's tier (PWA read-only, native iOS per desktop switches; relay 7.1) in a **signed wrap** (relay 4.4), and sends it through the relay. The device verifies the wrap against the desktop signing key it saw in step 5 (now pinned) and returns key confirmation.
7. Deny, a mismatched code, a second link attempt for the same pending device (contested claim alert), or 10 minutes without approval: the device is `unlinked` and its keys are deleted.

The service never sees a key it could use: it forwards commitments, public keys, nonces and wraps.

### 4.6 Revoke

- From the desktop: signed revoke operation; the service blocks the device token at once; the desktop rotates (relay 4.9: rotate, wrap, publish, delete).
- From the web (any full session with a fresh passkey check): the service blocks the token at once and sets "revocation pending"; on its next contact the desktop **rotates before publishing** (relay D4 semantics). This replaces the printed revoke code of relay D4 for account holders.

### 4.7 Replace desktop

1. On the new computer, desktop sign-in (4.4) hits `409 desktop_exists`; the user chooses "Replace" and signs in again with a passkey (fresh, under 5 minutes).
2. The service revokes the old desktop's tokens, **unlinks every device**, deletes the relay data of the account, records the event and emails the user (and, if reachable, tells the old desktop through the relay).
3. Blocked for 72 hours after an email recovery (4.3 step 4, Q4).
4. No recovery key (D3): phones re-link to the new desktop with 4.5.

## 5. Data model

One SQLite file per service (WAL, foreign keys on, single process, numbered append-only migrations as in ADR 0008). Sub-project 1 tables are exact in the plan; later ones are outlined.

| Table | Sub-project | Content | Protected how |
|---|---|---|---|
| `users` | 1 | id (128-bit random), email (normalized), display name, language, time zone, status `pending_passkey`/`active`, `webauthn_user_id` (32 random bytes, never the email), created, updated, `recovered_at` | plain (needed to send mail) |
| `passkeys` | 1 | credential id, user, public key, counter, transports, device type, backed-up flag, name, created, last used | public keys only |
| `email_tokens` | 1 | `SHA-256(token)`, purpose, email, sign-up profile, expiry, used | **hash only**, 15 min, single use |
| `webauthn_challenges` | 1 | ceremony id, challenge, purpose, user | 5 min, deleted on use |
| `sessions` | 1 | `SHA-256(token)`, user, scope `full`/`setup`, via, created, last seen, expiry, `auth_at`, IP, revoked | **hash only** |
| `audit_events` | 1 | time, user id, event, IP, small detail (never tokens, bodies, or link fragments) | IP nulled after 72 h, row deleted after 400 days |
| `oauth_codes` | 2 | `SHA-256(code)`, user, client, PKCE challenge, redirect URI, expiry, used | hash only, 60 s |
| `desktop_tokens` | 2 | `SHA-256(token)`, family, kind access/refresh, expiry, revoked | hash only |
| `devices` | 2 | id, user, kind `desktop`/`ios`/`web`, label, status `pending`/`linked`/`unlinked`/`revoked`, signing and ECDH public keys, `SHA-256(device token)`, tier, times; **one `desktop` row per user** (partial unique index) | public keys and hashes only |
| `link_requests` | 2 | device, commitment, nonces, expiry 10 min, state | public values only |
| relay tables | 3 | manifest, snapshots (project list is one kind), wraps, inbox, outbox, revocation-pending flag (relay 2.2) | ciphertext only |

**Retention:** IP addresses at most **72 hours** (relay D5), in `sessions` and `audit_events` alike; access logs keep no IP beyond 72 h and never headers, bodies or URL fragments (relay 12); expired tokens, challenges and sessions purged every 10 minutes; relay items per relay 2.2.

**Encryption at rest:** the VPS disk plus encrypted off-host backups (sub-project 5). Nothing in the database is useful for signing in: tokens are hashed, passkeys are public keys.

## 6. Security

### 6.1 Threat model

Assets: the user's ability to sign in, the device list, the right to link a device (a linked device reads desktop data through the relay), the email address and profile, the service's reputation and mail-sending reputation.

| # | Threat | Controls | Residual |
|---|---|---|---|
| P1 | **Account takeover** (stolen session, stolen passkey device) | Passkeys with user verification; HttpOnly `__Host-` cookies; 1 h idle / 12 h absolute web sessions; fresh passkey check (5 min) for add/remove passkey, revoke, replace desktop, delete; new-passkey email; **linking still needs desktop approval** | An attacker with the user's unlocked phone and its passkey acts as the user until revoked |
| P2 | **Email takeover** | Email only recovers sign-in: it cannot link a device (desktop approval), and replacing the desktop is held 72 h after a recovery; recovery signs out all sessions and emails the user | Denial of service: an attacker can revoke devices |
| P3 | **Phishing** | Passkeys are origin-bound (the RP ID check defeats look-alike domains); no passwords or codes to type; the SAS is compared, never typed into a site | A user who approves a link on the desktop without comparing the code |
| P4 | **Server breach** (read the DB) | Only hashes and public keys; no AI keys, no data; relay holds ciphertext | Emails, names, time zones, device labels and IPs (72 h) leak; notify per privacy policy |
| P5 | **Malicious or compromised service** (it is the origin of the account pages) | The commitment-based SAS (4.5) stops key substitution; the desktop's local registry is authoritative (relay 4.6); signed wraps; the PWA is on a separate origin and hosting account (relay D1) | A hostile service can refuse service, read metadata, and present phishing pages on its own origin; it still cannot obtain data without a desktop approval the user confirms |
| P6 | **Malicious relay** | Relay design 4.10 and threats T1 to T23 apply unchanged | As stated there |
| P7 | **Abuse and spam sign-ups** | Sign-up closed until launch; rate limits per IP and per address; an address gets at most 3 mails per hour and 10 per day from all routes; an account exists only after the link is used; unfinished accounts deleted after 24 h | Low-volume abuse from many IPs |
| P8 | **User enumeration** | Sign-up and recovery always `202` with the same body; sign-in names no account; same error for every sign-in failure; mail sent off the request path so timing does not depend on the branch | Rate-limit `429`s apply equally to every address |
| P9 | **CSRF and cross-origin** | Every non-GET needs `Origin` equal to the service origin and `Content-Type: application/json`; cookies `SameSite=Strict`; no CORS on the account API, because the PWA uses the app-origin BFF and never calls `/v1/` cross-origin | None known |
| P10 | **Token leaks via mail links** | Token in the URL fragment; single use; 15 minutes; hash at rest; `Referrer-Policy: no-referrer` on the pages | A mail account reader within 15 minutes (= P2) |
| P11 | **Supply chain** | Three runtime dependencies, exact pins, lockfile, CI boundary check (only allowed imports; never `extension/`), `npm audit` in CI | A compromised pinned version; review on every bump |
| P12 | **Operator mistake** (reopen `/api/`, file mailer in production) | Config refuses non-loopback bind, non-HTTPS origin and the file mailer in production; the VPS README forbids reopening `/api/` | — |

### 6.2 Controls

| Control | Rule |
|---|---|
| Rate limits | Per IP: 120 requests/min overall, sign-up 10/h, recovery 10/h, link verification 20/h, sign-in options 30/min, sign-in verify 10/min. Per address: 3 mails/h and 10/day (shared by sign-up and recovery). Per account (sub-project 2): 5 pending links/h. In memory for the single process; `429` with `Retry-After`. |
| No enumeration | P8 above; tested for every route that takes an email. |
| CSRF / origin | P9 above. GET routes change nothing. |
| Client IP | Taken from `X-Real-IP` only when `ACCOUNTS_TRUST_PROXY=1` **and** the peer is loopback (nginx overwrites the header with `$remote_addr`). |
| Sessions | Opaque 256-bit tokens, hash stored. Web full session: idle 1 h, absolute 12 h. Setup session: 15 min, passkey registration only. Fresh check: 5 min since the last passkey proof. Desktop: access 15 min, refresh rotating, 30-day idle. Devices: relay L2 (30-day idle). |
| Passkey-only after setup | No password exists. Email links only create or recover; they never give a full session. |
| Audit log | Every sign-up, verification, sign-in (success and failure), passkey change, recovery, revoke, link, replace, export, delete and mail failure. Visible to the user in their export. |
| Admin access | No admin UI or API in v1. Operations by SSH with hardware-key MFA (relay 12), from a non-root sudo user (the current runbook uses `root@`, to change in sub-project 5); scripted read-only queries only. |
| Secrets | Sub-project 1 has one secret: the SMTP credential in `/etc/llm-ide/accounts.env` (`0600`). Session and OAuth tokens are random and stored hashed, so there is no signing key to steal. |
| Backups | Daily SQLite online backup, encrypted, off-host, 7 days (sub-project 5). Losing the database loses accounts, not user data: desktops and devices re-link. |
| Dependencies | `@simplewebauthn/server` for every WebAuthn check (well maintained, used widely, TypeScript, verifies attestation formats, counters, origin and RP ID; we write none of it). `nodemailer` for SMTP (no runtime dependencies). `better-sqlite3` as in the core. OAuth 2.0 + PKCE in sub-project 2 is server-side only and built from Node `crypto` (`randomBytes`, SHA-256): no primitive is hand-written; protocol code follows RFC 6749, 7636, 8252 and gets the external review. No other runtime dependency without a written reason. |
| Headers | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, HSTS, `Referrer-Policy: no-referrer`, a strict CSP on the account pages (relay 7.3 values). |

## 7. Errors and failure behaviour

| Failure | Behaviour |
|---|---|
| Email provider down | The API still answers `202`; delivery retries in memory for about 30 s (5 tries, doubling back-off), then logs `mail_failed` in the audit log. The token is never stored in clear, so a restart drops the mail; the page offers "resend" after 60 s. Passkey sign-in is unaffected. |
| Account service down | Desktops keep working locally; linked devices show "can't reach LLM-IDE" and their last decrypted snapshot (marked stale); no new sign-in, link or revoke. |
| Relay down (same service, separate unit) | As above for remote use; sign-in and profile still work. |
| Desktop offline | A link request waits up to 10 minutes, then the device is `unlinked` ("open LLM-IDE on your computer and try again"). A web revoke takes effect at once at the service; the desktop rotates first on its next start. Queued requests follow relay 5.2. |
| Database locked or corrupt | `500 internal` without details; restore from backup or start empty (users re-link; no user data is lost). |
| Clock skew on a device | Not security-relevant to the service (relay L5); expiry is checked with the service clock. |

Every error body is `{"error":"<code>"}` with a fixed code; no stack traces or SQL text leave the process.

## 8. Privacy and legal launch gates

Public sign-up opens only when **all** are done (sub-project 5):

1. **Terms of service** and **privacy policy** published: what is stored (section 5), where (VPS region), processors (VPS host, email provider), retention (72 h IPs, 400-day audit, 7-day backups), that user data stays on the desktop and AI runs there with the user's own credentials.
2. **Data export** (`GET /v1/account/export`, sub-project 1) and **deletion** (`POST /v1/account/delete`, sub-project 1; backups age out in 7 days) work and are linked from the account page.
3. A privacy contact and an abuse contact; a breach-notification procedure (including the jurisdictions the operator is subject to, such as Japan's APPI and the GDPR for EU users).
4. Only strictly necessary cookies (one session cookie), so no consent banner; no third-party script or analytics (UN-061).
5. Mail domain authentication: SPF, DKIM and DMARC for the sending domain.
6. **External security review (relay D9, G-EXT)** of this spec, the relay spec, and the sub-project 1 to 4 code, with findings fixed or accepted in writing.
7. Minimum age stated in the terms.

## 9. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit and route | Every flow in section 4 for sub-project 1, error codes, expiry, single use, scope rules | `node:test`, in-process server on `127.0.0.1:0`, injected clock, in-memory mailer, a fake WebAuthn adapter that records the arguments passed to the library |
| No enumeration | Known and unknown addresses give identical status and body on sign-up and recovery | Paired requests |
| Origin and CSRF | Missing or foreign `Origin`, wrong content type | Route tests |
| Rate limits | Each limit trips and resets | Injected clock |
| Token blindness | After a full scenario, no issued token, cookie or link fragment appears anywhere in the database | Scan every table |
| Retention | IPs nulled at 72 h, pending accounts deleted at 24 h | Injected clock |
| Boundary | No import outside the package, `node:` built-ins and the three allowed dependencies | CI script |
| Real passkeys | Registration and sign-in with a real authenticator, RP ID and origin exact | Sub-project 4: browser automation with Chrome's virtual authenticator, plus the user on a real iPhone (`(you)`); assert a passkey from `accounts.llm-ide.com` is not offered on `app.llm-ide.com` |
| OAuth + PKCE | Wrong verifier, reused code, expired code, wrong redirect URI, refresh reuse | Sub-project 2 |
| Linking | Key substitution by the service gives mismatched codes; contested claim; timeout; deny | Sub-project 2, scripted malicious-service test |
| PWA BFF | Code exchange and refresh stay same-origin; no CORS preflight; cookie flags; logout/revoke | Sub-project 4, browser + BFF tests |
| Relay origin | The PWA origin is allowed; any other origin is refused | Sub-project 3/4 |
| Desktop redirect | Loopback code is single-use and foreign scheme cannot exchange it | Sub-project 2 |
| Relay | The negative-test list of relay 11.1 | Sub-project 3 |
| External review | Spec and code | Sub-project 5 |

## 10. Sub-projects

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| 1 | **Account service: identity, profile, sessions** | `account-service/` skeleton, SQLite, email sign-up, passkeys, sessions, lost-passkey flow, profile, export and delete, rate limits, audit, CI, systemd and nginx deploy note. API only. Sign-up closed. | — |
| 2 | **Desktop sign-in and device linking** | OAuth code + PKCE, `llmide://` on the Tauri desktop, desktop device registration, one-desktop rule and replace, the desktop's outbound connection, link requests with the commitment SAS (4.5), revoke, desktop UI | 1; relay R0 and R1 (spec and crypto library) for the wrap step |
| 3 | **Relay** | Relay design R0 to R4 on the account service's relay unit, multi-tenant by account; Host API v1 inside envelopes; snapshot producer and request consumer on the desktop | 2 (accounts and devices); R0/R1 can start in parallel with 1 |
| 4 | **iPhone and web clients** | Account pages (sign-up, verify, sign-in, account), PWA on its own origin and hosting account, native iOS passkey sign-in and linking, relay transport replacing the SSH tunnel | 2, 3 |
| 5 | **Security review and launch** | G-EXT external review, legal gates (section 8), backups, monitoring, hardware-key MFA accounts, commit-pinned CI actions, then sign-up opened | 1 to 4 |

## 11. Open questions for the user

Each has a recommended secure default that the plans assume until you say otherwise.

| # | Question | Recommended default |
|---|---|---|
| Q1 | Which email provider sends sign-up and recovery mail? | A transactional provider over SMTPS (port 465), such as Amazon SES (Tokyo region) or Postmark, with SPF, DKIM and DMARC on the sending domain; never a self-hosted mail server. |
| Q2 | Which WebAuthn library? | `@simplewebauthn/server` 14.0.3, exact pin, bumped only with a changelog read. |
| Q3 | Which origins? | `accounts.llm-ide.com` (account pages, API, relay; WebAuthn RP ID) on the VPS; the PWA on `app.llm-ide.com` with a **separate hosting account** and hardware-key MFA (relay D1), plus a same-origin BFF for token exchange/refresh; the PWA currently at the `llm-ide.com` root moves there. The PWA delegates passkeys to the accounts origin; it never uses a parent-domain RP ID. |
| Q4 | Hold "replace desktop" for 72 hours after an email recovery? | Yes. |
| Q5 | Spam defence beyond rate limits (CAPTCHA)? | None at launch (no third-party script, UN-061); add a privacy-preserving challenge only if abuse appears. |
| Q6 | Who writes the terms and privacy policy, and which minimum age? | A lawyer-reviewed text for the operator's jurisdiction; minimum age 16. |
| Q7 | Who performs and pays for the external review (relay X2)? | Book it while sub-project 3 runs, so the review covers sub-projects 1 to 4 in one window. |
| Q8 | Account deletion: immediate or with a grace period? | Immediate after a fresh passkey check; backups age out in 7 days. |
